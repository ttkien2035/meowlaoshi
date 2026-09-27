//! Pure-Rust Local engine (offline): X-ASR recognition + Hy-MT2 translation.
//! Replaces the former Python/MLX sidecar. Commands mirror the cloud
//! realtime engines: start → raw-body audio → stop, events over a Channel.

pub mod asr;
pub mod llm;
pub mod models;
pub mod pipeline;
pub mod spm;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::ipc::{Channel, InvokeBody, Request as IpcRequest};
use tauri::State;

use crate::commands::audio_models;
use crate::settings::SettingsState;
use pipeline::{LocalEvent, Session, SessionConfig};

#[derive(Default)]
pub struct LocalState {
    sessions: Mutex<HashMap<u64, Session>>,
    next_id: Mutex<u64>,
}

#[derive(Deserialize)]
pub struct GlossaryPair {
    pub source: String,
    pub target: String,
}

#[derive(Deserialize)]
pub struct LocalStartConfig {
    /// ISO code as used elsewhere in the app ("zh", "auto", …).
    pub source_language: String,
    pub target_language: String,
    /// Active course profile glossary; only entries found in a sentence are
    /// put into that sentence's prompt.
    #[serde(default)]
    pub glossary: Vec<GlossaryPair>,
}

/// Language name for the translation prompt.
fn lang_name(code: &str) -> &'static str {
    match code {
        "zh" | "zh-CN" | "zh-TW" | "yue" => "Chinese",
        "vi" => "Vietnamese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "fr" => "French",
        "de" => "German",
        "es" => "Spanish",
        "ru" => "Russian",
        "th" => "Thai",
        _ => "the source language",
    }
}

#[tauri::command]
pub async fn local_start(
    config: LocalStartConfig,
    on_event: Channel<LocalEvent>,
    state: State<'_, LocalState>,
    settings: State<'_, SettingsState>,
) -> Result<u64, String> {
    let custom_gguf = settings
        .0
        .lock()
        .map(|s| s.local_llm_gguf.clone())
        .unwrap_or_default();

    let asr = models::asr_files()
        .ok_or("models_missing: model nhận dạng (X-ASR) chưa được tải (Cài đặt › Model › Local)")?;
    let llm_model = models::llm_path(&custom_gguf)
        .ok_or("models_missing: model dịch (GGUF) chưa được tải (Cài đặt › Model › Local)")?;
    let vad_model = audio_models::installed_path(audio_models::SILERO_VAD_ID)
        .ok_or("models_missing: Silero VAD chưa được tải (Cài đặt › Micro › Tải model)")?;

    let session = pipeline::start_with_sink(
        SessionConfig {
            asr,
            llm_model,
            vad_model,
            source_lang_name: lang_name(&config.source_language).to_string(),
            target_lang_name: lang_name(&config.target_language).to_string(),
            glossary: config
                .glossary
                .into_iter()
                .filter(|g| !g.source.trim().is_empty() && !g.target.trim().is_empty())
                .map(|g| (g.source.trim().to_string(), g.target.trim().to_string()))
                .collect(),
            timing: Default::default(),
        },
        Box::new(move |event| {
            let _ = on_event.send(event);
        }),
    )?;

    let id = {
        let mut next = state.next_id.lock().map_err(|e| e.to_string())?;
        *next += 1;
        *next
    };
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);
    Ok(id)
}

/// Hot path: raw s16le 16 kHz body, session id in `x-session-id`.
#[tauri::command]
pub fn local_send_audio(
    request: IpcRequest<'_>,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    let id = crate::commands::session_id_from_headers(request.headers())?;
    let pcm = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("expected raw PCM body".into()),
    };
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("Session {id} not found"))?;
    session.push_audio(pcm.clone())
}

/// Stop: dropping the session unwinds both workers and frees the models.
#[tauri::command]
pub async fn local_stop(session_id: u64, state: State<'_, LocalState>) -> Result<(), String> {
    let removed = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id);
    if let Some(session) = removed {
        // The LLM thread may be mid-sentence; drop off the async runtime.
        let _ = tauri::async_runtime::spawn_blocking(move || drop(session)).await;
    }
    Ok(())
}
