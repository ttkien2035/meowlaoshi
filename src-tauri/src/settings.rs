use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Translation term: source → target mapping for Soniox
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationTerm {
    pub source: String,
    pub target: String,
}

/// General context pair for Soniox (`{key: "domain", value: "finance"}`).
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

/// Context for Soniox — domain hints, transcription terms and a glossary.
/// Mirrors the Soniox `context` object so nothing the UI edits is dropped
/// on save (the old struct kept only `domain` + `translation_terms`).
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomContext {
    /// Legacy single domain string from older settings files; superseded by `general`.
    pub domain: Option<String>,
    pub general: Vec<KeyValue>,
    /// Domain words that help transcription (source language).
    pub terms: Vec<String>,
    /// Free-form background text.
    pub text: Option<String>,
    /// Glossary: source → target pairs the translation must respect.
    pub translation_terms: Vec<TranslationTerm>,
}

/// A course profile: one context (glossary, domain, background) per subject,
/// switchable between lectures.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CourseProfile {
    pub id: String,
    pub name: String,
    pub context: CustomContext,
}

/// App settings — persisted to JSON
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Soniox API key
    pub soniox_api_key: String,
    /// OpenAI API key (for gpt-realtime-translate)
    pub openai_api_key: String,
    /// Alibaba Cloud DashScope API key (for Qwen LiveTranslate Flash)
    #[serde(default)]
    pub qwen_api_key: String,
    /// Source language: "auto" or ISO 639-1 code
    pub source_language: String,
    /// Target language: ISO 639-1 code
    pub target_language: String,
    /// Audio source: "system" | "microphone" | "both"
    pub audio_source: String,
    /// Font size in px
    pub font_size: u32,
    /// UI theme: "light" (default) | "dark" | "system".
    pub theme: String,
    /// Max transcript lines to display
    pub max_lines: u32,
    /// Translation mode: "soniox" | "local" | "openai"
    pub translation_mode: String,
    /// Legacy session-wide context; migrated into the "default" course
    /// profile by the frontend on first run.
    pub custom_context: Option<CustomContext>,
    /// Course profiles (Settings › Engine dịch › Hồ sơ môn học).
    pub profiles: Vec<CourseProfile>,
    /// Id of the profile whose context is sent to Soniox; empty = first.
    pub active_profile: String,
    /// ElevenLabs API key for TTS narration
    pub elevenlabs_api_key: String,
    /// Whether TTS narration is enabled
    pub tts_enabled: bool,
    /// TTS provider: "edge" | "microsoft" | "google-free" | "tiktok" | "google" | "elevenlabs"
    pub tts_provider: String,
    /// ElevenLabs voice ID
    pub tts_voice_id: String,
    /// TTS speed multiplier (Web Speech)
    pub tts_speed: f64,
    /// Edge TTS voice name
    pub edge_tts_voice: String,
    /// Edge TTS speed percentage
    pub edge_tts_speed: i32,
    /// Auto-read new translations aloud
    pub tts_auto_read: bool,
    /// Google Cloud TTS API key
    pub google_tts_api_key: String,
    /// Google TTS voice name
    pub google_tts_voice: String,
    /// Google TTS speaking rate
    pub google_tts_speed: f64,
    /// Microsoft v2 (Edge endpoint, dynamic voice list) selected voice
    pub microsoft_v2_voice: String,
    /// Microsoft v2 speed percentage (reuses edge synth)
    pub microsoft_v2_speed: i32,
    /// Google Free (android-tts) language token, e.g. "vi-VN" | "en-US"
    pub google_free_voice: String,
    /// Optional user Google API key for Google Free. When set, overrides the build-time
    /// GOOGLE_FREE_TTS_KEY. Empty → fall back to the build-time key (if any).
    #[serde(default)]
    pub google_free_api_key: String,
    /// Google Free client-side playback speed (endpoint has no rate param). 1.0 = normal.
    #[serde(default = "default_local_tts_speed")]
    pub google_free_speed: f32,
    /// TikTok TTS speaker code, e.g. "BV074_streaming"
    pub tiktok_voice: String,
    /// TikTok client-side playback speed (endpoint has no rate param). 1.0 = normal.
    #[serde(default = "default_local_tts_speed")]
    pub tiktok_speed: f32,
    /// TikTok sessionid cookie (user-supplied; required by the endpoint)
    pub tiktok_session_id: String,
    /// Local offline (Piper/sherpa-onnx) selected voice id, e.g. "vi_VN-vais1000-medium"
    #[serde(default)]
    pub local_tts_voice: String,
    /// Local offline TTS speed (1.0 = normal). Piper length-scale is applied inversely.
    #[serde(default = "default_local_tts_speed")]
    pub local_tts_speed: f32,
    /// Folder where local TTS models are stored; empty = default app-data location.
    #[serde(default)]
    pub local_tts_models_dir: String,
    /// OpenAI Realtime: when true server generates translated audio.
    /// Default false — speaker → mic feedback loop on shared devices.
    #[serde(default)]
    pub openai_audio_output: bool,

    // ── Model selection (Settings → Model tab) ──
    /// Soniox real-time STT model, e.g. "stt-rt-v5".
    pub soniox_model: String,
    /// OpenAI realtime translation model (query param of the WS URL).
    pub openai_model: String,
    /// Qwen (DashScope) realtime translation model (query param of the WS URL).
    pub qwen_model: String,
    /// Helper LLM (OpenAI-compatible chat API) for academic re-translation,
    /// summaries, etc. Preset id: "deepseek" | "dashscope" | "zhipu" | "openai" | "custom".
    pub llm_provider: String,
    /// Base URL of the OpenAI-compatible endpoint (without /chat/completions).
    pub llm_base_url: String,
    pub llm_api_key: String,
    pub llm_model: String,
    /// Local engine: custom GGUF path overriding the bundled Qwen download.
    pub local_llm_gguf: String,
    /// The first-run engine picker has been answered. Fresh installs start
    /// `false` (see `Default`); a settings file written before this field
    /// existed belongs to someone who already chose, so it loads as `true`.
    #[serde(default = "engine_picker_done_for_existing_file")]
    pub engine_picker_done: bool,

    // ── Soniox session (Settings › Engine dịch). These were saved by the
    // form but missing here, so serde dropped them on every save. ──
    /// `max_endpoint_delay_ms`: how long Soniox may wait before closing a
    /// sentence. 1500 measured best on a real lecture: translation lag
    /// 0.79 s median (p90 1.0 s) vs 1.51 s (p90 3.2 s) at the old 3000, same
    /// accuracy; 500 chops sentences and is slower.
    #[serde(default = "default_endpoint_delay")]
    pub endpoint_delay: u32,
    /// "one_way" | "two_way".
    #[serde(default = "default_translation_type")]
    pub translation_type: String,
    /// Two-way pair.
    #[serde(default = "default_language_a")]
    pub language_a: String,
    #[serde(default = "default_language_b")]
    pub language_b: String,
    #[serde(default)]
    pub language_hints_strict: bool,

    // ── Microphone chain (Settings → Micro) ──
    /// macOS: capture via Apple's Voice-Processing I/O unit (system AEC/NS/AGC).
    pub mic_voice_processing: bool,
    /// 80 Hz high-pass (rumble / handling noise).
    pub mic_highpass: bool,
    /// Software AGC: lifts a distant speaker to a steady level.
    pub mic_agc: bool,
    /// GTCRN denoiser (needs the downloaded model; ignored otherwise).
    pub mic_denoise: bool,
    /// Silero VAD gate: send only speech (saves STT cost; needs the model).
    pub mic_vad: bool,
    /// Bumped when a default changes for existing installs; files below the
    /// current value get `migrated()` applied on load.
    #[serde(default)]
    pub settings_schema: u32,
}

