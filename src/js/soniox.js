/**
 * Soniox WebSocket Client
 * Connects directly to wss://stt-rt.soniox.com/transcribe-websocket
 * 
 * Features:
 * - Auto-reconnect on transient errors
 * - Seamless session reset every SESSION_DURATION_MS (make-before-break)
 * - Context carryover via context.text field
 * - Speaker diarization
 * - Language identification (per-token language tags)
 * - Connection keepalive (prevents timeout during silence)
 * - Rich context support (general key-value, terms, text, translation_terms)
 * - Confidence score pass-through
 */

const SONIOX_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';

// Reconnect settings
const MAX_RECONNECT = 3;
const RECONNECT_DELAY_MS = 2000;

// Session reset: 3 minutes
const SESSION_DURATION_MS = 3 * 60 * 1000;

// Keep last N chars of translations for context carryover
const CONTEXT_HISTORY_CHARS = 500;
// After a seamless reset, keep the old socket open this long at most while it
// delivers the finals for audio already sent.
const OLD_WS_DRAIN_TIMEOUT_MS = 5000;
// 16 kHz s16le mono; skip audio once the socket holds more than 5 s unsent.
const BYTES_PER_SECOND = 32000;
const MAX_BUFFERED_BYTES = 5 * BYTES_PER_SECOND;
// Soniox caps a context at 8 000 tokens; glossary/index.js trims terms and
// pairs to a budget that leaves room for `general` and `text`.
import { budgetContext } from './glossary/index.js';

// Keepalive: send every 15s to prevent timeout when no audio
const KEEPALIVE_INTERVAL_MS = 15000;

export class SonioxClient {
    constructor() {
        this.ws = null;
        this.apiKey = '';
        this.isConnected = false;
        this._reconnectAttempts = 0;
        this._config = null;
        this._intentionalDisconnect = false;
        this._sessionTimer = null;
        this._keepaliveTimer = null;
        this._recentTranslations = []; // Rolling buffer of recent translations
        this._drainingWs = null; // Old socket still delivering finals after a reset
        this._backlogActive = false; // Skipping audio because the socket can't drain
        this._skippedBytes = 0;
        this.onBacklog = null; // (active: boolean, skippedSeconds: number) => void

        // Callbacks
        this.onOriginal = null;       // (text, speaker, language) => {}
        this.onTranslation = null;    // (text) => {}
        this.onProvisional = null;    // (text, speaker, language) => {}
        this.onStatusChange = null;   // (status) => {}
        this.onError = null;          // (message, kind) => {} — kind: 'auth' | 'credits' | 'lost' | undefined
        this.onConfidence = null;     // (avgConfidence) => {}
    }

    /**
     * Connect to Soniox WebSocket
     */
    connect(config) {
        const { apiKey } = config;
        this.apiKey = apiKey;
        this._config = config;
        this._intentionalDisconnect = false;
        this._reconnectAttempts = 0;
        this._recentTranslations = [];

        if (!apiKey) {
            this._setStatus('error');
            this.onError?.('Chưa có API key Soniox.', 'auth');
            return;
        }

        this._doConnect(config);
    }

