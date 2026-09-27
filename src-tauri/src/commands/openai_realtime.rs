// OpenAI Realtime translate provider — backend WebSocket bridge.
//
// Browsers can't set Authorization headers on WebSockets, so we run the WS
// in Rust. Frontend sends 16kHz s16le PCM via Tauri commands; we resample
// to 24kHz, base64-encode, and forward to OpenAI. Server events are parsed
// and emitted to the frontend via a Tauri Channel.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use http::Request;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::{Channel, InvokeBody, Request as IpcRequest};
use tauri::State;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::audio::resampler::UpsamplerTo24k;

const OPENAI_REALTIME_BASE: &str = "wss://api.openai.com/v1/realtime/translations";
const OPENAI_DEFAULT_MODEL: &str = "gpt-realtime-translate";
/// Bounded audio queue: 100 ms chunks → ~10 s of backlog before we drop.
const AUDIO_QUEUE_CHUNKS: usize = 100;
/// Capture batches are 100 ms; the server processes faster than real time, so
/// a short backlog is caught up naturally. Past 5 s we skip ahead to 2 s.
const CHUNK_SECS: f32 = 0.1;
const BACKLOG_SKIP_ABOVE: usize = 50;
const BACKLOG_KEEP: usize = 20;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// WS URL for `model`; falls back to the default when empty. Model ids are
/// restricted to URL-safe chars so a settings value can't inject query params.
fn realtime_url(model: &str) -> String {
    let cleaned: String = model
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
        .collect();
    let m = if cleaned.is_empty() { OPENAI_DEFAULT_MODEL } else { cleaned.as_str() };
    format!("{}?model={}", OPENAI_REALTIME_BASE, m)
}

#[derive(Debug, Deserialize)]
pub struct OpenAiRealtimeConfig {
    pub api_key: String,
    /// Realtime model id (Settings → Model). Empty → default.
    #[serde(default)]
    pub model: String,
    pub source_language: String,
    pub target_language: String,
    pub voice: Option<String>,
    /// When true (default), server generates translated audio output.
    /// When false, requests text-only modality so no TTS audio is generated
    /// (saves cost and bandwidth — for read-only use cases).
    #[serde(default = "default_true")]
    pub audio_output: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OpenAiEvent {
    Status {
        state: String,
        message: Option<String>,
    },
    Transcript {
        text: String,
        is_final: bool,
    },
    SourceTranscript {
        text: String,
        is_final: bool,
    },
    AudioChunk {
        pcm_base64: String,
    },
    Error {
        code: String,
        message: String,
    },
    Closed {
        reason: String,
    },
}

struct Session {
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop_tx: mpsc::UnboundedSender<()>,
    upsampler: Mutex<UpsamplerTo24k>,
}

#[derive(Default)]
pub struct OpenAiState {
    sessions: Mutex<HashMap<u64, Session>>,
    next_id: Mutex<u64>,
}

#[tauri::command]
pub async fn openai_realtime_start(
    config: OpenAiRealtimeConfig,
    on_event: Channel<OpenAiEvent>,
    state: State<'_, OpenAiState>,
) -> Result<u64, String> {
    if config.api_key.trim().is_empty() {
        return Err("OpenAI API key is empty".into());
    }

    let session_id = {
        let mut id = state.next_id.lock().unwrap();
        *id += 1;
        *id
    };

    let upsampler = UpsamplerTo24k::new()?;

    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>(AUDIO_QUEUE_CHUNKS);
    let (stop_tx, stop_rx) = mpsc::unbounded_channel::<()>();

    let session = Session {
        audio_tx,
        stop_tx,
        upsampler: Mutex::new(upsampler),
    };
    state.sessions.lock().unwrap().insert(session_id, session);

    let event_ch = on_event.clone();
    let cfg = OpenAiRealtimeConfig {
        api_key: config.api_key,
        model: config.model,
        source_language: config.source_language,
        target_language: config.target_language,
        voice: config.voice,
        audio_output: config.audio_output,
    };

    tokio::spawn(async move {
        let _ = event_ch.send(OpenAiEvent::Status {
            state: "connecting".into(),
            message: None,
        });

        if let Err(e) = run_session(cfg, audio_rx, stop_rx, event_ch.clone()).await {
            let _ = event_ch.send(OpenAiEvent::Error {
                code: "session_failed".into(),
                message: e,
            });
        }

        let _ = event_ch.send(OpenAiEvent::Closed {
            reason: "session_ended".into(),
        });
    });

    Ok(session_id)
}

/// Hot path (5×/s). PCM arrives as the raw invoke body — no JSON number array
/// to serialize/parse — with the session id in the `x-session-id` header.
#[tauri::command]
pub async fn openai_realtime_send_audio(
    request: IpcRequest<'_>,
    state: State<'_, OpenAiState>,
) -> Result<(), String> {
    let session_id = super::session_id_from_headers(request.headers())?;
    let pcm = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("expected raw PCM body".into()),
    };

    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    let upsampled = session.upsampler.lock().unwrap().push(pcm)?;
    if upsampled.is_empty() {
        return Ok(());
    }
    match session.audio_tx.try_send(upsampled) {
        Ok(()) => Ok(()),
        // Real-time audio: if the socket can't keep up, dropping the newest
        // chunk beats unbounded memory growth.
        Err(mpsc::error::TrySendError::Full(_)) => {
            eprintln!("[openai] audio queue full — dropping chunk");
            Ok(())
        }
        Err(mpsc::error::TrySendError::Closed(_)) => Err("session closed".into()),
    }
}

