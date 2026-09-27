/**
 * App — main application controller
 * Wires together: settings, UI, Soniox client, and audio capture
 */

import { settingsManager } from './settings.js';
import { openDialog, ensureOfflinePack, downloadOfflinePack, offlinePackStatus, askApiKey, showMicPermissionDialog, MicSilenceWatch, runFirstRunWizard } from './onboarding.js';
import { TranscriptUI } from './ui.js';
import { sonioxClient } from './soniox.js';
import { elevenLabsTTS } from './elevenlabs-tts.js';
import { googleTTS } from './google-tts.js';
import { edgeTTSRust } from './edge-tts.js';
import { microsoftTTS } from './microsoft-tts.js';
import { googleFreeTTS } from './google-free-tts.js';
import { tiktokTTS } from './tiktok-tts.js';
import { localTTS } from './local-tts.js';

// ─── Settings → Model tab: presets ────────────────────────────
// Default model ids per real-time engine (must match settings.rs defaults).
const MODEL_DEFAULTS = {
    soniox: 'stt-rt-v5',
    qwen: 'qwen3-livetranslate-flash-realtime',
    openai: 'gpt-realtime-translate',
};
// Helper LLM presets — all OpenAI-compatible (/chat/completions). The user can
// edit the base URL and type any model id via "Tuỳ chỉnh…".
const LLM_PRESETS = {
    deepseek: {
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        hint: 'Rẻ, truy cập tốt từ Trung Quốc. Key tại platform.deepseek.com',
    },
    dashscope: {
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
        hint: 'Dùng chung key DashScope với engine Qwen. Bản trong nước: https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    zhipu: {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: ['glm-4-flash', 'glm-4-plus'],
        hint: 'glm-4-flash miễn phí. Key tại bigmodel.cn',
    },
    openai: {
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-4o-mini', 'gpt-4o'],
        hint: 'Cần VPN khi ở Trung Quốc.',
    },
    custom: {
        baseUrl: '',
        models: [],
        hint: 'Bất kỳ endpoint chuẩn OpenAI (…/v1 → gọi /chat/completions).',
    },
};
import { audioPlayer, readAudioPlayer } from './audio-player.js';
import { Reader } from './reader.js';
import { updater } from './updater.js';
import { sessionStore } from './session-store.js';
import { StudyView } from './study-view.js';
import { applyTheme, getResolvedTheme } from './theme.js';
import { QWEN_LANGS } from './qwen-langs.js';
// Platform class before first paint so the toolbar never jumps: macOS gets
// room for the native traffic lights (see main.css "macOS window chrome").
if (navigator.userAgent.includes('Mac OS X')) document.documentElement.classList.add('platform-macos');

// No browser context menu (Reload / Inspect Element) on app chrome — only
// where text lives, so Copy/Paste/Look Up keep working there.
document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea, [contenteditable], #transcript-content, #session-viewer-content, #study-list')) {
        e.preventDefault();
    }
});

import { initShell, setActivity, getActivity, setLiveBadge, bindMenu, initWindowModes, startAutoHideWatch, stopAutoHideWatch, toggleManualCompact, isAutoHideEnabled, setAutoHideEnabled, getWindowMode } from './ui-shell.js';

const { invoke, Channel } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

// Static fallback for Microsoft v2 voices when the live list endpoint is unreachable.
const MS_VOICE_FALLBACK = [
    { short_name: 'vi-VN-HoaiMyNeural', friendly_name: 'HoaiMy', gender: 'Female', locale: 'vi-VN' },
    { short_name: 'vi-VN-NamMinhNeural', friendly_name: 'NamMinh', gender: 'Male', locale: 'vi-VN' },
    { short_name: 'en-US-JennyNeural', friendly_name: 'Jenny', gender: 'Female', locale: 'en-US' },
    { short_name: 'en-US-GuyNeural', friendly_name: 'Guy', gender: 'Male', locale: 'en-US' },
];

class App {
    constructor() {
        this.isRunning = false;
        this.isStarting = false; // Guard against re-entry
        this.currentSource = 'system'; // 'system' | 'microphone' | 'both'
        this.translationMode = 'soniox'; // 'soniox' | 'local'
        this.transcriptUI = null;
        this.appWindow = getCurrentWindow();
        this.localClient = null;       // LocalEngineClient while a Local session runs
        this.localPipelineReady = false;
        this.recordingStartTime = null;
        this.sessionStartTime = null;  // Session start timestamp (new Date())
        this.sessionSourceLang = 'auto';
        this.sessionTargetLang = 'vi';
        this.sessionMode = 'one_way';
        this.ttsEnabled = false;  // TTS runtime toggle
        this.isPinned = false;    // User's always-on-top choice (📌 / ⌘P); a normal window by default
        this.isCompact = false;   // Compact mode (hide control bar)
        this._closing = false;    // Guard so the exit flush runs exactly once
    }

    async init() {
        // Load settings
        await settingsManager.load();
        // First run after the profiles feature: wrap the legacy context in a profile.
        await this._ensureProfiles();

        // Init transcript UI
        const transcriptContainer = document.getElementById('transcript-content');
        this.transcriptUI = new TranscriptUI(transcriptContainer);
        // Library › ôn bài: marks + notes editable after class
        this.studyView = new StudyView({ toast: (m, k) => this._showToast(m, k) });

        // Init session store — one session file lives across many Start/Pause
        // cycles; it autosaves while recording and finalizes on Stop or app close.
        const initSettings = settingsManager.get();
        sessionStore.init({
            engine: initSettings.translation_mode || 'soniox',
            sourceLang: initSettings.source_language || 'auto',
            targetLang: initSettings.target_language || 'vi',
        });

        // Check platform — hide Local MLX on non-Apple-Silicon
        await this._checkPlatformSupport();

        // Apply saved settings to UI
        // TTS is always OFF on app start — user must toggle on each session
        this.ttsEnabled = false;
        this._applySettings(settingsManager.get());

        // Bind event listeners
        this._bindEvents();

        // Flush the session on every close route (window ✕, Cmd+Q, Dock quit).
        await this._bindCloseHooks();

        // Bind keyboard shortcuts
        this._bindKeyboardShortcuts();

        // Subscribe to settings changes
        settingsManager.onChange((settings) => this._applySettings(settings));

        // Init audio player for TTS
        audioPlayer.init();

        // Read mode (in-overlay TTS reader). 'live' = capture→translate→speak; 'read' =
        // paste text → read aloud. Default live. Reader is built lazily on Play.
        this._readMode = 'live';
        this._reader = null;
        this._initReadMode();

        // Wire TTS audio callbacks for every provider (single source of registration
        // so a new provider can never be silently left unwired).
        this._allTTS = [elevenLabsTTS, edgeTTSRust, googleTTS, microsoftTTS, googleFreeTTS, tiktokTTS, localTTS];
        for (const tts of this._allTTS) {
            tts.onAudioChunk = (base64Audio, isFinal) => {
                audioPlayer.enqueue(base64Audio);
            };
            tts.onError = (error) => {
                console.error('[TTS]', error);
                this._showToast(error, 'error');
            };
        }

        // Window modes: normal window (default) ↔ compact floating overlay (⤢)
        document.addEventListener('window-mode-changed', () => this._applyAlwaysOnTop());
        initWindowModes(this.appWindow);
        this._watchFullscreen();

        // Check for updates (non-blocking)
        this._initAboutTab();
        this._checkForUpdates();

        // Show engine picker on first launch
        this._maybeShowEnginePicker();

        console.log('🐱 MeowLaoshi initialized');
    }

    async _checkPlatformSupport() {
        try {
            // Apple Silicon detection must be Rosetta-proof: the x64 build on an
            // ARM Mac reports arch "x86_64" but is_arm_hardware asks the real CPU.
            // MLX runs as a native-ARM Python subprocess, so it works even when
            // the app binary itself is x64-under-Rosetta.
            const arch = await invoke('get_platform_info');
            const info = JSON.parse(arch);
            this._platformOs = info.os; // 'macos' | 'windows' | 'linux'
            this.isAppleSilicon = info.is_arm_hardware === true
                || (info.os === 'macos' && info.arch === 'aarch64');
        } catch {
            // Fallback: check via navigator
            this._platformOs = navigator.userAgent.includes('Mac OS X') ? 'macos'
                : navigator.userAgent.includes('Windows') ? 'windows' : 'linux';
            this.isAppleSilicon = navigator.platform === 'MacIntel' &&
                navigator.userAgent.includes('Mac OS X');
        }

        // The Local engine (X-ASR + Hy-MT2 via llama.cpp) runs in-process on
        // every platform; Apple Silicon just gets Metal. Readiness depends only
        // on the models being downloaded.
        this._localModelsReady = null;
        this._refreshLocalModelsStatus();
    }

    // ─── Event Binding ──────────────────────────────────────

