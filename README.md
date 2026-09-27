# MeowLaoshi 猫老师 — Lecture Edition

*Listen to lectures in Chinese, understand them in Vietnamese.* (Formerly “My Translator — Lecture Edition”.)

**English** · [Tiếng Việt](README.vi.md)

A **real-time** speech translation app for macOS and Windows, tuned for **listening to lectures in Chinese and taking notes in Vietnamese** (finance and economics). Forked from [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator) (MIT). It keeps the Tauri + Rust architecture and adds course profiles with term glossaries, a notes pane with hotkeys, a classroom microphone chain, and a **pure-Rust** offline engine (no Python).

> The app's interface is in Vietnamese. Menu names below are given as they appear in the app, with a translation in parentheses.

---

## Contents

1. [Features](#features)
2. [Install (macOS)](#install-macos)
3. [First-time setup](#first-time-setup)
4. [In class — suggested workflow](#in-class--suggested-workflow)
5. [Keyboard shortcuts](#keyboard-shortcuts)
6. [Build from source](#build-from-source)
7. [Free packaging for friends](#free-packaging-for-friends)
8. [Where your data lives](#where-your-data-lives)
9. [Troubleshooting](#troubleshooting)
- [Local model benchmarks](#local-model-benchmarks)
10. [Architecture](#architecture)
11. [Repository layout](#repository-layout)

---

## Features

### Four translation engines, switchable from the toolbar

| Engine | Runs | Latency (speech → text on screen) | Cost | Notes |
|---|---|---|---|---|
| ☁️ **Soniox** `stt-rt-v5` (recommended) | cloud | live text **~1.3 s** (90 % within 2.1 s); translation **~0.8 s** (90 % within 1.0 s) with the default 1.5 s sentence close — *measured* | **$0.12/hour**, translation included | 60+ languages; uses the course profile's **glossary** and context; most accurate on real lectures (3.0 % errors vs 11.4 % for Local) |
| 🖥️ **Local** (offline) | on device, pure Rust | works phrase by phrase: the Chinese shows as soon as a phrase is recognised and the Vietnamese streams in word by word, done **~1.0 s** after the phrase ends on a MacBook Air M5 with Metal (~1.9 s on an x86 CPU). In non-stop speech a phrase is closed at the first real pause after 4 s (8 s at most), so a word reaches the screen **~3.4 s** after it is spoken on average — *measured* | **free** | X-ASR Zipformer (punctuation; the course glossary becomes hotwords) + Tencent Hy-MT2-1.8B (glossary in the prompt); no network or VPN needed |
| ⚡ **OpenAI Realtime** `gpt-realtime-translate` | cloud | not measured here | **≈ $3.06/hour** ($0.034/min translation + $0.017/min `gpt-realtime-whisper` transcription) | translated voice output; needs a VPN in mainland China; no glossary |
| 🌏 **Qwen LiveTranslate** (not recommended) | cloud (Alibaba, Singapore) | translation done **~0.8 s** after a sentence ends — *measured on Qwen3.8* | **≈ $5/hour** — *measured* from the service's own token counts on Qwen3.8 (≈ 40× Soniox) | reachable from mainland China without a VPN; accurate on terms but no glossary; kept in the app, not used. The app still speaks the legacy `qwen3-livetranslate-flash-realtime` protocol |

Soniox latency was measured on 2 minutes of a real lecture streamed at real-time pace from Vietnam over an ordinary connection, with the finance glossary loaded; the figures are medians from when a word is spoken to when it (or its translation) reaches the app. Prices are the vendors' list prices on 2026-09-26 ([Soniox](https://soniox.com/pricing), [OpenAI](https://developers.openai.com/api/docs/pricing)); Qwen's is measured (see *Cloud live translation compared* below).

Each engine's model name can be changed in **Cài đặt › Model** (Settings › Model), including a custom GGUF for Local. The same screen holds a **helper LLM** slot (DeepSeek / Qwen DashScope / Zhipu GLM / OpenAI / any OpenAI-compatible API) for the upcoming academic re-translation and summary features.

### For the classroom

- **Course profiles.** Each subject has its own domain, recognition terms, background context and a **source → target glossary**. A built-in list of **~480 Chinese–English–Vietnamese terms** loads with one click: a core finance set (statements, ratios, corporate finance, investments, derivatives, banking and monetary policy, macroeconomics, econometrics, tax, governance, classroom phrases), a master's-level set (asset pricing, fixed income, financial engineering, valuation, bank regulation and PBoC tools, Chinese capital markets, empirical methods) and CUFE names (schools, campuses, graduate-study vocabulary). For Soniox the list is trimmed to its 8 000-token context limit, longest terms first; the Local engine turns every term of ≥ 3 characters into a recognition hotword. Switching profile **mid-lecture** takes effect immediately.
- **Notes pane** under the transcript (`⌘⇧N`), saved with the session and exported to Markdown.
  - `⌘⇧C` copies the latest sentence into the notes, with its time and source text.
  - `⌘⇧1/2/3` mark the latest sentence ⭐ important / ❓ unclear / 📝 on the exam. Marks show in the transcript and are collected under *Đánh dấu* (Marks) on export.
- **Automatic 📝** when the lecturer says *会考 / 考点 / 期末考 / 必考…* ("this will be on the exam").
- **The live transcript scrolls back through the whole lecture** (up to ~1 500 sentences on screen). Scrolling up to reread doesn't get pulled back down; at the bottom it follows new text.
- **Library study view.** Every session saves itself (Markdown + JSON, every 15 s and on stop/quit). Open one to:
  - reread every sentence (translation, source, time);
  - **add ⭐ ❓ 📝 marks after class**;
  - **keep writing notes** (auto-saved);
  - filter by mark and search within the session, then click a result to jump to it in context.

  You can also search across sessions, rename them, copy as Markdown, and export SRT/TXT.

### Microphone & audio

- **Microphone chain.** It runs on its own thread and never blocks the audio callback. Steps: anti-aliased resampling → 80 Hz high-pass → **GTCRN noise suppression** (on device) → **AGC** (gain up only during speech) → optional **Silero VAD** (sends audio only while someone speaks, which saves STT cost).
- **Apple Voice Processing** (macOS): the system's own echo cancellation, noise suppression and AGC, at almost no CPU cost.
- Sources: microphone, system audio (ScreenCaptureKit / WASAPI), or **both mixed**.
- **Stays in real time.** When the network or the machine falls behind, the app skips old audio instead of letting the translation drift further behind, and tells you ("⏩ đã bỏ qua X s", skipped X s).

### Reading & listening

- **Text-to-speech** reads translations aloud. Providers: free Edge, Microsoft, Google, ElevenLabs, TikTok, or **offline Piper** with Vietnamese voices; see the [TTS guide](docs/tts_guide.md).
- A **Read mode** (Đọc) reads pasted text aloud.

### macOS-style interface

- **Light (default) or dark theme**, or follow the system: **Cài đặt › Hiển thị › Giao diện** (Settings › Display › Appearance), or the ⋯ menu for a quick switch. Every text colour meets WCAG AA contrast (≥ 4.5:1) in both themes.
- A normal window that doesn't cover other apps, native traffic lights and system font (SF, with PingFang for Chinese). Also: opaque surfaces, native scrollbars and cursor, and *Reduce motion* is respected.
- **⤢ Floating panel**: shrinks to a small always-on-top window to use next to slides. **📌 Pin** (`⌘P`) keeps the normal window on top.
- Two-column source | translation view, a compact mode that hides the toolbar, transcript font 18 px by default (up to 140 px).

### Engineering (what differs from the original)

- **No leaks, nothing running while idle.** Audio crosses IPC as binary with bounded queues and connection timeouts. Capture stops instantly, and models are freed when a session stops.
- **Light on resources** (only the Local model may be heavy):
  - no blur or transparency, no animations running during a lecture, no web fonts;
  - the transcript renders incrementally: each sentence costs the same however long the lecture runs, and all tokens in one frame are drawn once.
- **Nothing is downloaded at install.** Models download only when you press **Tải model** (Download models): noise suppression + VAD ~1.2 MB, Local ~1.6 GB, all SHA-256 verified.
- `settings.json` is written atomically with a `.bak` copy; API keys are never logged.

---

## Install (macOS)

> Sharing the app with friends: send **[docs/huong-dan-cai-dat.pdf](docs/huong-dan-cai-dat.pdf)** along with the DMG — a 3-page Vietnamese guide to installing, setting up, using the app in class and fixing common problems (Markdown source: [docs/huong-dan-cai-dat.md](docs/huong-dan-cai-dat.md); rebuild the PDF with `python3 scripts/build-guide-pdf.py`).

**Requirements:** macOS 13 or later. Apple silicon (M1 or later) works best; Intel works too (Local is slower).

1. Open **[Releases](https://github.com/ttkien2035/meowlaoshi/releases/latest)** and download the right file:

   | Your machine | File |
   |---|---|
   | Mac with Apple silicon (M1 or later) | `MeowLaoshi_<version>_aarch64.dmg` |
   | Intel Mac | `MeowLaoshi_<version>_x64.dmg` |
   | Windows 10/11 | `MeowLaoshi_<version>_x64-setup.exe` |

   To check your chip:  → **About This Mac** → *Chip*.

2. Open the `.dmg` and drag **MeowLaoshi** into **Applications** as the arrow in its window shows, then close the window.

3. First launch. Releases are **free**, not signed with an Apple Developer ID, so macOS blocks the first launch:
   1. Open the app → macOS says it can't be opened → click **Done**.
   2. **System Settings › Privacy & Security** → scroll down → **Open Anyway** next to the app → enter your password.
   3. You only do this once. Later versions update from inside the app (**Cài đặt › Giới thiệu › Kiểm tra bản mới**, Settings › About › Check for updates).

   (From Terminal: `xattr -dr com.apple.quarantine /Applications/MeowLaoshi.app`.)

4. Grant permissions when asked: **Microphone** (required for lectures) and **Screen & System Audio Recording** (only to translate audio playing on the Mac, e.g. Zoom or videos). macOS may ask you to reopen the app after granting them.

No Python, Homebrew or anything else to install.

---

## First-time setup

The first launch opens a four-step guide; every step can be skipped and redone later in **Cài đặt** (Settings):

1. **Soniox key** — paste it and press **Kiểm tra key** (Check key): the app connects right away and confirms. No key? Choose **Chưa có key** (No key yet) and use the offline engine.
2. **Offline pack** — one 1.6 GB download (speech recognition, translation, sentence detection) so Local works without network or VPN. It downloads in the background with a progress chip.
3. **Subject** — *Tài chính – kinh tế* (finance & economics) creates a course profile with the ~480-term glossary; *Môn khác* (other) starts empty.
4. **Microphone test** — grants the macOS permission and shows a live level meter.

With a key the app starts on Soniox, otherwise on Local. Whenever something is missing later (a key, the offline pack, microphone permission, the network), the app shows a dialog with the button that fixes it. Mic defaults: 80 Hz high-pass on, noise suppression and AGC **off** — measured on real lectures, both made recognition worse in a reverberant room with student chatter.

---

## In class — suggested workflow

- Sit near the lecturer or use an external/lapel mic. A MacBook mic 5–10 m away loses a lot of accuracy.
- Open notes with `⌘⇧N`, then mark as you listen:
  - `⌘⇧1` an important point;
  - `⌘⇧2` something unclear;
  - `⌘⇧3` "on the exam" (or let the app catch it);
  - `⌘⇧C` to keep a sentence verbatim.
- Switch subject from the profile menu on the Live bar (shown once you have 2+ profiles).
- After class press **Dừng** (Stop). The session is in **📚 Thư viện** (Library); open it to study:
  - filter 📝 for exam material, and ❓ for questions to ask;
  - add marks and keep writing notes;
  - **Chép** (Copy) gives Markdown to paste into Notion or Apple Notes.
- Ask the lecturer before recording.

---

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `⌘↩` | Start / Stop |
| `⌘1` / `⌘2` / `⌘3` | Source: system audio / microphone / both |
| `⌘⇧N` | Toggle the notes pane |
| `⌘⇧C` | Copy the latest sentence into notes (with time) |
| `⌘⇧1` / `⌘⇧2` / `⌘⇧3` | Mark the latest sentence ⭐ / ❓ / 📝 |
| `⌘T` | Toggle reading translations aloud |
| `⌘,` | Settings |
| `⌘P` · `⌘D` · `⌘M` | Pin window · Compact · Minimize |
| `?` | Shortcut sheet |

(On Windows use `Ctrl` instead of `⌘`.)

---

## Build from source

### Requirements

| | macOS | Windows | Linux (development/testing only) |
|---|---|---|---|
| Toolchain | Xcode Command Line Tools (`xcode-select --install`) | Visual Studio Build Tools (C++), WebView2 | `build-essential clang cmake pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libasound2-dev libssl-dev` |
| Rust | [rustup](https://rustup.rs) — stable | rustup stable | rustup stable |
| Node.js | 20+ | 20+ | 20+ |
| CMake | `brew install cmake` | cmake.org | apt |

CMake and clang are needed for llama.cpp (the Local engine). It compiles **once** on the first build (5–10 minutes) and is cached after that.

### Run a development build

```bash
git clone https://github.com/ttkien2035/meowlaoshi.git
cd meowlaoshi
npm install
cp .env.example .env          # optional; empty is fine
npm run dev                   # opens the app with DevTools; UI hot-reloads
```

With `APP_IDENTIFIER=com.ttkien2035.meowlaoshi.dev` in `.env`, `npm run dev` gets its own Microphone/Screen Recording permissions and leaves the installed app alone.

### Checks & tests

```bash
cd src-tauri
cargo check && cargo clippy --all-targets      # must be warning-free
cargo test                                     # tests that need no models
# Local engine against real models (the app's installed model folder works):
MT_TEST_XASR_DIR=/path/x-asr-zh-en-punct-int8 MT_TEST_GGUF=/path/Hy-MT2-1.8B-Q6_K.gguf \
  MT_TEST_WAV=/path/zh.wav cargo test --lib local:: -- --include-ignored --nocapture
```

Test environment variables:

| Variable | Purpose |
|---|---|
| `MT_TEST_XASR_DIR` | extracted X-ASR folder (the app's `local-models/x-asr-zh-en-punct-int8` works) |
| `MT_TEST_WAV` | 16 kHz mono s16le wav for the recognition test (default: first wav in `$MT_TEST_XASR_DIR/test_wavs`). On macOS: `say -v Tingting "…" -o zh.aiff && afconvert -f WAVE -d LEI16@16000 -c 1 zh.aiff zh.wav` |
| `MT_TEST_VAD`, `MT_TEST_LONG_WAV` | Silero VAD model + a long noisy wav for `cargo test --release --test local_pipeline -- --ignored` (checks the 4–8 s utterance cut) |
| `MT_TEST_LECTURE_WAV`, `MT_TEST_OUT`, `MT_TEST_TIMING`, `MT_TEST_CHUNK_MS` | latency probe `cargo test --release --test local_latency -- --ignored`: streams a lecture wav in real time through VAD → X-ASR → a stand-in translator and writes one JSON line per event; `MT_TEST_TIMING=min_silence,soft,hard,pause` in seconds |
| `MT_TEST_GGUF` | GGUF file for the LLM test |
| `MT_SETTINGS_DIR` | the app/tests read and write `settings.json` here instead of the real location, to test corrupt settings/`.bak` without touching yours |

Integration tests (`src-tauri/tests/*.rs`) use the seams in `my_translator_lib::test_api`:

- `MicProcessor`: the microphone DSP without cpal;
- `start_with_sink` / `start_with_translator`: a Local session with a closure event sink and a stub translator;
- `Session::finish`: graceful end that translates what's queued;
- `Settings`.

### Release build

```bash
npm run build:local
# macOS:   src-tauri/target/release/bundle/dmg/MeowLaoshi_<ver>_aarch64.dmg
# Windows: src-tauri/target/release/bundle/nsis/MeowLaoshi_<ver>_x64-setup.exe
```

`build:local` ad-hoc signs on macOS. If the auto-updater's private key isn't available, it skips the update files; the app itself is unaffected. No Apple account is needed.

Intel Mac build from an Apple silicon Mac:

```bash
rustup target add x86_64-apple-darwin
npm run build:local -- --target x86_64-apple-darwin
# → src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/
```

---

## Free packaging for friends

No Apple Developer membership ($99/year) is needed. macOS builds are **ad-hoc signed**; friends click **Open Anyway** once (see *Install*, step 3).

### Option 1 — build a DMG yourself

On a Mac: `npm run build:local`, then share the `.dmg` from `src-tauri/target/release/bundle/dmg/`.

### Option 2 — publish on GitHub (with auto-update)

GitHub Actions (free for public repos) builds all three versions: Apple silicon Mac, Intel Mac and Windows. It then creates a **draft Release** with the downloads and the `latest.json` the auto-updater reads.

**One-time setup:**

1. GitHub disables Actions on forks by default: open the **Actions** tab → *I understand my workflows, go ahead and enable them*.
2. Create the auto-updater key (free, unrelated to Apple). This repo's public key is already in `src-tauri/tauri.conf.json`; only make a new pair for a different fork:
   ```bash
   npm run tauri signer generate -- -w ~/.tauri/my-translator-updater.key --ci
   # paste the .pub file's content into plugins.updater.pubkey in src-tauri/tauri.conf.json
   ```
3. Open **Settings › Secrets and variables › Actions › New repository secret**. Name it `TAURI_SIGNING_PRIVATE_KEY`; the value is the private key file's content (`cat ~/.tauri/my-translator-updater.key`). Never commit this file.

**Each release:**

```bash
# 1. Bump the version in 3 places: package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
# 2. Add a "## vX.Y.Z - YYYY-MM-DD" section to docs/project-changelog.md — it becomes the Release page text
git tag vX.Y.Z && git push origin vX.Y.Z
# 3. Wait for Actions (~20–30 min), open Releases, check the draft, press Publish
```

To build without releasing: **Actions › Build & Release › Run workflow** (downloads are attached to the run).

Installed copies see the new version under **Cài đặt › Giới thiệu › Kiểm tra bản mới**. The updater only accepts builds signed with this repo's key.

---

## Where your data lives

| What | macOS | Windows |
|---|---|---|
| Settings (API keys, course profiles, glossaries) | `~/Library/Application Support/com.ttkien2035.meowlaoshi/settings.json` (+ `.bak`) | `%APPDATA%\com.ttkien2035.meowlaoshi\settings.json` |
| Sessions (Markdown + JSON) | `~/Library/Application Support/com.ttkien2035.meowlaoshi/transcripts/` | `%APPDATA%\com.ttkien2035.meowlaoshi\transcripts\` |
| Noise/VAD models, Local models, Piper voices | `~/Library/Application Support/com.ttkien2035.meowlaoshi/{audio-models,local-models,piper-models}` | `%APPDATA%\com.ttkien2035.meowlaoshi\…` |

Everything stays on your machine. Only the cloud engine you choose receives audio; there is no intermediate server.

### Uninstalling

Dragging the app to the Trash removes only the app; the data folders above stay (about 1.5 GB with the offline pack, including the Soniox key and every session).

- **Keep the data** (reinstalling later without re-downloading or re-entering the key): quit the app and drag **MeowLaoshi** from Applications to the Trash.
- **Remove everything** (lending or selling the Mac): copy out any sessions you want first (Library › Copy), then quit, trash the app, and delete the three folders:

  ```bash
  rm -rf ~/Library/Application\ Support/com.ttkien2035.meowlaoshi ~/Library/WebKit/com.ttkien2035.meowlaoshi ~/Library/Caches/com.ttkien2035.meowlaoshi
  tccutil reset All com.ttkien2035.meowlaoshi   # optional: forget the microphone permission
  ```

  Without Terminal: Finder › Go › Go to Folder (`⌘⇧G`) → each of `~/Library/Application Support`, `~/Library/WebKit`, `~/Library/Caches` → drag `com.ttkien2035.meowlaoshi` to the Trash. Step-by-step in Vietnamese: [docs/huong-dan-cai-dat.md › 6](docs/huong-dan-cai-dat.md#6-gỡ-cài-đặt).
- Windows: uninstall from **Settings › Apps › Installed apps**, then delete `%APPDATA%\com.ttkien2035.meowlaoshi` (data) and `%LOCALAPPDATA%\com.ttkien2035.meowlaoshi` (WebView2 storage). Not yet checked on a Windows machine.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Nothing is heard / status never changes | Check the **Microphone** permission in System Settings; pick the 🎤 source on the Live bar |
| Soniox error 401/402 | Wrong key or no credit — check console.soniox.com |
| Qwen `WebSocket error` right after Start | The DashScope key must be created in the **Singapore** region (international endpoint) |
| "⏩ Mạng chậm" (slow network) toasts keep appearing | Weak Wi-Fi: switch to Qwen (no VPN needed) or Local (offline) |
| Local says models are needed | Cài đặt › Model › Local › **Tải model**; needs ~1.6 GB free |
| Terminal shows `getApplicationProperty: called with invalid property` / `error messaging the mach port for IMKCFRunLoopWakeUpReliable` while typing | Noise from macOS's Input Method Kit when an input method (e.g. Vietnamese Telex) is active; it appears in Electron, Qt and Java apps too and is harmless. Nothing to fix in the app. |
| Recognition makes many mistakes | Keep noise suppression and AGC off (the default); sit closer or use an external mic; pick the right course profile so its glossary applies |
| The first build takes very long | llama.cpp is compiling; first time only. Needs `cmake` + `clang` |
| macOS won't open the app / says it is "damaged" | Free build without a Developer ID — **Privacy & Security › Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/MeowLaoshi.app` |

In a dev build (`npm run dev`), DevTools shows the `[Soniox]`, `[Mic]` and `[Local]` logs.

---

## Local model benchmarks

Measured 2026-09-26 on an x86 CPU (4 threads for recognition, 8 for the LLM) with the same sherpa-onnx / llama.cpp calls the app makes; the harness and data are not in the repo. An M-chip is faster (see [Apple Silicon end to end](#apple-silicon-end-to-end-macbook-air-m5) below); compare rows, not absolute times.

### Speech recognition (Mandarin) — mixed error rate, lower is better

Test material: 100 utterances each from SpeechIO ZH00000 (finance talks), ZH00008 and ZH00025 (in-person lectures) and WenetSpeech `test_meeting` (far-field meetings); 80 "classroom" utterances = lecture speech with synthetic reverb (RT60 0.7 s) and student babble at 10 dB SNR; two real 25-minute lectures scored against human subtitles.

| Model | Download | Finance talks | Lectures | Meetings | Classroom (sim.) | All 480 | Real lecture | Real lecture + room | ms/utt | Peak RSS |
|---|---|---|---|---|---|---|---|---|---|---|
| **X-ASR zh-en punct int8** (chosen) | 136 MB | 2.6 % | 5.6 / 4.3 % | 9.6 % | 14.6 % | **6.8 %** | **8.2 %** | **11.3 %** | 65 | 578 MB |
| SenseVoice-small int8 (previous) | 163 MB | 3.0 % | 4.6 / 5.4 % | 8.9 % | 16.6 % | 7.0 % | 8.9 % | 13.1 % | 68 | 354 MB |
| FireRedASR2-AED int8 | 839 MB | 2.7 % | 3.3 / 4.0 % | 7.1 % | 11.3 % | 5.3 % | — | — | 1 016 | 1.75 GB |
| FunASR-Nano int8 | 842 MB | 2.8 % | 4.8 / 4.3 % | 9.1 % | 15.3 % | 6.7 % | — | — | 465 | 1.7 GB |
| Qwen3-ASR-0.6B int8 | 879 MB | 3.2 % | 6.2 / 4.6 % | 9.3 % | 14.6 % | 7.1 % | — | — | 645 | 1.96 GB |
| zipformer-ctc-zh int8 | 301 MB | 4.2 % | 4.7 / 6.9 % | 9.1 % | 13.6 % | 7.2 % | — | — | 99 | 733 MB |
| FireRedASR2-CTC int8 | 521 MB | 4.3 % | 7.2 / 6.2 % | 9.4 % | 17.1 % | 8.3 % | — | — | 508 | 970 MB |
| SenseVoice 2025-09 / funasr-nano builds | 166–188 MB | 3.4–4.0 % | — | 10.6–11.1 % | 20.9–22.4 % | 9.1 % | — | — | 66 | — |
| Paraformer-zh 2025 int8 | 228 MB | 3.3 % | 7.0 / 9.5 % | 12.4 % | 24.4 % | 10.4 % | — | — | 52 | 321 MB |

FireRedASR2-AED is the most accurate but 15× slower and 5× the memory — it breaks the lightweight rule. X-ASR's streaming modes were not adopted: its own report shows 480 ms streaming at 9.1 % vs 7.1 % offline on WenetSpeech meeting.

### Mic chain and glossary hotwords (X-ASR)

| Configuration | Classroom (sim.) | Real lecture + room | Finance-term recall (143 terms, classroom) |
|---|---|---|---|
| high-pass 80 Hz only | 14.9 % | 11.3 % | 93.0 % |
| + AGC | — | 12.3 % | — |
| + GTCRN denoiser | 33.0 % | 15.4 % | 83.9 % |
| + glossary hotwords (terms of ≥ 3 characters, score 2.0) | 14.9 % | 11.3 % | **99.3 %** (SenseVoice: 84.6 %) |

Hence GTCRN and AGC are off by default (still available in Settings › Micro), and every glossary term of three or more Chinese characters becomes a hotword. Also found: under continuous babble, sherpa-onnx's VAD never reached its 8 s `max_speech_duration` cut (one 46 s segment — that much delay, and X-ASR aborts at ≥ 50 s); the pipeline now cuts an utterance itself (see *Keeping up with the lecturer* below).

### Apple Silicon end to end (MacBook Air M5)

Measured 2026-09-26 by QA on a MacBook Air M5 (10 cores, 16 GB, macOS 27): 72 s of Mandarin lecture audio (12 sentences from real classes and finance lectures, macOS voice *Tingting*, 1.5 s pauses) streamed at real-time pace in 200 ms chunks through the app's own Local pipeline — Silero VAD → X-ASR int8 → Hy-MT2-1.8B Q6_K on Metal — with no glossary. Three runs; per-sentence medians. The split between recognition and translation comes from extra runs with an instant stand-in translator.

| Measure | Result |
|---|---|
| End of sentence → translation on screen | **0.96 s** median (0.77–1.45 s; longer sentences take longer) |
| … of which pause detection + recognition | 0.54 s (0.35 s pause + wait for the next 200 ms chunk + recognition) |
| … of which translation | 0.44 s median (0.27–0.75 s) |
| Recognition alone | 0.20 s for 10.1 s of audio |
| Model load when pressing Start | 0.2–0.5 s; **~14 s once** after installing or updating the app (Metal compiles its shaders, then macOS caches them) |
| Memory | 2.0 GB after loading, 2.36 GB peak |
| CPU while streaming | ~8 % on average (the LLM runs on the GPU) |
| Stop → models released | ~50 ms |
| Sentences with untranslated Chinese | **0/12** |

### Keeping up with the lecturer (Local, 2026-09-27)

Local translates whole phrases, so in non-stop speech a phrase's first words wait until it is closed. Measured on three 5-minute spans of a real finance lecture (the one in *Cloud live translation compared* below: minutes 5–10, 30–35 and 60–65, scored against its human subtitles), streamed in real time in 100 ms chunks through Silero VAD → X-ASR with a stand-in translator as slow as Hy-MT2 on an M5 (`tests/local_latency.rs`):

| Phrase closing rule | Recognition errors | First word of a phrase on screen (median) | Average word on screen |
|---|---|---|---|
| 8 s, at the first quiet moment; 12 s at most (previous) | 11.3 % | 8.6 s after it is said | 4.6 s |
| 8 s, at a ≥ 0.2 s pause; 12 s at most | **9.7 %** | 8.7 s | 4.9 s |
| 5 s, at a ≥ 0.2 s pause; 8 s at most | 10.9 % | 5.9 s | 3.6 s |
| 5 s, at a ≥ 0.3 s pause; 10 s at most | 9.9 % | 6.1 s | 4.0 s |
| **4 s, at a ≥ 0.3 s pause; 8 s at most** (default) | 10.1 % | **5.1 s** | **3.4 s** |

Cutting shorter by itself costs accuracy (a plain 4 s / 6 s cut: 14.9 % on the first span, against 13.4 % for the previous rule), because a cut can land inside a word. Waiting for a real pause fixes that, which is why the default is both faster and more accurate than before. The pause is measured on fixed 50 ms frames, so it does not depend on the capture batch size.

Two further changes remove waiting without touching accuracy: the Chinese phrase is shown the moment it is recognised (dual view), and the translation streams in word by word — on an x86 CPU its first words appeared 0.25–0.36 s after recognition against 0.9–1.2 s for the whole sentence; every partial is a prefix of the final translation, which replaces it. Audio now reaches the engines in 100 ms batches instead of 200 ms: for Soniox that cut the translation lag from 0.96 s to 0.90 s (median; 90 % within 1.08 s instead of 1.20 s) with the same accuracy.

### Cloud reference: Soniox (measured with a real key, same audio)

| | Soniox, no context | Soniox + glossary context | Best local (X-ASR + hotwords) |
|---|---|---|---|
| Real lecture, first 5 min, MER | 3.0 % | 3.0 % | 11.4 % (SenseVoice 12.0 %) |
| Finance-term recall, classroom sim. | 93.0 % | **97.2 %** | 99.3 % |
| Errors on the term set | 1.8 % | 1.0 % | 1.1 % |

Soniox is the primary engine for a reason; the Local engine is the offline fallback. The glossary context lifts Soniox's term recall and translation consistency at no cost in errors. Soniox's 8 000-token context limit is real: the full ~480-term glossary was rejected ("Context is too long: 9958 tokens"), which is why `glossary/index.js` budgets it (Soniox counts about 0.87× this app's estimate; a context estimated at 8 025 was accepted).

### Cloud live translation compared (2026-09-27, real keys, same audio)

Streamed at real-time pace: 5 minutes of a real finance lecture (scored against human subtitles), 72 finance-term sentences in a simulated classroom, and 12 sentences 4 s apart for latency.

| | **Soniox** `stt-rt-v5` + glossary | Qwen3.8-LiveTranslate | Gemini 3.5 Live Translate |
|---|---|---|---|
| Transcript errors, real lecture | **2.7 %** | 11.3 %¹ | 7.8 % |
| Transcript errors, classroom term set | **1.0 %** | 1.9 % | 14.0 % |
| Finance-term recall | 96.2 % | **97.7 %** | 72.7 % |
| Translation uses the glossary's Vietnamese term | **97/133** | 88/133 | 55/133 |
| Sentence end → translation done (median) | 0.84 s | **0.82 s** | 2.20 s |
| Cost per hour | **$0.12** | ≈ $5² | ≈ $2.2 |
| Course glossary | yes | no | no |
| Mainland China without VPN | no | yes | no |

¹ Qwen transcribes fillers (呃, 哈) that the subtitles leave out; on the term set it is close to Soniox. ² From the service's own usage counts (≈ 61 audio + 48 text-output tokens per second).

How fast Soniox closes a sentence (`max_endpoint_delay_ms`, Settings › Engine dịch › *Chờ chốt câu*) drives the translation lag, since Soniox translates only finalized text. Same 5-minute real lecture, real-time pace:

| Sentence close | Transcript errors | Translation lag (median / 90 %) | Sentences closed |
|---|---|---|---|
| 0.5 s | 4.0 % | 1.47 s / 4.23 s | 36 (chopped) |
| 1.0 s | 3.6 % | 0.79 s / 1.06 s | 13 |
| **1.5 s** (default) | **2.7 %** | **0.79 s / 1.00 s** | 7 |
| 3.0 s (previous default) | 2.7 % | 1.51 s / 3.23 s | 6 |

Decision: **Soniox stays the main engine** — most accurate, as fast as anything tested, and 20–40× cheaper. Qwen3.8 matches it on terms and speed but costs ≈ $5/hour, so it is not used. Gemini 3.5 is weaker on finance terms and slower, and always returns audio even when only text is requested; it is not integrated.

### Translation (Chinese → Vietnamese) — 25 finance-lecture sentences, greedy decoding

| Model | File | Sentences with untranslated Chinese | s/sentence (CPU) | Notes |
|---|---|---|---|---|
| **Hy-MT2-1.8B Q6_K** (chosen) | 1.47 GB | **0/25** | 1.4 | accurate numbers, follows the glossary |
| Hy-MT2-1.8B Q4_K_M | 1.13 GB | 0/25 | 1.2 | dropped a digit ("3.2" → "3") |
| Hy-MT2-7B Q4_K_M | 4.6 GB | 0/25 | 6.5–7.5 | best quality, too heavy |
| Qwen2.5-3B-Instruct Q4_K_M (previous) | 2.1 GB | 15/25 | 2.0 | one sentence answered in English |
| Qwen3-4B-Instruct-2507 Q4_K_M | 2.5 GB | 0/25 | 2.6–3.3 | content errors (bond → stock) |
| Qwen3.5-4B Q4_K_M | 2.7 GB | 0/15 | 3.1 | wrong weekday |
| Gemma-3-4B-it Q4_K_M | 2.5 GB | 0/15 | 2.4 | invented "dollars" |
| Qwen3-1.7B Q4_K_M | 1.1 GB | 1/15 | 1.2 | number errors |

## Architecture

```
                  ┌ Soniox (WebSocket from the UI; profile glossary + context)
Mic / system ─► Rust capture ─► DSP thread (resample · HPF · GTCRN · AGC · VAD) ─► binary IPC ─┼ Qwen LiveTranslate (Rust WS)
                                                                                                ├ OpenAI Realtime (Rust WS)
                                                                                                └ Local: Silero VAD → X-ASR → Hy-MT2 (llama.cpp)
                                                                                                                      │
                                                         Live view · Notes · Library (Markdown + JSON)  ◄─────────────┘
```

- **Tauri 2** (Rust backend; HTML/JS UI with no framework and no bundler)
- **cpal** / **ScreenCaptureKit** / **WASAPI** capture; **coreaudio-rs** for Apple Voice Processing; **rubato** resampling
- **sherpa-onnx**: Silero VAD, X-ASR recognition (hotwords from the glossary), GTCRN noise suppression (optional), Piper TTS
- **llama-cpp-2** (llama.cpp): Hy-MT2-1.8B GGUF (any instruct GGUF as a custom model), Metal on Apple silicon
- **reqwest / tokio-tungstenite** for the cloud engines

Rust is checked with `cargo clippy --all-targets` (zero warnings) and with tests against real models on Linux/CI. The macOS-only parts (ScreenCaptureKit, Voice Processing, Metal) are verified on a MacBook.

---

## Repository layout

```
src/                     UI (plain HTML/CSS/JS, no bundler)
  js/app.js              orchestration: sessions, engines, settings, shortcuts
  js/ui.js               live transcript (incremental rendering)
  js/study-view.js       Library › study view
  js/session-store.js    session persistence (JSON + Markdown)
  js/glossary/           Chinese–English–Vietnamese finance glossary
src-tauri/               Rust backend (Tauri 2)
  src/audio/             capture: cpal, ScreenCaptureKit, WASAPI, Apple Voice Processing, mic DSP
  src/local/             offline engine: VAD → X-ASR → Hy-MT2 (llama.cpp)
  src/commands/          Tauri commands: cloud engines, TTS, sessions, model downloads
docs/project-changelog.md  change history (CI uses it as release notes)
docs/tts_guide*.md         text-to-speech guide (English / Vietnamese)
doc_coding/                plans & QA reports between the dev session (WSL) and the QA session (macOS)
scripts/tauri-with-env.mjs dev/build wrapper (.env, ad-hoc signing, skips update files without the key)
.github/workflows/         build + release on GitHub Actions
```

---

## Credits & license

MeowLaoshi by **ttkien2035**. Based on [My Translator](https://github.com/phuc-nt/my-translator) by Nguyễn Trọng Phúc. As the MIT License requires, the original copyright and license notice are kept in [LICENSE](LICENSE); this fork's changes are MIT as well. App icon: [Noto Emoji](https://github.com/googlefonts/noto-emoji) "cat face" (Google, Apache-2.0; source in `src-tauri/icons/source/`). Models: [X-ASR](https://github.com/Gilgamesh-J/X-ASR) (SJTU et al., Apache-2.0), [Hy-MT2](https://huggingface.co/tencent/Hy-MT2-1.8B) (Tencent, Apache-2.0), [Silero VAD](https://github.com/snakers4/silero-vad), GTCRN, [Piper](https://github.com/rhasspy/piper) — each under its own license.
