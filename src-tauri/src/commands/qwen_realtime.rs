// Qwen LiveTranslate Flash realtime translation provider — backend WS bridge.
//
// Mirrors `my-translator-mobile` v0.4.3 client (see
// my-translator-mobile/src/engines/qwen-realtime-client.ts).
//
// Key facts:
//   - WS URL: dashscope-intl + ?model=qwen3-livetranslate-flash-realtime
//   - Audio in: pcm16 @ 16kHz mono (no resampling — Soniox pipeline native rate)
//   - Server-VAD only. Manual input_audio_buffer.commit / response.create are
//     rejected by Live Flash — server segments turns on its own.
//   - Text-only modality. No TTS playback (would loop back into mic).
//   - Source language MUST be explicit. "auto" falls back to "en" — Live Flash
//     auto-detect stalls after a single segment on real-device mic input.
//   - No source transcript: Live Flash only exposes translation. Drop dual-panel
//     source side when this engine is active.
//
// Event mapping (verified via mobile probe 2026-05-25):
//   response.text.text  → Transcript(is_final=false, text=committed+stash)
//   response.text.done  → Transcript(is_final=true,  text=final)
//   error               → Error

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

const QWEN_REALTIME_BASE: &str = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime";
const QWEN_DEFAULT_MODEL: &str = "qwen3-livetranslate-flash-realtime";
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
    let m = if cleaned.is_empty() { QWEN_DEFAULT_MODEL } else { cleaned.as_str() };
    format!("{}?model={}", QWEN_REALTIME_BASE, m)
}

