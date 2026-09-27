/**
 * Transcript UI — live transcript with incremental DOM updates.
 *
 * - Translated text: primary colour; original (pending translation): dim;
 *   provisional (being recognised): dimmed italic, or bright when the
 *   provider streams the target language (OpenAI target / Qwen).
 * - Speaker labels / language badges when they change; low-confidence
 *   segments highlighted; ⭐ ❓ 📝 marks.
 *
 * Rendering model (cheap on long lectures):
 * - Each segment owns its DOM nodes, created once. A translation fills in
 *   that segment's nodes; a dropped segment removes only its nodes.
 * - Both layouts exist side by side — `.seg-block` (single column) and a
 *   source/target pair in `.panel-source` / `.panel-translation` (dual) —
 *   and CSS (`#overlay-view.dual-view`) picks one, so switching view mode
 *   re-renders nothing.
 * - Provisional text lives in fixed nodes at the end; token updates only
 *   change their textContent and are coalesced to one write per animation
 *   frame, with at most one layout read per frame for smart scroll.
 * - Scrollback covers the session up to MAX_SEGMENTS (≈ 3 h of lecture);
 *   the complete session is always in the Library (SessionStore).
 * - Following the lecture: the newest translation carries `.latest` (a soft
 *   highlight; moving it touches two segments, not the history). At the
 *   bottom the view keeps following; scrolled up to re-read, it stays put and
 *   a "↓ N câu mới" button jumps back to the newest sentence.
 */

/** Segments kept on screen; older ones leave the DOM (not the saved session). */
const MAX_SEGMENTS = 1500;
/** An original without a translation after this long is dropped from view. */
const STALE_ORIGINAL_MS = 10000;
const MAX_PENDING_ORIGINALS = 3;
/** "Near the bottom" slack for smart scroll, px. */
const STICK_PX = 100;

export class TranscriptUI {
    constructor(container) {
        this.container = container;
        this.contentEl = null;   // .transcript-flow
        this.srcPanel = null;    // .panel-source    (dual)
        this.tgtPanel = null;    // .panel-translation (dual)
        this.fontSize = 18;
        this.viewMode = 'single'; // 'single' | 'dual'

        // { original, translation, status: 'original'|'translated', speaker,
        //   language, confidence, createdAt, mark?, nodes }
        this.segments = [];
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        // Source-side provisional (OpenAI Realtime: source ASR is separate from
        // target). Soniox leaves this empty; its provisionalText is source ASR.
        this.sourceProvisionalText = '';
        this._provider = 'soniox';
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;

        // Originals awaiting a translation. Always few (≤ MAX_PENDING_ORIGINALS)
        // and near the end, so lookups walk back from the tail instead of
        // scanning the whole history — O(1) per event on a 3-hour session.
        this._pending = 0;
        // Direct refs (no querySelector over the growing transcript per event).
        this._listeningEl = null;
        this._statusEl = null;
        // Last label shown, so a label only appears when speaker/language changes.
        this._labelSpeaker = null;
        this._labelLang = null;
        // Frame-coalescing state.
        this._frame = 0;
        this._stick = null; // "was at the bottom" captured before a frame's mutations
        this._prov = null;  // provisional nodes { block, blockText, blockLabels, src, tgt, key }
        // Follow the lecture.
        this._latest = null;    // segment carrying .latest
        this._newInFrame = 0;   // translations added since the last flush
        this._unseen = 0;       // translations that arrived while scrolled up
        this._jumpBtn = null;
        this._scrollRaf = 0;
        // Scroll events do not bubble, but a capture listener on the container
        // sees the single-view scroller and both dual panels.
        container.addEventListener('scroll', () => this._onUserScroll(), { capture: true, passive: true });
    }

    get provider() {
        return this._provider;
    }

    set provider(value) {
        this._provider = value;
        this._syncDualClass();
        this._queue();
    }