#[tauri::command]
pub async fn openai_realtime_stop(
    session_id: u64,
    state: State<'_, OpenAiState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.remove(&session_id) {
        let _ = session.stop_tx.send(());
    }
    Ok(())
}

async fn run_session(
    cfg: OpenAiRealtimeConfig,
    mut audio_rx: mpsc::Receiver<Vec<u8>>,
    mut stop_rx: mpsc::UnboundedReceiver<()>,
    event_ch: Channel<OpenAiEvent>,
) -> Result<(), String> {
    // Build WebSocket request with auth headers
    let request = Request::builder()
        .uri(realtime_url(&cfg.model))
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .header("Host", "api.openai.com")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
        .body(())
        .map_err(|e| format!("build request: {}", e))?;

    // Bounded connect; a stop that arrives while connecting is honoured instead
    // of completing the handshake for a session nobody wants anymore.
    let (ws_stream, _) = tokio::select! {
        biased;
        _ = stop_rx.recv() => return Ok(()),
        res = tokio::time::timeout(CONNECT_TIMEOUT, connect_async(request)) => res
            .map_err(|_| format!("websocket connect: timed out after {}s", CONNECT_TIMEOUT.as_secs()))?
            .map_err(|e| format!("websocket connect: {}", e))?,
    };

    let (mut ws_sink, mut ws_stream) = ws_stream.split();

    // Send session.update once connected
    let session_update = build_session_update(&cfg);
    ws_sink
        .send(Message::Text(session_update.into()))
        .await
        .map_err(|e| format!("send session.update: {}", e))?;

    let _ = event_ch.send(OpenAiEvent::Status {
        state: "ready".into(),
        message: None,
    });

    loop {
        tokio::select! {
            biased;

            _ = stop_rx.recv() => {
                let _ = ws_sink.send(Message::Close(None)).await;
                break;
            }

            Some(audio_chunk) = audio_rx.recv() => {
                // Backlog policy for live translation: stay current. If the
                // socket fell behind by more than BACKLOG_SKIP_ABOVE (network
                // stall), skip the oldest chunks down to BACKLOG_KEEP and tell
                // the UI how much was dropped.
                if audio_rx.len() > BACKLOG_SKIP_ABOVE {
                    let mut dropped = 0usize;
                    while audio_rx.len() > BACKLOG_KEEP {
                        if audio_rx.try_recv().is_err() { break; }
                        dropped += 1;
                    }
                    let _ = event_ch.send(OpenAiEvent::Status {
                        state: "backlog_skipped".into(),
                        message: Some(format!("{:.1}", dropped as f32 * CHUNK_SECS)),
                    });
                }
                let b64 = B64.encode(&audio_chunk);
                let evt = serde_json::json!({
                    "type": "session.input_audio_buffer.append",
                    "audio": b64,
                });
                if let Err(e) = ws_sink.send(Message::Text(evt.to_string().into())).await {
                    return Err(format!("send audio: {}", e));
                }
            }

            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_server_event(&text, &event_ch, cfg.audio_output);
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Close(frame))) => {
                        let reason = frame
                            .map(|f| format!("{}: {}", f.code, f.reason))
                            .unwrap_or_else(|| "remote_close".into());
                        let _ = event_ch.send(OpenAiEvent::Closed { reason });
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(format!("ws error: {}", e)),
                    None => break,
                }
            }
        }
    }

    Ok(())
}