/// 2: GTCRN and AGC off by default (2026-09-26).
const SETTINGS_SCHEMA: u32 = 2;

impl Default for Settings {
    fn default() -> Self {
        Self {
            soniox_api_key: String::new(),
            openai_api_key: String::new(),
            qwen_api_key: String::new(),
            // Personal default: in-person Mandarin lectures → Vietnamese, via mic.
            source_language: "zh".to_string(),
            target_language: "vi".to_string(),
            audio_source: "microphone".to_string(),
            font_size: 18,
            theme: "light".to_string(),
            max_lines: 5,
            translation_mode: "soniox".to_string(),
            custom_context: None,
            profiles: Vec::new(),
            active_profile: String::new(),
            elevenlabs_api_key: String::new(),
            tts_enabled: false,
            tts_provider: "edge".to_string(),
            tts_voice_id: "21m00Tcm4TlvDq8ikWAM".to_string(),
            tts_speed: 1.2,
            edge_tts_voice: "vi-VN-HoaiMyNeural".to_string(),
            edge_tts_speed: 50,
            tts_auto_read: true,
            google_tts_api_key: String::new(),
            google_tts_voice: "vi-VN-Chirp3-HD-Aoede".to_string(),
            google_tts_speed: 1.0,
            microsoft_v2_voice: "vi-VN-HoaiMyNeural".to_string(),
            microsoft_v2_speed: 20,
            google_free_voice: "vi-VN".to_string(),
            google_free_api_key: String::new(),
            google_free_speed: 1.0,
            tiktok_voice: "BV074_streaming".to_string(),
            tiktok_speed: 1.0,
            tiktok_session_id: String::new(),
            local_tts_voice: "vi_VN-vais1000-medium".to_string(),
            local_tts_speed: 1.0,
            local_tts_models_dir: String::new(),
            openai_audio_output: false,
            soniox_model: "stt-rt-v5".to_string(),
            openai_model: "gpt-realtime-translate".to_string(),
            qwen_model: "qwen3-livetranslate-flash-realtime".to_string(),
            llm_provider: "deepseek".to_string(),
            llm_base_url: String::new(),
            llm_api_key: String::new(),
            llm_model: String::new(),
            local_llm_gguf: String::new(),
            engine_picker_done: false,
            mic_voice_processing: false,
            mic_highpass: true,
            // Both measured harmful on lecture audio (see Settings › Micro hint).
            mic_agc: false,
            mic_denoise: false,
            mic_vad: false,
            settings_schema: SETTINGS_SCHEMA,
            endpoint_delay: default_endpoint_delay(),
            translation_type: default_translation_type(),
            language_a: default_language_a(),
            language_b: default_language_b(),
            language_hints_strict: false,
        }
    }
}