    _doConnect(config, carryoverContext = null) {
        const { apiKey, sourceLanguage, targetLanguage, customContext,
                translationType, languageA, languageB, languageHintsStrict,
                endpointDelay, model } = config;

        this._setStatus('connecting');
        console.log('[Soniox] Connecting to', SONIOX_ENDPOINT);

        let newWs;
        try {
            newWs = new WebSocket(SONIOX_ENDPOINT);
            console.log('[Soniox] WebSocket created, readyState:', newWs.readyState);
        } catch (err) {
            console.error('[Soniox] Failed to create WebSocket:', err);
            this._setStatus('error');
            this.onError?.(`Failed to create WebSocket: ${err.message}`);
            return;
        }

        newWs.onopen = () => {
            console.log('[Soniox] WebSocket OPEN');

            // Build config message
            const configMsg = {
                api_key: apiKey,
                model: model || 'stt-rt-v5',
                audio_format: 'pcm_s16le',
                sample_rate: 16000,
                num_channels: 1,
                enable_endpoint_detection: true,
                max_endpoint_delay_ms: endpointDelay || 1500,
                enable_speaker_diarization: true,
                enable_language_identification: true,
            };

            // Language hints
            if (sourceLanguage && sourceLanguage !== 'auto') {
                configMsg.language_hints = [sourceLanguage];
            }

            // Language hints strict mode (#4)
            if (languageHintsStrict) {
                configMsg.language_hints_strict = true;
            }

            // Translation config (#5: support one-way and two-way)
            if (translationType === 'two_way' && languageA && languageB) {
                configMsg.translation = {
                    type: 'two_way',
                    language_a: languageA,
                    language_b: languageB,
                };
                // For two-way, set language hints to both languages
                configMsg.language_hints = [languageA, languageB];
            } else if (targetLanguage) {
                configMsg.translation = {
                    type: 'one_way',
                    target_language: targetLanguage,
                };
            }

            // Context: build using new API format (general, text, terms, translation_terms)
            const context = this._buildContext(customContext, carryoverContext);
            if (context) {
                configMsg.context = context;
            }

            console.log('[Soniox] Sending config (model:', configMsg.model, ')');
            newWs.send(JSON.stringify(configMsg));

            // Make-before-break: close old WS AFTER new one is ready
            const oldWs = this.ws;
            if (oldWs && oldWs !== newWs) {
                console.log('[Soniox] Seamless switch: draining old WebSocket');
                // Make-before-break: signal end-of-audio to the old socket but
                // keep listening, so the finals for audio already sent are not
                // lost (closing immediately dropped the tail of the last
                // utterance at every 3-min reset). Closed on `finished` or
                // after a safety timeout.
                oldWs._isOld = true; // onclose must not trigger reconnect
                try {
                    if (oldWs.readyState === WebSocket.OPEN) {
                        oldWs.send(new ArrayBuffer(0)); // end-of-audio signal
                    } else {
                        oldWs.close(1000, 'Session reset');
                    }
                } catch (e) {
                    // ignore
                }
                this._drainingWs = oldWs;
                oldWs._drainTimer = setTimeout(() => this._closeOldWs(oldWs), OLD_WS_DRAIN_TIMEOUT_MS);
            }

            // Switch to new WS
            this.ws = newWs;
            this.isConnected = true;
            this._reconnectAttempts = 0;
            this._setStatus('connected');
            console.log('[Soniox] Connected and config sent');

            // Start session timer & keepalive
            this._startSessionTimer();
            this._startKeepalive();
        };

        newWs.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (newWs._isOld) {
                    // Old socket draining after a seamless reset: accept only
                    // finalized tokens — the new socket owns provisional text.
                    if (Array.isArray(data.tokens)) {
                        const finals = data.tokens.filter((t) => t.is_final);
                        if (finals.length > 0) this._handleResponse({ ...data, tokens: finals });
                    }
                    if (data.finished || data.error_code) this._closeOldWs(newWs);
                    return;
                }

                if (data.error_code) {
                    this._handleApiError(data);
                    return;
                }

                this._handleResponse(data);
            } catch (err) {
                console.error('Failed to parse Soniox response:', err);
            }
        };

        newWs.onerror = (event) => {
            if (newWs._isOld) return;
            console.error('[Soniox] WebSocket ERROR:', event);
            // The close event that follows says what happened; nothing to show yet.
            console.warn('[Soniox] socket error (close event follows)');
        };

        newWs.onclose = (event) => {
            // Ignore close events from old WebSocket during seamless switch
            if (newWs._isOld) {
                console.log('[Soniox] Old WebSocket closed (drained)');
                this._closeOldWs(newWs); // clears the drain timer
                return;
            }

            console.log('[Soniox] WebSocket CLOSED, code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean);
            this.isConnected = false;

            // Only null out ws if this is the current one
            if (this.ws === newWs) {
                this.ws = null;
            }

            if (this._intentionalDisconnect) {
                this._setStatus('disconnected');
                return;
            }

            // Handle close codes
            if (event.code === 1000) {
                this._setStatus('disconnected');
            } else if (event.code === 1006) {
                this._tryReconnect('Mất kết nối');
            } else if (event.code === 4001 || event.code === 4003) {
                this._setStatus('error');
                this.onError?.('Soniox từ chối API key.', 'auth');
            } else if (event.code === 4029) {
                this._setStatus('error');
                this.onError?.('Soniox đang giới hạn số yêu cầu, chờ một chút rồi bấm Bắt đầu lại.');
            } else if (event.code === 4002) {
                this._setStatus('error');
                this.onError?.('Key Soniox đã hết hạn mức sử dụng.', 'credits');
            } else {
                this._tryReconnect(`Kết nối bị đóng (mã ${event.code})`);
            }
        };
    }

    /**
     * Send raw PCM audio data
     */
    sendAudio(pcmData) {
        const ws = this.ws;
        if (ws?.readyState !== WebSocket.OPEN) return;
        // Backlog policy for live translation: stay current. `bufferedAmount`
        // is audio the browser still hasn't put on the wire; past ~5 s we are
        // that far behind the lecturer, so skip instead of queueing. Once the
        // socket drains we resume from "now" and report how much was skipped.
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            this._skippedBytes += pcmData.byteLength ?? pcmData.length ?? 0;
            if (!this._backlogActive) {
                this._backlogActive = true;
                this.onBacklog?.(true, 0);
            }
            return;
        }
        if (this._backlogActive) {
            this._backlogActive = false;
            this.onBacklog?.(false, this._skippedBytes / BYTES_PER_SECOND);
            this._skippedBytes = 0;
        }
        ws.send(pcmData);
    }

    /**
     * Gracefully disconnect
     */
    disconnect() {
        this._intentionalDisconnect = true;
        this._stopSessionTimer();
        this._stopKeepalive();
        this._closeOldWs(this._drainingWs);

        if (this.ws) {
            try {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(new ArrayBuffer(0));
                }
                this.ws.close(1000, 'User disconnected');
            } catch (err) {
                console.error('Error during disconnect:', err);
            }
            this.ws = null;
        }
        this.isConnected = false;
        this._setStatus('disconnected');
    }

    /**
     * Swap the context (e.g. the user picked another course profile) and, if
     * connected, apply it immediately through a seamless reset — Soniox only
     * reads `context` at connect time.
     */
    updateContext(customContext) {
        if (!this._config) return;
        this._config = { ...this._config, customContext };
        if (this.isConnected) this._seamlessReset();
    }

    /** Close a socket left draining after a seamless reset (idempotent). */
    _closeOldWs(ws) {
        if (!ws) return;
        if (ws._drainTimer) {
            clearTimeout(ws._drainTimer);
            ws._drainTimer = null;
        }
        if (this._drainingWs === ws) this._drainingWs = null;
        try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close(1000, 'Session reset');
            }
        } catch (e) {
            // ignore
        }
    }

    /**
     * Process Soniox response
     */
    _handleResponse(data) {
        if (!data.tokens || data.tokens.length === 0) return;

        let originalText = '';
        let translationText = '';
        let provisionalText = '';
        let hasEnd = false;
        let speaker = null;
        let language = null;
        let confidenceSum = 0;
        let confidenceCount = 0;

        for (const token of data.tokens) {
            if (token.text === '<end>') {
                hasEnd = true;
                continue;
            }

            if (token.speaker && token.translation_status === 'original') {
                speaker = token.speaker;
            }

            // Capture language from original tokens
            if (token.language && token.translation_status !== 'translation') {
                language = token.language;
            }

            // Track confidence scores for original final tokens
            if (token.confidence !== undefined && token.is_final && token.translation_status === 'original') {
                confidenceSum += token.confidence;
                confidenceCount++;
            }

            if (token.translation_status === 'original') {
                if (token.is_final) {
                    originalText += token.text;
                } else {
                    provisionalText += token.text;
                }
            } else if (token.translation_status === 'translation') {
                if (token.is_final) {
                    translationText += token.text;
                }
            } else if (token.translation_status === 'none') {
                // Third-language speech in two-way mode: treat as original (untranslated)
                if (token.is_final) {
                    originalText += token.text;
                } else {
                    provisionalText += token.text;
                }
            }
        }

        // Emit average confidence for this batch
        if (confidenceCount > 0) {
            const avgConfidence = confidenceSum / confidenceCount;
            this.onConfidence?.(avgConfidence);
        }

        // Emit finalized original text with speaker + language
        if (originalText.trim()) {
            this.onOriginal?.(originalText, speaker, language);
        }

        // Emit translation + store for context carryover
        if (translationText.trim()) {
            this.onTranslation?.(translationText);
            this._addToHistory(translationText);
        }

        // Emit provisional text with speaker + language
        if (provisionalText.trim()) {
            this.onProvisional?.(provisionalText, speaker, language);
        } else if (originalText.trim() || translationText.trim() || hasEnd) {
            this.onProvisional?.('');
        }
    }

    // ─── Session Timer ────────────────────────────────────────

    _startSessionTimer() {
        this._stopSessionTimer();
        this._sessionTimer = setTimeout(() => {
            this._seamlessReset();
        }, SESSION_DURATION_MS);
    }

    _stopSessionTimer() {
        if (this._sessionTimer) {
            clearTimeout(this._sessionTimer);
            this._sessionTimer = null;
        }
    }

    /**
     * Seamless session reset: open new WS, switch, close old
     * Audio capture continues uninterrupted
     */
    _seamlessReset() {
        if (!this._config || this._intentionalDisconnect) return;

        console.log('[Soniox] ♻️ Seamless session reset (every 3 min)');

        // Build carryover context from recent translations
        const carryover = this._getCarryoverContext();

        // Open new connection (make-before-break)
        this._doConnect(this._config, carryover);
    }

    // ─── Keepalive ────────────────────────────────────────────

    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'keepalive' }));
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    _stopKeepalive() {
        if (this._keepaliveTimer) {
            clearInterval(this._keepaliveTimer);
            this._keepaliveTimer = null;
        }
    }

    // ─── Context Builder ─────────────────────────────────────

    /**
     * Build context object using Soniox API format:
     * - general: array of {key, value} pairs (domain, topic, speakers...)
     * - text: longer unstructured context (carryover, background)
     * - terms: transcription terms (domain-specific words)
     * - translation_terms: array of {source, target} pairs
     */
    _buildContext(customContext, carryoverContext) {
        const context = {};
        let hasContent = false;

        // General key-value pairs
        const general = [];
        if (customContext?.general && Array.isArray(customContext.general)) {
            // New format: array of {key, value}
            general.push(...customContext.general);
        } else if (customContext?.domain) {
            // Legacy format: single domain string → convert to general
            general.push({ key: 'domain', value: customContext.domain });
        }
        if (general.length > 0) {
            context.general = general;
            hasContent = true;
        }

        // Recognition terms and the translation glossary, trimmed to the
        // token budget (longest Chinese terms first — the rare ones).
        if (customContext?.terms?.length || customContext?.translation_terms?.length) {
            const { context: fitted, dropped, tokens } = budgetContext(customContext);
            if (fitted.terms.length > 0) {
                context.terms = fitted.terms;
                hasContent = true;
            }
            if (fitted.translation_terms.length > 0) {
                context.translation_terms = fitted.translation_terms;
                hasContent = true;
            }
            if (dropped > 0) {
                console.warn(`[Soniox] glossary trimmed to ~${tokens} tokens: ${dropped} short entries left out`);
            }
        }

        // Text context: user-provided background + carryover
        const textParts = [];
        if (customContext?.text) {
            textParts.push(customContext.text);
        }
        if (carryoverContext) {
            textParts.push(`Recent conversation: ${carryoverContext}`);
        }
        if (textParts.length > 0) {
            context.text = textParts.join('\n\n');
            hasContent = true;
        }

        return hasContent ? context : null;
    }

    // ─── Context Carryover ────────────────────────────────────

    _addToHistory(text) {
        this._recentTranslations.push(text);
        // Trim to keep under CONTEXT_HISTORY_CHARS
        let total = this._recentTranslations.reduce((sum, t) => sum + t.length, 0);
        while (total > CONTEXT_HISTORY_CHARS && this._recentTranslations.length > 1) {
            const removed = this._recentTranslations.shift();
            total -= removed.length;
        }
    }

    _getCarryoverContext() {
        if (this._recentTranslations.length === 0) return null;
        return this._recentTranslations.join(' ').trim();
    }

    // ─── Error Handling ──────────────────────────────────────

    _handleApiError(data) {
        const code = data.error_code || 0;
        const message = data.error_message || 'Unknown API error';

        console.error('Soniox API error:', code, message);

        if (code === 408) {
            this._tryReconnect('Hết thời gian chờ');
            return;
        }

        let userMessage = `Soniox báo lỗi: ${message}`;
        let kind;
        if (code === 401) {
            userMessage = 'Soniox từ chối API key.'; kind = 'auth';
        } else if (code === 402) {
            userMessage = 'Key Soniox đã hết hạn mức sử dụng.'; kind = 'credits';
        } else if (code === 429) {
            userMessage = 'Soniox đang giới hạn số yêu cầu, chờ một chút rồi bấm Bắt đầu lại.';
        } else if (code === 400) {
            userMessage = `Cấu hình gửi tới Soniox không hợp lệ: ${message}`;
        }

        this._setStatus('error');
        this.onError?.(userMessage, kind);
    }

    _tryReconnect(reason) {
        if (this._reconnectAttempts >= MAX_RECONNECT) {
            this._setStatus('error');
            this.onError?.(`${reason}; đã thử nối lại ${MAX_RECONNECT} lần.`, 'lost');
            return;
        }

        this._reconnectAttempts++;
        const delay = RECONNECT_DELAY_MS * this._reconnectAttempts;

        console.log(`Reconnecting (${this._reconnectAttempts}/${MAX_RECONNECT}) in ${delay}ms...`);
        this._setStatus('connecting');
        this.onError?.(`${reason}, đang nối lại (${this._reconnectAttempts}/${MAX_RECONNECT})…`);

        setTimeout(() => {
            if (!this._intentionalDisconnect && this._config) {
                const carryover = this._getCarryoverContext();
                this._doConnect(this._config, carryover);
            }
        }, delay);
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }
}

// Singleton
export const sonioxClient = new SonioxClient();