    /** Update display settings. */
    configure({ fontSize, fontColor, viewMode }) {
        if (fontSize !== undefined) {
            this.fontSize = fontSize;
            this.container.style.setProperty('--transcript-font-size', `${fontSize}px`);
        }
        if (fontColor !== undefined) {
            this.fontColor = fontColor;
            this.container.style.setProperty('--transcript-font-color', fontColor);
        }
        if (viewMode !== undefined && viewMode !== this.viewMode) {
            this.viewMode = viewMode;
            this._syncDualClass();
            // Both layouts already exist; just land at the newest text.
            this._stick = { flow: true, src: true, tgt: true };
            this._queue();
        }
    }

    /**
     * Add finalized original text (pending translation). `key` lets the
     * engine pair the translation with this exact segment later
     * (`addTranslation(text, { key })`) instead of "the oldest pending one".
     */
    addOriginal(text, speaker, language, key) {
        this._removeListening();
        this._noteScroll();
        const seg = {
            original: text,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            language: language || null,
            confidence: this.lastConfidence,
            createdAt: Date.now(),
            nodes: null,
            key: key ?? null,
        };
        this._mount(seg);
        this.segments.push(seg);
        this._pending++;
        if (speaker) this.currentSpeaker = speaker;
        if (language) this.currentLanguage = language;
        this._cleanupStaleOriginals();
        this._trim();
        this._queue();
    }

    /**
     * Apply a translation to the oldest untranslated segment (or add a new one).
     * With `{ key, original }` it goes to the pending segment added under that
     * key; if that one is gone (trimmed as stale) a new segment carrying
     * `original` is added, so a translation never lands on the wrong sentence.
     */
    addTranslation(text, { key, original } = {}) {
        this._noteScroll();
        let seg = key !== undefined && key !== null ? this._pendingByKey(key) : this._oldestPending();
        if (seg) {
            this._pending--;
        } else {
            seg = {
                original: original || '',
                translation: null,
                status: 'original',
                speaker: null,
                language: null,
                confidence: null,
                createdAt: Date.now(),
                nodes: null,
                key: null,
            };
            this._mount(seg);
            this.segments.push(seg);
        }
        if (key !== undefined && key !== null && this._partialKey === key) this._clearPartial();
        seg.translation = text;
        seg.status = 'translated';
        this._paintTranslation(seg);
        this._setLatest(seg);
        this._newInFrame++;
        this._trim();
        this._queue();
    }

