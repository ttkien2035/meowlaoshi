// Local engine client (pure-Rust backend: X-ASR recognition + Hy-MT2 via llama.cpp).
// Same shape as the cloud realtime clients: connect → sendAudio → disconnect,
// events over a Tauri Channel. Audio goes as the raw invoke body with the
// session id in a header (no JSON number arrays).

const { invoke, Channel } = window.__TAURI__.core;

export class LocalEngineClient {
    constructor() {
        this.sessionId = null;
        this.channel = null;
        this.isConnected = false;

        this.onStatus = () => {};     // (state, message)
        this.onTranscript = () => {}; // (src, startMs, endMs) — recognised, translation pending
        this.onPartial = () => {};    // (tgt, startMs) — translation so far, whole words
        this.onResult = () => {};     // (src, tgt, startMs, endMs)
        this.onError = () => {};    // (code, message)
        this.onClosed = () => {};   // (reason)
    }

    /** cfg: { sourceLanguage, targetLanguage, glossary: [{source, target}] } */
    async connect(cfg) {
        this.channel = new Channel();
        this.channel.onmessage = (evt) => this._handleEvent(evt);
        try {
            this.sessionId = await invoke('local_start', {
                config: {
                    source_language: cfg.sourceLanguage || 'auto',
                    target_language: cfg.targetLanguage || 'vi',
                    glossary: cfg.glossary || [],
                },
                onEvent: this.channel,
            });
            this.isConnected = true;
        } catch (err) {
            this.onError('connect_failed', String(err));
            throw err;
        }
    }

    async sendAudio(arrayBuffer) {
        if (!this.isConnected || this.sessionId == null) return;
        try {
            await invoke('local_send_audio', new Uint8Array(arrayBuffer), {
                headers: { 'x-session-id': String(this.sessionId) },
            });
        } catch (err) {
            console.warn('[Local] send audio failed:', err);
        }
    }

    async disconnect() {
        if (!this.isConnected) return;
        this.isConnected = false;
        try {
            await invoke('local_stop', { sessionId: this.sessionId });
        } catch {}
    }

    _handleEvent(evt) {
        switch (evt.type) {
            case 'status':
                this.onStatus(evt.state, evt.message);
                break;
            case 'transcript':
                this.onTranscript(evt.src, evt.start_ms, evt.end_ms);
                break;
            case 'partial':
                this.onPartial(evt.tgt, evt.start_ms);
                break;
            case 'result':
                this.onResult(evt.src, evt.tgt, evt.start_ms, evt.end_ms);
                break;
            case 'error':
                this.onError(evt.code, evt.message);
                break;
            case 'closed':
                if (this.isConnected) {
                    this.isConnected = false;
                    invoke('local_stop', { sessionId: this.sessionId }).catch(() => {});
                }
                this.onClosed(evt.reason);
                break;
        }
    }
}