    _bindEvents() {
        // Settings button
        document.getElementById('btn-settings').addEventListener('click', () => {
            this._showView('settings');
        });
        // Any change the user makes in Settings is saved when the screen is
        // left, whichever way (programmatic form fills are not "trusted").
        const settingsView = document.getElementById('settings-view');
        const markDirty = (e) => { if (e.isTrusted) this._settingsDirty = true; };
        settingsView.addEventListener('input', markDirty, true);
        settingsView.addEventListener('change', markDirty, true);
        document.addEventListener('offline-pack-changed', () => this._refreshLocalModelsStatus());

        // Back from settings
        document.getElementById('btn-back').addEventListener('click', () => {
            this._showView('overlay');
        });

        // Back from session viewer to session list (saves pending study edits)
        document.getElementById('btn-session-back-to-list').addEventListener('click', async () => {
            await this.studyView.close();
            document.getElementById('sessions-list-panel').style.display = '';
            document.getElementById('session-viewer').style.display = 'none';
            this._showSessions(document.getElementById('input-session-search')?.value || '');
        });

        // Copy session content (Markdown with marks + notes; plain text for legacy)
        document.getElementById('btn-session-copy').addEventListener('click', async () => {
            const content = this._currentViewedSession?.isLegacy
                ? (document.getElementById('session-viewer-content')?.textContent || '')
                : this.studyView.markdown();
            if (content) {
                await navigator.clipboard.writeText(content);
                this._showToast('Đã chép', 'success');
            }
        });

        // Session search box (debounced)
        const searchInput = document.getElementById('input-session-search');
        if (searchInput) {
            let t;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(t);
                const q = e.target.value;
                t = setTimeout(() => this._showSessions(q), 200);
            });
        }

        // Edit session title (inline prompt)
        document.getElementById('btn-session-edit-title')?.addEventListener('click', async () => {
            const cur = this._currentViewedSession;
            if (!cur || cur.isLegacy) {
                this._showToast('Không đổi tên được buổi học định dạng cũ', 'error');
                return;
            }
            const titleEl = document.getElementById('session-viewer-title');
            const oldTitle = titleEl?.textContent || '';
            const newTitle = prompt('Đổi tên buổi học:', oldTitle);
            if (newTitle == null || newTitle === oldTitle) return;
            try {
                await invoke('update_session_title', { id: cur.id, title: newTitle });
                // The open study store must not write the old title back later.
                this.studyView.setTitle(cur.id, newTitle);
                if (titleEl) titleEl.textContent = newTitle;
                this._showToast('Đã đổi tên', 'success');
            } catch (err) {
                this._showToast(`Đổi tên thất bại: ${err}`, 'error');
            }
        });

        // Export session
        document.getElementById('btn-session-export-srt')?.addEventListener('click', () => this._exportCurrentSession('srt'));
        document.getElementById('btn-session-export-txt')?.addEventListener('click', () => this._exportCurrentSession('txt'));

        // (Minimize button removed from toolbar — ⌘M / window menu still work)

        // Pin/Unpin button
        document.getElementById('btn-pin').addEventListener('click', () => {
            this._togglePin();
        });

        // Compact mode button
        document.getElementById('btn-compact').addEventListener('click', () => {
            this._toggleCompact();
        });

        // View mode toggle (dual panel)
        document.getElementById('btn-view-mode').addEventListener('click', () => {
            this._toggleViewMode();
        });

        // Font size quick controls
        document.getElementById('btn-font-up').addEventListener('click', () => this._adjustFontSize(4));
        document.getElementById('btn-font-down').addEventListener('click', () => this._adjustFontSize(-4));

        // Color dot controls
        document.querySelectorAll('.color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
                const color = dot.dataset.color;
                this.transcriptUI.configure({ fontColor: color });
            });
        });

        // Start/Stop button
        document.getElementById('btn-start').addEventListener('click', async () => {
            if (this.isStarting) return; // Prevent re-entry
            try {
                if (this.isRunning) {
                    await this.stopSession();
                } else {
                    this.isStarting = true;
                    await this.start();
                }
            } catch (err) {
                console.error('[App] Start/Stop error:', err);
                this._showToast(`Lỗi: ${err}`, 'error');
                this.isRunning = false;
                this._updateStartButton();
                this._updateStatus('error');
                this.transcriptUI.clear();
                this.transcriptUI.showPlaceholder();
            } finally {
                this.isStarting = false;
            }
        });

        // Pause button — stop capture + persist, but keep the same session file.
        // Only reachable while running (disabled otherwise); next Start appends a
        // new chunk to the same file rather than starting a fresh one.
        document.getElementById('btn-pause')?.addEventListener('click', async () => {
            if (this.isStarting || !this.isRunning) return;
            try {
                await this.pause();
            } catch (err) {
                console.error('[App] Pause error:', err);
                this._showToast(`Lỗi: ${err}`, 'error');
            }
        });

        // Source buttons
        // Audio source dropdown (⌘1/2/3 still switch via _setSource)
        document.getElementById('select-audio-source')?.addEventListener('change', (e) => {
            this._setSource(e.target.value);
        });

        // Clear button — clears display only (auto-save happens on stop)
        document.getElementById('btn-clear').addEventListener('click', async () => {
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            this.recordingStartTime = null;
        });

        // Copy transcript button
        document.getElementById('btn-copy').addEventListener('click', async () => {
            const text = this.transcriptUI.getPlainText();
            if (text) {
                await navigator.clipboard.writeText(text);
                this._showToast('Đã chép', 'success');
            } else {
                this._showToast('Chưa có gì để chép', 'info');
            }
        });

        // Open saved transcripts folder (kept for Finder access)
        document.getElementById('btn-open-transcripts').addEventListener('click', async () => {
            try {
                await invoke('open_transcript_dir');
            } catch (err) {
                this._showToast('Không mở được thư mục: ' + err, 'error');
            }
        });

        // Settings form elements
        this._bindSettingsForm();

        // Manual drag for settings view
        // data-tauri-drag-region doesn't work well when parent contains buttons
        // Using Tauri's recommended appWindow.startDragging() approach instead
        document.getElementById('settings-view')?.addEventListener('mousedown', (e) => {
            const interactive = e.target.closest('button, input, select, label, a, textarea, .settings-section, .settings-actions');
            if (!interactive && e.buttons === 1) {
                e.preventDefault();
                this.appWindow.startDragging();
            }
        });

        // Toggle API key visibility
        document.getElementById('btn-toggle-key').addEventListener('click', () => {
            const input = document.getElementById('input-api-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-openai-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-openai-key');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('link-openai')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://platform.openai.com/api-keys');
        });

        // Inline key format validation + engine-option enable/disable
        const sonioxInput = document.getElementById('input-api-key');
        const openaiInput = document.getElementById('input-openai-key');
        sonioxInput?.addEventListener('input', () => this._refreshKeyStatus());
        openaiInput?.addEventListener('input', () => this._refreshKeyStatus());

        // Test-connection buttons
        document.getElementById('btn-test-soniox')?.addEventListener('click', () => this._testConnection('soniox'));
        document.getElementById('btn-test-openai')?.addEventListener('click', () => this._testConnection('openai'));

        // Translation mode toggle
        document.getElementById('select-translation-mode').addEventListener('change', (e) => {
            this._updateModeUI(e.target.value);
        });
        this._bindModelTab();
        this._bindMicTab();
        this._bindProfileUi();
        this._bindNotes();

        // Toolbar engine pill: same switch, available any time the session isn't
        // running. While running, the pill is locked (visual feedback only).
        document.querySelectorAll('#engine-pill .engine-pill-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.isRunning || this.isStarting) {
                    this._showToast('Tạm dừng phiên trước khi đổi engine', 'error');
                    return;
                }
                this._selectEngineClass(btn.dataset.engineClass);
            });
        });

        // Translation type toggle (one-way / two-way)
        document.getElementById('select-translation-type')?.addEventListener('change', (e) => {
            this._updateTranslationTypeUI(e.target.value);
        });

        // Soniox link
        document.getElementById('link-soniox').addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://console.soniox.com/signup/');
        });

        // ElevenLabs link
        document.getElementById('link-elevenlabs')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://elevenlabs.io/app/sign-up');
        });

        // Save settings — both top and bottom buttons
        document.getElementById('btn-save-settings').addEventListener('click', () => {
            this._saveSettingsFromForm();
        });
        document.getElementById('btn-save-settings-top')?.addEventListener('click', () => {
            this._saveSettingsFromForm();
        });

        // Theme: applies (and saves) immediately; the ⋯ menu toggles light ↔ dark.
        document.getElementById('select-theme')?.addEventListener('change', (e) => this._setTheme(e.target.value));
        document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
            this._setTheme(getResolvedTheme() === 'dark' ? 'light' : 'dark');
        });
        document.addEventListener('theme-changed', (e) => this._syncThemeControls(e.detail.theme));

        document.getElementById('range-font-size').addEventListener('input', (e) => {
            document.getElementById('font-size-value').textContent = `${e.target.value}px`;
        });


        document.getElementById('range-endpoint-delay')?.addEventListener('input', (e) => {
            document.getElementById('endpoint-delay-value').textContent = `${(e.target.value / 1000).toFixed(1)}s`;
        });

        // Toggle ElevenLabs API key visibility
        document.getElementById('btn-toggle-elevenlabs-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-elevenlabs-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-google-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-tts-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-google-free-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-free-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Settings wizard navigation: home cards open detail screens, back rows return home
        document.querySelectorAll('.settings-card, .settings-back-row').forEach(el => {
            el.addEventListener('click', () => {
                if (el.classList.contains('disabled')) return;
                this._showSettingsScreen(el.dataset.screen);
            });
        });

        // TTS enable/disable toggle in settings — show/hide detail
        document.getElementById('check-tts-enabled')?.addEventListener('change', (e) => {
            const detail = document.getElementById('tts-settings-detail');
            if (detail) detail.style.display = e.target.checked ? '' : 'none';
        });

        // TTS provider toggle — show/hide relevant settings panels
        document.getElementById('select-tts-provider')?.addEventListener('change', (e) => {
            this._updateTTSProviderUI(e.target.value);
        });

        // TTS speed slider — show value
        document.getElementById('range-tts-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tts-speed-value');
            if (label) label.textContent = e.target.value + 'x';
        });

        // Edge TTS speed slider
        document.getElementById('range-edge-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('edge-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        document.getElementById('range-google-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('google-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Microsoft v2 speed slider
        document.getElementById('range-microsoft-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('microsoft-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        // Microsoft v2 language filter — re-fill the voice dropdown for the chosen language
        document.getElementById('select-microsoft-lang')?.addEventListener('change', (e) => {
            this._fillMicrosoftVoices(e.target.value);
        });

        // Local offline: language filter re-renders the voice list
        document.getElementById('select-local-lang')?.addEventListener('change', (e) => {
            this._fillLocalVoices(e.target.value);
        });

        // Local offline: speed slider (0.5x–2.0x)
        document.getElementById('range-local-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('local-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Google-free / TikTok: client-side speed sliders (0.5x–2.0x)
        document.getElementById('range-google-free-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('google-free-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });
        document.getElementById('range-tiktok-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tiktok-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Local offline: change model storage folder
        document.getElementById('btn-local-change-dir')?.addEventListener('click', () => {
            this._maybePickModelsDir();
        });

        // Local offline: reset model folder back to the default app location
        document.getElementById('btn-local-reset-dir')?.addEventListener('click', () => {
            this._resetModelsDir();
        });

        // TikTok: paste a "Copy as cURL" and auto-extract the sessionid cookie into the field
        document.getElementById('input-tiktok-curl')?.addEventListener('input', (e) => {
            const m = e.target.value.match(/sessionid=([^;"'\s\\]+)/i);
            const sidInput = document.getElementById('input-tiktok-session');
            if (m && m[1] && sidInput && sidInput.value !== m[1]) {
                sidInput.value = m[1];
                this._showToast('sessionid extracted from cURL ✓', 'success');
            }
        });

        // Add translation term row
        document.getElementById('btn-add-term')?.addEventListener('click', () => {
            this._addTermRow('', '');
        });

        // Add general context row
        document.getElementById('btn-add-general')?.addEventListener('click', () => {
            this._addGeneralRow('', '');
        });

        // TTS toggle button in overlay
        document.getElementById('btn-tts').addEventListener('click', () => {
            this._toggleTTS();
        });

        // Wire Soniox callbacks. Soniox emits original + translation as
        // separate finals; we FIFO-pair them into the session store so each
        // saved segment has both source and target text.
        this._sonioxOriginalQueue = [];
        sonioxClient.onOriginal = (text, speaker, language) => {
            this.transcriptUI.addOriginal(text, speaker, language);
            this._sonioxOriginalQueue.push(text);
        };

        sonioxClient.onTranslation = (text) => {
            this.transcriptUI.addTranslation(text);
            const src = this._sonioxOriginalQueue.shift() || '';
            sessionStore.addSegment(src, text);
            this._autoMarkExam(src);
            this._speakIfEnabled(text);
        };

        sonioxClient.onProvisional = (text, speaker, language) => {
            if (text) {
                this.transcriptUI.setProvisional(text, speaker, language);
            } else {
                this.transcriptUI.clearProvisional();
            }
        };

        sonioxClient.onStatusChange = (status) => {
            this._updateStatus(status);
        };

        sonioxClient.onError = (error, kind) => this._onSonioxError(error, kind);

        sonioxClient.onConfidence = (avgConfidence) => {
            this.transcriptUI.setConfidence(avgConfidence);
        };

        sonioxClient.onBacklog = (active, skippedSec) => this._onBacklog(active, skippedSec);
    }

    _bindSettingsForm() {
        // These are handled in _populateSettingsForm and _saveSettingsFromForm
    }

    // ─── Keyboard Shortcuts ─────────────────────────────────

    _bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // While an input method is composing (Vietnamese Telex, Chinese
            // pinyin) Enter/Escape/letters belong to the IME; keyCode 229 is
            // the legacy "in composition" value WebKit still sends.
            if (e.isComposing || e.keyCode === 229) return;

            // Note-taking shortcuts come first: they must work while typing in
            // the notes pane. Digits use e.code so ⇧ doesn't turn '1' into '!'.
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
                const key = e.key.toLowerCase();
                if (key === 'n') { e.preventDefault(); this._toggleNotes(); return; }
                if (key === 'c') { e.preventDefault(); this._noteLastTranslation(); return; }
                const markByCode = { Digit1: '⭐', Digit2: '❓', Digit3: '📝' };
                if (markByCode[e.code]) { e.preventDefault(); this._markLast(markByCode[e.code]); return; }
            }

            // Ignore when typing in input fields (SELECT: keep native typeahead)
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
                return;
            }

            // Cmd/Ctrl + Enter: Start/Stop
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (this.isStarting) return;
                (async () => {
                    try {
                        if (this.isRunning) {
                            await this.stopSession();
                        } else {
                            this.isStarting = true;
                            await this.start();
                        }
                    } catch (err) {
                        console.error('[App] Keyboard start/stop error:', err);
                        this._showToast(`Lỗi: ${err}`, 'error');
                        this.isRunning = false;
                        this._updateStartButton();
                        this._updateStatus('error');
                    } finally {
                        this.isStarting = false;
                    }
                })();
            }

            // Escape: Go back to overlay / close settings
            if (e.key === 'Escape') {
                e.preventDefault();
                // Shortcut sheet closes first if open
                const sheet = document.getElementById('shortcut-sheet');
                if (sheet && sheet.style.display !== 'none') {
                    this._toggleShortcutSheet?.(false);
                    return;
                }
                const settingsVisible = document.getElementById('settings-view').classList.contains('active');
                if (settingsVisible) {
                    this._showView('overlay');
                }
            }

            // "?": shortcut cheat-sheet (guarded above from input/textarea)
            if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                this._toggleShortcutSheet?.(true);
            }

            // Cmd/Ctrl + ,: Open settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                this._showView('settings');
            }

            // Cmd/Ctrl + 1: Switch to System Audio
            if ((e.metaKey || e.ctrlKey) && e.key === '1') {
                e.preventDefault();
                this._setSource('system');
            }

            // Cmd/Ctrl + 2: Switch to Microphone
            if ((e.metaKey || e.ctrlKey) && e.key === '2') {
                e.preventDefault();
                this._setSource('microphone');
            }

            // Cmd/Ctrl + 3: Switch to Both
            if ((e.metaKey || e.ctrlKey) && e.key === '3') {
                e.preventDefault();
                this._setSource('both');
            }

            // Cmd/Ctrl + T: Toggle TTS
            if ((e.metaKey || e.ctrlKey) && e.key === 't') {
                e.preventDefault();
                this._toggleTTS();
            }

            // Cmd/Ctrl + M: Minimize
            if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
                e.preventDefault();
                this.appWindow.minimize();
            }

            // Cmd/Ctrl + P: Toggle Pin
            if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
                e.preventDefault();
                this._togglePin();
            }

            // Cmd/Ctrl + D: Toggle Compact
            if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
                e.preventDefault();
                this._toggleCompact();
            }
        });
    }

    // ─── Views ──────────────────────────────────────────────

    _showView(view) {
        const settingsEl = document.getElementById('settings-view');
        if (view !== 'settings' && settingsEl.classList.contains('active') && this._settingsDirty) {
            this._settingsDirty = false;
            this._saveSettingsFromForm({ quiet: true, stay: true });
        }
        document.getElementById('overlay-view').classList.toggle('active', view === 'overlay');
        document.getElementById('settings-view').classList.toggle('active', view === 'settings');

        if (view === 'settings') {
            this._populateSettingsForm();
            this._settingsDirty = false;
            this._showSettingsScreen('settings-home'); // wizard always opens at home
        }
        // Returning to the overlay while in Read mode: a voice/provider may have
        // changed in Settings — refresh both the capability hint AND the voice
        // quick-pick (else it keeps the old provider's options + settings key).
        if (view === 'overlay' && getActivity() === 'read') {
            this._populateReadQuickPick();
            this._showReadCapabilityHint();
        }
    }

    /** Wizard: show one settings screen (home or a detail) inside the settings view. */
    _showSettingsScreen(id) {
        if (!id || !document.getElementById(id)) id = 'settings-home';
        document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(id).classList.add('active');
        if (id === 'settings-home') this._updateSettingsCards();
        document.querySelector('.settings-body')?.scrollTo(0, 0);
    }

    /** Wizard: refresh the home cards' status subtitles from current settings. */
    _updateSettingsCards() {
        const s = settingsManager.get();
        const mode = s.translation_mode || 'soniox';
        const engineNames = { soniox: 'Soniox', local: 'Local MLX', openai: 'OpenAI Realtime', qwen: 'Qwen LiveTranslate' };
        const keyField = { soniox: 'soniox_api_key', openai: 'openai_api_key', qwen: 'qwen_api_key' };
        const hasKey = mode === 'local' || !!(s[keyField[mode]] || '').trim();
        const subT = document.getElementById('card-translation-sub');
        if (subT) {
            subT.textContent =
                `${engineNames[mode] || mode} · ${s.source_language || 'auto'} → ${s.target_language || 'vi'}` +
                (hasKey ? '' : ' · ⚠️ chưa có API key');
        }

        const subModel = document.getElementById('card-model-sub');
        if (subModel) {
            const engModel = { soniox: s.soniox_model, qwen: s.qwen_model, openai: s.openai_model }[mode];
            const llm = s.llm_model ? ` · LLM: ${s.llm_model}` : ' · LLM: chưa cấu hình';
            subModel.textContent = `${engineNames[mode] || mode}${engModel ? ` (${engModel})` : ''}${llm}`;
        }

        const subMic = document.getElementById('card-mic-sub');
        if (subMic) {
            const on = [];
            if (s.mic_voice_processing) on.push('Apple VP');
            if (s.mic_denoise !== false) on.push('khử ồn');
            if (s.mic_agc !== false) on.push('AGC');
            if (s.mic_vad) on.push('VAD');
            const models = this._audioModelsReady === false ? ' · ⚠️ chưa tải model' : '';
            subMic.textContent = (on.length ? on.join(' · ') : 'không xử lý') + models;
        }

        // TTS card: cloud-realtime engines run text-only — reflect on the card, never hide.
        const isCloudRealtime = mode === 'openai' || mode === 'qwen';
        const provNames = {
            edge: 'Edge TTS', microsoft: 'Microsoft v2', 'google-free': 'Google TTS Free',
            tiktok: 'TikTok TTS', local: 'Local (Offline)', google: 'Google Chirp HD', elevenlabs: 'ElevenLabs',
        };
        const cardTts = document.getElementById('card-tts');
        const subTts = document.getElementById('card-tts-sub');
        if (cardTts) cardTts.classList.toggle('disabled', isCloudRealtime);
        if (subTts) {
            if (isCloudRealtime) {
                subTts.textContent = `Tắt — engine ${engineNames[mode]} chạy dạng chữ, không đọc tiếng`;
            } else {
                const prov = s.tts_provider || 'edge';
                const voice = prov === 'local' && s.local_tts_voice ? ` · ${s.local_tts_voice}` : '';
                subTts.textContent = `${provNames[prov] || prov}${voice}`;
            }
        }
    }

    // ─── Settings → Model tab ──────────────────────────────
    // Engine/model picker + helper-LLM config. Keys for the real-time engines
    // stay in the Translation tab; this tab only shows whether they're present.

    _bindModelTab() {
        document.querySelectorAll('#model-engine-list .model-engine-pick').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.isRunning || this.isStarting) {
                    this._showToast('Tạm dừng phiên trước khi đổi engine', 'error');
                    return;
                }
                const mode = btn.dataset.engine;
                settingsManager.save({ translation_mode: mode });
                const select = document.getElementById('select-translation-mode');
                if (select) select.value = mode;
                this._updateModeUI(mode);
                this._populateModelTab();
            });
        });
        document.querySelectorAll('#tab-model select[data-custom]').forEach(sel => {
            sel.addEventListener('change', () => this._syncCustomModelInput(sel));
        });
        document.getElementById('select-llm-provider')?.addEventListener('change', (e) => {
            this._applyLlmPreset(e.target.value, true);
        });
        document.getElementById('btn-toggle-llm-key')?.addEventListener('click', () => {
            const inp = document.getElementById('input-llm-key');
            if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
        });
        document.getElementById('btn-test-llm')?.addEventListener('click', () => this._testLlmConnection());
        document.getElementById('btn-local-models-download')
            ?.addEventListener('click', () => this._downloadLocalModels());
        document.getElementById('link-model-to-keys')?.addEventListener('click', (e) => {
            e.preventDefault();
            this._showSettingsScreen('tab-translation');
        });
    }

    /** Show the free-text input only when the select is on "Tuỳ chỉnh…". */
    _syncCustomModelInput(sel) {
        const custom = document.getElementById(sel.dataset.custom);
        if (!custom) return;
        const isCustom = sel.value === '__custom';
        custom.style.display = isCustom ? '' : 'none';
        if (isCustom) custom.focus();
    }

    /** Select `value` in a model dropdown; non-preset values go to the custom input. */
    _setModelSelect(selId, value) {
        const sel = document.getElementById(selId);
        if (!sel) return;
        const isPreset = Array.from(sel.options).some(o => o.value === value && value !== '__custom');
        if (value && !isPreset) {
            sel.value = '__custom';
            const custom = document.getElementById(sel.dataset.custom);
            if (custom) custom.value = value;
        } else {
            sel.value = value || sel.options[0]?.value || '';
        }
        this._syncCustomModelInput(sel);
    }

    _readModelSelect(selId) {
        const sel = document.getElementById(selId);
        if (!sel) return '';
        if (sel.value === '__custom') {
            return document.getElementById(sel.dataset.custom)?.value.trim() || '';
        }
        return sel.value;
    }

    _populateModelTab() {
        const s = settingsManager.get();
        const mode = s.translation_mode || 'soniox';
        document.querySelectorAll('#model-engine-list .model-engine-row').forEach(row => {
            row.classList.toggle('active', row.dataset.engine === mode);
        });
        const keyOf = { soniox: s.soniox_api_key, qwen: s.qwen_api_key, openai: s.openai_api_key };
        for (const [eng, key] of Object.entries(keyOf)) {
            const el = document.getElementById(`model-key-${eng}`);
            if (!el) continue;
            const ok = !!(key || '').trim();
            el.textContent = ok ? '● đã có key' : '○ chưa có key';
            el.classList.toggle('ok', ok);
        }
        const ggufInput = document.getElementById('input-local-gguf');
        if (ggufInput) ggufInput.value = s.local_llm_gguf || '';
        this._refreshLocalModelsStatus();
        this._setModelSelect('select-soniox-model', s.soniox_model || MODEL_DEFAULTS.soniox);
        this._setModelSelect('select-qwen-model', s.qwen_model || MODEL_DEFAULTS.qwen);
        this._setModelSelect('select-openai-model', s.openai_model || MODEL_DEFAULTS.openai);

        // Helper LLM
        const provider = LLM_PRESETS[s.llm_provider] ? s.llm_provider : 'deepseek';
        const provSel = document.getElementById('select-llm-provider');
        if (provSel) provSel.value = provider;
        this._applyLlmPreset(provider, false);
        const base = document.getElementById('input-llm-base-url');
        if (base) base.value = s.llm_base_url || LLM_PRESETS[provider].baseUrl;
        const key = document.getElementById('input-llm-key');
        if (key) key.value = s.llm_api_key || '';
        this._setModelSelect('select-llm-model', s.llm_model || LLM_PRESETS[provider].models[0] || '');
    }

    /** Fill base URL + model options for an LLM provider preset. */
    _applyLlmPreset(provider, resetValues) {
        const preset = LLM_PRESETS[provider] || LLM_PRESETS.custom;
        const base = document.getElementById('input-llm-base-url');
        if (base && resetValues) base.value = preset.baseUrl;
        const sel = document.getElementById('select-llm-model');
        if (sel) {
            sel.innerHTML = '';
            for (const m of preset.models) {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                sel.appendChild(opt);
            }
            const custom = document.createElement('option');
            custom.value = '__custom';
            custom.textContent = 'Tuỳ chỉnh…';
            sel.appendChild(custom);
            if (resetValues) this._setModelSelect('select-llm-model', preset.models[0] || '');
        }
        const hint = document.getElementById('hint-llm');
        if (hint) hint.textContent = preset.hint || '';
    }

    _collectModelTab() {
        return {
            soniox_model: this._readModelSelect('select-soniox-model') || MODEL_DEFAULTS.soniox,
            qwen_model: this._readModelSelect('select-qwen-model') || MODEL_DEFAULTS.qwen,
            openai_model: this._readModelSelect('select-openai-model') || MODEL_DEFAULTS.openai,
            llm_provider: document.getElementById('select-llm-provider')?.value || 'deepseek',
            llm_base_url: document.getElementById('input-llm-base-url')?.value.trim() || '',
            llm_api_key: document.getElementById('input-llm-key')?.value.trim() || '',
            llm_model: this._readModelSelect('select-llm-model'),
            local_llm_gguf: document.getElementById('input-local-gguf')?.value.trim() || '',
        };
    }

    /** One tiny chat completion against the configured helper LLM. */
    async _testLlmConnection() {
        const cfg = this._collectModelTab();
        const status = document.getElementById('key-status-llm');
        if (!cfg.llm_api_key || !cfg.llm_base_url || !cfg.llm_model) {
            this._showToast('Cần đủ Base URL, API key và model', 'error');
            return;
        }
        if (status) { status.className = 'key-status checking'; status.textContent = 'đang kiểm tra…'; }
        try {
            const url = cfg.llm_base_url.replace(/\/+$/, '') + '/chat/completions';
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llm_api_key}` },
                body: JSON.stringify({
                    model: cfg.llm_model,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 5,
                }),
            });
            if (!res.ok) {
                const txt = (await res.text()).slice(0, 200);
                throw new Error(`HTTP ${res.status}: ${txt}`);
            }
            if (status) { status.className = 'key-status ok'; status.textContent = '✓ kết nối OK'; }
            this._showToast(`LLM OK — ${cfg.llm_model}`, 'success');
        } catch (err) {
            if (status) { status.className = 'key-status bad'; status.textContent = '✗ lỗi'; }
            this._showToast(`LLM lỗi: ${err.message}`, 'error');
        }
    }

    // ─── Settings → Micro tab ──────────────────────────────
    // Toggles for the Rust mic chain + on-demand download of the two small
    // ONNX models (GTCRN denoiser, Silero VAD) it can use.

    _bindMicTab() {
        document.getElementById('btn-audio-models-download')
            ?.addEventListener('click', () => this._downloadAudioModels());
    }

    _populateMicTab() {
        const s = settingsManager.get();
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
        set('check-mic-vpio', !!s.mic_voice_processing);
        set('check-mic-highpass', s.mic_highpass !== false);
        set('check-mic-agc', s.mic_agc !== false);
        set('check-mic-denoise', s.mic_denoise !== false);
        set('check-mic-vad', !!s.mic_vad);
        // Apple Voice Processing exists only on macOS.
        const isMac = this._platformOs === 'macos';
        for (const id of ['mic-vpio-row', 'mic-vpio-hint']) {
            const el = document.getElementById(id);
            if (el) el.style.display = isMac ? '' : 'none';
        }
        this._refreshAudioModelsStatus();
    }

    _collectMicTab() {
        const get = (id, dflt) => document.getElementById(id)?.checked ?? dflt;
        return {
            mic_voice_processing: get('check-mic-vpio', false),
            mic_highpass: get('check-mic-highpass', true),
            mic_agc: get('check-mic-agc', true),
            mic_denoise: get('check-mic-denoise', true),
            mic_vad: get('check-mic-vad', false),
        };
    }

    async _refreshAudioModelsStatus() {
        const status = document.getElementById('audio-models-status');
        const btn = document.getElementById('btn-audio-models-download');
        try {
            const list = await invoke('audio_models_status');
            const missing = list.filter(m => !m.installed);
            this._audioModelsReady = missing.length === 0;
            if (status) {
                status.className = 'key-status ' + (this._audioModelsReady ? 'ok' : '');
                status.textContent = this._audioModelsReady
                    ? '✓ đã cài'
                    : `○ chưa tải (${(missing.reduce((a, m) => a + m.size, 0) / 1048576).toFixed(1)} MB)`;
            }
            if (btn) btn.style.display = this._audioModelsReady ? 'none' : '';
        } catch (err) {
            if (status) { status.className = 'key-status bad'; status.textContent = '✗ không kiểm tra được'; }
        }
    }

    async _downloadAudioModels() {
        const btn = document.getElementById('btn-audio-models-download');
        const progress = document.getElementById('audio-models-progress');
        if (btn) btn.disabled = true;
        const onProgress = new Channel();
        onProgress.onmessage = (msg) => {
            if (!progress) return;
            if (msg.phase === 'downloading' && msg.total > 0) {
                progress.textContent = `${msg.id}: ${Math.floor((msg.received / msg.total) * 100)}%`;
            } else if (msg.phase === 'done') {
                progress.textContent = `${msg.id}: ✓`;
            }
        };
        try {
            await invoke('audio_models_download', { onProgress });
            this._showToast('Đã tải model khử ồn + VAD ✓', 'success');
            if (progress) progress.textContent = '';
        } catch (err) {
            this._showToast(`Tải model thất bại: ${err}`, 'error');
            if (progress) progress.textContent = '';
        } finally {
            if (btn) btn.disabled = false;
            await this._refreshAudioModelsStatus();
        }
    }

    // ─── Settings Form ─────────────────────────────────────

    _populateSettingsForm() {
        const s = settingsManager.get();

        document.getElementById('input-api-key').value = s.soniox_api_key || '';
        const openaiKeyInput = document.getElementById('input-openai-key');
        if (openaiKeyInput) openaiKeyInput.value = s.openai_api_key || '';
        const qwenKeyInput = document.getElementById('input-qwen-key');
        if (qwenKeyInput) qwenKeyInput.value = s.qwen_api_key || '';
        document.getElementById('select-source-lang').value = s.source_language || 'auto';
        document.getElementById('select-target-lang').value = s.target_language || 'vi';
        document.getElementById('select-translation-mode').value = s.translation_mode || 'soniox';
        this._updateModeUI(s.translation_mode || 'soniox');
        this._refreshKeyStatus();
        this._populateModelTab();
        this._populateMicTab();

        // Translation type (one-way / two-way)
        const translationType = s.translation_type || 'one_way';
        document.getElementById('select-translation-type').value = translationType;
        this._updateTranslationTypeUI(translationType);

        // Two-way language selects
        document.getElementById('select-lang-a').value = s.language_a || 'zh';
        document.getElementById('select-lang-b').value = s.language_b || 'vi';

        // Strict language detection
        document.getElementById('check-strict-lang').checked = s.language_hints_strict || false;

        // Endpoint delay
        const endpointDelay = s.endpoint_delay || 1500;
        const delaySlider = document.getElementById('range-endpoint-delay');
        if (delaySlider) delaySlider.value = endpointDelay;
        const delayValue = document.getElementById('endpoint-delay-value');
        if (delayValue) delayValue.textContent = `${(endpointDelay / 1000).toFixed(1)}s`;

        // Audio source radio
        const radioValue = s.audio_source || 'system';
        const radio = document.querySelector(`input[name="audio-source"][value="${radioValue}"]`);
        if (radio) radio.checked = true;

        // Display
        const themeSel = document.getElementById('select-theme');
        if (themeSel) themeSel.value = s.theme || 'light';
        document.getElementById('range-font-size').value = s.font_size || 18;
        document.getElementById('font-size-value').textContent = `${s.font_size || 18}px`;

        // Course profiles: the context editor edits the active profile.
        this._renderProfileSelects();
        this._populateContextEditor(this._activeProfileContext());

        // TTS settings
        document.getElementById('input-elevenlabs-key').value = s.elevenlabs_api_key || '';
        document.getElementById('select-tts-voice').value = s.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
        // Edge TTS settings
        const edgeVoiceSelect = document.getElementById('select-edge-voice');
        if (edgeVoiceSelect) edgeVoiceSelect.value = s.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const edgeSpeedSlider = document.getElementById('range-edge-speed');
        const edgeSpeedLabel = document.getElementById('edge-speed-value');
        const edgeSpeed = s.edge_tts_speed !== undefined ? s.edge_tts_speed : 20;
        if (edgeSpeedSlider) edgeSpeedSlider.value = edgeSpeed;
        if (edgeSpeedLabel) edgeSpeedLabel.textContent = (edgeSpeed >= 0 ? '+' : '') + edgeSpeed + '%';

        // Google TTS settings
        const googleKeyInput = document.getElementById('input-google-tts-key');
        if (googleKeyInput) googleKeyInput.value = s.google_tts_api_key || '';
        const googleVoiceSelect = document.getElementById('select-google-voice');
        if (googleVoiceSelect) googleVoiceSelect.value = s.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
        const googleSpeedSlider = document.getElementById('range-google-speed');
        const googleSpeedLabel = document.getElementById('google-speed-value');
        const googleSpeed = s.google_tts_speed || 1.0;
        if (googleSpeedSlider) googleSpeedSlider.value = googleSpeed;
        if (googleSpeedLabel) googleSpeedLabel.textContent = googleSpeed + 'x';

        // Microsoft v2 settings (voice populated dynamically in _updateTTSProviderUI)
        const msVoiceSelect = document.getElementById('select-microsoft-voice');
        if (msVoiceSelect) msVoiceSelect.value = s.microsoft_v2_voice || 'vi-VN-HoaiMyNeural';
        const msSpeedSlider = document.getElementById('range-microsoft-speed');
        const msSpeedLabel = document.getElementById('microsoft-speed-value');
        const msSpeed = s.microsoft_v2_speed !== undefined ? s.microsoft_v2_speed : 20;
        if (msSpeedSlider) msSpeedSlider.value = msSpeed;
        if (msSpeedLabel) msSpeedLabel.textContent = (msSpeed >= 0 ? '+' : '') + msSpeed + '%';

        // Google Free settings
        const gfKeyInput = document.getElementById('input-google-free-key');
        if (gfKeyInput) gfKeyInput.value = s.google_free_api_key || '';
        const gfVoiceSelect = document.getElementById('select-google-free-voice');
        if (gfVoiceSelect) gfVoiceSelect.value = s.google_free_voice || 'vi-VN';
        const gfSpeed = s.google_free_speed || 1.0;
        const gfSpeedSlider = document.getElementById('range-google-free-speed');
        const gfSpeedLabel = document.getElementById('google-free-speed-value');
        if (gfSpeedSlider) gfSpeedSlider.value = gfSpeed;
        if (gfSpeedLabel) gfSpeedLabel.textContent = parseFloat(gfSpeed).toFixed(1) + 'x';

        // TikTok settings
        const ttVoiceSelect = document.getElementById('select-tiktok-voice');
        if (ttVoiceSelect) ttVoiceSelect.value = s.tiktok_voice || 'BV074_streaming';
        const ttSession = document.getElementById('input-tiktok-session');
        if (ttSession) ttSession.value = s.tiktok_session_id || '';
        const ttSpeed = s.tiktok_speed || 1.0;
        const ttSpeedSlider = document.getElementById('range-tiktok-speed');
        const ttSpeedLabel = document.getElementById('tiktok-speed-value');
        if (ttSpeedSlider) ttSpeedSlider.value = ttSpeed;
        if (ttSpeedLabel) ttSpeedLabel.textContent = parseFloat(ttSpeed).toFixed(1) + 'x';

        // TTS provider
        const providerSelect = document.getElementById('select-tts-provider');
        if (providerSelect) {
            providerSelect.value = s.tts_provider || 'edge';
            this._updateTTSProviderUI(providerSelect.value);
        }
    }

    async _saveSettingsFromForm({ quiet = false, stay = false } = {}) {
        this._settingsDirty = false;
        const settings = {
            soniox_api_key: document.getElementById('input-api-key').value.trim(),
            openai_api_key: document.getElementById('input-openai-key')?.value.trim() || '',
            qwen_api_key: document.getElementById('input-qwen-key')?.value.trim() || '',
            source_language: document.getElementById('select-source-lang').value,
            target_language: document.getElementById('select-target-lang').value,
            translation_mode: document.getElementById('select-translation-mode').value,
            translation_type: document.getElementById('select-translation-type')?.value || 'one_way',
            language_a: document.getElementById('select-lang-a')?.value || 'zh',
            language_b: document.getElementById('select-lang-b')?.value || 'vi',
            language_hints_strict: document.getElementById('check-strict-lang')?.checked || false,
            endpoint_delay: parseInt(document.getElementById('range-endpoint-delay')?.value || 1500),
            audio_source: document.querySelector('input[name="audio-source"]:checked')?.value || 'system',
            theme: document.getElementById('select-theme')?.value || 'light',
            font_size: parseInt(document.getElementById('range-font-size').value),
            custom_context: null,
            ...this._collectModelTab(),
            ...this._collectMicTab(),
        };

        // Course profile context: the editor's content belongs to the active profile.
        const editedContext = this._readContextEditor();
        settings.profiles = this._getProfiles().map(p =>
            p.id === this._activeProfileId() ? { ...p, context: editedContext } : p
        );
        settings.active_profile = this._activeProfileId();

        // TTS settings
        settings.tts_provider = document.getElementById('select-tts-provider')?.value || 'edge';
        settings.elevenlabs_api_key = document.getElementById('input-elevenlabs-key').value.trim();
        settings.tts_voice_id = document.getElementById('select-tts-voice').value;
        settings.edge_tts_voice = document.getElementById('select-edge-voice')?.value || 'vi-VN-HoaiMyNeural';
        settings.edge_tts_speed = parseInt(document.getElementById('range-edge-speed')?.value || 20);
        settings.tts_speed = parseFloat(document.getElementById('range-tts-speed')?.value || 1.2);
        settings.google_tts_api_key = document.getElementById('input-google-tts-key')?.value.trim() || '';
        settings.google_tts_voice = document.getElementById('select-google-voice')?.value || 'vi-VN-Chirp3-HD-Aoede';
        settings.google_tts_speed = parseFloat(document.getElementById('range-google-speed')?.value || 1.0);
        settings.microsoft_v2_voice = document.getElementById('select-microsoft-voice')?.value || 'vi-VN-HoaiMyNeural';
        settings.microsoft_v2_speed = parseInt(document.getElementById('range-microsoft-speed')?.value || 20);
        settings.google_free_api_key = document.getElementById('input-google-free-key')?.value.trim() || '';
        settings.google_free_voice = document.getElementById('select-google-free-voice')?.value || 'vi-VN';
        settings.google_free_speed = parseFloat(document.getElementById('range-google-free-speed')?.value || 1.0);
        settings.tiktok_voice = document.getElementById('select-tiktok-voice')?.value || 'BV074_streaming';
        settings.tiktok_speed = parseFloat(document.getElementById('range-tiktok-speed')?.value || 1.0);
        settings.tiktok_session_id = document.getElementById('input-tiktok-session')?.value.trim() || '';
        settings.local_tts_speed = parseFloat(document.getElementById('range-local-speed')?.value || 1.0);
        settings.tts_enabled = false;

        try {
            await settingsManager.save(settings);
            this._showToast(quiet ? 'Đã lưu thay đổi' : 'Đã lưu cài đặt', 'success');
            if (!stay) this._showView('overlay');
        } catch (err) {
            this._showToast(`Lưu thất bại: ${err}`, 'error');
        }
    }

    // ─── Apply Settings ────────────────────────────────────

    _applySettings(settings) {
        // The window is always fully opaque: the old "Opacity" setting dimmed all
        // text (default 85 %) and forced an extra GPU compositing layer.
        applyTheme(settings.theme || 'light');

        // Live status row: language pair display
        const langEl = document.getElementById('live-lang');
        if (langEl) {
            langEl.textContent = `${settings.source_language || 'auto'} → ${settings.target_language || 'vi'}`;
        }
        this._renderProfileSelects();

        // Saving settings must not silently turn narration off (it used to — every
        // ⌘1/2/3 source switch killed TTS). Keep the toggle, re-apply the active
        // provider's config, and disconnect non-active providers to drop stale audio.
        if (this._allTTS) {
            const active = this._getActiveTTS();
            for (const tts of this._allTTS) {
                if (tts !== active && tts.isConnected) tts.disconnect();
            }
            if (this.ttsEnabled && active) this._configureTTS(active, settings);
        }

        // Update transcript UI
        if (this.transcriptUI) {
            this.transcriptUI.configure({
                fontSize: settings.font_size || 18,
            });
        }

        // Update current source button states
        this.currentSource = settings.audio_source || 'system';
        this._updateSourceButtons();

        this._updateTTSButton();
    }

    // ─── TTS Control ──────────────────────────────────────

    async _toggleTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';

        // Block TTS in two-way mode to prevent audio feedback loop
        const translationType = document.getElementById('select-translation-type')?.value;
        if (translationType === 'two_way') {
            this._showToast('Chế độ hai chiều không dùng đọc bản dịch (tránh vòng lặp âm thanh)', 'error');
            return;
        }

        // Local provider: the selected voice must actually be downloaded (async check).
        // Only gate when turning ON (turning off never needs a model).
        if (provider === 'local' && !this.ttsEnabled) {
            const installed = await this._isLocalVoiceInstalled(settings.local_tts_voice);
            if (!installed) {
                this._showToast('Tải một giọng đọc trong Cài đặt › Giọng đọc › Local', 'error');
                this._showView('settings');
                return;
            }
        }

        // Check credentials for providers that require them (free providers need none)
        if (provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('Nhập API key ElevenLabs trong Cài đặt › Giọng đọc', 'error');
            this._showView('settings');
            return;
        }
        if (provider === 'google' && !settings.google_tts_api_key) {
            this._showToast('Nhập API key Google TTS trong Cài đặt › Giọng đọc', 'error');
            this._showView('settings');
            return;
        }
        if (provider === 'tiktok' && !settings.tiktok_session_id) {
            this._showToast('Nhập sessionid TikTok trong Cài đặt › Giọng đọc', 'error');
            this._showView('settings');
            return;
        }

        this.ttsEnabled = !this.ttsEnabled;
        this._updateTTSButton();

        const tts = this._getActiveTTS();

        if (this.ttsEnabled) {
            this._configureTTS(tts, settings);
            if (this.isRunning) {
                tts.connect();
                audioPlayer.resume();
            }
            const label = {
                edge: 'Edge TTS (Free)',
                microsoft: 'Microsoft v2 (Free)',
                'google-free': 'Google TTS (Free)',
                tiktok: 'TikTok TTS (Free)',
                local: 'Local Offline',
                google: 'Google Chirp 3 HD',
                elevenlabs: 'ElevenLabs',
            }[provider] || provider;
            this._showToast(`Đọc bản dịch: bật 🔊 (${label})`, 'success');
        } else {
            tts.disconnect();
            audioPlayer.stop();
            this._showToast('Đọc bản dịch: tắt 🔇', 'success');
        }
    }

    _getActiveTTS() {
        const provider = settingsManager.get().tts_provider || 'edge';
        const map = {
            edge: edgeTTSRust,
            microsoft: microsoftTTS,
            'google-free': googleFreeTTS,
            tiktok: tiktokTTS,
            local: localTTS,
            google: googleTTS,
            elevenlabs: elevenLabsTTS,
        };
        const tts = map[provider];
        if (!tts) {
            console.warn(`[TTS] Unknown provider "${provider}", falling back to Edge`);
            return edgeTTSRust;
        }
        return tts;
    }

    _configureTTS(tts, settings) {
        const provider = settings.tts_provider || 'edge';
        // Client-side playback speed ONLY for providers whose endpoint has no rate param
        // (Google-free, TikTok). Others apply speed server-side / in the engine → keep 1.0.
        const clientRate =
            provider === 'google-free' ? (settings.google_free_speed || 1.0) :
            provider === 'tiktok' ? (settings.tiktok_speed || 1.0) : 1.0;
        audioPlayer.setPlaybackRate(clientRate);
        if (provider === 'elevenlabs') {
            tts.configure({
                apiKey: settings.elevenlabs_api_key,
                voiceId: settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM',
            });
        } else if (provider === 'google') {
            const voice = settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
            const langCode = voice.replace(/-Chirp3.*/, '');
            tts.configure({
                apiKey: settings.google_tts_api_key,
                voice: voice,
                languageCode: langCode,
                speakingRate: settings.google_tts_speed || 1.0,
            });
        } else if (provider === 'microsoft') {
            tts.configure({
                voice: settings.microsoft_v2_voice || 'vi-VN-HoaiMyNeural',
                speed: settings.microsoft_v2_speed !== undefined ? settings.microsoft_v2_speed : 20,
            });
        } else if (provider === 'google-free') {
            tts.configure({
                voice: settings.google_free_voice || 'vi-VN',
                apiKey: settings.google_free_api_key || '',
            });
        } else if (provider === 'tiktok') {
            tts.configure({
                voice: settings.tiktok_voice || 'BV074_streaming',
                sessionId: settings.tiktok_session_id || '',
            });
        } else if (provider === 'local') {
            tts.configure({
                voice: settings.local_tts_voice || 'vi_VN-vais1000-medium',
                speed: settings.local_tts_speed || 1.0,
            });
        } else {
            tts.configure({
                voice: settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
                speed: settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20,
            });
        }
    }

    // ─── Course profiles ───────────────────────────────────
    // One context (glossary, domain, background) per subject. The Settings
    // context editor edits the active profile; the Live bar switches it.

    _getProfiles() {
        const s = settingsManager.get();
        return Array.isArray(s.profiles) ? s.profiles : [];
    }

    _activeProfileId() {
        const s = settingsManager.get();
        const ps = this._getProfiles();
        return ps.some(p => p.id === s.active_profile) ? s.active_profile : (ps[0]?.id || '');
    }

    _activeProfile() {
        const id = this._activeProfileId();
        return this._getProfiles().find(p => p.id === id) || null;
    }

    _activeProfileContext() {
        return this._activeProfile()?.context || settingsManager.get().custom_context || null;
    }

    static _emptyContext() {
        return { general: [], terms: [], text: null, translation_terms: [] };
    }

    /** First run: wrap the legacy session-wide context into a "Chung" profile. */
    async _ensureProfiles() {
        const s = settingsManager.get();
        if (Array.isArray(s.profiles) && s.profiles.length > 0) return;
        const ctx = s.custom_context || App._emptyContext();
        try {
            await settingsManager.save({ profiles: [{ id: 'default', name: 'Chung', context: ctx }], active_profile: 'default' });
        } catch (err) {
            console.error('[Profiles] migration failed:', err);
        }
    }

    _renderProfileSelects() {
        const ps = this._getProfiles();
        const active = this._activeProfileId();
        for (const id of ['select-profile', 'select-live-profile']) {
            const sel = document.getElementById(id);
            if (!sel) continue;
            sel.innerHTML = '';
            for (const p of ps) {
                const o = document.createElement('option');
                o.value = p.id;
                o.textContent = p.name;
                sel.appendChild(o);
            }
            sel.value = active;
        }
        const live = document.getElementById('select-live-profile');
        if (live) live.style.display = ps.length > 1 ? '' : 'none';
        const stats = document.getElementById('profile-stats');
        const ctx = this._activeProfile()?.context;
        if (stats) {
            stats.textContent = ctx
                ? `${(ctx.translation_terms || []).length} cặp thuật ngữ · ${(ctx.terms || []).length} từ nhận dạng`
                : '';
        }
        const del = document.getElementById('btn-profile-delete');
        if (del) del.disabled = ps.length <= 1;
    }

    /** Fill the context editor from a profile context. */
    _populateContextEditor(ctx) {
        const generalList = document.getElementById('context-general-list');
        if (generalList) {
            generalList.innerHTML = '';
            (ctx?.general || []).forEach(g => this._addGeneralRow(g.key, g.value));
        }
        const termsInput = document.getElementById('input-context-terms');
        if (termsInput) termsInput.value = (ctx?.terms || []).join('\n');
        const textInput = document.getElementById('input-context-text');
        if (textInput) textInput.value = ctx?.text || '';
        const termsList = document.getElementById('translation-terms-list');
        if (termsList) {
            termsList.innerHTML = '';
            (ctx?.translation_terms || []).forEach(t => this._addTermRow(t.source, t.target));
        }
    }

    /** Read the context editor back into a profile context object. */
    _readContextEditor() {
        const ctx = App._emptyContext();
        document.querySelectorAll('#context-general-list .general-row').forEach(row => {
            const key = row.querySelector('.general-key')?.value.trim();
            const value = row.querySelector('.general-value')?.value.trim();
            if (key && value) ctx.general.push({ key, value });
        });
        const termsRaw = document.getElementById('input-context-terms')?.value.trim() || '';
        ctx.terms = termsRaw ? termsRaw.split('\n').map(t => t.trim()).filter(Boolean) : [];
        ctx.text = document.getElementById('input-context-text')?.value.trim() || null;
        document.querySelectorAll('#translation-terms-list .term-row').forEach(row => {
            const source = row.querySelector('.term-source')?.value.trim();
            const target = row.querySelector('.term-target')?.value.trim();
            if (source && target) ctx.translation_terms.push({ source, target });
        });
        return ctx;
    }

    /** Profiles with the editor's current content written into the active one. */
    _profilesWithEditedActive() {
        const edited = this._readContextEditor();
        return this._getProfiles().map(p => (p.id === this._activeProfileId() ? { ...p, context: edited } : p));
    }

    _bindProfileUi() {
        document.getElementById('select-profile')
            ?.addEventListener('change', (e) => this._setActiveProfile(e.target.value, { fromSettings: true }));
        document.getElementById('select-live-profile')
            ?.addEventListener('change', (e) => this._setActiveProfile(e.target.value));
        document.getElementById('btn-profile-add')?.addEventListener('click', () => this._openProfileNameEditor('add'));
        document.getElementById('btn-profile-rename')?.addEventListener('click', () => this._openProfileNameEditor('rename'));
        document.getElementById('btn-profile-name-ok')?.addEventListener('click', () => this._confirmProfileName());
        document.getElementById('btn-profile-name-cancel')?.addEventListener('click', () => this._closeProfileNameEditor());
        document.getElementById('input-profile-name')?.addEventListener('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) return; // Enter commits the IME candidate, not the name
            if (e.key === 'Enter') { e.preventDefault(); this._confirmProfileName(); }
            if (e.key === 'Escape') { e.preventDefault(); this._closeProfileNameEditor(); }
        });
        document.getElementById('btn-profile-delete')?.addEventListener('click', () => this._deleteActiveProfile());
        document.getElementById('btn-profile-import-finance')?.addEventListener('click', () => this._importFinanceGlossary());
    }

    /**
     * Switch the active profile. From Settings, unsaved edits of the previous
     * profile are kept. While a Soniox session runs, the new context is
     * applied immediately via a seamless reset.
     */
    async _setActiveProfile(id, { fromSettings = false } = {}) {
        if (!this._getProfiles().some(p => p.id === id)) return;
        const patch = { active_profile: id };
        if (fromSettings) patch.profiles = this._profilesWithEditedActive();
        try {
            await settingsManager.save(patch);
        } catch (err) {
            this._showToast(`Không lưu được hồ sơ: ${err}`, 'error');
            return;
        }
        this._renderProfileSelects();
        if (fromSettings) this._populateContextEditor(this._activeProfileContext());
        if (this.isRunning && this.translationMode === 'soniox') {
            sonioxClient.updateContext(this._activeProfileContext());
            this._showToast(`Hồ sơ "${this._activeProfile()?.name}" — đã áp dụng`, 'success');
        }
    }

    _openProfileNameEditor(mode) {
        this._profileNameMode = mode;
        const editor = document.getElementById('profile-name-editor');
        const input = document.getElementById('input-profile-name');
        if (!editor || !input) return;
        input.value = mode === 'rename' ? (this._activeProfile()?.name || '') : '';
        input.placeholder = mode === 'rename' ? 'Tên mới' : 'Tên môn, ví dụ: Tài chính doanh nghiệp';
        editor.style.display = '';
        input.focus();
    }

    _closeProfileNameEditor() {
        const editor = document.getElementById('profile-name-editor');
        if (editor) editor.style.display = 'none';
    }

    async _confirmProfileName() {
        const name = document.getElementById('input-profile-name')?.value.trim();
        if (!name) return;
        let patch;
        if (this._profileNameMode === 'add') {
            const id = 'p-' + Date.now().toString(36);
            const profiles = this._profilesWithEditedActive();
            profiles.push({
                id,
                name,
                context: { ...App._emptyContext(), general: [{ key: 'domain', value: 'university lecture' }] },
            });
            patch = { profiles, active_profile: id };
        } else {
            const profiles = this._getProfiles().map(p => (p.id === this._activeProfileId() ? { ...p, name } : p));
            patch = { profiles };
        }
        try {
            await settingsManager.save(patch);
        } catch (err) {
            this._showToast(`Không lưu được hồ sơ: ${err}`, 'error');
            return;
        }
        this._closeProfileNameEditor();
        this._renderProfileSelects();
        this._populateContextEditor(this._activeProfileContext());
    }

    async _deleteActiveProfile() {
        const ps = this._getProfiles();
        const victim = this._activeProfile();
        if (!victim || ps.length <= 1) return;
        const msg = `Xoá hồ sơ "${victim.name}" cùng toàn bộ thuật ngữ của nó?`;
        const dlg = window.__TAURI__?.dialog;
        const ok = dlg?.confirm ? await dlg.confirm(msg, { title: 'MeowLaoshi', kind: 'warning' }) : window.confirm(msg);
        if (!ok) return;
        const remaining = ps.filter(p => p.id !== victim.id);
        try {
            await settingsManager.save({ profiles: remaining, active_profile: remaining[0].id });
        } catch (err) {
            this._showToast(`Không xoá được: ${err}`, 'error');
            return;
        }
        this._renderProfileSelects();
        this._populateContextEditor(this._activeProfileContext());
    }

    /**
     * Merge the built-in glossaries (core finance, advanced finance, CUFE)
     * into the active profile, de-duplicated by source term. Every pair
     * goes to the glossary; only terms of ≥ 3 characters become recognition
     * terms (shorter ones are known words and only cost Soniox tokens).
     */
    async _importFinanceGlossary() {
        const btn = document.getElementById('btn-profile-import-finance');
        if (btn) btn.disabled = true;
        try {
            const { allGlossaryTerms, isRecognitionTerm } = await import('./glossary/index.js');
            const ctx = this._readContextEditor();
            const havePair = new Set(ctx.translation_terms.map(t => t.source));
            const haveTerm = new Set(ctx.terms);
            let added = 0;
            for (const g of allGlossaryTerms()) {
                if (!havePair.has(g.zh)) {
                    ctx.translation_terms.push({ source: g.zh, target: g.vi });
                    havePair.add(g.zh);
                    added++;
                }
                if (isRecognitionTerm(g.zh) && !haveTerm.has(g.zh)) {
                    ctx.terms.push(g.zh);
                    haveTerm.add(g.zh);
                }
            }
            if (!ctx.general.some(kv => kv.key === 'domain')) {
                ctx.general.push({ key: 'domain', value: 'finance, economics, accounting — university lecture' });
            }
            const profiles = this._getProfiles().map(p => (p.id === this._activeProfileId() ? { ...p, context: ctx } : p));
            await settingsManager.save({ profiles });
            this._populateContextEditor(ctx);
            this._renderProfileSelects();
            this._showToast(added ? `Đã nạp ${added} thuật ngữ mới` : 'Từ điển đã có đủ trong hồ sơ', 'success');
        } catch (err) {
            this._showToast(`Nạp từ điển thất bại: ${err}`, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    _addTermRow(source = '', target = '') {
        const list = document.getElementById('translation-terms-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'term-row';
        row.innerHTML = `<input type="text" class="term-source" value="${this._escAttr(source)}" placeholder="Source" />` +
            `<input type="text" class="term-target" value="${this._escAttr(target)}" placeholder="Target" />` +
            `<button type="button" class="btn-remove-term" title="Remove">×</button>`;
        row.querySelector('.btn-remove-term').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _addGeneralRow(key = '', value = '') {
        const list = document.getElementById('context-general-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'general-row';
        row.innerHTML = `<input type="text" class="general-key" value="${this._escAttr(key)}" placeholder="Key (e.g. domain)" />` +
            `<input type="text" class="general-value" value="${this._escAttr(value)}" placeholder="Value (e.g. Medical)" />` +
            `<button type="button" class="btn-remove-general" title="Remove">×</button>`;
        row.querySelector('.btn-remove-general').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _escAttr(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _updateTTSProviderUI(provider) {
        // Show only the active provider's settings panel.
        const panels = {
            edge: 'tts-edge-settings',
            microsoft: 'tts-microsoft-settings',
            'google-free': 'tts-google-free-settings',
            tiktok: 'tts-tiktok-settings',
            local: 'tts-local-settings',
            google: 'tts-google-settings',
            elevenlabs: 'tts-elevenlabs-settings',
        };
        for (const [id, elId] of Object.entries(panels)) {
            const el = document.getElementById(elId);
            if (el) el.style.display = provider === id ? '' : 'none';
        }
        // Update hint text
        const hint = document.getElementById('tts-provider-hint');
        if (hint) {
            const hints = {
                edge: 'Free, natural voices — no API key needed',
                microsoft: 'Free — full Microsoft voice list (vi + en), sent to Microsoft',
                'google-free': 'Free — experimental, may stop working anytime. Text sent to Google',
                tiktok: 'Free — needs a TikTok sessionid. Text sent to TikTok',
                local: 'Free & 100% offline — download a voice below; nothing is sent anywhere',
                google: 'Near-human quality — requires Google Cloud API key (1M chars/month free)',
                elevenlabs: 'Premium quality — requires ElevenLabs API key',
            };
            hint.textContent = hints[provider] || '';
        }
        // Microsoft v2: populate the full voice list dynamically (fallback stays in HTML).
        if (provider === 'microsoft') this._populateMicrosoftVoices();
        // Local: fetch catalog + install state and render the downloadable voice list.
        if (provider === 'local') this._populateLocalVoices();
    }

    /**
     * Fetch Microsoft's vi+en voice list once (cached), then fill the voice dropdown
     * filtered by the selected Language. The Language dropdown keeps the voice list short
     * (Microsoft has ~50 English voices). Default language follows the saved voice's locale.
     */
    async _populateMicrosoftVoices() {
        const langSel = document.getElementById('select-microsoft-lang');
        const saved = settingsManager.get().microsoft_v2_voice || 'vi-VN-HoaiMyNeural';
        // Initialize the Language dropdown from the saved voice's locale (once).
        if (langSel && !langSel.dataset.init) {
            langSel.value = saved.startsWith('en') ? 'en' : 'vi';
            langSel.dataset.init = 'true';
        }
        if (!this._msVoices) {
            try {
                const voices = await microsoftTTS.listVoices();
                this._msVoices = (Array.isArray(voices) && voices.length) ? voices : MS_VOICE_FALLBACK;
            } catch (err) {
                console.warn('[Microsoft v2] voice list fetch failed, using static fallback:', err);
                this._msVoices = MS_VOICE_FALLBACK;
            }
        }
        this._fillMicrosoftVoices(langSel ? langSel.value : 'vi');
    }

    /** Fill #select-microsoft-voice with cached voices for `lang` ("vi"|"en"), restoring saved. */
    _fillMicrosoftVoices(lang) {
        const select = document.getElementById('select-microsoft-voice');
        if (!select) return;
        const saved = settingsManager.get().microsoft_v2_voice;
        const list = (this._msVoices || MS_VOICE_FALLBACK).filter(v => (v.locale || '').startsWith(lang));
        select.innerHTML = '';
        for (const v of list) {
            const opt = document.createElement('option');
            opt.value = v.short_name;
            opt.textContent = `${v.friendly_name} (${v.gender})`;
            select.appendChild(opt);
        }
        // Keep the saved voice if it belongs to this language, else pick the first.
        if (saved && list.some(v => v.short_name === saved)) select.value = saved;
        else if (select.options.length) select.selectedIndex = 0;
    }

    // ─── Local offline (Piper) voice manager ──────────────

    /** Fetch the catalog + install state once per open, then render the list. */
    async _populateLocalVoices() {
        const langSel = document.getElementById('select-local-lang');
        const saved = settingsManager.get().local_tts_voice || 'vi_VN-vais1000-medium';
        if (langSel && !langSel.dataset.init) {
            langSel.value = saved.startsWith('en') ? 'en' : 'vi';
            langSel.dataset.init = 'true';
        }
        // Show the real resolved models folder (per-OS absolute path) so the user can
        // find the files themselves. Falls back to the raw setting if the query fails.
        const dirInput = document.getElementById('input-local-models-dir');
        if (dirInput) {
            try {
                dirInput.value = await invoke('local_tts_models_dir_path');
            } catch {
                dirInput.value = settingsManager.get().local_tts_models_dir || 'Default app location';
            }
        }
        // Speed slider from saved setting.
        const speedSlider = document.getElementById('range-local-speed');
        const speedLabel = document.getElementById('local-speed-value');
        const speed = settingsManager.get().local_tts_speed || 1.0;
        if (speedSlider) speedSlider.value = speed;
        if (speedLabel) speedLabel.textContent = parseFloat(speed).toFixed(1) + 'x';
        await this._refreshLocalVoices();
        this._fillLocalVoices(langSel ? langSel.value : 'vi');
    }

    /** (Re)load the catalog + install state from the backend into a cache. */
    async _refreshLocalVoices() {
        try {
            const list = await invoke('local_tts_list_models');
            this._localVoices = Array.isArray(list) ? list : [];
        } catch (err) {
            console.warn('[Local TTS] list failed:', err);
            this._localVoices = [];
        }
        this._localInstalled = new Set(
            (this._localVoices || []).filter(v => v.installed).map(v => v.id)
        );
    }

    /** True if `id` is currently installed (fresh backend check). */
    async _isLocalVoiceInstalled(id) {
        if (!id) return false;
        await this._refreshLocalVoices();
        return this._localInstalled.has(id);
    }

    /** Render the voice rows for `lang` ("vi"|"en") with download/delete controls. */
    _fillLocalVoices(lang) {
        const container = document.getElementById('local-voice-list');
        if (!container) return;
        const saved = settingsManager.get().local_tts_voice;
        const all = this._localVoices || [];
        // Catalog voices filter by the selected language; imported (local) voices are shown
        // regardless of language (their language is unknown).
        const catalogList = all.filter(v => !v.imported && v.lang === lang);
        const importedList = all.filter(v => v.imported);
        container.innerHTML = '';
        if (!catalogList.length && !importedList.length) {
            container.innerHTML = '<p class="hint">No voices for this language.</p>';
            return;
        }

        const addRow = (v) => {
            const row = document.createElement('div');
            row.className = 'local-voice-row';
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;';
            const sizeMb = (v.approxSizeBytes / 1e6).toFixed(0);
            if (v.installed) {
                const checked = saved === v.id ? 'checked' : '';
                row.innerHTML =
                    `<label style="flex:1;display:flex;align-items:center;gap:6px;cursor:pointer;">` +
                    `<input type="radio" name="local-voice" value="${v.id}" ${checked} />` +
                    `<span>${this._esc(v.display)}</span></label>` +
                    `<button type="button" class="icon-btn small btn-local-delete" data-id="${v.id}" title="Delete">🗑️</button>`;
            } else {
                row.innerHTML =
                    `<span style="flex:1;color:var(--text-muted,#888);">${this._esc(v.display)} · ${sizeMb} MB</span>` +
                    `<span class="local-progress" data-id="${v.id}" style="min-width:64px;text-align:right;"></span>` +
                    `<button type="button" class="icon-btn small btn-local-download" data-id="${v.id}" title="Download">⬇️</button>`;
            }
            container.appendChild(row);
        };

        catalogList.forEach(addRow);
        if (importedList.length) {
            const hdr = document.createElement('p');
            hdr.className = 'hint';
            hdr.style.cssText = 'margin:8px 0 2px;font-weight:600;';
            hdr.textContent = `Imported (local) — ${importedList.length}`;
            container.appendChild(hdr);
            importedList.forEach(addRow);
        }

        container.querySelectorAll('.btn-local-download').forEach(btn =>
            btn.addEventListener('click', () => this._downloadLocalVoice(btn.dataset.id))
        );
        container.querySelectorAll('.btn-local-delete').forEach(btn =>
            btn.addEventListener('click', () => this._deleteLocalVoice(btn.dataset.id))
        );
        container.querySelectorAll('input[name="local-voice"]').forEach(radio =>
            radio.addEventListener('change', () => {
                if (radio.checked) settingsManager.save({ local_tts_voice: radio.value });
            })
        );
    }

    /** Download a voice model with live progress, then re-render as installed. */
    async _downloadLocalVoice(id) {
        // Download straight into the default app models folder — no folder prompt.
        // Users who want a custom location can still set it via the Model folder field.
        const progressEl = document.querySelector(`.local-progress[data-id="${id}"]`);
        const btn = document.querySelector(`.btn-local-download[data-id="${id}"]`);
        if (btn) btn.disabled = true;
        const onProgress = new Channel();
        onProgress.onmessage = (msg) => {
            if (!progressEl) return;
            if (msg.phase === 'downloading' && msg.total > 0) {
                progressEl.textContent = `${Math.floor((msg.received / msg.total) * 100)}%`;
            } else if (msg.phase === 'extracting') {
                progressEl.textContent = '…';
            }
        };
        try {
            await invoke('local_tts_download_model', { id, onProgress });
            this._showToast('Voice downloaded ✓', 'success');
            await this._refreshLocalVoices();
            this._fillLocalVoices(document.getElementById('select-local-lang')?.value || 'vi');
        } catch (err) {
            this._showToast(`Download failed: ${err}`, 'error');
            if (btn) btn.disabled = false;
            if (progressEl) progressEl.textContent = '';
        }
    }

    /** Delete an installed voice (real on-device removal), then re-render. */
    async _deleteLocalVoice(id) {
        try {
            await invoke('local_tts_delete_model', { id });
            this._showToast('Voice deleted', 'success');
            await this._refreshLocalVoices();
            this._fillLocalVoices(document.getElementById('select-local-lang')?.value || 'vi');
        } catch (err) {
            this._showToast(`Xoá thất bại: ${err}`, 'error');
        }
    }

    /**
     * Open the folder picker; on pick, persist as models dir and refresh.
     * Returns the chosen path, or null if the user cancelled (so callers can abort),
     * or '' if the picker itself failed.
     */
    async _maybePickModelsDir() {
        try {
            const { open } = window.__TAURI__.dialog;
            const picked = await open({ directory: true, multiple: false, title: 'Choose model folder' });
            if (picked === null || picked === undefined) return null; // cancelled
            const dir = Array.isArray(picked) ? picked[0] : picked;
            await settingsManager.save({ local_tts_models_dir: dir });
            const dirInput = document.getElementById('input-local-models-dir');
            if (dirInput) dirInput.value = dir;
            await this._refreshLocalVoices();
            this._fillLocalVoices(document.getElementById('select-local-lang')?.value || 'vi');
            return dir;
        } catch (err) {
            console.warn('[Local TTS] folder pick failed:', err);
            return '';
        }
    }

    /** Reset the model folder back to the default app location and refresh the list. */
    async _resetModelsDir() {
        await settingsManager.save({ local_tts_models_dir: '' });
        const dirInput = document.getElementById('input-local-models-dir');
        if (dirInput) {
            try {
                dirInput.value = await invoke('local_tts_models_dir_path');
            } catch {
                dirInput.value = 'Default app location';
            }
        }
        await this._refreshLocalVoices();
        this._fillLocalVoices(document.getElementById('select-local-lang')?.value || 'vi');
        this._showToast('Model folder reset to default', 'success');
    }

    _updateTranslationTypeUI(type) {
        const oneway = document.getElementById('section-oneway-langs');
        const twoway = document.getElementById('section-twoway-langs');
        const hintTwoway = document.getElementById('hint-twoway');
        const strictLang = document.getElementById('section-strict-lang');

        if (type === 'two_way') {
            if (oneway) oneway.style.display = 'none';
            if (twoway) twoway.style.display = 'flex';
            if (hintTwoway) hintTwoway.style.display = 'block';
            // Hide strict lang in two-way mode (both languages are specified)
            if (strictLang) strictLang.style.display = 'none';
            // Force-disable TTS in two-way mode to prevent audio feedback loop
            if (this.ttsEnabled) {
                this.ttsEnabled = false;
                this._getActiveTTS().disconnect();
                audioPlayer.stop();
            }
            this._updateTTSButton();
        } else {
            if (oneway) oneway.style.display = 'flex';
            if (twoway) twoway.style.display = 'none';
            if (hintTwoway) hintTwoway.style.display = 'none';
            if (strictLang) strictLang.style.display = 'flex';
            this._updateTTSButton();
        }
    }

    _updateTTSButton() {
        const btn = document.getElementById('btn-tts');
        const iconOff = document.getElementById('icon-tts-off');
        const iconOn = document.getElementById('icon-tts-on');
        const isTwoWay = document.getElementById('select-translation-type')?.value === 'two_way';

        if (btn) {
            btn.classList.toggle('active', this.ttsEnabled);
            btn.classList.toggle('disabled', isTwoWay);
            btn.title = isTwoWay ? 'TTS disabled in two-way mode' : 'Toggle TTS (Ctrl+T)';
        }
        if (iconOff) iconOff.style.display = this.ttsEnabled ? 'none' : 'block';
        if (iconOn) iconOn.style.display = this.ttsEnabled ? 'block' : 'none';
    }

    _speakIfEnabled(text) {
        if (this.ttsEnabled && text?.trim()) {
            this._getActiveTTS().speak(text);
        }
    }

    // ─── Read Mode (in-overlay TTS reader) ─────────────────

    // Conservative per-provider chunk caps (chars). Local is offline (no endpoint cap);
    // cloud providers use safe values; google-free/tiktok stay well under their real caps
    // (TikTok's Rust command hard-caps at 280). Raise only after measuring a live call.
    static get READ_MAX_LEN() {
        return { local: 400, edge: 200, microsoft: 200, google: 200, 'google-free': 120, tiktok: 120 };
    }

    _initReadMode() {
        // Activity shell: switcher clicks → panels; side effects handled here.
        initShell();
        document.addEventListener('activity-changed', (e) => this._onActivityChanged(e.detail));
        // Overflow menu (⋯) in the Live action row
        this._moreMenu = bindMenu('btn-more', 'more-menu');
        // Menu items that navigate/close: shut the menu after action
        ['btn-copy', 'btn-clear', 'btn-compact', 'btn-shortcuts', 'btn-notes', 'btn-theme-toggle'].forEach((id) => {
            document.getElementById(id)?.addEventListener('click', () => this._moreMenu.close());
        });
        // Shortcut sheet (⋯ menu + `?` key; Esc/click-outside closes)
        const sheet = document.getElementById('shortcut-sheet');
        const toggleSheet = (show) => { if (sheet) sheet.style.display = show ? '' : 'none'; };
        document.getElementById('btn-shortcuts')?.addEventListener('click', () => toggleSheet(true));
        sheet?.addEventListener('click', (e) => { if (e.target === sheet) toggleSheet(false); });
        this._toggleShortcutSheet = toggleSheet;

        // Read quick-pick: save the active provider's voice key + re-check capability
        document.getElementById('read-voice-quick')?.addEventListener('change', (e) => {
            const key = e.target.dataset.key;
            if (!key) return;
            settingsManager.save({ [key]: e.target.value });
            this._showReadCapabilityHint();
        });
        // "Chỉnh thêm…" deep-links to Settings → TTS detail
        document.getElementById('btn-read-tts-settings')?.addEventListener('click', () => {
            this._showView('settings');
            this._showSettingsScreen('tab-tts');
        });
        // Auto-hide toolbar toggle (✓ prefix reflects state; persists in localStorage)
        const autoHideBtn = document.getElementById('btn-auto-hide');
        const renderAutoHide = () => {
            if (autoHideBtn) {
                autoHideBtn.textContent = `${isAutoHideEnabled() ? '✓' : '　'} Tự ẩn khi đang dịch`;
            }
        };
        renderAutoHide();
        autoHideBtn?.addEventListener('click', () => {
            setAutoHideEnabled(!isAutoHideEnabled());
            renderAutoHide();
        });
        document.getElementById('btn-read-play')?.addEventListener('click', () => {
            // Play doubles as Resume when paused — do NOT rebuild the reader.
            if (this._reader && this._reader.state === 'paused') this._reader.play();
            else this._startRead();
        });
        document.getElementById('btn-read-pause')?.addEventListener('click', () => {
            this._reader?.pause();
        });
        document.getElementById('btn-read-stop')?.addEventListener('click', () => this._stopRead());
    }

    /** Side effects when the activity switcher changes space. Panel visibility
     *  itself is owned by ui-shell; this handles pause/drain/render concerns. */
    _onActivityChanged({ activity, previous }) {
        if (previous === 'read' && activity !== 'read') this._exitReadMode();
        if (activity === 'read') this._enterReadMode();
        if (activity === 'library') this._showSessions();
        if (previous === 'library' && activity !== 'library') this.studyView.flush();
    }

    async _enterReadMode() {
        // Stop any running Live session AND drain the shared provider's queue so an in-flight
        // Live synth cannot fire onAudioChunk into the Live context after the switch.
        // Panel visibility is owned by ui-shell; here we only hide the Live-only
        // toolbar controls (shared toolbar until the phase-2 consolidation).
        if (this.isRunning) await this.pause();
        try { this._getActiveTTS().disconnect(); } catch { /* provider may be idle */ }

        this._readMode = 'read'; // legacy alias for getActivity()==='read' checks
        // Live controls now live inside the Live panel, which ui-shell hides —
        // no per-element toggling needed anymore.
        this._resetReadUI();
        this._populateReadQuickPick();
        this._showReadCapabilityHint();
    }

    /**
     * Voice quick-pick in the Read panel — mirrors the active provider's voice
     * options from its Settings select (DRY: one source of options, two views).
     * Local voices come from the installed catalog instead.
     */
    async _populateReadQuickPick() {
        const sel = document.getElementById('read-voice-quick');
        if (!sel) return;
        const s = settingsManager.get();
        const provider = s.tts_provider || 'edge';
        const map = {
            edge: { src: 'select-edge-voice', key: 'edge_tts_voice' },
            microsoft: { src: 'select-microsoft-voice', key: 'microsoft_v2_voice' },
            'google-free': { src: 'select-google-free-voice', key: 'google_free_voice' },
            tiktok: { src: 'select-tiktok-voice', key: 'tiktok_voice' },
            google: { src: 'select-google-voice', key: 'google_tts_voice' },
            elevenlabs: { src: 'select-tts-voice', key: 'tts_voice_id' },
        };
        sel.innerHTML = '';
        if (provider === 'local') {
            await this._refreshLocalVoices();
            const installed = (this._localVoices || []).filter(v => v.installed);
            installed.forEach(v => sel.add(new Option(v.display, v.id)));
            sel.dataset.key = 'local_tts_voice';
            if (s.local_tts_voice) sel.value = s.local_tts_voice;
            sel.disabled = installed.length === 0;
        } else {
            const m = map[provider] || map.edge; // legacy/unknown provider → safe fallback
            const src = document.getElementById(m.src);
            if (src) [...src.options].forEach(o => sel.add(new Option(o.textContent, o.value)));
            sel.dataset.key = m.key;
            const cur = s[m.key];
            if (cur) sel.value = cur;
            sel.disabled = sel.options.length === 0;
        }
    }

    _exitReadMode() {
        this._stopRead();
        this._readMode = 'live';
    }

    _setEl(id, display) {
        const el = document.getElementById(id);
        if (el) el.style.display = display;
    }

    /** Capability = usability, not method existence. Returns {ok, reason, provider}. */
    async _readCapability() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';
        const tts = this._getActiveTTS();
        if (typeof tts.synthesize !== 'function') {
            return { ok: false, reason: 'Nhà cung cấp TTS này không hỗ trợ chế độ Đọc. Hãy chọn Edge, Local, Microsoft, Google hoặc TikTok.' };
        }
        if (provider === 'google' && !settings.google_tts_api_key) {
            return { ok: false, reason: 'Thiếu Google Cloud API key (Cài đặt → TTS → Google).' };
        }
        if (provider === 'tiktok' && !settings.tiktok_session_id) {
            return { ok: false, reason: 'Thiếu TikTok sessionid (Cài đặt → TTS → TikTok).' };
        }
        if (provider === 'local') {
            const installed = await this._isLocalVoiceInstalled(settings.local_tts_voice);
            if (!installed) return { ok: false, reason: 'Chưa tải model giọng Local (Cài đặt → TTS → Local).' };
        }
        return { ok: true, provider };
    }

    async _showReadCapabilityHint() {
        const hintEl = document.getElementById('read-hint');
        const cap = await this._readCapability();
        const playBtn = document.getElementById('btn-read-play');
        if (this._readMode !== 'read') return;
        if (hintEl) hintEl.textContent = cap.ok ? '' : cap.reason;
        if (playBtn) playBtn.disabled = !cap.ok;
    }

    async _startRead() {
        const cap = await this._readCapability();
        if (!cap.ok) { this._showReadCapabilityHint(); return; }

        const text = (document.getElementById('read-input')?.value || '').trim();
        if (!text) { this._showToast('Nhập văn bản để đọc', 'error'); return; }

        const settings = settingsManager.get();
        const provider = cap.provider;
        const tts = this._getActiveTTS();
        this._configureTTS(tts, settings); // set voice/key/session + client rate

        // Client-side rate: only providers without a server rate param.
        const clientRate = provider === 'google-free' ? (settings.google_free_speed || 1.0)
            : provider === 'tiktok' ? (settings.tiktok_speed || 1.0) : 1.0;
        readAudioPlayer.setReadRate(clientRate);

        const lookahead = provider === 'local' ? 2 : 1;
        const interChunkDelayMs = (provider === 'google-free' || provider === 'tiktok') ? 250 : 0;
        const maxLen = App.READ_MAX_LEN[provider] || 120;

        this._reader?.stop(); // never leak a previous (e.g. paused) reader — it could race audio
        readAudioPlayer.stop();
        this._reader = new Reader({
            synthesize: (t) => tts.synthesize(t),
            player: readAudioPlayer,
            lookahead,
            interChunkDelayMs,
        });
        this._reader.onProgress = (n, total) => this._updateReadProgress(n, total);
        this._reader.onSentence = (i) => this._highlightReadChunk(i);
        this._reader.onChunkError = (i) => this._markReadChunkError(i);
        this._reader.onError = (msg) => this._showToast(msg, 'error');
        this._reader.onState = (state) => this._onReadState(state);

        this._reader.load(text, maxLen);
        if (this._reader.total === 0) { this._showToast('Không có nội dung để đọc', 'error'); return; }
        this._renderReadChunks(this._reader.chunks);
        this._reader.play();
    }

    _stopRead() {
        this._reader?.stop();
        this._reader = null;
        this._resetReadUI();
    }

    _onReadState(state) {
        if (state === 'playing') this._updateReadControls('playing');
        else if (state === 'paused') this._updateReadControls('paused');
        else if (state === 'done' || state === 'stopped') {
            this._updateReadControls('idle');
        }
    }

    _updateReadControls(mode) {
        // mode: 'idle' | 'playing' | 'paused'
        if (mode === 'idle') {
            this._setEl('btn-read-play', '');
            this._setEl('btn-read-pause', 'none');
            this._setEl('btn-read-stop', 'none');
            this._setEl('read-input', '');
            this._setEl('read-output', 'none');
        } else if (mode === 'playing') {
            this._setEl('btn-read-play', 'none');
            this._setEl('btn-read-pause', '');
            this._setEl('btn-read-stop', '');
            this._setEl('read-input', 'none');
            this._setEl('read-output', '');
        } else if (mode === 'paused') {
            this._setEl('btn-read-play', ''); // play acts as resume
            this._setEl('btn-read-pause', 'none');
            this._setEl('btn-read-stop', '');
        }
    }

    _resetReadUI() {
        this._updateReadControls('idle');
        const out = document.getElementById('read-output');
        if (out) out.innerHTML = '';
        const prog = document.getElementById('read-progress');
        if (prog) prog.textContent = '';
        const fill = document.getElementById('read-progress-fill');
        if (fill) fill.style.width = '0%';
    }

    /** Build chunk spans with textContent (never innerHTML) — pasted text is untrusted. */
    _renderReadChunks(chunks) {
        const out = document.getElementById('read-output');
        if (!out) return;
        out.innerHTML = '';
        chunks.forEach((c, i) => {
            const span = document.createElement('span');
            span.className = 'read-chunk';
            span.dataset.index = String(i);
            span.textContent = c + ' ';
            out.appendChild(span);
        });
    }

    _highlightReadChunk(index) {
        const out = document.getElementById('read-output');
        if (!out) return;
        out.querySelectorAll('.read-chunk.active').forEach((el) => el.classList.remove('active'));
        const span = out.querySelector(`.read-chunk[data-index="${index}"]`);
        if (span) {
            span.classList.add('active');
            span.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }

    _markReadChunkError(index) {
        const span = document.getElementById('read-output')
            ?.querySelector(`.read-chunk[data-index="${index}"]`);
        if (span) span.classList.add('error');
    }

    _updateReadProgress(n, total) {
        const prog = document.getElementById('read-progress');
        if (prog) prog.textContent = `đoạn ${n}/${total}`;
        const fill = document.getElementById('read-progress-fill');
        if (fill) fill.style.width = total ? `${Math.round((n / total) * 100)}%` : '0%';
    }

    // ─── Source Control ────────────────────────────────────

    _setSource(source) {
        const wasRunning = this.isRunning;
        const labels = { system: 'System Audio', microphone: 'Microphone', both: 'System + Mic' };
        const label = labels[source] || source;
        // Persist so subsequent settings notifications don't reset us back.
        settingsManager.save({ audio_source: source });

        if (wasRunning) {
            this.pause().then(() => {
                this.currentSource = source;
                this._updateSourceButtons();
                this._showToast(`Đã chuyển sang ${label}`, 'success');
                this.start();
            });
        } else {
            this.currentSource = source;
            this._updateSourceButtons();
            this._showToast(`Nguồn: ${label}`, 'success');
        }
    }

    _updateSourceButtons() {
        const sel = document.getElementById('select-audio-source');
        if (sel) sel.value = this.currentSource;
    }

    // ─── Engine picker (Standard vs OpenAI) ──────────────────
    // OpenAI Realtime is structurally different (text+voice fused, no two-way,
    // no custom TTS), so we surface the choice as a top-level decision rather
    // than burying it in Settings. "Standard" represents the Soniox/Local pair
    // — they share the same UX shape (text-only, optional TTS, two-way, etc.).

    _engineClassFromMode(mode) {
        // Pill buttons are one per engine (soniox / local / openai / qwen).
        return ['soniox', 'local', 'openai', 'qwen'].includes(mode) ? mode : 'soniox';
    }

    _selectEngineClass(klass) {
        const settings = settingsManager.get();
        const currentMode = settings.translation_mode || 'soniox';
        let nextMode = currentMode;
        if (klass === 'openai' || klass === 'qwen' || klass === 'soniox' || klass === 'local') {
            nextMode = klass;
        } else if (klass === 'standard') {
            // Welcome-screen card still groups Soniox/Local as "Standard".
            // Stay on whatever standard sub-engine was configured before, or
            // default to soniox if previously a cloud realtime engine.
            nextMode = (currentMode === 'soniox' || currentMode === 'local')
                ? currentMode : 'soniox';
        }

        const saved = settingsManager.save({ translation_mode: nextMode });
        const select = document.getElementById('select-translation-mode');
        if (select) select.value = nextMode;
        this._updateModeUI(nextMode);
        // Callers that start right after switching await this, so start()
        // reads the new mode rather than the one being replaced.
        return saved;
    }

    _updatePillState(mode) {
        const klass = this._engineClassFromMode(mode);
        const s = settingsManager.get();
        // Readiness dot per engine: key present (cloud) / Apple Silicon (local).
        const ready = {
            soniox: !!(s.soniox_api_key || '').trim(),
            openai: !!(s.openai_api_key || '').trim(),
            qwen: !!(s.qwen_api_key || '').trim(),
            local: this._localModelsReady === true,
        };
        document.querySelectorAll('#engine-pill .engine-pill-btn').forEach(btn => {
            const k = btn.dataset.engineClass;
            btn.classList.toggle('active', k === klass);
            const dot = btn.querySelector('.engine-pill-dot');
            if (dot) dot.classList.toggle('ok', !!ready[k]);
        });
    }

    _setEnginePillLocked(locked) {
        const pill = document.getElementById('engine-pill');
        if (!pill) return;
        pill.dataset.locked = locked ? 'true' : 'false';
        pill.querySelectorAll('.engine-pill-btn').forEach(btn => { btn.disabled = locked; });
    }

    _showEnginePicker() {
        const picker = document.getElementById('engine-picker');
        if (picker) picker.style.display = '';
    }

    _hideEnginePicker() {
        const picker = document.getElementById('engine-picker');
        if (picker) picker.style.display = 'none';
        this._enginePickerDismissed = true;
        // Persist: the picker is a first-run question, not a per-launch modal.
        if (!settingsManager.get().engine_picker_done) {
            settingsManager.save({ engine_picker_done: true }).catch(e => console.warn('[Picker] save failed:', e));
        }
    }

    async _maybeShowEnginePicker() {
        // First run only (settings.engine_picker_done): the onboarding wizard
        // (Soniox key → offline pack → subject → mic test). Afterwards the
        // toolbar pill switches engines.
        if (this._enginePickerDismissed || settingsManager.get().engine_picker_done) return;
        if (this.isRunning || this.isStarting) return;
        if (this.transcriptUI && this.transcriptUI.hasContent()) return;
        this._enginePickerDismissed = true;
        const { mode } = await runFirstRunWizard({ pingSoniox: (k) => this._pingSoniox(k) });
        const s = settingsManager.get();
        this.currentSource = s.audio_source || 'microphone';
        this._updateSourceButtons();
        await this._selectEngineClass(mode);
        this._renderProfileSelects?.();
        this._refreshLocalModelsStatus();
        this._pulseStartButton();
    }

    /** Draw the eye to Start once, after onboarding (no motion if reduced). */
    _pulseStartButton() {
        const btn = document.getElementById('btn-start');
        if (!btn) return;
        btn.classList.add('attention');
        setTimeout(() => btn.classList.remove('attention'), 6000);
    }

    _updateModeUI(mode) {
        const isSoniox = mode === 'soniox';
        const isLocal = mode === 'local';
        const isOpenAi = mode === 'openai';
        const isQwen = mode === 'qwen';
        // Cloud-realtime engines that share the OpenAI-style audio toggle,
        // mic-only capture, and dual-panel routing. Used in place of bare
        // `isOpenAi` checks below so Qwen inherits the same UI shape.
        const isCloudRealtime = isOpenAi || isQwen;
        this._updatePillState(mode);

        // Single dynamic hint line per engine (mobile parity). Only #hint-mode-soniox
        // stays visible as the live container; the other hint nodes are kept hidden
        // so existing IDs remain wired but don't clutter the panel.
        const hintSoniox = document.getElementById('hint-mode-soniox');
        const hintLocal = document.getElementById('hint-mode-local');
        const hintOpenAi = document.getElementById('hint-mode-openai');
        const hintQwen = document.getElementById('hint-mode-qwen');
        const ENGINE_HINTS = {
            soniox: 'Cloud · 60+ ngôn ngữ · dùng từ điển môn học · chữ hiện sau ~1–2 s',
            local: 'Offline · X-ASR + Hy-MT2 trên máy · bản dịch hiện sau khi hết mỗi câu (~1–2 s)',
            openai: 'Cloud · có giọng nói dịch · không dùng từ điển',
            qwen: 'Cloud · 60+ ngôn ngữ · chỉ văn bản · không dùng từ điển · chọn ngôn ngữ nguồn',
        };
        if (hintSoniox) {
            hintSoniox.textContent = ENGINE_HINTS[mode] || '';
            hintSoniox.style.display = '';
        }
        // Highlight a warning when the picked engine can't run yet — either
        // Local MLX on unsupported hardware, or a cloud engine missing its key.
        // The option stays selectable (Hiếu's ask): the user needs to pick it
        // to add the key; start() blocks launch until the requirement is met.
        const s = settingsManager.get();
        const localUnsupported = isLocal && this._localModelsReady === false;
        const missingKey =
            (isSoniox && !(s.soniox_api_key || '').trim()) ? 'Soniox' :
            (isOpenAi && !(s.openai_api_key || '').trim()) ? 'OpenAI Realtime' :
            (isQwen && !(s.qwen_api_key || '').trim()) ? 'Qwen' : null;
        if (hintSoniox) {
            const warn = localUnsupported || !!missingKey;
            hintSoniox.classList.toggle('hint-warning', warn);
            if (localUnsupported) {
                hintSoniox.textContent = '⚠️ Cần tải gói offline — bấm Bắt đầu, app sẽ hỏi tải.';
            } else if (missingKey) {
                hintSoniox.textContent = `⚠️ ${missingKey} cần API key — nhập key bên dưới rồi mới bắt đầu được.`;
            }
        }
        if (hintLocal) hintLocal.style.display = 'none';
        if (hintOpenAi) hintOpenAi.style.display = 'none';
        if (hintQwen) hintQwen.style.display = 'none';

        const costWarning = document.getElementById('openai-cost-warning');
        if (costWarning) costWarning.style.display = isOpenAi ? '' : 'none';

        // Mobile-parity: show only the key section for the active engine.
        // Local hides them all (no key needed).
        const sectionApiKey = document.getElementById('section-api-key');
        const sectionOpenAiKey = document.getElementById('section-openai-key');
        const sectionQwenKey = document.getElementById('section-qwen-key');
        if (sectionApiKey) sectionApiKey.style.display = isSoniox ? '' : 'none';
        if (sectionOpenAiKey) sectionOpenAiKey.style.display = isOpenAi ? '' : 'none';
        if (sectionQwenKey) sectionQwenKey.style.display = isQwen ? '' : 'none';

        // Soniox-only features: Custom context, Strict language detection,
        // Endpoint delay. The realtime engines manage these internally.
        const sectionContext = document.getElementById('section-soniox-context');
        if (sectionContext) sectionContext.style.display = isSoniox ? '' : 'none';
        const sectionStrictLang = document.getElementById('section-strict-lang');
        if (sectionStrictLang) sectionStrictLang.style.display = isSoniox ? '' : 'none';
        const sectionEndpointDelay = document.getElementById('section-endpoint-delay');
        if (sectionEndpointDelay) sectionEndpointDelay.style.display = isSoniox ? '' : 'none';

        // Two-way mode incompatible with realtime translation engines — force
        // one-way + disable the option for any cloud-realtime mode.
        const typeSelect = document.getElementById('select-translation-type');
        if (typeSelect) {
            const twoWayOpt = typeSelect.querySelector('option[value="two_way"]');
            if (twoWayOpt) twoWayOpt.disabled = isCloudRealtime;
            if (isCloudRealtime && typeSelect.value === 'two_way') {
                typeSelect.value = 'one_way';
                this._updateTranslationTypeUI('one_way');
            }
        }

        // Custom TTS toggle: cloud realtime engines run text-only to prevent
        // the speaker → mic feedback loop on shared devices.
        const ttsCheck = document.getElementById('check-tts-enabled');
        if (ttsCheck) {
            ttsCheck.disabled = isCloudRealtime;
            if (isCloudRealtime) ttsCheck.checked = false;
            const ttsDetail = document.getElementById('tts-settings-detail');
            if (ttsDetail) ttsDetail.style.display = (isCloudRealtime || !ttsCheck.checked) ? 'none' : '';
        }
        const btnTts = document.getElementById('btn-tts');
        if (btnTts) btnTts.style.display = isCloudRealtime ? 'none' : '';

        // Wizard: TTS availability shows on the home card (disabled + reason) —
        // never hidden. If the user is inside the TTS detail when switching to a
        // cloud-realtime engine, snap back to home so the state change is visible.
        this._updateSettingsCards();
        if (isCloudRealtime && document.getElementById('tab-tts')?.classList.contains('active')) {
            this._showSettingsScreen('settings-home');
        }
        const btnOpenAiAudio = document.getElementById('btn-openai-audio');
        if (btnOpenAiAudio) btnOpenAiAudio.style.display = 'none';

        // Restrict target language list to 13 OpenAI-supported in openai mode.
        // Qwen LiveTranslate Flash has its own 60-language list (mirrors mobile
        // v0.4.3); Qwen also hides Auto on the source picker because the model
        // rejects "auto" on real mic input.
        this._refreshTargetLangList(mode);
        this._refreshSourceLangList(mode);
    }

    _refreshTargetLangList(mode) {
        const select = document.getElementById('select-target-lang');
        if (!select) return;
        const OPENAI_LANGS = [
            ['en','English'], ['es','Spanish'], ['pt','Portuguese'], ['fr','French'],
            ['de','German'], ['it','Italian'], ['ru','Russian'], ['hi','Hindi'],
            ['id','Indonesian'], ['vi','Vietnamese'], ['ja','Japanese'],
            ['ko','Korean'], ['zh','Chinese'],
        ];
        const current = select.value;
        if (mode === 'openai') {
            if (!this._fullTargetLangHTML) this._fullTargetLangHTML = select.innerHTML;
            select.innerHTML = OPENAI_LANGS
                .map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
            select.value = OPENAI_LANGS.some(([c]) => c === current) ? current : 'vi';
        } else if (mode === 'qwen') {
            if (!this._fullTargetLangHTML) this._fullTargetLangHTML = select.innerHTML;
            const langs = QWEN_LANGS;
            select.innerHTML = langs
                .map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
            select.value = langs.some((l) => l.code === current) ? current : 'vi';
        } else if (this._fullTargetLangHTML) {
            select.innerHTML = this._fullTargetLangHTML;
            select.value = current || 'vi';
        }
    }

    _refreshSourceLangList(mode) {
        const select = document.getElementById('select-source-lang');
        if (!select) return;
        const current = select.value;
        if (mode === 'qwen') {
            if (!this._fullSourceLangHTML) this._fullSourceLangHTML = select.innerHTML;
            const langs = QWEN_LANGS;
            // No "Auto" — Live Flash stalls after one segment on real mic when
            // source isn't explicit (verified iPhone v0.4.2, 2026-05-25).
            select.innerHTML = langs
                .map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
            const validCurrent = langs.some((l) => l.code === current) && current !== 'auto';
            select.value = validCurrent ? current : 'en';
        } else if (this._fullSourceLangHTML) {
            select.innerHTML = this._fullSourceLangHTML;
            select.value = current || 'auto';
        }
    }

    // ─── API key validation & connection test ─────────────

    // Inline format check — runs on every keystroke. Cheap, no network.
    // Updates: per-field status badge + engine dropdown option enable/disable.
    _refreshKeyStatus() {
        const sonioxKey = document.getElementById('input-api-key')?.value.trim() || '';
        const openaiKey = document.getElementById('input-openai-key')?.value.trim() || '';

        // Soniox keys are opaque hex-like strings, ~32+ chars. Be lenient.
        const sonioxOk = sonioxKey.length >= 20;
        // OpenAI keys start with sk- and are ~50+ chars.
        const openaiOk = /^sk-[A-Za-z0-9_\-]{20,}$/.test(openaiKey);

        const sonioxStatus = document.getElementById('key-status-soniox');
        if (sonioxStatus) {
            sonioxStatus.className = 'key-status ' + (sonioxKey === '' ? '' : sonioxOk ? 'ok' : 'bad');
            sonioxStatus.textContent = sonioxKey === '' ? '' : sonioxOk ? '✓ format ok' : '✗ check format';
        }
        const openaiStatus = document.getElementById('key-status-openai');
        if (openaiStatus) {
            openaiStatus.className = 'key-status ' + (openaiKey === '' ? '' : openaiOk ? 'ok' : 'bad');
            openaiStatus.textContent = openaiKey === '' ? '' : openaiOk ? '✓ format ok' : '✗ should start with sk-';
        }

        // Engines that need a key stay SELECTABLE even when it's missing —
        // otherwise the user can't pick the engine to add its key (catch-22).
        // The label hints "add key first", and start() blocks launch until the
        // key is present. (Same not-hard-disabled principle as Local MLX.)
        const select = document.getElementById('select-translation-mode');
        if (select) {
            const sonioxOpt = select.querySelector('option[value="soniox"]');
            const openaiOpt = select.querySelector('option[value="openai"]');
            if (sonioxOpt) {
                sonioxOpt.disabled = false;
                sonioxOpt.textContent = sonioxOk ? '☁️ Soniox' : '☁️ Soniox — cần nhập key';
            }
            if (openaiOpt) {
                openaiOpt.disabled = false;
                openaiOpt.textContent = openaiOk ? '⚡ OpenAI Realtime' : '⚡ OpenAI Realtime — cần nhập key';
            }
        }
    }

    // Live ping the provider to verify key actually works.
    async _testConnection(provider) {
        const statusEl = document.getElementById(`key-status-${provider}`);
        const btn = document.getElementById(`btn-test-${provider}`);
        if (!statusEl || !btn) return;

        const inputId = provider === 'soniox' ? 'input-api-key' : 'input-openai-key';
        const key = document.getElementById(inputId)?.value.trim() || '';
        if (!key) {
            statusEl.className = 'key-status bad';
            statusEl.textContent = '✗ empty';
            return;
        }

        btn.disabled = true;
        statusEl.className = 'key-status checking';
        statusEl.textContent = '… testing';

        try {
            const ok = provider === 'soniox'
                ? await this._pingSoniox(key)
                : await this._pingOpenAi(key);
            statusEl.className = 'key-status ' + (ok ? 'ok' : 'bad');
            statusEl.textContent = ok ? '✓ connected' : '✗ rejected';
        } catch (e) {
            statusEl.className = 'key-status bad';
            statusEl.textContent = '✗ ' + (e?.message || 'failed');
        } finally {
            btn.disabled = false;
        }
    }

    // Soniox: open WS, send config, wait for first response, close.
    _pingSoniox(apiKey) {
        return new Promise((resolve) => {
            const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
            const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 5000);
            ws.onopen = () => {
                ws.send(JSON.stringify({ api_key: apiKey, model: 'stt-rt-v5', audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1 }));
            };
            ws.onmessage = (e) => {
                clearTimeout(timer);
                try {
                    const v = JSON.parse(e.data);
                    resolve(!v.error_code);
                } catch { resolve(true); }
                try { ws.close(); } catch {}
            };
            ws.onerror = () => { clearTimeout(timer); resolve(false); };
        });
    }

    // OpenAI: cheap HTTP GET /v1/models with the key.
    async _pingOpenAi(apiKey) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
            const r = await fetch('https://api.openai.com/v1/models', {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: ctrl.signal,
            });
            return r.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    // ─── Start/Stop ────────────────────────────────────────

    async start() {
        let settings = settingsManager.get();
        this.translationMode = settings.translation_mode || 'soniox';
        // Never log the settings object — it contains every API key.
        console.log('[App] start() called, translation_mode:', this.translationMode,
            'source:', settings.audio_source, 'langs:', `${settings.source_language}→${settings.target_language}`);

        // Whatever is missing gets a dialog with the button that fixes it;
        // once fixed, starting simply continues.
        if (this.translationMode === 'local' && !(await this._refreshLocalModelsStatus())) {
            if (!(await ensureOfflinePack())) return;
            await this._refreshLocalModelsStatus();
        }
        const keyFor = { soniox: 'soniox_api_key', openai: 'openai_api_key', qwen: 'qwen_api_key' }[this.translationMode];
        if (keyFor && !(settings[keyFor] || '').trim()) {
            const ping = this.translationMode === 'soniox' ? (k) => this._pingSoniox(k)
                : this.translationMode === 'openai' ? (k) => this._pingOpenAi(k) : null;
            const r = await askApiKey(this.translationMode, { ping });
            if (r === 'offline') { await this._selectEngineClass('local'); return this.start(); }
            if (r !== 'saved') return;
            settings = settingsManager.get();
        }

        // Check ElevenLabs key only if TTS is enabled AND provider is elevenlabs
        if (this.ttsEnabled && settings.tts_provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('Đọc bản dịch đang bật nhưng thiếu API key ElevenLabs — nhập trong Cài đặt hoặc tắt đọc', 'error');
            this._showView('settings');
            return;
        }

        this.isRunning = true;
        this._updateStartButton();
        this._hideEnginePicker();
        this._armMicWatch(settings);
        this._setEnginePillLocked(true);
        if (!this.recordingStartTime) this.recordingStartTime = Date.now();

        // Record session metadata for auto-save
        if (!this.sessionStartTime) {
            this.sessionStartTime = new Date();
            const translationType = settings.translation_type || 'one_way';
            this.sessionMode = translationType;
            if (translationType === 'two_way') {
                this.sessionSourceLang = settings.language_a || 'zh';
                this.sessionTargetLang = settings.language_b || 'vi';
            } else {
                this.sessionSourceLang = settings.source_language || 'auto';
                this.sessionTargetLang = settings.target_language || 'vi';
            }
        }

        // Begin a session chunk — every Start/Stop cycle becomes one chunk in
        // the persistent SessionStore. Engine/lang may have changed since
        // last chunk, so pass them in.
        sessionStore.beginChunk({
            engine: this.translationMode,
            sourceLang: this.sessionSourceLang,
            targetLang: this.sessionTargetLang,
        });

        // Clear transcript only if nothing is showing
        if (!this.transcriptUI.hasContent()) {
            this.transcriptUI.showListening();
        } else {
            this.transcriptUI.clearProvisional();
        }

        if (this.translationMode === 'local') {
            await this._startLocalMode(settings);
        } else if (this.translationMode === 'openai') {
            await this._startOpenAiMode(settings);
        } else if (this.translationMode === 'qwen') {
            await this._startQwenMode(settings);
        } else {
            await this._startSonioxMode(settings);
        }

        // Start TTS if enabled — skipped in realtime modes (built-in audio)
        if (this.ttsEnabled && this.translationMode !== 'openai' && this.translationMode !== 'qwen') {
            const tts = this._getActiveTTS();
            this._configureTTS(tts, settings);
            tts.connect();
            audioPlayer.resume();
        }
    }

    async _startOpenAiMode(settings) {
        this._updateStatus('connecting');
        const { OpenAiRealtimeClient } = await import('./openai-realtime-client.js');
        const { OpenAiAudioOutputQueue } = await import('./openai-audio-output-queue.js');

        // Tell the UI which provider is active so dual-panel rendering routes
        // provisional text to the correct panel (source vs target).
        this.transcriptUI.provider = 'openai';

        this.openAiOutputQueue = new OpenAiAudioOutputQueue();
        this.openAiClient = new OpenAiRealtimeClient();

        this.openAiClient.onStatusChange = (state, message) => {
            if (state === 'ready') this._updateStatus('connected');
            else if (state === 'connecting') this._updateStatus('connecting');
            else if (state === 'backlog_skipped') this._onBacklog(false, parseFloat(message) || 0);
        };
        this.openAiClient.onProvisional = (text) => {
            this.transcriptUI.setProvisional(text, null, null);
        };
        this.openAiClient.onSourceProvisional = (text) => {
            // Source-side provisional: keep dual panel responsive while ASR runs.
            this.transcriptUI.setSourceProvisional?.(text);
        };
        this.openAiClient.onSegment = (sourceText, translatedText) => {
            // Pair source + translation atomically so FIFO matching in addTranslation works.
            if (sourceText) this.transcriptUI.addOriginal(sourceText, null, null);
            this.transcriptUI.addTranslation(translatedText);
            // Atomic write to session store — bypass UI's loose FIFO since
            // OpenAI gives us both texts in one event.
            sessionStore.addSegment(sourceText || '', translatedText || '');
            this._autoMarkExam(sourceText || '');
            this.transcriptUI.clearSourceProvisional?.();
            this.transcriptUI.clearProvisional();
        };
        this.openAiClient.onError = (code, msg) => {
            console.error('[OpenAI Realtime]', code, msg);
            this._showToast(`${code}: ${msg}`, 'error');
            this._updateStatus('error');
        };
        this.openAiClient.onClosed = (reason) => {
            console.warn('[OpenAI Realtime] closed:', reason);
            if (this.isRunning) {
                this._showToast('OpenAI ngắt kết nối — đang nối lại…', 'success');
                setTimeout(() => {
                    if (this.isRunning) this._startOpenAiMode(settingsManager.get());
                }, 1000);
            }
        };

        try {
            await this.openAiClient.connect({
                apiKey: settings.openai_api_key,
                model: settings.openai_model || MODEL_DEFAULTS.openai,
                sourceLanguage: settings.source_language || 'auto',
                targetLanguage: settings.target_language,
                audioOutput: false,
            }, this.openAiOutputQueue);
        } catch (err) {
            this._showToast(`Không kết nối được OpenAI: ${err}`, 'error');
            await this.pause();
            return;
        }

        try {
            let audioBatchCount = 0;
            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                audioBatchCount++;
                this._micWatch?.feed(pcmData);
                if (audioBatchCount <= 3 || audioBatchCount % 50 === 0) {
                    console.log(`[OpenAI capture] batch #${audioBatchCount}, size:`, pcmData?.byteLength ?? pcmData?.length ?? 0);
                }
                const bytes = new Uint8Array(pcmData);
                this.openAiClient.sendAudio(bytes.buffer);
            };
            console.log('[OpenAI] Starting audio capture, source:', this.currentSource);
            await invoke('start_capture', {
                source: this.currentSource,
                channel,
            });
            console.log('[OpenAI] start_capture invoked OK');
        } catch (err) {
            console.error('Failed to start audio capture:', err);
            this._showToast(`Lỗi âm thanh: ${err}`, 'error');
            await this.pause();
        }
    }

    async _startQwenMode(settings) {
        this._updateStatus('connecting');
        const { QwenRealtimeClient } = await import('./qwen-realtime-client.js');

        // Live Flash is translation-only (no source transcript). Force the
        // single-panel translation view; dual-panel would render an empty
        // source column.
        this.transcriptUI.provider = 'qwen';

        this.qwenClient = new QwenRealtimeClient();

        this.qwenClient.onStatusChange = (state, message) => {
            if (state === 'ready') this._updateStatus('connected');
            else if (state === 'connecting') this._updateStatus('connecting');
            else if (state === 'backlog_skipped') this._onBacklog(false, parseFloat(message) || 0);
        };
        this.qwenClient.onProvisional = (text) => {
            this.transcriptUI.setProvisional(text, null, null);
        };
        this.qwenClient.onSegment = (sourceText, translatedText) => {
            this.transcriptUI.addTranslation(translatedText);
            sessionStore.addSegment('', translatedText || '');
            this.transcriptUI.clearProvisional();
        };
        this.qwenClient.onError = (code, msg) => {
            console.error('[Qwen Realtime]', code, msg);
            this._showToast(`${code}: ${msg}`, 'error');
            this._updateStatus('error');
        };
        this.qwenClient.onClosed = (reason) => {
            console.warn('[Qwen Realtime] closed:', reason);
            if (this.isRunning) {
                this._showToast('Qwen ngắt kết nối — đang nối lại…', 'success');
                setTimeout(() => {
                    if (this.isRunning) this._startQwenMode(settingsManager.get());
                }, 1000);
            }
        };

        try {
            // Live Flash rejects "auto" — fall back to English. UI also
            // strips the "auto" option when engine = qwen (see
            // _refreshSourceLangList), so this is belt-and-suspenders.
            const sourceLang =
                settings.source_language && settings.source_language !== 'auto'
                    ? settings.source_language
                    : 'en';
            await this.qwenClient.connect({
                apiKey: settings.qwen_api_key,
                model: settings.qwen_model || MODEL_DEFAULTS.qwen,
                sourceLanguage: sourceLang,
                targetLanguage: settings.target_language,
            });
        } catch (err) {
            this._showToast(`Không kết nối được Qwen: ${err}`, 'error');
            await this.pause();
            return;
        }

        try {
            let audioBatchCount = 0;
            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                audioBatchCount++;
                this._micWatch?.feed(pcmData);
                if (audioBatchCount <= 3 || audioBatchCount % 50 === 0) {
                    console.log(`[Qwen capture] batch #${audioBatchCount}, size:`, pcmData?.byteLength ?? pcmData?.length ?? 0);
                }
                const bytes = new Uint8Array(pcmData);
                this.qwenClient.sendAudio(bytes.buffer);
            };
            console.log('[Qwen] Starting audio capture, source:', this.currentSource);
            await invoke('start_capture', {
                source: this.currentSource,
                channel,
            });
            console.log('[Qwen] start_capture invoked OK');
        } catch (err) {
            console.error('Failed to start audio capture:', err);
            this._showToast(`Lỗi âm thanh: ${err}`, 'error');
            await this.pause();
        }
    }

    async _startSonioxMode(settings) {
        // Connect to Soniox
        console.log('[App] Connecting to Soniox...');
        this.transcriptUI.provider = 'soniox';
        this._updateStatus('connecting');
        sonioxClient.connect({
            apiKey: settings.soniox_api_key,
            sourceLanguage: settings.source_language,
            targetLanguage: settings.target_language,
            model: settings.soniox_model || MODEL_DEFAULTS.soniox,
            customContext: this._activeProfileContext(),
            translationType: settings.translation_type || 'one_way',
            languageA: settings.language_a,
            languageB: settings.language_b,
            languageHintsStrict: settings.language_hints_strict || false,
            endpointDelay: settings.endpoint_delay || 1500,
        });

        // Start audio capture — Rust batches audio every 200ms, JS just forwards
        try {
            let audioChunkCount = 0;

            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                audioChunkCount++;
                this._micWatch?.feed(pcmData);
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Audio] Batch #${audioChunkCount}, size:`, pcmData?.byteLength ?? pcmData?.length ?? 0);
                }
                // Forward batched audio to Soniox
                const bytes = new Uint8Array(pcmData);
                sonioxClient.sendAudio(bytes.buffer);
            };

            console.log('[App] Starting audio capture, source:', this.currentSource);
            await invoke('start_capture', {
                source: this.currentSource,
                channel: channel,
            });
            console.log('[App] Audio capture started successfully');
        } catch (err) {
            console.error('Failed to start audio capture:', err);
            this._showToast(`Lỗi âm thanh: ${err}`, 'error');
            await this.pause();
        }
    }

    async _startLocalMode(settings) {
        console.log('[App] Starting Local engine (X-ASR + Hy-MT2, in-process)...');
        this.transcriptUI.provider = 'soniox';
        this._updateStatus('connecting');

        // Never start a session that can't run (start() normally checked already).
        if (!(await this._refreshLocalModelsStatus())) {
            await this.pause();
            if (await ensureOfflinePack()) { await this._refreshLocalModelsStatus(); this.start(); }
            return;
        }

        const { LocalEngineClient } = await import('./local-engine-client.js');
        this.localClient = new LocalEngineClient();
        this.localPipelineReady = false;

        this.localClient.onStatus = (state, message) => {
            if (state === 'loading') {
                if (message) {
                    const statusText = document.getElementById('status-text');
                    if (statusText) statusText.textContent = message;
                    this.transcriptUI.showStatusMessage(message);
                }
            } else if (state === 'ready') {
                this.localPipelineReady = true;
                this._updateStatus('connected');
                this.transcriptUI.removeStatusMessage();
                this.transcriptUI.showListening();
                this._showToast('Local: model đã sẵn sàng', 'success');
            } else if (state === 'backlog_skipped') {
                // Utterances dropped so translation stays current (count, not seconds).
                const n = parseInt(message, 10) || 0;
                if (n > 0) this._showToast(`⏩ Bỏ qua ${n} câu để bám kịp`, 'error');
            }
        };
        this.localClient.onResult = (src, tgt) => {
            // Chase effect: original first (dim), translation right after.
            if (src) this.transcriptUI.addOriginal(src);
            setTimeout(() => {
                if (tgt) {
                    this.transcriptUI.addTranslation(tgt);
                    this._speakIfEnabled(tgt);
                }
            }, 80);
            sessionStore.addSegment(src || '', tgt || '');
            this._autoMarkExam(src || '');
        };
        this.localClient.onError = (code, message) => {
            console.error('[Local]', code, message);
            this._showToast(`Local ${code}: ${message}`, 'error');
            if (code === 'asr_load' || code === 'llm_load') this._updateStatus('error');
        };
        this.localClient.onClosed = (reason) => {
            console.warn('[Local] closed:', reason);
            if (this.isRunning) this._updateStatus('disconnected');
        };

        try {
            const ctx = this._activeProfileContext();
            await this.localClient.connect({
                sourceLanguage: settings.source_language || 'auto',
                targetLanguage: settings.target_language || 'vi',
                glossary: (ctx?.translation_terms || []).map(t => ({ source: t.source, target: t.target })),
            });
        } catch (err) {
            console.error('Failed to start Local engine:', err);
            this.localClient = null;
            await this.pause();
            if (/^models_missing/.test(String(err))) {
                if (await ensureOfflinePack()) { await this._refreshLocalModelsStatus(); this.start(); }
            } else {
                this._showToast(`Chế độ offline không khởi động được: ${err}`, 'error');
            }
            return;
        }

        // Audio capture → engine (raw bytes). Models keep loading in the
        // background; audio arriving before "ready" is queued (bounded).
        try {
            const audioChannel = new window.__TAURI__.core.Channel();
            let audioChunkCount = 0;
            audioChannel.onmessage = (pcmData) => {
                audioChunkCount++;
                this._micWatch?.feed(pcmData);
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Local] Audio batch #${audioChunkCount}, size:`, pcmData?.byteLength ?? pcmData?.length ?? 0);
                }
                const bytes = new Uint8Array(pcmData);
                this.localClient?.sendAudio(bytes.buffer);
            };
            await invoke('start_capture', { source: this.currentSource, channel: audioChannel });
            console.log('[App] Audio capture started');
        } catch (err) {
            console.error('Audio capture failed:', err);
            this._showToast(`Âm thanh: ${err}`, 'error');
            await this.pause();
        }
    }

    /** Local engine model status → updates the Model tab row; true when all installed. */
    async _refreshLocalModelsStatus() {
        const el = document.getElementById('model-key-local');
        const btn = document.getElementById('btn-local-models-download');
        try {
            const list = await invoke('local_models_status');
            const missing = list.filter(m => !m.installed);
            this._localModelsReady = missing.length === 0;
            if (el) {
                el.textContent = this._localModelsReady
                    ? `● Offline: sẵn sàng${this.isAppleSilicon ? ' · Metal' : ''}`
                    : `○ Offline: chưa tải (${(missing.reduce((a, m) => a + m.size, 0) / 1e9).toFixed(1).replace('.', ',')} GB)`;
                el.classList.toggle('ok', this._localModelsReady);
            }
            if (btn) btn.style.display = this._localModelsReady ? 'none' : '';
        } catch (err) {
            this._localModelsReady = false;
            if (el) { el.textContent = '✗ không kiểm tra được'; el.classList.remove('ok'); }
        }
        this._updatePillState(settingsManager.get().translation_mode || 'soniox');
        return this._localModelsReady;
    }

    async _downloadLocalModels() {
        const btn = document.getElementById('btn-local-models-download');
        const progress = document.getElementById('local-models-progress');
        if (btn) btn.disabled = true;
        try {
            await downloadOfflinePack((st) => { if (progress) progress.textContent = `${Math.floor(st.frac * 100)} % · ${st.text}`; });
            this._showToast('Đã tải gói offline ✓', 'success');
            if (progress) progress.textContent = '';
        } catch (err) {
            if (progress) progress.textContent = err.message;
        } finally {
            if (btn) btn.disabled = false;
            await this._refreshLocalModelsStatus();
        }
    }

    /** Arm the denied-microphone detector for this Start (mic sources only). */
    _armMicWatch(settings) {
        this._micWatch = null;
        // The VAD gate sends only speech, so silence there is normal.
        if (this.currentSource === 'system' || settings.mic_vad) return;
        this._micWatch = new MicSilenceWatch(async () => {
            if (!this.isRunning) return;
            await this.pause();
            if ((await showMicPermissionDialog()) === 'retry') this.start();
        });
    }

    /** Soniox trouble with a way out: re-enter the key, or fall back to offline. */
    async _onSonioxError(message, kind) {
        if (kind === 'auth' || kind === 'credits') {
            if (this._sonioxDialogOpen) return;
            this._sonioxDialogOpen = true;
            try {
                if (this.isRunning) await this.pause();
                const reason = kind === 'auth' ? 'Soniox từ chối key hiện tại.' : 'Key Soniox đã hết hạn mức sử dụng. Hãy hỏi người đã cấp key cho bạn.';
                const r = await askApiKey('soniox', { reason, ping: (k) => this._pingSoniox(k) });
                if (r === 'saved') this.start();
                else if (r === 'offline') { await this._selectEngineClass('local'); this.start(); }
            } finally { this._sonioxDialogOpen = false; }
            return;
        }
        if (kind === 'lost') {
            if (this._sonioxDialogOpen || !this.isRunning) return;
            this._sonioxDialogOpen = true;
            try {
                await this.pause();
                const pack = await offlinePackStatus().catch(() => ({ ready: false }));
                await new Promise((resolve) => {
                    const toOffline = async (c) => {
                        c.close(); resolve();
                        if (await ensureOfflinePack()) { await this._selectEngineClass('local'); this.start(); }
                    };
                    openDialog({
                        icon: '📡',
                        title: 'Mất kết nối tới Soniox',
                        body: [Object.assign(document.createElement('p'), { className: 'dlg-text', textContent: pack.ready
                            ? 'Kiểm tra Wi-Fi hoặc VPN. Trong lúc chờ, bạn có thể dịch tiếp bằng chế độ offline trên máy.'
                            : 'Kiểm tra Wi-Fi hoặc VPN rồi thử lại. Muốn dịch cả khi mất mạng, hãy tải gói offline.' })],
                        onDismiss: resolve,
                        actions: [
                            { label: 'Thử lại', kind: 'secondary', onClick: (c) => { c.close(); resolve(); this.start(); } },
                            { label: pack.ready ? 'Dịch offline' : 'Tải gói offline', kind: 'primary', onClick: toOffline },
                        ],
                    });
                });
            } finally { this._sonioxDialogOpen = false; }
            return;
        }
        this._showToast(message, 'error');
    }

    // Pause: stop capture and persist the current chunk, but keep the session
    // file open. The next Start appends a new chunk to the same file. Finalizing
    // into a new file is stopSession()'s job.
    async pause() {
        this.isRunning = false;
        this._updateStartButton();
        this._setEnginePillLocked(false);

        // Stop audio capture
        try {
            await invoke('stop_capture');
        } catch (err) {
            console.error('Failed to stop audio capture:', err);
        }

        if (this.translationMode === 'local') {
            if (this.localClient) {
                try { await this.localClient.disconnect(); } catch {}
                this.localClient = null;
            }
            this.localPipelineReady = false;
            this.transcriptUI.removeStatusMessage();
            this._updateStatus('disconnected');
        } else if (this.translationMode === 'openai') {
            if (this.openAiClient) {
                try { await this.openAiClient.disconnect(); } catch {}
                this.openAiClient = null;
            }
            if (this.openAiOutputQueue) {
                this.openAiOutputQueue.close();
                this.openAiOutputQueue = null;
            }
            this._updateStatus('disconnected');
        } else if (this.translationMode === 'qwen') {
            if (this.qwenClient) {
                try { await this.qwenClient.disconnect(); } catch {}
                this.qwenClient = null;
            }
            try { await invoke('stop_capture'); } catch {}
            this._updateStatus('disconnected');
        } else {
            // Disconnect Soniox
            sonioxClient.disconnect();
        }

        // Keep transcript visible — don't clear
        this.transcriptUI.clearProvisional();

        // Stop TTS — every provider, not just the two WebSocket ones, so queued
        // lines don't keep playing after Pause.
        for (const tts of this._allTTS || [elevenLabsTTS, edgeTTSRust]) {
            try { tts.disconnect(); } catch (e) { console.warn('[TTS] disconnect failed:', e); }
        }

        audioPlayer.stop();

        // Drain any leftover Soniox originals that didn't get paired
        if (this._sonioxOriginalQueue) this._sonioxOriginalQueue.length = 0;

        // Close the chunk and persist the whole session (md + json sidecar).
        // Transcript stays on screen — clearSession is no longer called here
        // so user can review & continue in next chunk.
        sessionStore.endChunk();
        const result = await sessionStore.persist();
        if (result === 'saved') {
            const n = sessionStore.totalSegmentCount();
            this._showToast(`Đã lưu ${n} câu`, 'success');
        } else if (result === 'failed') {
            this._showToast('Lưu thất bại — phiên vẫn giữ trong bộ nhớ', 'error');
        }
        // 'skipped' → data already on disk or nothing to save; no toast.

        // sessionStartTime stays — pausing keeps the same session file, which
        // lives across many Start/Pause cycles. stopSession() resets it.
    }

    // Stop: pause (if running), finalize the current session file, then start a
    // fresh session so the next Start writes a new file pair. Keeps the
    // transcript on screen. Never wipes in-memory data on a failed save.
    async stopSession() {
        if (this.isRunning) await this.pause();

        if (sessionStore.isEmpty()) {
            this._showToast('Chưa có gì để lưu', 'success');
        } else {
            const result = await sessionStore.endSession();
            if (result === 'failed') {
                // Keep the in-memory session intact so the user can retry Stop.
                this._showToast('Lưu thất bại — phiên vẫn giữ trong bộ nhớ', 'error');
                return;
            }
            this._showToast('Đã lưu buổi học — lần Bắt đầu sau sẽ tạo buổi mới', 'success');
        }

        // Reset session identity: fresh ID + current settings so the next Start
        // writes a new file. Resetting sessionStartTime forces start() to
        // re-stamp the metadata block with the current language pair.
        this.sessionStartTime = null;
        const settings = settingsManager.get();
        sessionStore.init({
            engine: settings.translation_mode || 'soniox',
            sourceLang: settings.source_language || 'auto',
            targetLang: settings.target_language || 'vi',
        });
        this._syncNotesFromStore(); // new session → empty notes pane
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Persist the session on the way out. endSession() first (cheap local write
    // that finalizes the file), then best-effort engine teardown via pause().
    // Both are idempotent, so running this more than once is harmless.
    async _flushOnExit() {
        try { await this.studyView?.flush(); } catch (e) { console.error('[App] exit flush (study view) failed:', e); }
        try { await sessionStore.endSession(); } catch (e) { console.error('[App] exit flush (endSession) failed:', e); }
        try { await this.pause(); } catch (e) { console.error('[App] exit flush (pause) failed:', e); }
    }

    // Two close routes, one flush:
    //  • window ✕ / appWindow.close() → onCloseRequested (frontend)
    //  • Cmd+Q / Dock quit → Rust RunEvent::ExitRequested emits 'app-exit-requested'
    // Both flush (raced against a 3s deadline so a hung engine can't wedge the
    // app) then exit_app, which force-exits the process cleanly in Rust.
    async _bindCloseHooks() {
        await this.appWindow.onCloseRequested(async (event) => {
            if (this._closing) return;
            this._closing = true;
            event.preventDefault();
            await Promise.race([this._flushOnExit(), this._sleep(3000)]);
            try {
                await invoke('exit_app');
            } catch {
                try { await this.appWindow.destroy(); } catch {}
            }
        });

        await this.appWindow.listen('app-exit-requested', async () => {
            if (this._closing) return;
            this._closing = true;
            await Promise.race([this._flushOnExit(), this._sleep(3000)]);
            try { await invoke('exit_app'); } catch {}
        });
    }

    _updateStartButton() {
        const btn = document.getElementById('btn-start');
        const iconPlay = document.getElementById('icon-play');
        const iconStop = document.getElementById('icon-stop');

        btn.classList.toggle('recording', this.isRunning);
        iconPlay.style.display = this.isRunning ? 'none' : 'block';
        iconStop.style.display = this.isRunning ? 'block' : 'none';
        const label = document.getElementById('btn-start-label');
        if (label) label.textContent = this.isRunning ? 'Dừng' : 'Bắt đầu';

        // Pause is only actionable while running. (Don't also gate on isStarting:
        // start() calls this while isStarting is still true, and the click handler
        // already guards the starting window.)
        const btnPause = document.getElementById('btn-pause');
        if (btnPause) btnPause.disabled = !this.isRunning;
    }

    // ─── Transcript Persistence ───────────────────────────────

    _formatDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}m ${sec}s`;
    }


    // ─── Status ────────────────────────────────────────────

    // ─── Notes & markers (Live › 📝 Ghi chú) ────────────────
    // Free-form notes live in the SessionStore (autosaved, exported to the
    // session Markdown) and markers ⭐ ❓ 📝 sit on individual segments.

    _bindNotes() {
        document.getElementById('btn-notes')?.addEventListener('click', () => this._toggleNotes());
        document.getElementById('btn-notes-close')?.addEventListener('click', () => this._toggleNotes(false));
        const ta = document.getElementById('notes-text');
        if (ta) {
            // Debounce so autosave isn't bumped on every keystroke.
            let timer = null;
            ta.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(() => sessionStore.setNotes(ta.value), 800);
            });
            ta.addEventListener('blur', () => {
                clearTimeout(timer);
                sessionStore.setNotes(ta.value);
            });
        }
    }

    _toggleNotes(show) {
        const pane = document.getElementById('notes-pane');
        if (!pane) return;
        const visible = pane.style.display !== 'none';
        const next = show ?? !visible;
        pane.style.display = next ? '' : 'none';
        if (next) {
            this._syncNotesFromStore();
            document.getElementById('notes-text')?.focus();
        }
    }

    _syncNotesFromStore() {
        const ta = document.getElementById('notes-text');
        if (ta && ta.value !== (sessionStore.notes || '')) ta.value = sessionStore.notes || '';
    }

    /** Append one line to the notes (opens the pane so the user sees it land). */
    _appendNote(line) {
        const cur = sessionStore.notes || '';
        const next = (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + line + '\n';
        sessionStore.setNotes(next);
        this._toggleNotes(true);
        const ta = document.getElementById('notes-text');
        if (ta) {
            ta.value = next;
            ta.scrollTop = ta.scrollHeight;
        }
    }

    _noteLastTranslation() {
        const seg = sessionStore.lastSegment();
        if (!seg) {
            this._showToast('Chưa có câu nào để chép', 'error');
            return;
        }
        this._appendNote(`[${seg.ts}] ${seg.tgt}${seg.src ? `  （${seg.src}）` : ''}`);
    }

    /** Toggle a marker on the latest segment; a set marker also lands in the notes. */
    _markLast(mark) {
        const seg = sessionStore.markLastSegment(mark);
        if (!seg) {
            this._showToast('Chưa có câu nào để đánh dấu', 'error');
            return;
        }
        this.transcriptUI?.markLast?.(seg.mark || null);
        if (seg.mark) {
            this._appendNote(`[${seg.ts}] ${seg.mark} ${seg.tgt}`);
        } else {
            this._showToast('Đã bỏ đánh dấu', 'success');
        }
    }

    /**
     * Lecturers flag exam material verbally ("这个考试会考", "这是考点"…).
     * Mark such segments 📝 automatically so they're easy to find later.
     */
    _autoMarkExam(src) {
        if (!src || !/(考试会考|会考|要考|考点|期末考|期中考|必考)/.test(src)) return;
        const seg = sessionStore.lastSegment();
        if (!seg || seg.mark) return;
        sessionStore.markLastSegment('📝');
        this.transcriptUI?.markLast?.('📝');
        this._showToast('📝 Giảng viên báo: phần này sẽ thi', 'success');
    }

    /**
     * The engine fell behind live audio (network stall, or Local MLX slower
     * than real time). `active` = currently skipping; on recovery `skippedSec`
     * is how much speech was dropped to get back to "now". Staying current
     * beats a drifting delay for live lecture translation.
     */
    _onBacklog(active, skippedSec) {
        if (active) {
            if (!this._backlogToastShown) {
                this._backlogToastShown = true;
                this._showToast('⏩ Mạng chậm — đang bỏ bớt để bám kịp lời giảng', 'error');
            }
            return;
        }
        this._backlogToastShown = false;
        if (skippedSec >= 0.5) {
            this._showToast(`⏩ Đã bỏ qua ${skippedSec.toFixed(1)} s để bám kịp`, 'error');
        }
    }

    _updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');

        dot.className = 'status-dot';

        switch (status) {
            case 'connecting':
                dot.classList.add('connecting');
                text.textContent = 'Đang kết nối…';
                break;
            case 'connected':
                dot.classList.add('connected');
                text.textContent = 'Đang nghe';
                break;
            case 'disconnected':
                dot.classList.add('disconnected');
                text.textContent = 'Sẵn sàng';
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = 'Lỗi';
                break;
        }
        // Live tab shows a red badge while a session runs so the user sees
        // recording state even from the Đọc / Thư viện activities.
        setLiveBadge(this.isRunning);
        // Auto-hide chrome only while translating (idle 3s → hide, hover/keys → show)
        if (this.isRunning) startAutoHideWatch();
        else stopAutoHideWatch();
    }

    // ─── Pin / Unpin (Always on Top) ────────────────────

    async _togglePin() {
        this.isPinned = !this.isPinned;
        await this._applyAlwaysOnTop();
        this._showToast(this.isPinned ? 'Đã ghim — luôn nằm trên các cửa sổ khác' : 'Bỏ ghim — cửa sổ bình thường', 'success');
    }

    /** Apply + persist a theme preference ('light' | 'dark' | 'system'). */
    async _setTheme(pref) {
        await applyTheme(pref);
        try { await settingsManager.save({ theme: pref }); } catch (e) { console.warn('[Theme] save failed:', e); }
    }

    /** Keep the Settings select and the ⋯ menu label in step with the theme. */
    _syncThemeControls(resolved) {
        const btn = document.getElementById('btn-theme-toggle');
        if (btn) btn.textContent = resolved === 'dark' ? '☀️ Giao diện sáng' : '🌙 Giao diện tối';
        const sel = document.getElementById('select-theme');
        const pref = settingsManager.get().theme || 'light';
        if (sel && sel.value !== pref) sel.value = pref;
    }

    /**
     * Full screen hides the traffic lights, so the toolbar drops their inset
     * (html.is-fullscreen). Checked once per resize burst, not per event.
     */
    _watchFullscreen() {
        if (!document.documentElement.classList.contains('platform-macos')) return;
        let t = null;
        const sync = async () => {
            try {
                document.documentElement.classList.toggle('is-fullscreen', await this.appWindow.isFullscreen());
            } catch { /* not critical */ }
        };
        this.appWindow.onResized(() => { clearTimeout(t); t = setTimeout(sync, 150); }).catch(() => {});
        sync();
    }

    /**
     * Always-on-top = the user's pin, or the compact overlay (⤢), which is a
     * floating panel for use over slides and so always floats. Leaving the
     * overlay restores the user's own choice.
     */
    async _applyAlwaysOnTop() {
        const onTop = this.isPinned || getWindowMode() === 'overlay';
        try { await this.appWindow.setAlwaysOnTop(onTop); } catch (e) { console.warn('[Window] setAlwaysOnTop failed:', e); }
        const btn = document.getElementById('btn-pin');
        if (btn) btn.classList.toggle('active', onTop);
    }

    // ─── Compact Mode ───────────────────────────────

    _toggleCompact() {
        // Unified with auto-hide in ui-shell — one chrome hide/show mechanism.
        this.isCompact = toggleManualCompact();
    }

    _toggleViewMode() {
        const isDual = this.transcriptUI.viewMode === 'dual';
        const newMode = isDual ? 'single' : 'dual';
        this.transcriptUI.configure({ viewMode: newMode });
        const btn = document.getElementById('btn-view-mode');
        if (btn) btn.classList.toggle('active', newMode === 'dual');
    }

    _adjustFontSize(delta) {
        const current = this.transcriptUI.fontSize || 18;
        const newSize = Math.max(12, Math.min(140, current + delta));
        this.transcriptUI.configure({ fontSize: newSize });

        // Update display
        const display = document.getElementById('font-size-display');
        if (display) display.textContent = newSize;

        // Sync with settings slider
        const slider = document.getElementById('range-font-size');
        if (slider) slider.value = newSize;
        const sliderVal = document.getElementById('font-size-value');
        if (sliderVal) sliderVal.textContent = `${newSize}px`;
    }

    // ─── Toast ─────────────────────────────────────────────

    // ─── Session History ───────────────────────────────────

    async _showSessions(query) {
        const listEl = document.getElementById('sessions-list');
        const listPanel = document.getElementById('sessions-list-panel');
        const viewer = document.getElementById('session-viewer');

        if (listPanel) listPanel.style.display = '';
        if (viewer) viewer.style.display = 'none';
        if (!listEl) return;

        listEl.innerHTML = '<div class="sessions-loading">Loading...</div>';

        try {
            const cmd = query && query.trim() ? 'search_sessions' : 'list_sessions';
            const args = query && query.trim() ? { query: query.trim() } : {};
            const sessions = await invoke(cmd, args);
            if (sessions.length === 0) {
                listEl.innerHTML = '<div class="sessions-empty">No saved sessions yet.</div>';
                return;
            }

            listEl.innerHTML = sessions.map(s => this._renderSessionItem(s)).join('');

            listEl.querySelectorAll('.session-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.closest('.session-delete-btn')) return;
                    const id = item.dataset.id;
                    const legacy = item.dataset.legacy === '1';
                    this._openSession(id, legacy);
                });
            });
            listEl.querySelectorAll('.session-delete-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const id = btn.dataset.id;
                    // Block deleting the active session — the next autosave would
                    // just resurrect the file the user deleted.
                    if (id === sessionStore.id) {
                        this._showToast('Không xoá được buổi đang chạy — Dừng trước', 'error');
                        return;
                    }
                    if (!confirm('Delete this session permanently?')) return;
                    try {
                        await invoke('delete_session', { id });
                        await this._showSessions();
                    } catch (err) {
                        this._showToast(`Xoá thất bại: ${err}`, 'error');
                    }
                });
            });
        } catch (err) {
            listEl.innerHTML = `<div class="sessions-empty">Error: ${err}</div>`;
        }
    }

    _renderSessionItem(s) {
        const title = this._esc(s.title || 'Untitled session');
        const created = this._esc(s.created_at || '').slice(0, 16);
        const duration = this._formatSeconds(s.duration_sec || 0);
        const engine = s.engine || 'unknown';
        const engineBadge = s.has_legacy_only
            ? `<span class="session-badge badge-legacy">legacy</span>`
            : `<span class="session-badge badge-engine">${this._esc(engine)}</span>`;
        const langPair = s.source_lang && s.target_lang
            ? `<span class="session-badge">${this._esc(s.source_lang)} → ${this._esc(s.target_lang)}</span>`
            : '';
        const segCount = s.segment_count > 0 ? `<span class="session-meta-dim">${s.segment_count} segments</span>` : '';
        const chunks = s.chunk_count > 1 ? `<span class="session-meta-dim">${s.chunk_count} chunks</span>` : '';
        const delBtn = `<button class="session-delete-btn" title="Delete" data-id="${this._escAttr(s.id)}">×</button>`;
        return `<div class="session-item" data-id="${this._escAttr(s.id)}" data-legacy="${s.has_legacy_only ? '1' : '0'}">
            <div class="session-item-row1">
                <span class="session-item-title">${title}</span>
                ${delBtn}
            </div>
            <div class="session-item-row2">
                ${engineBadge}
                ${langPair}
                <span class="session-meta-dim">${created}</span>
                ${duration ? `<span class="session-meta-dim">${duration}</span>` : ''}
                ${segCount}
                ${chunks}
            </div>
        </div>`;
    }

    async _openSession(id, isLegacy = false) {
        const listPanel = document.getElementById('sessions-list-panel');
        const viewer = document.getElementById('session-viewer');
        const title = document.getElementById('session-viewer-title');
        const legacyEl = document.getElementById('session-viewer-content');
        const studyParts = ['.study-toolbar', '#study-body'].map(sel => viewer?.querySelector(sel));
        const showStudy = (on) => {
            studyParts.forEach(el => { if (el) el.style.display = on ? '' : 'none'; });
            if (legacyEl) legacyEl.style.display = on ? 'none' : '';
            if (!on) document.getElementById('study-readonly-note').style.display = 'none';
        };

        if (listPanel) listPanel.style.display = 'none';
        if (viewer) viewer.style.display = '';
        if (title) title.textContent = id;
        this._currentViewedSession = { id, isLegacy };

        try {
            if (isLegacy) {
                await this.studyView.close();
                showStudy(false);
                if (legacyEl) legacyEl.textContent = await invoke('read_legacy_session', { id });
            } else {
                showStudy(true);
                const store = await this.studyView.open(id, sessionStore);
                if (title) title.textContent = store.title || id;
            }
        } catch (err) {
            showStudy(false);
            if (legacyEl) legacyEl.textContent = `Không mở được buổi học: ${err}`;
        }
    }

    _formatSeconds(sec) {
        if (!sec) return '';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m`;
        return `${sec}s`;
    }

    async _exportCurrentSession(format) {
        const cur = this._currentViewedSession;
        if (!cur || cur.isLegacy) {
            this._showToast('Không xuất được buổi học định dạng cũ', 'error');
            return;
        }
        try {
            await this.studyView.flush(); // export reads the file on disk
            const cmd = format === 'srt' ? 'export_session_srt' : 'export_session_txt';
            const text = await invoke(cmd, { id: cur.id });
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${cur.id}.${format}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this._showToast(`Đã xuất .${format}`, 'success');
        } catch (err) {
            this._showToast(`Xuất thất bại: ${err}`, 'error');
        }
    }

    async _checkForUpdates() {
        updater.onUpdateFound = (version, notes) => {
            this._onUpdateAvailable(version, notes);
        };
        updater.onError = (err) => {
            const statusText = document.getElementById('update-status-text');
            if (statusText) statusText.textContent = `⚠️ Check failed: ${err.message || err}`;
        };
        updater.onCheckComplete = (hasUpdate) => {
            const checkBtn = document.getElementById('btn-check-update');
            if (checkBtn) checkBtn.classList.remove('spinning');
            if (!hasUpdate && !this._pendingUpdateVersion) {
                const statusText = document.getElementById('update-status-text');
                if (statusText) statusText.textContent = '✅ App is up to date';
            }
        };
        // Delay check slightly so app finishes loading first
        setTimeout(() => {
            const statusText = document.getElementById('update-status-text');
            const checkBtn = document.getElementById('btn-check-update');
            if (statusText) statusText.textContent = 'Checking for updates...';
            if (checkBtn) checkBtn.classList.add('spinning');
            updater.checkForUpdates();
        }, 3000);
    }

    _triggerUpdateCheck() {
        const statusText = document.getElementById('update-status-text');
        const checkBtn = document.getElementById('btn-check-update');
        if (statusText) statusText.textContent = 'Checking for updates...';
        if (checkBtn) checkBtn.classList.add('spinning');
        updater.checkForUpdates();
    }

    _onUpdateAvailable(version, notes) {
        this._pendingUpdateVersion = version;

        // 1. Show badge on settings gear
        const badge = document.getElementById('settings-badge');
        if (badge) badge.style.display = '';

        // 2. Update About tab status
        const statusEl = document.getElementById('update-status');
        const statusText = document.getElementById('update-status-text');
        const actions = document.getElementById('update-actions');
        if (statusEl) statusEl.classList.add('has-update');
        if (statusText) statusText.textContent = `🆕 Update v${version} available`;
        if (actions) actions.style.display = '';

        // 3. Show subtle hint on main screen
        const existing = document.querySelector('.update-hint');
        if (existing) existing.remove();
        const hint = document.createElement('div');
        hint.className = 'update-hint';
        hint.textContent = `Update v${version} available — go to Settings → About`;
        hint.addEventListener('click', () => {
            this._showView('settings');
            this._showSettingsScreen('tab-about');
            hint.remove();
        });
        document.body.appendChild(hint);

        // Auto-hide hint after 8 seconds
        setTimeout(() => { if (hint.parentNode) hint.remove(); }, 8000);
    }

    _initAboutTab() {
        // Real version from the bundle (tauri.conf.json), not a hard-coded label.
        window.__TAURI__?.app?.getVersion?.()
            .then((v) => { const el = document.getElementById('about-version'); if (el) el.textContent = `v${v}`; })
            .catch(() => {});

        // GitHub links
        document.getElementById('link-github')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__?.opener?.openUrl('https://github.com/ttkien2035/meowlaoshi');
        });
        document.getElementById('link-issues')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__?.opener?.openUrl('https://github.com/ttkien2035/meowlaoshi/issues');
        });

        // Check for Updates button
        document.getElementById('btn-check-update')?.addEventListener('click', () => {
            this._triggerUpdateCheck();
        });

        // Download & Install button
        document.getElementById('btn-do-update')?.addEventListener('click', async () => {
            const btnText = document.getElementById('update-btn-text');
            const btn = document.getElementById('btn-do-update');
            const progressDiv = document.getElementById('update-progress');
            const progressFill = document.getElementById('update-progress-fill');
            const progressPct = document.getElementById('update-progress-pct');

            if (btn) btn.disabled = true;
            if (btnText) btnText.textContent = 'Downloading...';
            if (progressDiv) progressDiv.style.display = '';

            try {
                await updater.downloadAndInstall((downloaded, total) => {
                    if (total > 0) {
                        const pct = Math.round((downloaded / total) * 100);
                        if (progressFill) progressFill.style.width = `${pct}%`;
                        if (progressPct) progressPct.textContent = `${pct}%`;
                        if (btnText) btnText.textContent = `Downloading ${pct}%...`;
                    }
                });
                // Install succeeded! Try to restart
                if (btnText) btnText.textContent = 'Restarting...';
                try {
                    const relaunch = window.__TAURI__?.process?.relaunch;
                    if (relaunch) {
                        await relaunch();
                    } else {
                        const invoke = window.__TAURI__?.core?.invoke;
                        if (invoke) await invoke('plugin:process|restart');
                    }
                } catch (restartErr) {
                    // Restart failed (e.g. process plugin not available) but update IS installed
                    console.warn('[Update] Restart failed, update is installed:', restartErr);
                    if (btnText) btnText.textContent = '✅ Updated! Restart app';
                    const statusText = document.getElementById('update-status-text');
                    if (statusText) statusText.textContent = '✅ Update installed — close and reopen the app';
                    if (btn) btn.disabled = true;
                }
            } catch (err) {
                const errMsg = err?.message || String(err);
                if (btnText) btnText.textContent = 'Failed — try again';
                const statusText = document.getElementById('update-status-text');
                if (statusText) statusText.textContent = `⚠️ Install error: ${errMsg}`;
                if (btn) btn.disabled = false;
                console.error('[Update]', err);
            }
        });
    }

    _showToast(message, type = 'success') {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto-remove (longer for errors)
        const duration = type === 'error' ? 5000 : 3000;
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