    /** Scroll to the newest sentence and resume following. */
    jumpToLatest() {
        const smooth = !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
        for (const e of this._scrollers()) e.scrollTo({ top: e.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
        this._setUnseen(0);
    }

    /** Move the `.latest` highlight to `seg` (both layouts). */
    _setLatest(seg) {
        if (this._latest === seg) return;
        const prev = this._latest?.nodes;
        if (prev) for (const n of [prev.block, prev.srcWrap, prev.tgtWrap]) n.classList.remove('latest');
        this._latest = seg;
        const n = seg.nodes;
        if (n) for (const e of [n.block, n.srcWrap, n.tgtWrap]) e.classList.add('latest');
    }

    /** The scrollers of the current layout. */
    _scrollers() {
        if (this._isDual()) return [this.srcPanel, this.tgtPanel].filter(Boolean);
        const f = this._flowScroller();
        return f ? [f] : [];
    }

    _onUserScroll() {
        if (this._scrollRaf || !this._unseen) return;
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
        this._scrollRaf = raf(() => {
            this._scrollRaf = 0;
            const main = this._isDual() ? this.tgtPanel : this._flowScroller();
            if (main && main.scrollHeight - main.scrollTop - main.clientHeight < STICK_PX) this._setUnseen(0);
        });
    }

    _setUnseen(n) {
        this._unseen = n;
        if (!n && !this._jumpBtn) return;
        if (!this._jumpBtn) {
            const host = this.container.parentElement || this.container;
            this._jumpBtn = el('button', 'jump-latest');
            this._jumpBtn.type = 'button';
            this._jumpBtn.addEventListener('click', () => this.jumpToLatest());
            host.appendChild(this._jumpBtn);
        }
        this._jumpBtn.hidden = !n;
        if (n) this._jumpBtn.textContent = `↓ ${n} câu mới`;
    }

    /** Set (or clear with null) the marker on the latest translated segment. */
    markLast(mark) {
        for (let i = this.segments.length - 1; i >= 0; i--) {
            const seg = this.segments[i];
            if (seg.status === 'translated' && seg.translation) {
                if (mark) seg.mark = mark; else delete seg.mark;
                this._paintMark(seg);
                return;
            }
        }
    }

    /**
     * Translation so far of the pending segment `key` (Local: the LLM streams
     * words). Dual view: replaces that segment's "..."; single view: shown in
     * the provisional block until the final translation arrives.
     */
    setPartial(key, text) {
        const seg = this._pendingByKey(key);
        if (!seg || !text) return;
        this._removeListening();
        this._noteScroll();
        this._partialKey = key;
        if (seg.nodes && seg.nodes.tgtText.textContent !== text) seg.nodes.tgtText.textContent = text;
        this.provisionalText = text;
        this._queue();
    }

    _clearPartial() {
        this._partialKey = null;
        this.provisionalText = '';
        this._queue();
    }

    /** Update provisional (in-progress) text. */
    setProvisional(text, speaker, language) {
        this._removeListening();
        // Provisional text usually arrives before the first final segment, so
        // the containers may not exist yet.
        if (text) this._ensureContent();
        this._noteScroll();
        this.provisionalText = text || '';
        this.provisionalSpeaker = speaker || null;
        this.provisionalLanguage = language || null;
        this._queue();
    }

    clearProvisional() {
        if (!this.provisionalText && !this.provisionalSpeaker && !this.provisionalLanguage) return;
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this._queue();
    }

    /** Source-side provisional (OpenAI Realtime only; shown in dual view). */
    setSourceProvisional(text) {
        this._removeListening();
        if (text) this._ensureContent();
        this._noteScroll();
        this.sourceProvisionalText = text || '';
        this._queue();
    }

    clearSourceProvisional() {
        if (!this.sourceProvisionalText) return;
        this.sourceProvisionalText = '';
        this._queue();
    }

    /** Is there anything on screen? */
    hasContent() {
        return this.segments.length > 0 || !!this.provisionalText || !!this._listeningEl;
    }

    /** Placeholder state (no session content). */
    showPlaceholder() {
        this._resetState();
        this.container.innerHTML = `
      <div class="transcript-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        <p>Bấm ▶ Bắt đầu để dịch</p>
        <p class="shortcut-hint">⌘ Enter</p>
      </div>
    `;
    }

    /** "Listening…" indicator until the first text arrives. */
    showListening() {
        this._removeListening();
        this.container.querySelector('.transcript-placeholder')?.remove();
        this._ensureContent();
        const indicator = document.createElement('div');
        indicator.className = 'listening-indicator';
        indicator.innerHTML = `
            <div class="listening-waves">
                <span></span><span></span><span></span><span></span><span></span>
            </div>
            <p>Đang nghe…</p>
        `;
        this.contentEl.appendChild(indicator);
        this._listeningEl = indicator;
    }

    /** Status message in the transcript area (e.g. loading a model). */
    showStatusMessage(message) {
        this._ensureContent();
        if (!this._statusEl) {
            this._statusEl = document.createElement('div');
            this._statusEl.className = 'pipeline-status';
            this._statusEl.style.cssText = 'text-align:center; padding:8px; color:var(--text-secondary); font-size:13px;';
            this.contentEl.appendChild(this._statusEl);
        }
        this._statusEl.textContent = message;
    }

    removeStatusMessage() {
        this._statusEl?.remove();
        this._statusEl = null;
    }

    /** Transcript as plain text for copying (everything still on screen). */
    getPlainText() {
        const lines = [];
        for (const seg of this.segments) {
            if (seg.original) lines.push(seg.original);
            if (seg.translation) lines.push(seg.translation);
            if (seg.original || seg.translation) lines.push('');
        }
        if (this.provisionalText) lines.push(this.provisionalText);
        return lines.join('\n').trim();
    }

    /** Clear the display (the saved session is untouched). */
    clear() {
        this._resetState();
        this.container.innerHTML = '';
    }

    setConfidence(confidence) {
        this.lastConfidence = confidence;
    }

    // ─── DOM construction ─────────────────────────────────

    _ensureContent() {
        if (this.contentEl) return;
        this.container.innerHTML = '';
        this.contentEl = el('div', 'transcript-flow');
        this.srcPanel = el('div', 'panel-source');
        this.tgtPanel = el('div', 'panel-translation');
        this.contentEl.append(this.srcPanel, this.tgtPanel);

        // Provisional nodes: always the last child of their parent.
        const block = el('div', 'seg-block provisional');
        const blockLabels = el('span', 'seg-labels');
        const blockText = el('div', 'seg-provisional');
        block.append(blockLabels, blockText);
        block.hidden = true;
        const src = el('div', 'seg-text pending');
        const tgt = el('div', 'seg-text pending');
        src.hidden = true;
        tgt.hidden = true;
        this.contentEl.appendChild(block);
        this.srcPanel.appendChild(src);
        this.tgtPanel.appendChild(tgt);
        this._prov = { block, blockText, blockLabels, src, tgt, key: null };
        this.container.appendChild(this.contentEl);
        this._syncDualClass();
    }

    /** Create a segment's nodes (single block + dual pair), before the provisional ones. */
    _mount(seg) {
        this._ensureContent();
        const speakerChanged = !!seg.speaker && seg.speaker !== this._labelSpeaker;
        const langChanged = !!seg.language && seg.language !== this._labelLang;
        if (speakerChanged) this._labelSpeaker = seg.speaker;
        if (langChanged) this._labelLang = seg.language;

        // Single column: hidden until translated (single view shows translations only).
        const block = el('div', 'seg-block');
        if (speakerChanged) block.append(el('span', 'speaker-label', `Speaker ${seg.speaker}:`), ' ');
        if (langChanged) block.append(el('span', 'lang-badge', this._langEmoji(seg.language)), ' ');
        const blockText = el('div', 'seg-translated');
        block.appendChild(blockText);
        block.hidden = true;

        // Dual: source now, target "..." until the translation arrives.
        const srcWrap = el('div', 'seg-pair');
        if (speakerChanged) srcWrap.appendChild(el('div', 'speaker-label', `Speaker ${seg.speaker}:`));
        const srcText = el('div', 'seg-text', seg.original || '');
        if (langChanged) srcText.prepend(el('span', 'lang-badge', this._langEmoji(seg.language)), ' ');
        srcWrap.appendChild(srcText);
        srcWrap.hidden = !seg.original;
        const tgtWrap = el('div', 'seg-pair');
        if (speakerChanged) tgtWrap.appendChild(el('div', 'speaker-label', ' '));
        const tgtText = el('div', 'seg-text pending', '...');
        tgtWrap.appendChild(tgtText);
        tgtWrap.hidden = !seg.original;

        this.contentEl.insertBefore(block, this._prov.block);
        this.srcPanel.insertBefore(srcWrap, this._prov.src);
        this.tgtPanel.insertBefore(tgtWrap, this._prov.tgt);
        seg.nodes = { block, blockText, srcWrap, tgtWrap, tgtText, markEls: [] };
    }

    _paintTranslation(seg) {
        const n = seg.nodes;
        if (!n) return;
        const low = seg.confidence !== null && seg.confidence !== undefined && seg.confidence < 0.7;
        n.blockText.textContent = seg.translation;
        n.blockText.classList.toggle('low-confidence', low);
        n.block.hidden = false;
        n.tgtText.textContent = seg.translation;
        n.tgtText.className = low ? 'seg-text low-confidence' : 'seg-text';
        n.tgtWrap.hidden = false;
        n.srcWrap.hidden = false;
        n.markEls = [];
        if (seg.mark) this._paintMark(seg);
    }

    _paintMark(seg) {
        const n = seg.nodes;
        if (!n) return;
        n.markEls.forEach(m => m.remove());
        n.markEls = [];
        if (!seg.mark) return;
        for (const target of [n.blockText, n.tgtText]) {
            const m = el('span', 'seg-mark', seg.mark);
            target.prepend(m);
            n.markEls.push(m);
        }
    }

    _unmount(seg) {
        const n = seg.nodes;
        if (!n) return;
        if (this._latest === seg) this._latest = null;
        n.block.remove();
        n.srcWrap.remove();
        n.tgtWrap.remove();
        seg.nodes = null;
    }

    _syncDualClass() {
        const overlay = document.getElementById('overlay-view');
        if (overlay) overlay.classList.toggle('dual-view', this._isDual());
    }

    /** Qwen Live Flash is translation-only (no source channel): always single. */
    _isDual() {
        return this.viewMode === 'dual' && this._provider !== 'qwen';
    }

    // ─── Frame coalescing ─────────────────────────────────

    /** Capture "was at the bottom" once per frame, before this frame's mutations. */
    _noteScroll() {
        if (this._stick) return;
        const at = (e) => !e || (e.scrollHeight - e.scrollTop - e.clientHeight) < STICK_PX;
        this._stick = { flow: at(this._flowScroller()), src: at(this.srcPanel), tgt: at(this.tgtPanel) };
    }

    _queue() {
        if (this._frame) return;
        const raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (cb) => setTimeout(cb, 16);
        this._frame = raf(() => {
            this._frame = 0;
            this._flush();
        });
    }

    _flush() {
        if (!this.contentEl) return;
        this._paintProvisional();
        const stick = this._stick;
        const added = this._newInFrame;
        this._stick = null;
        this._newInFrame = 0;
        if (!stick) return;
        const flow = this._flowScroller();
        if (stick.flow && flow) flow.scrollTop = flow.scrollHeight;
        if (this._isDual()) {
            if (stick.src && this.srcPanel) this.srcPanel.scrollTop = this.srcPanel.scrollHeight;
            if (stick.tgt && this.tgtPanel) this.tgtPanel.scrollTop = this.tgtPanel.scrollHeight;
        }
        // Scrolled up to re-read: don't pull the view down, say what's new.
        const following = this._isDual() ? stick.tgt : stick.flow;
        if (added) this._setUnseen(following ? 0 : this._unseen + added);
    }

    /** Write the provisional state into its fixed nodes (text only, one pass). */
    _paintProvisional() {
        const p = this._prov;
        if (!p) return;
        const text = this.provisionalText;
        const srcProv = this.sourceProvisionalText;

        // Single column. OpenAI's provisionalText is the target stream when a
        // source stream exists; Qwen is target-only; Local's is the partial
        // translation (setPartial); Soniox's is source ASR.
        const local = this._provider === 'local';
        const targetStream = !!srcProv || this._provider === 'qwen' || local;
        p.block.hidden = !text;
        if (text) {
            const cls = targetStream ? 'seg-translated' : 'seg-provisional';
            if (p.blockText.className !== cls) p.blockText.className = cls;
            if (p.blockText.textContent !== text) p.blockText.textContent = text;
            // Labels only when they differ from the last committed ones.
            const sp = this.provisionalSpeaker && this.provisionalSpeaker !== this._labelSpeaker ? this.provisionalSpeaker : null;
            const lg = this.provisionalLanguage && this.provisionalLanguage !== this._labelLang ? this.provisionalLanguage : null;
            const key = `${sp || ''}|${lg || ''}`;
            if (key !== p.key) {
                p.key = key;
                p.blockLabels.textContent = '';
                if (sp) p.blockLabels.append(el('span', 'speaker-label', `Speaker ${sp}:`), ' ');
                if (lg) p.blockLabels.append(el('span', 'lang-badge', this._langEmoji(lg)), ' ');
            }
        }

        // Dual. OpenAI: source = sourceProvisionalText, target = provisionalText.
        // Soniox: source = provisionalText, target "...". Local paints its
        // partial into the pending segment itself, so no provisional rows.
        const usingOpenAi = this._provider === 'openai';
        const srcText = local ? '' : usingOpenAi ? srcProv : text;
        const tgtText = usingOpenAi ? text : '';
        const any = !local && !!(srcProv || text);
        p.src.hidden = !srcText;
        if (srcText && p.src.textContent !== srcText) p.src.textContent = srcText;
        p.tgt.hidden = !any;
        const tgtShown = tgtText || '...';
        if (any && p.tgt.textContent !== tgtShown) p.tgt.textContent = tgtShown;
    }

    /** The element that scrolls in single view (#transcript-content, or its parent). */
    _flowScroller() {
        const c = this.container;
        const parent = c.parentElement;
        return (c.scrollHeight > c.clientHeight || !parent) ? c : parent;
    }

    // ─── Bookkeeping ──────────────────────────────────────

    _trim() {
        // Drop the oldest in one splice (not shift() per item).
        const excess = this.segments.length - MAX_SEGMENTS;
        if (excess <= 0) return;
        for (const seg of this.segments.splice(0, excess)) {
            if (seg.status === 'original') this._pending--;
            this._unmount(seg);
        }
    }

    /** The pending segment added under `key`, walking back over the pending tail. */
    _pendingByKey(key) {
        let seen = 0;
        for (let i = this.segments.length - 1; i >= 0 && seen < this._pending; i--) {
            const seg = this.segments[i];
            if (seg.status !== 'original') continue;
            seen++;
            if (seg.key === key) return seg;
        }
        return null;
    }

    /** Oldest untranslated segment, found by walking back over the pending tail. */
    _oldestPending() {
        let seen = 0, oldest = null;
        for (let i = this.segments.length - 1; i >= 0 && seen < this._pending; i--) {
            if (this.segments[i].status === 'original') { oldest = this.segments[i]; seen++; }
        }
        return oldest;
    }

    /**
     * Drop originals that never got a translation: older than
     * STALE_ORIGINAL_MS, or beyond MAX_PENDING_ORIGINALS pending (oldest first).
     */
    _cleanupStaleOriginals() {
        if (this._pending === 0) return;
        const now = Date.now();
        let seen = 0, kept = 0;
        const total = this._pending;
        for (let i = this.segments.length - 1; i >= 0 && seen < total; i--) {
            const seg = this.segments[i];
            if (seg.status !== 'original') continue;
            seen++;
            if (now - seg.createdAt > STALE_ORIGINAL_MS || kept >= MAX_PENDING_ORIGINALS) {
                this._unmount(seg);
                this.segments.splice(i, 1); // i is near the end: cheap
                this._pending--;
            } else {
                kept++;
            }
        }
    }

    _resetState() {
        if (this._frame) {
            (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)(this._frame);
            this._frame = 0;
        }
        this.segments = [];
        this._pending = 0;
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.provisionalLanguage = null;
        this.sourceProvisionalText = '';
        this._partialKey = null;
        this.currentSpeaker = null;
        this.currentLanguage = null;
        this.lastConfidence = null;
        this._labelSpeaker = null;
        this._labelLang = null;
        this._stick = null;
        this._prov = null;
        this._listeningEl = null;
        this._statusEl = null;
        this.contentEl = null;
        this.srcPanel = null;
        this.tgtPanel = null;
        this._latest = null;
        this._newInFrame = 0;
        this._setUnseen(0);
    }

    _removeListening() {
        if (!this._listeningEl) return;
        this._listeningEl.remove();
        this._listeningEl = null;
    }

    /** Language flag emoji + code. */
    _langEmoji(langCode) {
        const flags = {
            'en': '🇬🇧', 'ja': '🇯🇵', 'ko': '🇰🇷', 'zh': '🇨🇳',
            'vi': '🇻🇳', 'fr': '🇫🇷', 'de': '🇩🇪', 'es': '🇪🇸',
            'th': '🇹🇭', 'id': '🇮🇩', 'pt': '🇵🇹', 'ru': '🇷🇺',
            'ar': '🇸🇦', 'hi': '🇮🇳', 'it': '🇮🇹', 'nl': '🇳🇱',
            'pl': '🇵🇱', 'tr': '🇹🇷', 'sv': '🇸🇪', 'da': '🇩🇰',
            'no': '🇳🇴', 'fi': '🇫🇮', 'el': '🇬🇷', 'cs': '🇨🇿',
            'ro': '🇷🇴', 'hu': '🇭🇺', 'uk': '🇺🇦', 'he': '🇮🇱',
            'ms': '🇲🇾', 'tl': '🇵🇭', 'bn': '🇧🇩', 'ta': '🇱🇰',
        };
        const flag = flags[langCode] || '🌐';
        return `${flag} ${langCode.toUpperCase()}`;
    }
}

/** createElement + class + optional text (textContent — never HTML). */
function el(tag, className, text) {
    const e = document.createElement(tag);
    e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}