/// Serde default for `engine_picker_done` when the field is missing from an
/// existing settings file (see the field's doc).
fn engine_picker_done_for_existing_file() -> bool {
    true
}

/// Serde default for `local_tts_speed` (field-level default would give 0.0).
fn default_local_tts_speed() -> f32 {
    1.0
}

fn default_endpoint_delay() -> u32 {
    1500
}

fn default_translation_type() -> String {
    "one_way".to_string()
}

fn default_language_a() -> String {
    "zh".to_string()
}

fn default_language_b() -> String {
    "vi".to_string()
}

/// Get the settings file path:
/// `$MT_SETTINGS_DIR/settings.json` when that env var is set (tests/QA work
/// in a scratch dir without touching real settings), otherwise
/// ~/Library/Application Support/<APP_ID>/settings.json
fn settings_path() -> PathBuf {
    let dir = match std::env::var_os("MT_SETTINGS_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(crate::APP_ID),
    };
    dir.join("settings.json")
}

impl Settings {
    /// Load settings from disk, or return defaults.
    /// A corrupt/truncated main file falls back to the `.bak` written by the
    /// last save, so a crash mid-write never silently wipes API keys.
    pub fn load() -> Self {
        let path = settings_path();
        match Self::load_from(&path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "[settings] cannot load {}: {} — trying backup",
                    path.display(),
                    e
                );
                match Self::load_from(&backup_path(&path)) {
                    Ok(s) => s,
                    Err(e2) => {
                        eprintln!("[settings] backup unusable ({}); using defaults", e2);
                        Self::default()
                    }
                }
            }
        }
    }

    fn load_from(path: &std::path::Path) -> Result<Self, String> {
        if !path.exists() {
            return Err("file does not exist".to_string());
        }
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str::<Self>(&content)
            .map(Self::migrated)
            .map_err(|e| e.to_string())
    }

    /// Apply default changes that older files should pick up.
    fn migrated(mut self) -> Self {
        if self.settings_schema < 2 {
            // GTCRN doubled recognition errors in a reverberant classroom with
            // student babble (16.6 % → 33.6 %), AGC gave no gain even on
            // audio 20 dB too quiet; both had been on by default.
            self.mic_denoise = false;
            self.mic_agc = false;
        }
        self.settings_schema = SETTINGS_SCHEMA;
        self
    }

    /// Save settings to disk atomically (tmp + fsync + rename), keeping the
    /// previous file as `.bak`.
    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize: {}", e))?;

        // Back up the current file only if it is itself valid: after loading
        // from `.bak` because the main file was corrupt, copying the corrupt
        // file over the good backup would destroy the last good copy.
        // Best effort: a failed backup must not block saving.
        if Self::load_from(&path).is_ok() {
            let _ = fs::copy(&path, backup_path(&path));
        }

        let tmp = path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut f = fs::File::create(&tmp)
                .map_err(|e| format!("Failed to create tmp settings: {}", e))?;
            f.write_all(json.as_bytes())
                .map_err(|e| format!("Failed to write settings: {}", e))?;
            f.sync_all()
                .map_err(|e| format!("Failed to fsync settings: {}", e))?;
        }
        fs::rename(&tmp, &path).map_err(|e| format!("Failed to replace settings: {}", e))?;

        Ok(())
    }
}

