mod audio;
mod commands;
mod local;
mod settings;

/// Bundle identifier, also the name of the one per-user folder that holds
/// everything the app stores (settings, sessions, models, voices):
/// `~/Library/Application Support/com.ttkien2035.meowlaoshi` on macOS.
/// Must equal `identifier` in tauri.conf.json (checked by a test).
pub(crate) const APP_ID: &str = "com.ttkien2035.meowlaoshi";

/// Test seams for QA / integration tests (`src-tauri/tests/*.rs`), which can
/// only reach public paths. Not an API for the app itself.
#[doc(hidden)]
pub mod test_api {
    /// P6 — mic DSP without cpal: `MicProcessor::new(rate, channels, &opts)`,
    /// then `process(&interleaved_f32, &mut s16le_out)`.
    pub use crate::audio::mic_pipeline::{MicOptions, MicProcessor};
    /// P1/P2/P5 — Local pipeline with a closure sink and an optional stub
    /// translator (`start_with_translator`).
    pub use crate::local::llm::TranslateRequest;
    /// X-ASR file layout inside an extracted model folder, and the
    /// `bpe.vocab` writer the hotword encoder needs.
    pub use crate::local::models::{ensure_bpe_vocab, AsrFiles};
    pub use crate::local::pipeline::{
        start_with_sink, start_with_translator, LocalEvent, Session, SessionConfig, Timing, Translator,
        TranslatorFactory, UTTERANCE_QUEUE_MAX,
    };
    /// P3 — settings load/save; point `MT_SETTINGS_DIR` at a scratch dir first.
    pub use crate::settings::Settings;
}

use audio::microphone::MicCapture;
use audio::SystemAudioCapture;
use commands::audio::AudioState;
use local::LocalState;
use commands::local_tts::LocalTtsState;
use commands::openai_realtime::OpenAiState;
use commands::qwen_realtime::QwenState;
use settings::{Settings, SettingsState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

// Set once the frontend has flushed the session (or the exit deadline elapsed),
// so the ExitRequested handler stops preventing exit and the app can quit.
static EXIT_ALLOWED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn get_platform_info() -> String {
    // `std::env::consts::ARCH` is the arch of THIS binary, not the CPU. On an
    // Apple Silicon Mac running the x64 build under Rosetta it reports
    // "x86_64", which wrongly blocked the Local MLX engine (MLX runs as a
    // separate native-ARM Python subprocess, so it works fine there).
    // Ask the hardware directly so detection is Rosetta-proof.
    let is_arm_hardware = is_apple_silicon_hardware();
    format!(
        r#"{{"os":"{}","arch":"{}","is_arm_hardware":{},"version":"{}"}}"#,
        std::env::consts::OS,
        std::env::consts::ARCH,
        is_arm_hardware,
        env!("CARGO_PKG_VERSION")
    )
}

/// True only on Apple Silicon hardware (macOS), even when the current process
/// is x86_64 under Rosetta. Uses `sysctl hw.optional.arm64`, which reads the
/// real CPU, not the process translation state. Non-macOS → false.
#[cfg(target_os = "macos")]
fn is_apple_silicon_hardware() -> bool {
    std::process::Command::new("sysctl")
        .args(["-n", "hw.optional.arm64"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn is_apple_silicon_hardware() -> bool {
    false
}

// Called by the frontend after it has flushed the session on exit. Force-exits
// the process; the flag keeps a subsequent ExitRequested from being prevented.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    EXIT_ALLOWED.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load settings from disk (or defaults)
    let initial_settings = Settings::load();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            // Dev builds (compiled with the `devtools` feature): auto-open the WebView
            // inspector so JS/console errors are visible. Never compiled into release.
            #[cfg(feature = "devtools")]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            Ok(())
        })
        .manage(SettingsState(Mutex::new(initial_settings)))
        .manage(AudioState {
            system_audio: Mutex::new(SystemAudioCapture::new()),
            microphone: Mutex::new(MicCapture::new()),
            active_receiver: Mutex::new(None),
        })
        .manage(LocalState::default())
        .manage(LocalTtsState::default())
        .manage(OpenAiState::default())
        .manage(QwenState::default())
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::audio::start_capture,
            commands::audio::stop_capture,
            commands::open_privacy_settings,
            commands::audio_models::audio_models_status,
            commands::audio_models::audio_models_download,
            commands::transcript::open_transcript_dir,
            commands::session_store::save_session,
            commands::session_store::list_sessions,
            commands::session_store::read_session,
            commands::session_store::read_legacy_session,
            commands::session_store::delete_session,
            commands::session_store::update_session_title,
            commands::session_store::export_session_srt,
            commands::session_store::export_session_txt,
            commands::session_store::search_sessions,
            local::local_start,
            local::local_send_audio,
            local::local_stop,
            local::models::local_models_status,
            local::models::local_models_download,
            commands::edge_tts::edge_tts_speak,
            commands::microsoft_tts::microsoft_list_voices,
            commands::google_free_tts::google_free_tts_speak,
            commands::tiktok_tts::tiktok_tts_speak,
            commands::local_tts::local_tts_speak,
            commands::local_tts::local_tts_list_models,
            commands::local_tts::local_tts_models_dir_path,
            commands::local_tts::local_tts_download_model,
            commands::local_tts::local_tts_delete_model,
            commands::openai_realtime::openai_realtime_start,
            commands::openai_realtime::openai_realtime_send_audio,
            commands::openai_realtime::openai_realtime_stop,
            commands::qwen_realtime::qwen_realtime_start,
            commands::qwen_realtime::qwen_realtime_send_audio,
            commands::qwen_realtime::qwen_realtime_stop,
            get_platform_info,
            exit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Cmd+Q and Dock → Quit fire app-level ExitRequested (not the
            // window's onCloseRequested). Prevent the first exit, ask the
            // frontend to flush the session, and force-exit after a deadline so
            // a hung flush can never make the app unquittable.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !EXIT_ALLOWED.load(Ordering::SeqCst) {
                    use tauri::{Emitter, Manager};
                    api.prevent_exit();
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.emit("app-exit-requested", ());
                    }
                    let handle = app_handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        EXIT_ALLOWED.store(true, Ordering::SeqCst);
                        handle.exit(0);
                    });
                }
            }
        });
}