fn build_session_update(cfg: &OpenAiRealtimeConfig) -> String {
    // GA Realtime Translation schema (May 2026):
    // - WebSocket URL is /v1/realtime/translations?model=gpt-realtime-translate
    // - No voice / turn_detection at session level
    // - Input transcription uses gpt-realtime-whisper
    // - Output language goes under audio.output.language
    // The translation endpoint does NOT support text-only modality config —
    // both `session.modalities` and `session.output_modalities` are rejected.
    // For "mute", we drop output_audio events client-side instead (see
    // run_session — audio_output flag suppresses AudioChunk forwarding).
    let session = serde_json::json!({
        "audio": {
            "input": {
                "transcription": {"model": "gpt-realtime-whisper"},
                "noise_reduction": {"type": "near_field"}
            },
            "output": {"language": cfg.target_language}
        }
    });
    serde_json::json!({
        "type": "session.update",
        "session": session,
    })
    .to_string()
}

fn handle_server_event(text: &str, event_ch: &Channel<OpenAiEvent>, audio_output: bool) {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    let evt_type = match value.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };

    // Dev trace: log every event type (not the full payload — that's noisy)
    // so we can see the lifecycle around speech pauses and turn boundaries.
    eprintln!("[openai-realtime] event: {}", evt_type);

    match evt_type {
        "session.created" | "session.updated" => {
            // ack only
        }
        "session.input_transcript.delta" => {
            if let Some(delta) = value.get("delta").and_then(|v| v.as_str()) {
                let _ = event_ch.send(OpenAiEvent::SourceTranscript {
                    text: delta.into(),
                    is_final: false,
                });
            }
        }
        "session.input_transcript.done" | "session.input_audio_transcription.completed" => {
            // Whisper-side final for the input chunk. The `transcript` field
            // carries the full source text — use it as the authoritative source
            // (deltas can arrive at a different cadence than output translation
            // deltas, so accumulating deltas alone misaligns source/target pairs).
            let final_text = value
                .get("transcript")
                .and_then(|v| v.as_str())
                .or_else(|| value.get("text").and_then(|v| v.as_str()));
            if let Some(t) = final_text {
                let _ = event_ch.send(OpenAiEvent::SourceTranscript {
                    text: t.into(),
                    is_final: true,
                });
            }
        }
        "session.output_transcript.delta" => {
            if let Some(delta) = value.get("delta").and_then(|v| v.as_str()) {
                let _ = event_ch.send(OpenAiEvent::Transcript {
                    text: delta.into(),
                    is_final: false,
                });
            }
        }
        "session.output_transcript.done" => {
            if let Some(t) = value.get("transcript").and_then(|v| v.as_str()) {
                let _ = event_ch.send(OpenAiEvent::Transcript {
                    text: t.into(),
                    is_final: true,
                });
            }
        }
        "session.output_audio.delta" => {
            // Always forward; JS client gates playback via setMuted() so the
            // user can toggle mute live without restarting the session.
            let _ = audio_output; // unused — kept on signature for future server-side hint.
            if let Some(b64) = value.get("delta").and_then(|v| v.as_str()) {
                let _ = event_ch.send(OpenAiEvent::AudioChunk {
                    pcm_base64: b64.into(),
                });
            }
        }
        "session.closed" => {
            let _ = event_ch.send(OpenAiEvent::Closed {
                reason: "session.closed".into(),
            });
        }
        "error" => {
            let code = value
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let msg = value
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let _ = event_ch.send(OpenAiEvent::Error { code, message: msg });
        }
        other => {
            // Log unknown event types so we can discover server-side names we
            // haven't mapped yet (e.g. turn lifecycle around speech pauses).
            eprintln!(
                "[openai-realtime] unhandled event type: {} | payload: {}",
                other, text
            );
        }
    }
}