#[derive(Debug, Deserialize)]
pub struct QwenRealtimeConfig {
    pub api_key: String,
    /// Realtime model id (Settings → Model). Empty → default.
    #[serde(default)]
    pub model: String,
    /// BCP-47-ish code (e.g. "en", "ja"). "auto" or empty → fallback "en".
    pub source_language: String,
    /// BCP-47-ish code (e.g. "vi"). Sent as `translation.language`.
    pub target_language: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QwenEvent {
    Status {
        state: String,
        message: Option<String>,
    },
    Transcript {
        text: String,
        is_final: bool,
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
}

#[derive(Default)]
pub struct QwenState {
    sessions: Mutex<HashMap<u64, Session>>,
    next_id: Mutex<u64>,
}

#[tauri::command]
pub async fn qwen_realtime_start(
    config: QwenRealtimeConfig,
    on_event: Channel<QwenEvent>,
    state: State<'_, QwenState>,
) -> Result<u64, String> {
    if config.api_key.trim().is_empty() {
        return Err("Qwen (DashScope) API key is empty".into());
    }

    let session_id = {
        let mut id = state.next_id.lock().unwrap();
        *id += 1;
        *id
    };

    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>(AUDIO_QUEUE_CHUNKS);
    let (stop_tx, stop_rx) = mpsc::unbounded_channel::<()>();

    let session = Session { audio_tx, stop_tx };
    state.sessions.lock().unwrap().insert(session_id, session);

    let event_ch = on_event.clone();

    tokio::spawn(async move {
        let _ = event_ch.send(QwenEvent::Status {
            state: "connecting".into(),
            message: None,
        });

        if let Err(e) = run_session(config, audio_rx, stop_rx, event_ch.clone()).await {
            let _ = event_ch.send(QwenEvent::Error {
                code: "session_failed".into(),
                message: e,
            });
        }

        let _ = event_ch.send(QwenEvent::Closed {
            reason: "session_ended".into(),
        });
    });

    Ok(session_id)
}

/// Hot path (5×/s). PCM arrives as the raw invoke body — no JSON number array
/// to serialize/parse — with the session id in the `x-session-id` header.
#[tauri::command]
pub async fn qwen_realtime_send_audio(
    request: IpcRequest<'_>,
    state: State<'_, QwenState>,
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

    match session.audio_tx.try_send(pcm.clone()) {
        Ok(()) => Ok(()),
        // Real-time audio: if the socket can't keep up, dropping the newest
        // chunk beats unbounded memory growth.
        Err(mpsc::error::TrySendError::Full(_)) => {
            eprintln!("[qwen] audio queue full — dropping chunk");
            Ok(())
        }
        Err(mpsc::error::TrySendError::Closed(_)) => Err("session closed".into()),
    }
}

#[tauri::command]
pub async fn qwen_realtime_stop(
    session_id: u64,
    state: State<'_, QwenState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.remove(&session_id) {
        let _ = session.stop_tx.send(());
    }
    Ok(())
}

async fn run_session(
    cfg: QwenRealtimeConfig,
    mut audio_rx: mpsc::Receiver<Vec<u8>>,
    mut stop_rx: mpsc::UnboundedReceiver<()>,
    event_ch: Channel<QwenEvent>,
) -> Result<(), String> {
    let request = Request::builder()
        .uri(realtime_url(&cfg.model))
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .header("Host", "dashscope-intl.aliyuncs.com")
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

    let session_update = build_session_update(&cfg);
    ws_sink
        .send(Message::Text(session_update.into()))
        .await
        .map_err(|e| format!("send session.update: {}", e))?;

    let _ = event_ch.send(QwenEvent::Status {
        state: "ready".into(),
        message: None,
    });

    // Guard: response.text.done can fire twice for one response when both text
    // and audio_transcript streams complete. With modalities=["text"] this
    // shouldn't happen, but keep the guard — cheap insurance, matches mobile.
    let mut last_done_response_id: Option<String> = None;

    loop {
        tokio::select! {
            biased;

            _ = stop_rx.recv() => {
                let _ = ws_sink.send(Message::Close(None)).await;
                break;
            }

            Some(pcm) = audio_rx.recv() => {
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
                    let _ = event_ch.send(QwenEvent::Status {
                        state: "backlog_skipped".into(),
                        message: Some(format!("{:.1}", dropped as f32 * CHUNK_SECS)),
                    });
                }
                let b64 = B64.encode(&pcm);
                let evt = serde_json::json!({
                    "type": "input_audio_buffer.append",
                    "audio": b64,
                });
                if let Err(e) = ws_sink.send(Message::Text(evt.to_string().into())).await {
                    return Err(format!("send audio: {}", e));
                }
            }

            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_server_event(&text, &event_ch, &mut last_done_response_id);
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Close(frame))) => {
                        let reason = frame
                            .map(|f| format!("{}: {}", f.code, f.reason))
                            .unwrap_or_else(|| "remote_close".into());
                        let _ = event_ch.send(QwenEvent::Closed { reason });
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

fn build_session_update(cfg: &QwenRealtimeConfig) -> String {
    // Live Flash rejects "auto" for source. Empty / "auto" → "en" fallback
    // (mirrors mobile client onopen handler).
    let source = if cfg.source_language.is_empty() || cfg.source_language == "auto" {
        "en"
    } else {
        cfg.source_language.as_str()
    };

    let session = serde_json::json!({
        "modalities": ["text"],
        "input_audio_format": "pcm",
        "input_audio_transcription": { "language": source },
        "translation": { "language": cfg.target_language },
        // VAD is server-side — manual commits rejected on Live Flash.
        "turn_detection": serde_json::Value::Null,
    });

    serde_json::json!({
        "type": "session.update",
        "session": session,
    })
    .to_string()
}

fn handle_server_event(
    text: &str,
    event_ch: &Channel<QwenEvent>,
    last_done_response_id: &mut Option<String>,
) {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    let evt_type = match value.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };

    eprintln!("[qwen-livetranslate] event: {}", evt_type);

    match evt_type {
        "session.created" | "session.updated" | "response.created" | "response.done" => {}

        "response.text.text" => {
            // Live Flash streams via text (committed) + stash (pending).
            // Full provisional snapshot = text + stash. Emit on every tick.
            let committed = value.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let stash = value.get("stash").and_then(|v| v.as_str()).unwrap_or("");
            let snapshot = format!("{}{}", committed, stash);
            if !snapshot.is_empty() {
                let _ = event_ch.send(QwenEvent::Transcript {
                    text: snapshot,
                    is_final: false,
                });
            }
        }

        "response.text.done" => {
            let response_id = value
                .get("response_id")
                .and_then(|v| v.as_str())
                .or_else(|| value.get("item_id").and_then(|v| v.as_str()))
                .map(|s| s.to_string());

            if let (Some(rid), Some(last)) = (response_id.as_ref(), last_done_response_id.as_ref())
            {
                if rid == last {
                    return;
                }
            }
            *last_done_response_id = response_id;

            let t = value.get("text").and_then(|v| v.as_str());
            if let Some(t) = t {
                eprintln!(
                    "[qwen-livetranslate] DONE: {}",
                    t.chars().take(120).collect::<String>()
                );
                let _ = event_ch.send(QwenEvent::Transcript {
                    text: t.into(),
                    is_final: true,
                });
            }
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
            let _ = event_ch.send(QwenEvent::Error { code, message: msg });
        }

        _ => {}
    }
}
