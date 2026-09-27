use super::audio_models;
use crate::audio::mic_pipeline::MicOptions;
use crate::audio::microphone::MicCapture;
use crate::audio::SystemAudioCapture;
use crate::settings::SettingsState;
use std::sync::mpsc;
use std::sync::Mutex;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    State,
};

/// State for tracking active audio captures
pub struct AudioState {
    pub system_audio: Mutex<SystemAudioCapture>,
    pub microphone: Mutex<MicCapture>,
    pub active_receiver: Mutex<Option<AudioForwarder>>,
}

/// Forwards audio from a receiver to a Tauri IPC channel
pub struct AudioForwarder {
    /// Handle to signal stop
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl AudioForwarder {
    fn stop(&self) {
        self.stop_flag
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Start audio capture and forward data to the frontend via IPC channel
#[tauri::command]
pub fn start_capture(
    source: String,
    channel: Channel<InvokeResponseBody>,
    state: State<'_, AudioState>,
    settings: State<'_, SettingsState>,
) -> Result<(), String> {
    // Stop any existing capture first
    stop_capture_inner(&state);

    let receiver: mpsc::Receiver<Vec<u8>> = match source.as_str() {
        "system" => {
            let sys = state.system_audio.lock().map_err(|e| e.to_string())?;
            sys.start()?
        }
        "microphone" => {
            let mut mic = state.microphone.lock().map_err(|e| e.to_string())?;
            mic.start(mic_options(&settings))?
        }
        "both" => {
            // Start both sources and MIX them (sample sum), not concatenate.
            let sys = state.system_audio.lock().map_err(|e| e.to_string())?;
            let sys_rx = sys.start()?;
            let mut mic = state.microphone.lock().map_err(|e| e.to_string())?;
            let mic_rx = match mic.start(mic_options(&settings)) {
                Ok(rx) => rx,
                Err(e) => {
                    // Don't leave system capture running for a source that failed.
                    sys.stop();
                    return Err(e);
                }
            };
            spawn_mixer(sys_rx, mic_rx)
        }
        _ => return Err(format!("Unknown source: {}", source)),
    };

    // Spawn a thread to forward audio data from receiver to IPC channel
    let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();

    std::thread::spawn(move || {
        // 100 ms batches: every engine sees speech 100 ms sooner than with
        // 200 ms, and Local's cutter reacts at finer steps; 10 IPC sends/s is
        // cheap. 100 ms of 16 kHz s16le mono is 3200 B; headroom so a batch
        // never grows.
        const BATCH_CAP: usize = 8192;
        let batch_interval = std::time::Duration::from_millis(100);
        let mut buffer: Vec<u8> = Vec::with_capacity(BATCH_CAP);
        let mut last_flush = std::time::Instant::now();

        // Hand the batch to the webview as raw bytes (not a JSON number array),
        // swapping in a fresh buffer instead of cloning. False once the channel
        // is closed.
        let flush = |buffer: &mut Vec<u8>| -> bool {
            if buffer.is_empty() {
                return true;
            }
            let batch = std::mem::replace(buffer, Vec::with_capacity(BATCH_CAP));
            channel.send(InvokeResponseBody::Raw(batch)).is_ok()
        };

        loop {
            if stop_flag_clone.load(std::sync::atomic::Ordering::SeqCst) {
                flush(&mut buffer);
                break;
            }

            match receiver.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(data) => buffer.extend_from_slice(&data),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    flush(&mut buffer);
                    break;
                }
            }

            if last_flush.elapsed() >= batch_interval && !buffer.is_empty() {
                if !flush(&mut buffer) {
                    break; // webview channel closed
                }
                last_flush = std::time::Instant::now();
            }
        }
    });

    // Store the forwarder so we can stop it later
    let forwarder = AudioForwarder { stop_flag };
    let mut active = state.active_receiver.lock().map_err(|e| e.to_string())?;
    *active = Some(forwarder);

    Ok(())
}

/// Mix two 16 kHz s16le mono streams sample-by-sample (sum, clamped).
///
/// Driven by whichever side delivers — no timer thread. Each side keeps a
/// small FIFO; output is the overlap of both. If one side runs ahead by more
/// than `MIX_LAG_CAP` (clock drift, or the other device stalled) its excess is
/// emitted alone so audio keeps flowing and no queue can grow unbounded. Ends
/// when both sources are gone; the returned receiver then disconnects.
fn spawn_mixer(a: mpsc::Receiver<Vec<u8>>, b: mpsc::Receiver<Vec<u8>>) -> mpsc::Receiver<Vec<u8>> {
    use std::collections::VecDeque;
    use std::time::Duration;

    /// 250 ms of s16le at 16 kHz.
    const MIX_LAG_CAP: usize = 8000;

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::Builder::new()
        .name("audio-mixer".into())
        .spawn(move || {
            let mut qa: VecDeque<u8> = VecDeque::with_capacity(MIX_LAG_CAP * 2);
            let mut qb: VecDeque<u8> = VecDeque::with_capacity(MIX_LAG_CAP * 2);
            let (mut a_alive, mut b_alive) = (true, true);
            let mut out: Vec<u8> = Vec::with_capacity(MIX_LAG_CAP);

            while a_alive || b_alive {
                // Block on `a` (system audio delivers continuously); `b` is
                // drained opportunistically. The timeout keeps `b` flowing if
                // `a` stalls.
                if a_alive {
                    match a.recv_timeout(Duration::from_millis(50)) {
                        Ok(d) => qa.extend(d),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => a_alive = false,
                    }
                }
                if b_alive {
                    loop {
                        match b.try_recv() {
                            Ok(d) => qb.extend(d),
                            Err(mpsc::TryRecvError::Empty) => break,
                            Err(mpsc::TryRecvError::Disconnected) => {
                                b_alive = false;
                                break;
                            }
                        }
                    }
                } else if !a_alive {
                    break;
                }

                // Overlap → mixed; excess beyond the cap on either side → solo.
                let overlap = qa.len().min(qb.len()) & !1;
                out.clear();
                for _ in 0..overlap / 2 {
                    let sa = i16::from_le_bytes([qa.pop_front().unwrap(), qa.pop_front().unwrap()]);
                    let sb = i16::from_le_bytes([qb.pop_front().unwrap(), qb.pop_front().unwrap()]);
                    let mixed = (sa as i32 + sb as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                    out.extend_from_slice(&mixed.to_le_bytes());
                }
                for q in [&mut qa, &mut qb] {
                    if q.len() > MIX_LAG_CAP {
                        let solo = (q.len() - MIX_LAG_CAP) & !1;
                        out.extend(q.drain(..solo));
                    }
                }
                if !out.is_empty() && tx.send(std::mem::take(&mut out)).is_err() {
                    break; // forwarder gone
                }
                out.reserve(MIX_LAG_CAP);
            }
        })
        .expect("spawn audio-mixer thread");
    rx
}

/// Resolve the microphone chain from settings. Model stages are only enabled
/// when their file is actually installed, so a missing download degrades to
/// plain capture instead of failing to start.
fn mic_options(settings: &SettingsState) -> MicOptions {
    let s = settings
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    MicOptions {
        voice_processing: s.mic_voice_processing,
        highpass: s.mic_highpass,
        agc: s.mic_agc,
        denoise_model: s
            .mic_denoise
            .then(|| audio_models::installed_path(audio_models::GTCRN_ID))
            .flatten(),
        vad_model: s
            .mic_vad
            .then(|| audio_models::installed_path(audio_models::SILERO_VAD_ID))
            .flatten(),
    }
}

/// Stop audio capture
#[tauri::command]
pub fn stop_capture(state: State<'_, AudioState>) -> Result<(), String> {
    stop_capture_inner(&state);
    Ok(())
}

fn stop_capture_inner(state: &AudioState) {
    // Stop the forwarder
    if let Ok(mut active) = state.active_receiver.lock() {
        if let Some(forwarder) = active.take() {
            forwarder.stop();
        }
    }

    // Stop system audio
    if let Ok(sys) = state.system_audio.lock() {
        sys.stop();
    }

    // Stop microphone
    if let Ok(mut mic) = state.microphone.lock() {
        mic.stop();
    }
}

