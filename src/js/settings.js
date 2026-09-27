/**
 * Settings Manager — handles loading/saving settings via Tauri IPC
 */

const { invoke } = window.__TAURI__.core;

// Default settings shape
const DEFAULT_SETTINGS = {
  soniox_api_key: '',
  openai_api_key: '',
  qwen_api_key: '',
  source_language: 'zh',
  target_language: 'vi',
  audio_source: 'microphone',
  font_size: 18,
  // 'light' (default) | 'dark' | 'system'
  theme: 'light',
  max_lines: 5,
  translation_mode: 'soniox',
  custom_context: null,
  // Course profiles: [{ id, name, context: { general, terms, text, translation_terms } }]
  profiles: [],
  active_profile: '',
  elevenlabs_api_key: '',
  tts_enabled: false,
  tts_provider: 'edge',
  tts_voice_id: '21m00Tcm4TlvDq8ikWAM',
  tts_speed: 1.2,
  edge_tts_voice: 'vi-VN-HoaiMyNeural',
  edge_tts_speed: 50,
  tts_auto_read: true,
  // Google Cloud (premium) — kept for parity with backend defaults
  google_tts_api_key: '',
  google_tts_voice: 'vi-VN-Chirp3-HD-Aoede',
  google_tts_speed: 1.0,
  // New free online providers (Trudio-style)
  microsoft_v2_voice: 'vi-VN-HoaiMyNeural',
  microsoft_v2_speed: 20,
  google_free_voice: 'vi-VN',
  google_free_api_key: '',
  google_free_speed: 1.0,
  tiktok_voice: 'BV074_streaming',
  tiktok_speed: 1.0,
  tiktok_session_id: '',
  // Local offline (Piper/sherpa-onnx)
  local_tts_voice: 'vi_VN-vais1000-medium',
  local_tts_speed: 1.0,
  local_tts_models_dir: '',
  // Settings → Model tab (mirror settings.rs defaults)
  soniox_model: 'stt-rt-v5',
  openai_model: 'gpt-realtime-translate',
  qwen_model: 'qwen3-livetranslate-flash-realtime',
  llm_provider: 'deepseek',
  llm_base_url: '',
  llm_api_key: '',
  llm_model: '',
  local_llm_gguf: '',
  // First-run engine picker answered (Rust: fresh install false, existing file true)
  engine_picker_done: false,
  // Settings → Micro (mirror settings.rs defaults)
  mic_voice_processing: false,
  mic_highpass: true,
  mic_agc: false,
  mic_denoise: false,
  mic_vad: false,
  // Soniox session (mirror settings.rs)
  endpoint_delay: 1500,
  translation_type: 'one_way',
  language_a: 'zh',
  language_b: 'vi',
  language_hints_strict: false,
};

class SettingsManager {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this._listeners = [];
  }

  /**
   * Load settings from Rust backend
   */
  async load() {
    try {
      const settings = await invoke('get_settings');
      this.settings = { ...DEFAULT_SETTINGS, ...settings };
    } catch (err) {
      console.error('Failed to load settings:', err);
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this._notify();
    return this.settings;
  }

  /**
   * Save settings to Rust backend
   */
  async save(newSettings) {
    try {
      const merged = { ...this.settings, ...newSettings };
      await invoke('save_settings', { newSettings: merged });
      this.settings = merged;
      this._notify();
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      throw err;
    }
  }

  /**
   * Get current settings (cached)
   */
  get() {
    return { ...this.settings };
  }

  /**
   * Subscribe to settings changes
   */
  onChange(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  _notify() {
    const settings = this.get();
    this._listeners.forEach(cb => cb(settings));
  }
}

// Singleton
export const settingsManager = new SettingsManager();