fn backup_path(path: &std::path::Path) -> std::path::PathBuf {
    path.with_extension("json.bak")
}

/// Thread-safe settings state managed by Tauri
pub struct SettingsState(pub Mutex<Settings>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_picker_done_defaults() {
        // Fresh install: no file → Default → the picker shows once.
        assert!(!Settings::default().engine_picker_done);
        // A file written before the field existed: the user already chose.
        let legacy: Settings = serde_json::from_str(r#"{"translation_mode":"local"}"#).unwrap();
        assert!(legacy.engine_picker_done);
        assert_eq!(legacy.translation_mode, "local");
        // Theme defaults to light for new and pre-theme settings files; the
        // removed overlay_opacity / show_original fields are simply ignored.
        assert_eq!(Settings::default().theme, "light");
        let old: Settings = serde_json::from_str(r#"{"overlay_opacity":0.85,"show_original":true,"font_size":16}"#).unwrap();
        assert_eq!(old.theme, "light");
        assert_eq!(old.font_size, 16, "a user's own font size is kept");
        // Explicit value round-trips.
        let explicit: Settings = serde_json::from_str(r#"{"engine_picker_done":false}"#).unwrap();
        assert!(!explicit.engine_picker_done);
    }

    #[test]
    fn soniox_session_fields_round_trip() {
        // Fresh and pre-existing files get the measured default…
        assert_eq!(Settings::default().endpoint_delay, 1500);
        let old: Settings = serde_json::from_str(r#"{"translation_mode":"soniox"}"#).unwrap();
        assert_eq!((old.endpoint_delay, old.translation_type.as_str(), old.language_a.as_str(), old.language_b.as_str()), (1500, "one_way", "zh", "vi"));
        // …and what the form saves now survives a save/load.
        let s = Settings {
            endpoint_delay: 1000,
            translation_type: "two_way".into(),
            language_hints_strict: true,
            ..Default::default()
        };
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!((back.endpoint_delay, back.translation_type.as_str(), back.language_hints_strict), (1000, "two_way", true));
    }

    #[test]
    fn app_id_matches_tauri_config() {
        // Settings/models live under APP_ID while Tauri derives sessions and
        // WebView storage from tauri.conf.json: the two must never diverge.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], crate::APP_ID);
    }

    #[test]
    fn mic_defaults_migrate_once() {
        let d = Settings::default();
        assert!(!d.mic_denoise && !d.mic_agc && d.mic_highpass);
        assert_eq!(d.settings_schema, SETTINGS_SCHEMA);
        // A pre-schema file with the old defaults on: turned off once.
        let old: Settings = serde_json::from_str(r#"{"mic_denoise":true,"mic_agc":true,"mic_highpass":false}"#).unwrap();
        let old = old.migrated();
        assert!(!old.mic_denoise && !old.mic_agc);
        assert!(!old.mic_highpass, "unrelated choices are kept");
        assert_eq!(old.settings_schema, SETTINGS_SCHEMA);
        // A current file where the user turned them back on: left alone.
        let cur: Settings = serde_json::from_str(r#"{"settings_schema":2,"mic_denoise":true,"mic_agc":true}"#).unwrap();
        let cur = cur.migrated();
        assert!(cur.mic_denoise && cur.mic_agc);
    }
}
