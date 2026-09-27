# MeowLaoshi 猫老师 — Lecture Edition

*Nghe giảng tiếng Trung, hiểu bằng tiếng Việt.* (Tên cũ: “My Translator — Lecture Edition”.)

[English](README.md) · **Tiếng Việt**

Ứng dụng dịch giọng nói **theo thời gian thực** trên macOS/Windows, được tuỳ biến cho việc **nghe giảng bằng tiếng Trung và ghi chú bằng tiếng Việt** (ngành tài chính – kinh tế). Fork từ [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator) (MIT), giữ nguyên kiến trúc Tauri + Rust và bổ sung: hồ sơ môn học với từ điển thuật ngữ, khung ghi chú có phím tắt, xử lý micro cho lớp học, và engine offline **thuần Rust** (không Python).

---

## Mục lục

1. [Tính năng](#tính-năng)
2. [Cài đặt cho người dùng (macOS)](#cài-đặt-cho-người-dùng-macos)
3. [Thiết lập lần đầu](#thiết-lập-lần-đầu)
4. [Dùng trên lớp — quy trình gợi ý](#dùng-trên-lớp--quy-trình-gợi-ý)
5. [Phím tắt](#phím-tắt)
6. [Build từ mã nguồn](#build-từ-mã-nguồn)
7. [Đóng gói miễn phí cho bạn bè](#đóng-gói-miễn-phí-cho-bạn-bè)
8. [Dữ liệu nằm ở đâu](#dữ-liệu-nằm-ở-đâu)
9. [Xử lý sự cố](#xử-lý-sự-cố)
- [Kết quả đo model Local](#kết-quả-đo-model-local)
10. [Kiến trúc & công nghệ](#kiến-trúc--công-nghệ)
11. [Cấu trúc repo & tài liệu](#cấu-trúc-repo--tài-liệu)

---

## Tính năng

### Bốn engine dịch, chuyển đổi ngay trên thanh công cụ

| Engine | Chạy ở đâu | Độ trễ (từ lúc nói → chữ hiện) | Chi phí | Ghi chú |
|---|---|---|---|---|
| ☁️ **Soniox** `stt-rt-v5` (khuyên dùng) | cloud | chữ tạm **~1,3 s** (90 % trong 2,1 s); bản dịch **~1,7 s** (90 % trong 3,0 s) — *đã đo* | **$0,12/giờ**, đã gồm dịch | 60+ ngôn ngữ; nhận **từ điển thuật ngữ** và ngữ cảnh của hồ sơ môn học; chính xác nhất trên bài giảng thật (lỗi 3,0 % so với 11,4 % của Local) |
| 🖥️ **Local** (offline) | trên máy, thuần Rust | hiện **sau khi hết mỗi câu**: **~1,0 s** trên MacBook Air M5 dùng Metal (0,35 s nhận biết ngắt câu + ~0,2 s nhận dạng + ~0,45 s dịch), ~1,9 s trên CPU x86 — *đã đo* | **miễn phí** | X-ASR Zipformer (có dấu câu; từ điển môn học thành hotword) + Hy-MT2-1.8B của Tencent (từ điển đưa vào prompt); không cần mạng hay VPN |
| ⚡ **OpenAI Realtime** `gpt-realtime-translate` | cloud | chưa đo | **≈ $3,06/giờ** ($0,034/phút dịch + $0,017/phút nhận dạng `gpt-realtime-whisper`) | có giọng nói dịch; ở Trung Quốc đại lục cần VPN; không dùng được từ điển |
| 🌏 **Qwen LiveTranslate** (không khuyên dùng) | cloud (Alibaba, Singapore) | dịch xong **~0,8 s** sau khi hết câu — *đã đo trên Qwen3.8* | **≈ $5/giờ** — *đã đo* từ số token dịch vụ báo lại trên Qwen3.8 (≈ 40 lần Soniox) | vào được từ Trung Quốc không cần VPN; nhận thuật ngữ tốt nhưng không dùng được từ điển; vẫn có trong app nhưng không dùng. App vẫn dùng giao thức của model cũ `qwen3-livetranslate-flash-realtime` |

Độ trễ Soniox đo trên 2 phút bài giảng thật, gửi đúng tốc độ thực từ Việt Nam qua mạng thường, có nạp từ điển tài chính; số liệu là trung vị từ lúc một chữ được nói ra tới lúc chữ đó (hoặc bản dịch) về tới app. Giá là giá niêm yết của nhà cung cấp ngày 26-09-2026 ([Soniox](https://soniox.com/pricing), [OpenAI](https://developers.openai.com/api/docs/pricing)); giá Qwen là số đo thật (xem *So sánh dịch vụ dịch trực tiếp trên cloud* bên dưới).

Tên model của từng engine chỉnh được trong **Cài đặt › Model** (kể cả GGUF tuỳ chỉnh cho Local). Cùng chỗ đó có ô **LLM hỗ trợ** (DeepSeek / Qwen DashScope / Zhipu GLM / OpenAI / bất kỳ API chuẩn OpenAI) dành cho các tính năng dịch lại học thuật và tóm tắt sắp tới.

### Dành cho lớp học

- **Hồ sơ môn học** — mỗi môn một bộ: lĩnh vực, từ nhận dạng, ngữ cảnh nền và **từ điển thuật ngữ nguồn → đích**. Có sẵn **~480 thuật ngữ Trung–Anh–Việt** nạp bằng một nút bấm: bộ tài chính cơ bản (báo cáo tài chính, chỉ số, tài chính doanh nghiệp, đầu tư, phái sinh, ngân hàng – tiền tệ, vĩ mô, kinh tế lượng, thuế – quản trị, câu thường gặp trên lớp), bộ bậc thạc sĩ (định giá tài sản, trái phiếu, kỹ thuật tài chính, định giá doanh nghiệp, giám sát ngân hàng và công cụ của PBoC, thị trường vốn Trung Quốc, phương pháp thực nghiệm) và bộ CUFE (trường, học viện, cơ sở, từ vựng sau đại học). Với Soniox, danh sách được cắt vừa giới hạn 8 000 token, ưu tiên thuật ngữ dài; engine Local biến mọi thuật ngữ từ 3 chữ Hán thành hotword nhận dạng. Đổi hồ sơ **giữa giờ** cũng áp dụng ngay.
- **Khung ghi chú** ngay dưới bản dịch (`⌘⇧N`), tự lưu cùng phiên và xuất ra Markdown. `⌘⇧C` chép câu vừa dịch (kèm giờ và câu gốc). `⌘⇧1/2/3` đánh dấu câu vừa dịch ⭐ quan trọng / ❓ chưa hiểu / 📝 sẽ thi — dấu hiện ngay trên bản dịch và được gom thành mục *Đánh dấu* khi xuất.
- **Tự đánh dấu 📝** khi giảng viên nói *会考 / 考点 / 期末考 / 必考…* ("phần này sẽ thi").
- **Bản dịch trực tiếp cuộn lại được cả buổi** (tới ~1 500 câu trên màn hình). Cuộn lên đọc lại thì không bị kéo xuống; ở cuối thì tự theo chữ mới.
- **Thư viện ôn bài**: mọi buổi tự lưu (Markdown + JSON, 15 giây/lần và khi dừng/thoát). Mở một buổi để:
  - đọc lại từng câu (bản dịch, câu gốc, giờ);
  - **bấm đánh ⭐ ❓ 📝 sau giờ học**;
  - **viết tiếp ghi chú** (tự lưu);
  - lọc theo dấu và tìm trong buổi; bấm một câu trong kết quả để nhảy tới đúng chỗ.

  Ngoài ra: tìm giữa các buổi, đổi tên, chép Markdown, xuất SRT/TXT.

### Micro & âm thanh

- Chuỗi xử lý micro chạy ở thread riêng, không chặn callback âm thanh: resample chống aliasing → lọc thông cao 80 Hz → **khử ồn GTCRN** (trên máy) → **AGC** (chỉ tăng khi có tiếng nói) → **VAD Silero** (tuỳ chọn: chỉ gửi khi có tiếng nói, tiết kiệm phí STT).
- **Apple Voice Processing** (macOS): khử vang – khử ồn – AGC của hệ thống, gần như không tốn CPU.
- Nguồn: micro, âm thanh hệ thống (ScreenCaptureKit / WASAPI), hoặc **trộn cả hai**.
- **Bám kịp thời gian thực**: khi mạng nghẽn hoặc máy chậm, app bỏ phần âm thanh cũ thay vì để bản dịch trễ dần (có báo "⏩ đã bỏ qua X s").

### Đọc & nghe

- **TTS** đọc bản dịch (Edge miễn phí, Microsoft, Google, ElevenLabs, TikTok, hoặc **Piper offline** với giọng Việt; xem [hướng dẫn TTS](docs/tts_guide_vi.md)) và **chế độ Đọc** cho văn bản dán vào.

### Giao diện kiểu macOS

- **Giao diện sáng (mặc định) hoặc tối**, hoặc theo hệ thống: **Cài đặt › Hiển thị › Giao diện**, hoặc đổi nhanh trong menu ⋯. Mọi màu chữ đạt độ tương phản WCAG AA (≥ 4.5:1) ở cả hai giao diện.
- Cửa sổ bình thường (không đè lên app khác), traffic lights gốc, font hệ thống (SF / PingFang cho chữ Hán), nền đặc, thanh cuộn và con trỏ gốc, tôn trọng *Reduce motion*.
- **⤢ Cửa sổ nổi**: thu nhỏ thành khung luôn nằm trên để dùng cạnh slide. **📌 Ghim** (`⌘P`) giữ cửa sổ thường nằm trên.
- Chế độ hai cột nguồn | dịch, compact tự ẩn thanh công cụ, chữ bản dịch mặc định 18 px (tới 140 px), màn hình chính toàn tiếng Việt.

### Kỹ thuật (điểm khác biệt so với bản gốc)

- Audio qua IPC dạng nhị phân, hàng đợi có giới hạn, timeout kết nối, dừng thu tức thì, model giải phóng khi dừng phiên — không rò rỉ, không chạy ngầm khi nhàn rỗi.
- Nhẹ tài nguyên (chỉ model Local được phép nặng):
  - không hiệu ứng mờ/trong suốt, không animation chạy suốt buổi, không web font;
  - bản dịch vẽ tăng dần: mỗi câu tốn chi phí cố định dù buổi dài bao lâu, nhiều token trong một khung hình gộp thành một lần vẽ.
- Không tải gì khi cài app; model chỉ tải khi bạn bấm **Tải model** (khử ồn + VAD ~1,2 MB; Local ~1,6 GB), có kiểm tra SHA-256.
- `settings.json` ghi atomic + bản sao `.bak`; khoá API không bao giờ ghi ra log.

---

## Cài đặt cho người dùng (macOS)

> Gửi app cho bạn bè: kèm file **[docs/huong-dan-cai-dat.pdf](docs/huong-dan-cai-dat.pdf)** (3 trang: cài đặt, thiết lập, dùng trên lớp, xử lý lỗi; bản Markdown: [docs/huong-dan-cai-dat.md](docs/huong-dan-cai-dat.md)). Sửa bản Markdown rồi chạy `python3 scripts/build-guide-pdf.py` để tạo lại PDF.

**Yêu cầu:** macOS 13 trở lên. Chip Apple (M1 trở lên) chạy tốt nhất; Intel dùng được (Local chậm hơn).

1. Vào **[Releases](https://github.com/ttkien2035/meowlaoshi/releases/latest)** và tải đúng file:

   | Máy của bạn | File |
   |---|---|
   | Mac chip Apple (M1 trở lên) | `MeowLaoshi_<phiên bản>_aarch64.dmg` |
   | Mac Intel | `MeowLaoshi_<phiên bản>_x64.dmg` |
   | Windows 10/11 | `MeowLaoshi_<phiên bản>_x64-setup.exe` |

   Xem chip:  → **Giới thiệu về máy Mac này** → dòng *Chip*.

2. Mở file `.dmg`, kéo **MeowLaoshi** vào **Applications** theo mũi tên trong cửa sổ, rồi đóng cửa sổ.

3. Mở app lần đầu. App phát hành **miễn phí**, không ký bằng Apple Developer ID, nên macOS chặn lần mở đầu:
   1. Mở app → macOS báo *không mở được* → bấm **Xong**.
   2. **Cài đặt hệ thống › Quyền riêng tư & Bảo mật** → kéo xuống → bấm **Vẫn mở** cạnh tên app → nhập mật khẩu máy.
   3. Chỉ làm một lần. Các bản sau cập nhật ngay trong app (**Cài đặt › Giới thiệu › Kiểm tra bản mới**).

   (Người quen Terminal: `xattr -dr com.apple.quarantine /Applications/MeowLaoshi.app`.)

4. Cấp quyền khi được hỏi: **Micro** (bắt buộc để nghe giảng) và **Screen & System Audio Recording** (chỉ cần nếu dịch âm thanh từ máy — Zoom, video). Sau khi bật quyền, macOS có thể yêu cầu mở lại app.

Không cần cài Python, Homebrew hay bất cứ thứ gì khác.

---

## Thiết lập lần đầu

Lần đầu mở, app dẫn bạn qua 4 bước; bước nào cũng bỏ qua được và làm lại sau trong **Cài đặt**:

1. **Key Soniox** — dán key, bấm **Kiểm tra key**: app kết nối thử ngay và báo kết quả. Chưa có key thì chọn **Chưa có key** và dùng engine offline.
2. **Gói offline** — tải một lần 1,6 GB (nhận dạng, dịch, ngắt câu) để Local chạy không cần mạng hay VPN. Gói tải trong nền, có chip hiện phần trăm.
3. **Môn học** — *Tài chính – kinh tế* tạo sẵn hồ sơ môn với từ điển ~480 thuật ngữ; *Môn khác* bắt đầu với từ điển trống.
4. **Thử micro** — cấp quyền micro cho macOS và xem thanh mức âm theo giọng nói.

Có key thì app bắt đầu với Soniox, không có thì với Local. Về sau, hễ thiếu gì (key, gói offline, quyền micro, mạng), app hiện hộp thoại kèm nút sửa ngay. Mặc định micro: bật lọc 80 Hz, **tắt** khử ồn và AGC — đo trên bài giảng thật, cả hai làm nhận dạng kém đi trong phòng vang có tiếng sinh viên.

---

## Dùng trên lớp — quy trình gợi ý

- Ngồi gần giảng viên hoặc dùng micro rời/kẹp áo; micro MacBook cách 5–10 m sẽ giảm độ chính xác rõ rệt.
- Bật ghi chú `⌘⇧N`. Nghe đến ý quan trọng: `⌘⇧1`; chưa hiểu: `⌘⇧2`; giảng viên báo sẽ thi: `⌘⇧3` (hoặc để app tự bắt). Muốn giữ nguyên câu: `⌘⇧C`.
- Đổi môn ngay trên thanh Live bằng ô hồ sơ (hiện khi có ≥ 2 hồ sơ).
- Hết buổi bấm **Dừng**. Buổi học nằm trong **📚 Thư viện**: mở ra để ôn — lọc 📝 xem phần *sẽ thi*, lọc ❓ để hỏi lại giảng viên, đánh dấu thêm và viết tiếp ghi chú. Bấm **Chép** để lấy Markdown dán vào Notion/Apple Notes.
- Nên xin phép giảng viên trước khi ghi âm.

---

## Phím tắt

| Phím | Tác dụng |
|---|---|
| `⌘↩` | Bắt đầu / Dừng |
| `⌘1` / `⌘2` / `⌘3` | Nguồn: âm thanh hệ thống / micro / cả hai |
| `⌘⇧N` | Mở/đóng khung ghi chú |
| `⌘⇧C` | Chép câu vừa dịch vào ghi chú (kèm giờ) |
| `⌘⇧1` / `⌘⇧2` / `⌘⇧3` | Đánh dấu câu vừa dịch ⭐ / ❓ / 📝 |
| `⌘T` | Bật/tắt đọc bản dịch (TTS) |
| `⌘,` | Cài đặt |
| `⌘P` · `⌘D` · `⌘M` | Ghim cửa sổ · Compact · Thu nhỏ |
| `?` | Bảng phím tắt |

(Trên Windows dùng `Ctrl` thay `⌘`.)

---

## Build từ mã nguồn

### Yêu cầu

| | macOS | Windows | Linux (chỉ để phát triển/kiểm thử) |
|---|---|---|---|
| Toolchain | Xcode Command Line Tools (`xcode-select --install`) | Visual Studio Build Tools (C++), WebView2 | `build-essential clang cmake pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libasound2-dev libssl-dev` |
| Rust | [rustup](https://rustup.rs) — stable | rustup stable | rustup stable |
| Node.js | 20+ | 20+ | 20+ |
| CMake | `brew install cmake` | cmake.org | apt |

CMake và clang cần cho llama.cpp (engine Local) — biên dịch **một lần** ở lần build đầu (5–10 phút), sau đó có cache.

### Chạy bản phát triển

```bash
git clone https://github.com/ttkien2035/meowlaoshi.git
cd meowlaoshi
npm install
cp .env.example .env          # tuỳ chọn; để trống cũng được
npm run dev                   # mở app kèm DevTools; hot-reload giao diện
```

`npm run dev` có thể dùng `APP_IDENTIFIER=com.ttkien2035.meowlaoshi.dev` trong `.env` để bản dev có quyền Micro/Screen Recording riêng, không đụng bản cài chính thức.

### Kiểm tra & kiểm thử

```bash
cd src-tauri
cargo check && cargo clippy --all-targets      # phải sạch cảnh báo
cargo test                                     # test không cần model
# Kiểm thử engine Local với model thật (thư mục model đã cài trong app dùng được):
MT_TEST_XASR_DIR=/path/x-asr-zh-en-punct-int8 MT_TEST_GGUF=/path/Hy-MT2-1.8B-Q6_K.gguf \
  MT_TEST_WAV=/path/zh.wav cargo test --lib local:: -- --include-ignored --nocapture
```

Biến môi trường cho kiểm thử:

| Biến | Tác dụng |
|---|---|
| `MT_TEST_XASR_DIR` | thư mục X-ASR đã giải nén (dùng luôn `local-models/x-asr-zh-en-punct-int8` của app được) |
| `MT_TEST_WAV` | wav 16 kHz mono s16le cho test nhận dạng (mặc định: wav đầu tiên trong `$MT_TEST_XASR_DIR/test_wavs`). Trên macOS: `say -v Tingting "…" -o zh.aiff && afconvert -f WAVE -d LEI16@16000 -c 1 zh.aiff zh.wav` |
| `MT_TEST_VAD`, `MT_TEST_LONG_WAV` | model Silero VAD + một wav dài có ồn cho `cargo test --release --test local_pipeline -- --ignored` (kiểm ngắt câu 8–12 s) |
| `MT_TEST_GGUF` | file GGUF cho test LLM |
| `MT_SETTINGS_DIR` | app/test đọc-ghi `settings.json` trong thư mục này thay vì thư mục thật — thử settings hỏng/`.bak` mà không đụng cài đặt của bạn |

Test tích hợp (`src-tauri/tests/*.rs`) dùng các seam trong `my_translator_lib::test_api`: `MicProcessor` (DSP micro không cần cpal), `start_with_sink` / `start_with_translator` (phiên Local với closure nhận event và translator giả lập), `Session::finish` (kết thúc êm, dịch nốt hàng đợi), `Settings`.

### Build bản phát hành

```bash
npm run build:local
# macOS:   src-tauri/target/release/bundle/dmg/MeowLaoshi_<ver>_aarch64.dmg
# Windows: src-tauri/target/release/bundle/nsis/MeowLaoshi_<ver>_x64-setup.exe
```

`build:local` tự ký ad-hoc trên macOS và, nếu máy không có khoá riêng của bộ tự cập nhật, bỏ qua các file cập nhật (app vẫn chạy bình thường). Không cần tài khoản Apple nào.

Build cho Mac Intel từ máy Apple Silicon:

```bash
rustup target add x86_64-apple-darwin
npm run build:local -- --target x86_64-apple-darwin
# → src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/
```

---

## Đóng gói miễn phí cho bạn bè

Không cần Apple Developer ($99/năm). Bản macOS được **ký ad-hoc**; bạn bè bấm **Vẫn mở** một lần (mục *Cài đặt cho người dùng*, bước 3).

### Cách 1 — Tự build một file DMG

Trên Mac: `npm run build:local` → gửi file `.dmg` trong `src-tauri/target/release/bundle/dmg/`.

### Cách 2 — Phát hành trên GitHub (có tự cập nhật)

GitHub Actions (miễn phí với repo công khai) build cả ba bản — Mac chip Apple, Mac Intel, Windows — rồi tạo một **bản nháp Release** có sẵn file tải và `latest.json` cho bộ tự cập nhật.

**Chuẩn bị một lần:**

1. Repo fork trên GitHub tắt Actions mặc định: vào tab **Actions** → *I understand my workflows, go ahead and enable them*.
2. Tạo khoá cho bộ tự cập nhật (miễn phí, không liên quan Apple). Khoá công khai của repo này đã có trong `src-tauri/tauri.conf.json`; tạo cặp mới chỉ khi làm fork khác:
   ```bash
   npm run tauri signer generate -- -w ~/.tauri/my-translator-updater.key --ci
   # dán nội dung file .pub vào plugins.updater.pubkey trong src-tauri/tauri.conf.json
   ```
3. **Settings › Secrets and variables › Actions › New repository secret**: tên `TAURI_SIGNING_PRIVATE_KEY`, giá trị là nội dung file khoá riêng (`cat ~/.tauri/my-translator-updater.key`). Không bao giờ commit file này.

**Mỗi lần phát hành:**

```bash
# 1. Đổi version ở 3 chỗ: package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
# 2. Thêm mục "## vX.Y.Z - YYYY-MM-DD" vào docs/project-changelog.md — dùng làm nội dung trang Release
git tag vX.Y.Z && git push origin vX.Y.Z
# 3. Đợi Actions chạy xong (~20–30 phút), mở Releases, kiểm tra bản nháp, bấm Publish
```

Muốn build thử mà không tạo release: **Actions › Build & Release › Run workflow** (file tải kèm theo lượt chạy).

Máy đã cài sẽ thấy bản mới trong **Cài đặt › Giới thiệu › Kiểm tra bản mới**. Bộ tự cập nhật chỉ nhận bản ký bằng đúng khoá của repo này.

---

## Dữ liệu nằm ở đâu

| Nội dung | macOS | Windows |
|---|---|---|
| Cài đặt (API key, hồ sơ môn, từ điển) | `~/Library/Application Support/com.ttkien2035.meowlaoshi/settings.json` (+ `.bak`) | `%APPDATA%\com.ttkien2035.meowlaoshi\settings.json` |
| Buổi học (Markdown + JSON) | `~/Library/Application Support/com.ttkien2035.meowlaoshi/transcripts/` | `%APPDATA%\com.ttkien2035.meowlaoshi\transcripts\` |
| Model khử ồn/VAD, model Local, giọng Piper | `~/Library/Application Support/com.ttkien2035.meowlaoshi/{audio-models,local-models,piper-models}` | `%APPDATA%\com.ttkien2035.meowlaoshi\…` |

Tất cả ở trên máy bạn. Chỉ engine cloud bạn chọn nhận âm thanh; không có máy chủ trung gian.

### Gỡ cài đặt

Kéo app vào Thùng rác chỉ gỡ phần app; các thư mục dữ liệu ở trên vẫn còn (khoảng 1,5 GB kể cả gói offline, gồm cả key Soniox và mọi buổi học).

- **Giữ dữ liệu** (cài lại sau không phải tải lại hay dán lại key): thoát app, kéo **MeowLaoshi** từ Applications vào Thùng rác.
- **Gỡ sạch** (cho mượn hoặc bán máy): chép ra các buổi học muốn giữ (Thư viện › Chép), rồi thoát app, bỏ app vào Thùng rác và xoá ba thư mục:

  ```bash
  rm -rf ~/Library/Application\ Support/com.ttkien2035.meowlaoshi ~/Library/WebKit/com.ttkien2035.meowlaoshi ~/Library/Caches/com.ttkien2035.meowlaoshi
  tccutil reset All com.ttkien2035.meowlaoshi   # không bắt buộc: xoá quyền micro macOS còn nhớ
  ```

  Không dùng Terminal: Finder › Đi › Đi tới thư mục (`⌘⇧G`) → lần lượt `~/Library/Application Support`, `~/Library/WebKit`, `~/Library/Caches` → kéo `com.ttkien2035.meowlaoshi` vào Thùng rác. Từng bước cho người dùng phổ thông: [docs/huong-dan-cai-dat.md › 6](docs/huong-dan-cai-dat.md#6-gỡ-cài-đặt).
- Windows: gỡ trong **Cài đặt › Ứng dụng › Ứng dụng đã cài**, rồi xoá `%APPDATA%\com.ttkien2035.meowlaoshi` (dữ liệu) và `%LOCALAPPDATA%\com.ttkien2035.meowlaoshi` (bộ nhớ WebView2). Chưa kiểm trên máy Windows.

---

## Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Không nghe được gì / trạng thái không đổi | Kiểm tra quyền **Micro** trong Cài đặt hệ thống; chọn đúng nguồn 🎤 trên thanh Live |
| Soniox báo lỗi 401/402 | Sai key hoặc hết tiền — kiểm tra tại console.soniox.com |
| Qwen báo `WebSocket error` ngay khi Start | Key DashScope phải tạo ở region **Singapore** (endpoint quốc tế) |
| Toast "⏩ Mạng chậm" liên tục | Wi-Fi yếu: chuyển sang Qwen (không cần VPN) hoặc Local (offline) |
| Local: "cần tải model" | Cài đặt › Model › Local › **Tải model**; cần ~1,6 GB trống |
| Terminal in `getApplicationProperty: called with invalid property` / `error messaging the mach port for IMKCFRunLoopWakeUpReliable` khi gõ chữ | Nhiễu từ Input Method Kit của macOS khi đang dùng bộ gõ (ví dụ Telex tiếng Việt); Electron, Qt, Java cũng in y như vậy, vô hại. App không sửa được và không cần sửa. |
| Nhận dạng sai nhiều | Tắt "Khử tiếng ồn nền" và AGC (mặc định đã tắt); ngồi gần giảng viên hoặc dùng micro rời; chọn đúng hồ sơ môn để có từ điển |
| Build lần đầu rất lâu | llama.cpp đang được biên dịch; chỉ lần đầu. Cần `cmake` + `clang` |
| macOS không cho mở app / báo "bị hỏng" | Bản miễn phí chưa ký Developer ID — **Quyền riêng tư & Bảo mật › Vẫn mở**, hoặc `xattr -dr com.apple.quarantine /Applications/MeowLaoshi.app` |

Bạn có thể mở DevTools trong bản dev (`npm run dev`) để xem log `[Soniox]`, `[Mic]`, `[Local]`.

---

## Kết quả đo model Local

Đo ngày 26-09-2026 trên CPU x86 (4 luồng cho nhận dạng, 8 cho LLM), gọi đúng các hàm sherpa-onnx / llama.cpp như trong app; bộ đo và dữ liệu không nằm trong repo. Trên chip M nhanh hơn (xem [Đo trọn luồng trên chip Apple](#đo-trọn-luồng-trên-chip-apple-macbook-air-m5) bên dưới), nên hãy so các dòng với nhau, không lấy số tuyệt đối.

### Nhận dạng tiếng Trung — tỷ lệ lỗi, càng thấp càng tốt

Dữ liệu: mỗi tập 100 câu từ SpeechIO ZH00000 (hội thảo tài chính), ZH00008 và ZH00025 (giảng bài trực tiếp), WenetSpeech `test_meeting` (họp, thu xa micro); 80 câu "giảng đường" = giọng giảng bài thêm vang phòng mô phỏng (RT60 0,7 s) và tiếng sinh viên nói chuyện ở SNR 10 dB; hai bài giảng thật dài 25 phút chấm theo phụ đề người chép.

| Model | Tải về | Hội thảo tài chính | Giảng bài | Họp | Giảng đường (mô phỏng) | Cả 480 câu | Bài giảng thật | Bài giảng thật + phòng vang | ms/câu | RAM đỉnh |
|---|---|---|---|---|---|---|---|---|---|---|
| **X-ASR zh-en punct int8** (chọn) | 136 MB | 2,6 % | 5,6 / 4,3 % | 9,6 % | 14,6 % | **6,8 %** | **8,2 %** | **11,3 %** | 65 | 578 MB |
| SenseVoice-small int8 (trước đây) | 163 MB | 3,0 % | 4,6 / 5,4 % | 8,9 % | 16,6 % | 7,0 % | 8,9 % | 13,1 % | 68 | 354 MB |
| FireRedASR2-AED int8 | 839 MB | 2,7 % | 3,3 / 4,0 % | 7,1 % | 11,3 % | 5,3 % | — | — | 1 016 | 1,75 GB |
| FunASR-Nano int8 | 842 MB | 2,8 % | 4,8 / 4,3 % | 9,1 % | 15,3 % | 6,7 % | — | — | 465 | 1,7 GB |
| Qwen3-ASR-0.6B int8 | 879 MB | 3,2 % | 6,2 / 4,6 % | 9,3 % | 14,6 % | 7,1 % | — | — | 645 | 1,96 GB |
| zipformer-ctc-zh int8 | 301 MB | 4,2 % | 4,7 / 6,9 % | 9,1 % | 13,6 % | 7,2 % | — | — | 99 | 733 MB |
| FireRedASR2-CTC int8 | 521 MB | 4,3 % | 7,2 / 6,2 % | 9,4 % | 17,1 % | 8,3 % | — | — | 508 | 970 MB |
| SenseVoice bản 2025-09 / funasr-nano | 166–188 MB | 3,4–4,0 % | — | 10,6–11,1 % | 20,9–22,4 % | 9,1 % | — | — | 66 | — |
| Paraformer-zh 2025 int8 | 228 MB | 3,3 % | 7,0 / 9,5 % | 12,4 % | 24,4 % | 10,4 % | — | — | 52 | 321 MB |

FireRedASR2-AED chính xác nhất nhưng chậm gấp 15 lần và tốn RAM gấp 5, trái yêu cầu app nhẹ. Không dùng chế độ streaming của X-ASR: báo cáo của chính model cho thấy streaming 480 ms lỗi 9,1 % so với 7,1 % offline trên WenetSpeech meeting.

### Chuỗi micro và hotword từ từ điển (X-ASR)

| Cấu hình | Giảng đường (mô phỏng) | Bài giảng thật + phòng vang | Nhận đúng thuật ngữ tài chính (143 lượt, giảng đường) |
|---|---|---|---|
| chỉ lọc 80 Hz | 14,9 % | 11,3 % | 93,0 % |
| + AGC | — | 12,3 % | — |
| + khử ồn GTCRN | 33,0 % | 15,4 % | 83,9 % |
| + hotword từ từ điển (từ ≥ 3 chữ Hán, điểm 2,0) | 14,9 % | 11,3 % | **99,3 %** (SenseVoice: 84,6 %) |

Vì vậy GTCRN và AGC tắt mặc định (vẫn bật được trong Cài đặt › Micro), và mọi thuật ngữ từ 3 chữ Hán trở lên trong từ điển trở thành hotword. Phát hiện thêm: khi tiếng ồn liên tục, VAD của sherpa-onnx không bao giờ ngắt ở mốc 8 s `max_speech_duration` (có đoạn 46 s — dịch trễ bấy nhiêu, và X-ASR sập từ 50 s); pipeline nay tự ngắt câu ở chỗ lặng sau 8 s, chậm nhất là 12 s.

### Đo trọn luồng trên chip Apple (MacBook Air M5)

QA đo ngày 26-09-2026 trên MacBook Air M5 (10 nhân, 16 GB, macOS 27): 72 s audio bài giảng tiếng Trung (12 câu lấy từ lớp học thật và bài giảng tài chính, giọng *Tingting* của macOS, nghỉ 1,5 s giữa các câu) phát theo đúng thời gian thực, mỗi lần 200 ms, qua chính luồng Local của app — Silero VAD → X-ASR int8 → Hy-MT2-1.8B Q6_K trên Metal — không dùng từ điển. Chạy 3 lần, lấy trung vị theo từng câu. Phần tách nhận dạng / dịch có được nhờ chạy thêm với một bộ dịch giả trả kết quả tức thì.

| Chỉ số | Kết quả |
|---|---|
| Hết câu → bản dịch hiện trên màn hình | **0,96 s** trung vị (0,77–1,45 s; câu dài thì lâu hơn) |
| … trong đó nhận biết ngắt câu + nhận dạng | 0,54 s (0,35 s chờ ngắt + chờ gói 200 ms kế tiếp + nhận dạng) |
| … trong đó dịch | 0,44 s trung vị (0,27–0,75 s) |
| Riêng nhận dạng | 0,20 s cho 10,1 s audio |
| Nạp model khi bấm Bắt đầu | 0,2–0,5 s; **~14 s một lần** sau khi cài hoặc cập nhật app (Metal biên dịch shader, sau đó macOS lưu lại) |
| Bộ nhớ | 2,0 GB sau khi nạp, đỉnh 2,36 GB |
| CPU khi đang chạy | trung bình ~8 % (LLM chạy trên GPU) |
| Dừng → giải phóng model | ~50 ms |
| Câu còn sót chữ Hán | **0/12** |

### Mốc tham chiếu cloud: Soniox (đo bằng key thật, cùng audio)

| | Soniox, không context | Soniox + từ điển | Local tốt nhất (X-ASR + hotword) |
|---|---|---|---|
| Bài giảng thật, 5 phút đầu, tỷ lệ lỗi | 3,0 % | 3,0 % | 11,4 % (SenseVoice 12,0 %) |
| Nhận đúng thuật ngữ tài chính, giảng đường mô phỏng | 93,0 % | **97,2 %** | 99,3 % |
| Lỗi trên bộ câu thuật ngữ | 1,8 % | 1,0 % | 1,1 % |

Soniox là engine chính có lý do; engine Local là dự phòng offline. Từ điển đưa vào context giúp Soniox nhận đúng thuật ngữ hơn và dịch nhất quán hơn mà không tăng lỗi. Giới hạn 8 000 token của Soniox là thật: gửi cả ~480 mục bị từ chối ("Context is too long: 9958 tokens"), nên `glossary/index.js` phải cắt theo ngân sách (Soniox đếm khoảng 0,87 lần ước lượng của app; context ước lượng 8 025 được chấp nhận).

### So sánh dịch vụ dịch trực tiếp trên cloud (27-09-2026, key thật, cùng audio)

Gửi âm thanh đúng tốc độ thực: 5 phút bài giảng tài chính thật (chấm theo phụ đề người chép), 72 câu thuật ngữ tài chính trong giảng đường mô phỏng, và 12 câu cách nhau 4 s để đo độ trễ.

| | **Soniox** `stt-rt-v5` + từ điển | Qwen3.8-LiveTranslate | Gemini 3.5 Live Translate |
|---|---|---|---|
| Lỗi chép lời, bài giảng thật | **2,7 %** | 11,3 %¹ | 7,8 % |
| Lỗi chép lời, câu thuật ngữ trong lớp | **1,0 %** | 1,9 % | 14,0 % |
| Nhận đúng thuật ngữ tài chính | 96,2 % | **97,7 %** | 72,7 % |
| Bản dịch dùng đúng từ tiếng Việt trong từ điển | **97/133** | 88/133 | 55/133 |
| Hết câu → dịch xong (trung vị) | 0,84 s | **0,82 s** | 2,20 s |
| Chi phí mỗi giờ | **$0,12** | ≈ $5² | ≈ $2,2 |
| Từ điển môn học | có | không | không |
| Dùng ở Trung Quốc không cần VPN | không | có | không |

¹ Qwen chép cả từ đệm (呃, 哈) mà phụ đề đã lược; ở bộ câu thuật ngữ thì gần bằng Soniox. ² Tính từ số token dịch vụ báo lại (≈ 61 token âm thanh + 48 token chữ đầu ra mỗi giây).

Kết luận: **Soniox là engine chính** — chính xác nhất, nhanh ngang các dịch vụ còn lại và rẻ hơn 20–40 lần. Qwen3.8 bằng Soniox về thuật ngữ và tốc độ nhưng tốn ≈ $5/giờ nên không dùng. Gemini 3.5 yếu hơn ở thuật ngữ tài chính, chậm hơn, và luôn trả kèm giọng đọc dù chỉ yêu cầu chữ; không đưa vào app.

### Dịch Trung → Việt — 25 câu bài giảng tài chính, giải mã greedy

| Model | File | Câu còn lẫn chữ Hán | s/câu (CPU) | Ghi chú |
|---|---|---|---|---|
| **Hy-MT2-1.8B Q6_K** (chọn) | 1,47 GB | **0/25** | 1,4 | số liệu đúng, theo từ điển |
| Hy-MT2-1.8B Q4_K_M | 1,13 GB | 0/25 | 1,2 | mất chữ số ("3,2" → "3") |
| Hy-MT2-7B Q4_K_M | 4,6 GB | 0/25 | 6,5–7,5 | chất lượng tốt nhất, quá nặng |
| Qwen2.5-3B-Instruct Q4_K_M (trước đây) | 2,1 GB | 15/25 | 2,0 | 1 câu trả lời bằng tiếng Anh |
| Qwen3-4B-Instruct-2507 Q4_K_M | 2,5 GB | 0/25 | 2,6–3,3 | sai nội dung (trái phiếu → cổ phiếu) |
| Qwen3.5-4B Q4_K_M | 2,7 GB | 0/15 | 3,1 | sai thứ trong tuần |
| Gemma-3-4B-it Q4_K_M | 2,5 GB | 0/15 | 2,4 | tự thêm "đô la" |
| Qwen3-1.7B Q4_K_M | 1,1 GB | 1/15 | 1,2 | sai số liệu |

## Kiến trúc & công nghệ

```
                 ┌ Soniox (WebSocket từ giao diện; từ điển + ngữ cảnh hồ sơ môn)
Micro / hệ thống ─► Rust capture ─► DSP thread (resample · HPF · GTCRN · AGC · VAD) ─► IPC nhị phân ─┼ Qwen LiveTranslate (Rust WS)
                                                                                                    ├ OpenAI Realtime (Rust WS)
                                                                                                    └ Local: Silero VAD → X-ASR → Hy-MT2 (llama.cpp)
                                                                                                                          │
                                                             Overlay · Ghi chú · Thư viện (Markdown + JSON)  ◄────────────┘
```

- **Tauri 2** (Rust backend, giao diện HTML/JS không framework, không bundler)
- **cpal** / **ScreenCaptureKit** / **WASAPI** thu âm; **coreaudio-rs** cho Apple Voice Processing; **rubato** resample
- **sherpa-onnx**: Silero VAD, X-ASR nhận dạng (hotword từ từ điển), GTCRN khử ồn (tuỳ chọn), Piper TTS
- **llama-cpp-2** (llama.cpp): Hy-MT2-1.8B GGUF (GGUF instruct bất kỳ làm model tuỳ chỉnh), Metal trên Apple Silicon
- **reqwest / tokio-tungstenite** cho các engine cloud

Mã Rust được kiểm bằng `cargo clippy --all-targets` (0 cảnh báo) và test chạy model thật trên Linux/CI; các phần chỉ có trên macOS (ScreenCaptureKit, Voice Processing, Metal) kiểm trên MacBook.

---

## Cấu trúc repo & tài liệu

```
src/                     giao diện (HTML/CSS/JS thuần, không bundler)
  js/app.js              điều phối chính: phiên, engine, cài đặt, phím tắt
  js/ui.js               bản dịch trực tiếp (vẽ tăng dần)
  js/study-view.js       Thư viện › ôn bài
  js/session-store.js    lưu phiên (JSON + Markdown)
  js/glossary/           từ điển tài chính Trung–Anh–Việt
src-tauri/               backend Rust (Tauri 2)
  src/audio/             thu âm: cpal, ScreenCaptureKit, WASAPI, Apple Voice Processing, DSP micro
  src/local/             engine offline: VAD → X-ASR → Hy-MT2 (llama.cpp)
  src/commands/          lệnh Tauri: engine cloud, TTS, phiên, tải model
docs/project-changelog.md  lịch sử thay đổi (CI dùng làm release notes)
docs/tts_guide*.md         hướng dẫn giọng đọc
doc_coding/                kế hoạch & báo cáo QA giữa phiên phát triển (WSL) và phiên QA (macOS)
scripts/tauri-with-env.mjs chạy dev/build (.env, ký ad-hoc, tắt file cập nhật khi thiếu khoá)
.github/workflows/         build + phát hành trên GitHub Actions
```

---

## Ghi công & giấy phép

MeowLaoshi do **ttkien2035** phát triển. Dựa trên [My Translator](https://github.com/phuc-nt/my-translator) của Nguyễn Trọng Phúc; theo yêu cầu của giấy phép MIT, thông báo bản quyền và giấy phép gốc được giữ nguyên trong [LICENSE](LICENSE). Phần tuỳ biến trong fork này cũng theo MIT. Icon app: emoji "cat face" của [Noto Emoji](https://github.com/googlefonts/noto-emoji) (Google, Apache-2.0; bản gốc trong `src-tauri/icons/source/`). Model: [X-ASR](https://github.com/Gilgamesh-J/X-ASR) (ĐH Giao thông Thượng Hải và cộng sự, Apache-2.0), [Hy-MT2](https://huggingface.co/tencent/Hy-MT2-1.8B) (Tencent, Apache-2.0), [Silero VAD](https://github.com/snakers4/silero-vad), GTCRN, [Piper](https://github.com/rhasspy/piper) — theo giấy phép riêng của từng model.
