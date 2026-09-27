# Kế hoạch việc — chốt ngày 2026-09-25

Đã thống nhất giữa kỹ sư trưởng (WSL) và QA (Mac) sau QA vòng 1–2.
HEAD hiện tại: `f7d0769` trên cả `main` và `feature/lecture-assistant`.
Chi tiết findings: xem `qa-reports/2026-09-25-round1-2.md`.

Thực hiện theo thứ tự: **Commit A** trước, **Commit B** sau. Mỗi commit push
lên `feature/lecture-assistant` rồi fast-forward `main` để QA pull về test.

---

## Commit A — nền + test seam (không đổi giao diện)

| # | Việc | Chi tiết đã chốt |
|---|---|---|
| F1 | Lọc segment rác trong `src-tauri/src/local/pipeline.rs` | Bỏ segment có RMS < −45 dBFS **hoặc** text sau khi lược dấu câu ≤ 1 ký tự. Không đưa text trùng với segment liền trước vào LLM. Lý do: SenseVoice trả `"没。"` cho 1 s im lặng. |
| F2 | Trạng thái + warm-up Metal trong `src-tauri/src/local/llm.rs` / `pipeline.rs` | Lần nạp LLM đầu tiên trên macOS ggml biên dịch thư viện `fa` mất ~13,5 s. Thêm status `"Đang khởi tạo Metal (lần đầu ~15 s)…"` khi nạp, và warm-up một prompt 1 token ngay sau khi load để lần dịch đầu không gánh chi phí này. |
| F3 | Test đọc `MT_TEST_WAV` | Trong `src-tauri/src/local/asr.rs`, test `transcribes_chinese_sample` đọc wav từ env `MT_TEST_WAV`, fallback `$MT_TEST_SENSEVOICE_DIR/test_wavs/zh.wav`. Không commit wav vào repo; ghi lại cách tạo wav bằng `say` + `afconvert` (xem `qa-howto-macos.md`). |
| S1 | `MT_SETTINGS_DIR` | `settings_path()` trong `src-tauri/src/settings.rs` đọc env `MT_SETTINGS_DIR`; nếu có thì dùng thư mục đó thay cho `~/Library/Application Support/com.personal.translator`. Để QA test P3 trong thư mục tạm, không đụng settings thật. |
| S2 | Seam cho pipeline | `pipeline::start_with_sink(cfg, Box<dyn Fn(LocalEvent) + Send>)` vì `tauri::ipc::Channel` không tạo được trong test. `start()` hiện tại gọi qua seam này. Thêm cách thay LLM bằng stub (ví dụ trait hoặc `cfg(test)` hook) ngủ 5 s để test backlog (P5). |
| S3 | Seam cho mic DSP | `mic_pipeline::MicProcessor` public, có hàm xử lý buffer f32 vào → s16le ra không phụ thuộc cpal, để test P6. |

Sau Commit A, QA chạy P1–P7 (bảng bên dưới).

### Trạng thái Commit A — đã làm (kỹ sư trưởng, 2026-09-25)

Đủ F1, F2, F3, S1, S2, S3. Chỗ khác hoặc thêm so với bảng trên:

- **F1+ pre-roll (mới, phát hiện khi tự chạy P1-dạng):** VAD cắt mất phụ âm đầu câu ngay sau im lặng (`开放时间` → `放时间`). Pipeline giữ vòng đệm 12 s và ghép 300 ms trước mỗi segment. Kiểm với `zh.wav`, im lặng đầu 0/300/500 ms → cả ba ra `开放时间…`. P1 nên kiểm cả chữ đầu câu.
- **S1+ lỗi `.bak`:** `save()` trước đây luôn chép file chính sang `.bak`, nên khi file chính hỏng thì `.bak` tốt bị đè ngay lần lưu sau. Nay chỉ sao lưu nếu file chính parse được. Đây đúng là tình huống P3.
- **S2:** sink có kiểu `Box<dyn Fn(LocalEvent) + Send + Sync>` (phải `Sync` vì hai thread dùng chung). LLM stub đi qua `pipeline::start_with_translator(cfg, sink, factory)`, với `factory: Box<dyn FnOnce() -> Result<Box<dyn Translator>, String> + Send>` chạy trên thread `local-llm`. Thêm `Session::finish()`: đóng audio **không** cancel, flush câu cuối và dịch hết hàng đợi rồi `Closed`. Dùng cho P1/P5 (“câu cuối luôn được dịch”). `drop(Session)` vẫn là dừng ngay.
- **Đường vào cho test tích hợp:** `my_translator_lib::test_api` re-export `MicProcessor`, `MicOptions`, `start_with_sink`, `start_with_translator`, `Session`, `SessionConfig`, `LocalEvent` (có `Debug`), `Translator`, `TranslatorFactory`, `TranslateRequest`, `UTTERANCE_QUEUE_MAX`, `Settings`. Đặt test ở `src-tauri/tests/*.rs`.
- **S3/P6:** `MicProcessor::process` giữ lại tối đa ~1 chunk resample + 511 mẫu (cửa sổ 32 ms). Tự đo: sine 48 kHz stereo 10 s → 159 744/160 000 mẫu (lệch 0,16 %).
- **F2:** trên macOS/aarch64, status `loading` là "Đang khởi tạo Metal (lần đầu ~15 s)…". `Llm::warm_up()` decode 1 token sau khi load; bản CPU bỏ qua warm-up. Nếu LLM load lỗi, pipeline set cancel để ASR dừng.
- Unit test mới (không cần model): `rms_levels`, `filter_rejects_junk_and_repeats`, `history_ring_ranges`, `queue_drops_oldest_and_keeps_newest`.
- Chưa kiểm trên macOS: warm-up Metal (có thật sự bỏ được 13,5 s khỏi câu đầu không). QA đo giúp: thời gian từ `ready` → `Result` đầu tiên, lần chạy đầu sau khi xoá cache Metal.

---

## Commit B — macOS look (làm theo thứ tự U3 → U1 → U2 → U5 → U4 → U6)

Nhận xét gốc của Kiên: *"giao diện không ra một cái app trên macOS lắm"*.

| # | Việc | Chi tiết đã chốt |
|---|---|---|
| U3 | Font hệ thống | `src/styles/main.css`: `font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif`. Bỏ `<link>` Google Fonts trong `src/index.html` và bỏ `fonts.googleapis.com`/`fonts.gstatic.com` khỏi CSP trong `src-tauri/tauri.conf.json`. Lý do: Inter trông "web", và offline (lớp học) font nhấp nháy. |
| U1 | Traffic lights macOS | `tauri.conf.json` cửa sổ `main`: `decorations: true`, `titleBarStyle: "Overlay"`, `hiddenTitle: true`. Giữ `data-tauri-drag-region`. Bỏ nút `×` tự vẽ (`#btn-close`, `.close-btn`). Chừa ~78 px bên trái control-bar cho 3 nút. Windows sẽ có thanh tiêu đề gốc, chấp nhận. |
| U2 | Cửa sổ chính, không phải overlay | `alwaysOnTop: false` mặc định; kích thước mặc định 1000×680 (chế độ "mở rộng" hiện có thành mặc định). Giữ nút 📌 (`⌘P`) và chế độ compact overlay `⤢` cho lúc chiếu slide. |
| U5 | Modal chọn engine chỉ hiện lần đầu | Lưu cờ `engine_picker_done` trong settings; nếu đã có `translation_mode` do người dùng chọn thì không hiện `#engine-picker` khi mở app. Hiện tại modal đè lên app mỗi lần mở, kể cả khi toolbar phía sau đã là "Local ● Ready". |
| U4 | Việt hoá modal | Tiêu đề, 3 thẻ, hint, đơn vị giá ("~0,12 $/giờ"). Thứ tự thẻ: **Soniox → Local → Qwen**; **ẩn OpenAI** khỏi modal (vẫn chọn được trong Cài đặt). |
| U6 | Thẩm mỹ (làm cuối, có thể revert riêng) | Bo góc card 10–12 px; toolbar cao 38 px; nút primary theo accent hệ thống (#0A84FF); nền qua `windowEffects` macOS (`underWindowBackground`, cần `transparent: true`) **có fallback** giữ nền tối nếu effect không khả dụng. Chưa làm light mode (đợi Kiên xác nhận). |

Tiêu chí QA cho Commit B (QA kiểm bằng screenshot trên Mac):
- Traffic lights hiển thị đúng và kéo được cửa sổ bằng toolbar.
- Không còn chữ tiếng Anh trên màn hình chính.
- Mở app lần 2 không hiện modal chọn engine.
- Font là SF; mở app khi offline không đổi font.

### Trạng thái Commit B — B1 đã làm (kỹ sư trưởng, 2026-09-25)

Commit B tách hai phần để U6 revert riêng được: **B1** = U2, U3, U1, U5, U4 cùng Việt hoá màn hình chính; **B2** = U6 (xem dưới).

- **U2:** cửa sổ bình thường 1000×680 (tối thiểu 720×420), `alwaysOnTop: false`, 📌 không bật mặc định. App **luôn mở ở cửa sổ thường**, không nhớ chế độ overlay giữa các lần mở; kích thước theo từng chế độ vẫn nhớ. Chế độ ⤢ overlay (760×260) là cửa sổ nổi nên tự nằm trên cùng; về cửa sổ thường thì trả lại lựa chọn 📌 của người dùng.
- **U3:** font `-apple-system, system-ui, "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif`. Đã bỏ Google Fonts khỏi HTML và CSP, `lang="vi"`.
- **U1:** `decorations: true`, `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `trafficLightPosition {x: 12, y: 14}`, toolbar cao **38 px** (làm luôn ở B1 vì vị trí đèn phụ thuộc chiều cao). Chừa 78 px bên trái cho toolbar và header Cài đặt; toàn màn hình thì bỏ. Ở compact khi toolbar ẩn, transcript chừa 30 px phía trên. Đã bỏ nút × tự vẽ (nút đỏ đi qua `onCloseRequested`, vẫn lưu phiên) và `#resize-handle` chết.
- **U5:** cờ `engine_picker_done`: cài mới là `false`; file settings cũ chưa có trường này nạp thành `true` (không hiện lại). Đặt `true` khi chọn thẻ hoặc bấm Bắt đầu lần đầu.
- **U4:** modal tiếng Việt, thẻ **Soniox → Local → Qwen**, không có OpenAI.
- **Việt hoá:** mọi chữ và tooltip trên màn hình chính, nhãn trạng thái (Sẵn sàng / Đang kết nối… / Đang nghe / Lỗi), 44 toast trên các luồng chính. Cài đặt chi tiết còn một số chữ tiếng Anh; ngoài phạm vi B1.

**QA chụp màn hình B1 (thêm vào tiêu chí gốc):**

- Traffic lights có **nằm giữa theo chiều dọc** toolbar 38 px không. Số y = 14 lấy từ đo đạc của một app Tauri khác (tâm ≈ y + 5), chưa đo trên máy này. Lệch thì báo số px để chỉnh.
- Khoảng 78 px có đủ cho 3 đèn không, và nút Cài đặt không bị che.
- Vào/ra toàn màn hình: toolbar dời trái/phải đúng.
- Kéo cửa sổ bằng toolbar và khoảng trống. Double-click toolbar sẽ luôn phóng to, không theo cài đặt hệ thống; đây là giới hạn của `data-tauri-drag-region`.

### Phạm vi B2 (sửa theo nghiên cứu HIG/WebKit và yêu cầu "nhẹ tài nguyên" của Kiên)

**Không dùng vibrancy** (`windowEffects` + `transparent`). Kiên yêu cầu app nhẹ; chỉ model Local được tốn tài nguyên. Nền đặc dùng màu hệ thống.

1. Bỏ toàn bộ `backdrop-filter: blur(...)` (6 chỗ, có cả view chính). Cửa sổ không trong suốt nên blur không nhìn thấy mà vẫn tốn GPU mỗi khung hình.
2. Bỏ 4 animation vô hạn chạy lâu: nút ghi âm (suốt phiên), con trỏ nhấp nháy (suốt phiên), badge cập nhật (mãi mãi), sóng "đang nghe". Giữ các animation vài giây. Tôn trọng `prefers-reduced-motion`.
3. Màu: `color-scheme: dark`, màu chữ/viền theo `-apple-system-label` và `-apple-system-separator` (theo nghiên cứu, chạy được trong WKWebView), accent `#0A84FF`. WebKit không lộ accent thật của người dùng; muốn có phải đọc bằng Rust (để sau). Chưa làm light mode.
4. Bỏ các dấu hiệu "trang web": `cursor: default` (không dùng bàn tay trừ link), không cho chọn chữ trên chrome (chỉ chọn được trong transcript), `:focus-visible`, bỏ `::-webkit-scrollbar` tuỳ biến để dùng thanh cuộn overlay gốc, chặn menu chuột phải trừ ô nhập, `overscroll-behavior: none`.
5. Bo góc card 10–12 px, control 28 px theo HIG.
6. ~~Chuyển ▶ Bắt đầu / TTS / ⋯ lên toolbar~~. **Kiên quyết định giữ hàng nút dưới đáy** (2026-09-26); không làm.

### Trạng thái B2 — đã làm (mục 6 không làm theo quyết định của Kiên)

- **Nền đặc:** bảng màu tối kiểu macOS, cửa sổ `#1e1e1e`, toolbar `#2a2a2c`, accent `#0a84ff`; xanh/vàng/đỏ theo màu hệ thống; `color-scheme: dark`. Ba view toàn cửa sổ bỏ bo góc 14 px + viền + bóng (di sản cửa sổ không viền; giờ macOS tự bo góc).
- **Bỏ:** 11 dòng `backdrop-filter`; animation của nút ghi âm, con trỏ nhấp nháy, badge cập nhật; sóng "đang nghe" (giờ là cột tĩnh) cùng các `@keyframes` không còn dùng. Giữ các animation ngắn (đang kết nối, thanh tải, kiểm tra cập nhật). Có `prefers-reduced-motion`.
- **Hành vi gốc:**
  - Con trỏ mũi tên ở mọi nơi (34 chỗ), bàn tay chỉ cho link.
  - Không chọn được chữ trên chrome (`-webkit-user-select`, WebKit 16); chọn được trong transcript, ghi chú, buổi đã lưu và ô nhập.
  - Bỏ 14 rule `::-webkit-scrollbar`, dùng thanh cuộn overlay gốc.
  - Vòng focus chỉ khi dùng bàn phím (`:focus-visible`).
  - `overscroll-behavior: none`.
  - Menu chuột phải của trình duyệt bị chặn trên chrome, giữ trong vùng chữ.

**QA đo B2 (so với B1):** CPU của tiến trình WebView khi đang dịch liên tục và khi chờ câu đầu. Mục tiêu: chờ câu đầu ≈ 0 % (trước B2 có animation sóng và nút đỏ nhấp nháy). Chụp màn hình khi Settings › Accessibility › Display › *Reduce motion* bật.

### Commit C — transcript trực tiếp vẽ tăng dần (mới)

Hiện mỗi token dựng lại HTML toàn vùng transcript, và vùng này bị cắt còn ~800 ký tự. Trong cửa sổ thường 1000×680 vì vậy chỉ thấy vài câu cuối, không cuộn lên được. `TranscriptUI.sessionLog` giữ mọi câu mà không ai đọc (rò rỉ bộ nhớ, và quét tuyến tính mỗi câu).

- Câu đã chốt gắn thêm 1 node; token đang nhận dạng chỉ sửa 1 node. Cuộn xem lại cả buổi, dùng `content-visibility: auto`. Xoá `sessionLog`.
- **Tiêu chí QA:** CPU của WebView khi Soniox/Local đang nhận chữ liên tục ≤ bản hiện tại. Sau phiên giả lập 2 giờ (feed wav lặp), RSS tăng < 30 MB và số node DOM tăng tuyến tính theo số câu (không nhân bản). Cuộn lên thì không bị kéo xuống khi có chữ mới; ở đáy thì tự cuộn theo.

### Commit D — màn hình ôn bài trong Thư viện (mới, Kiên yêu cầu: "dịch cả buổi thì phải lưu lại để đọc lại, take note")

Thay khung xem Markdown chỉ đọc bằng màn hình ôn bài:

- Từng câu (dịch + gốc + giờ).
- Bấm để đánh ⭐ ❓ 📝.
- Khung ghi chú sửa được sau giờ học.
- Lọc theo dấu, tìm trong buổi, bấm mục đánh dấu để nhảy tới câu.
- Dùng `SessionStore.resume(id)` + `persist()` (lệnh `save_session` atomic hiện có), không thêm lệnh Rust.
- Buổi đang chạy trực tiếp thì chỉ xem.
- **Tiêu chí QA:** sửa ghi chú hoặc dấu → thoát app → mở lại → còn nguyên, và `.md` có mục *Đánh dấu* / *Ghi chú* cập nhật. Buổi 2 000 câu mở < 300 ms, cuộn không giật. Không sửa được buổi đang dịch.

Thứ tự: **B1 → B2 → D → C**.

### Trạng thái Commit C — đã làm (kỹ sư trưởng, 2026-09-26)

- **`src/js/ui.js` viết lại theo kiểu tăng dần.** Giữ nguyên API công khai và class CSS nên `app.js` hầu như không đổi.
  - Mỗi câu có node riêng, tạo một lần. Hai bố cục (một cột và hai cột) luôn tồn tại, CSS chọn bố cục hiển thị, nên đổi chế độ xem không vẽ lại gì.
  - Chữ đang nhận dạng nằm trong node cố định ở cuối; mọi token trong cùng một khung hình gộp thành **1** lần ghi DOM (`requestAnimationFrame`) và tối đa 1 lần đọc layout để cuộn thông minh.
- **Cuộn lại cả buổi:** bỏ việc cắt theo `max_lines × 160` ký tự; giữ tối đa 1 500 câu trong DOM, dùng `content-visibility: auto`. Bỏ thanh trượt "Max Lines" (trường settings `max_lines` vẫn giữ để tương thích).
- **Xoá:** `sessionLog` (bản sao không ai đọc, tăng mãi) cùng `getFullSessionText` / `getFormattedContent` / `clearSession`, và hàm chết `_saveTranscriptFile` trong `app.js`.
- **Hai lỗi O(n) mỗi sự kiện (O(n²) cả buổi), tìm được khi đo:**
  1. Tìm câu chờ dịch bằng `find` từ đầu mảng. Nay dùng bộ đếm + dò ngược từ cuối.
  2. `querySelector('.listening-indicator')` trên toàn cây DOM **ở mọi token**. Nay giữ tham chiếu trực tiếp.

  Đo trên jsdom: 1 600 câu kèm 1 token mỗi câu **2 476 ms → 285 ms**. Phần tăng còn lại theo độ dài là `SymbolTree.index` của jsdom (theo CPU profile); WebKit làm thao tác này O(1).
- **Sửa lỗi CSS có từ Commit D:** rule tác giả `display` (`.study-row`, `.seg-block`) thắng rule `[hidden]` của trình duyệt, nên **bộ lọc ở màn hình ôn bài không ẩn được câu**. Đã thêm `[hidden] { display: none !important; }`. Test jsdom lần này nạp `main.css` và kiểm style thật.
- **Sửa lỗi trong chính code C trước khi commit:** chữ đang nhận dạng đến trước câu chốt đầu tiên (thứ tự Soniox gửi) thì không hiện, vì vùng chứa chưa được tạo.
- **Test jsdom tạm (không commit), qua hết:**
  - 100 token/khung → 1 lần vẽ.
  - Câu chưa dịch ẩn thật (style), dịch xong thì hiện; huy hiệu ngôn ngữ; dấu hiện ở cả hai bố cục.
  - Đổi một cột ↔ hai cột giữ nguyên node; Qwen ép một cột.
  - Câu gốc chờ quá 3 bị bỏ cùng node; giới hạn 1 500 câu khớp DOM, không nhân bản.
  - `clear`/placeholder dựng lại đúng.
- **QA trên Mac:**
  - CPU tiến trình WebView khi Soniox nhận chữ liên tục, so với B2.
  - Cuộn lên giữa lúc đang dịch không bị kéo xuống; ở đáy thì tự theo.
  - Buổi dài (feed wav lặp ~2 giờ): RSS WebView tăng < 30 MB, `document.querySelectorAll('.seg-block').length` ≤ 1 501.
  - Chuyển hai cột giữa buổi mượt.

### Trạng thái Commit D — đã làm (kỹ sư trưởng, 2026-09-26)

- Module mới `src/js/study-view.js` (`StudyView`), để không nhồi thêm vào `app.js`.
  - Mở buổi qua `SessionStore.resume(id)`. Dấu và ghi chú ghi bằng `persist()` → `save_session` (atomic, JSON + Markdown), không thêm lệnh Rust.
  - Buổi đang mở trong Live (cùng `id` với `sessionStore`, kể cả đang tạm dừng) hiện **chỉ xem**, có banner.
- **Giao diện:**
  - Lọc Tất cả/⭐/❓/📝, tìm trong buổi; mỗi câu gồm giờ, bản dịch, câu gốc (`lang="zh-Hans"` → PingFang).
  - Nút dấu hiện khi rê chuột; dấu đang có luôn hiện, kèm vạch màu bên trái.
  - Khi đang lọc hoặc tìm, bấm vào câu → bỏ lọc và cuộn tới câu đó.
  - Ghi chú bên phải (cửa sổ hẹp hơn 860 px thì xuống dưới), hiện trạng thái "đang lưu…/đã lưu/lỗi lưu".
- **Tính nhất quán:**
  - Đổi tên cập nhật store đang mở, nên lần lưu sau không ghi lại tên cũ.
  - Xuất `.srt/.txt` flush trước khi đọc đĩa.
  - Về danh sách, rời Thư viện và thoát app (`_flushOnExit`) đều flush.
  - Chép = Markdown có dấu và ghi chú. Buổi định dạng cũ (`.md` đơn) vẫn hiện chữ thuần, chỉ đọc.
- **Hiệu năng:**
  - Dựng DOM một lần bằng `textContent` (không `innerHTML`, không có XSS từ nội dung), một listener chung cho cả danh sách.
  - `content-visibility: auto` trên từng câu; lọc/tìm chỉ bật tắt `hidden`.
  - Ghi debounce 600 ms (dấu) / 800 ms (ghi chú).
- **Tự kiểm (jsdom, test tạm, không commit):**
  - Qua hết: mở, lọc, nhảy, bật/tắt dấu, ghi chú, đổi tên, nhiều thay đổi → 1 lần ghi khi đóng, đóng lần hai không ghi, chỉ xem thì không ghi; `.md` có *Đánh dấu* / *Ghi chú*, dấu đã bỏ thì mất khỏi `.md`.
  - 2 000 câu: mở 278 ms, lọc 18 ms (jsdom chậm hơn WebKit).
- **QA trên Mac:** tiêu chí D ở trên; thêm: cuộn buổi 2 000 câu có mượt không; `prompt()` đổi tên có hiện trên WKWebView không (có từ trước, chưa ai kiểm).



---

## Bài kiểm thử QA sẽ chạy (tiêu chí pass/fail)

| Ưu tiên | Kiểm thử | Pass khi | Cần |
|---|---|---|---|
| P1 | Local end-to-end: đẩy wav 8,7 s (+1 s im lặng cuối) vào pipeline theo chunk 200 ms | ≥ 2 `Result`; `Result` đầu ≤ 4 s sau khi câu 1 kết thúc; 0 `Error`; không có result ≤ 1 ký tự; `Closed` ≤ 1 s sau drop `Session` | S2 |
| P2 | Rò rỉ bộ nhớ: 20 chu kỳ start → feed 3 s → drop `Session`; đo RSS trước/sau | RSS sau − trước < 50 MB; không còn thread `local-asr`/`local-llm`/`mic-dsp` | S2 |
| P3 | settings.rs: `settings.json` rỗng/hỏng khi có `.bak` hợp lệ → load | Key API và `profiles` giữ nguyên từ `.bak`; save tiếp theo tạo lại file đúng, `.bak` cập nhật | S1 |
| P4 | Downloader: (a) sai SHA → (b) chặn `huggingface.co` | (a) lỗi "SHA-256 mismatch", không có file đích, `.part` bị xoá; (b) tự chuyển `hf-mirror.com`, tiến độ phát ≤ 256 KiB/lần | — |
| P5 | Backlog Local: LLM stub ngủ 5 s, đẩy 10 câu liên tiếp | Có event `backlog_skipped`; hàng đợi ≤ 4; câu cuối luôn được dịch | S2 |
| P6 | Mic DSP: sine 1 kHz 48 kHz stereo 10 s qua `MicProcessor` (AGC off) | Mẫu ra = vào/3 ± 0,5 %; không alias > −60 dB; HPF loại DC (0,5 → < 0,01); AGC on: −40 dBFS nâng ≤ +18 dB, im lặng không nâng | S3 |
| P7 | Session export: mark ⭐/📝 + notes → `_toMarkdown`, `export_session_srt` | Mục `## Đánh dấu`, `## Ghi chú` đúng; SRT cue 1..n, timestamp tăng dần | — |
| P8 | Nhàn rỗi 60 s | CPU < 1 %, không thread DSP/LLM, không kết nối mạng ngoài updater | **PASS** (đã chạy) |

Các bước cần người thao tác (Kiên làm, QA đọc log): mic cpal + Soniox, khử ồn + VAD,
Apple Voice Processing, Soniox reset 3 phút, Local trong app, ghi chú/đánh dấu.

---

### Giao diện sáng/tối — đã làm (kỹ sư trưởng, 2026-09-26; Kiên yêu cầu, mặc định Sáng)

- **Token theo theme:**
  - `html[data-theme]` chọn theme; token sáng nằm trong `:root[data-theme="light"]`, token tối trong `:root`.
  - Khoảng 90 màu viết cứng đã thành token, gồm 49 chỗ `rgba(255,255,255,a)` → `rgba(var(--fg-rgb), a)`.
  - Chỉ giữ trắng ở 5 chỗ chữ/nền trắng nằm trên nền màu.
  - Chấm màu chữ transcript là `--tx-color-1/2/3` theo theme.
- **Tương phản (đo bằng script trên token):** 26/26 cặp chữ/nền quan trọng ở cả hai theme ≥ 4.5:1. Chữ chính 12–15:1, chữ mờ nhất 4.7:1, chữ trắng trên nút 5.0–6.8:1. Accent dùng làm chữ tách ra `--accent-text`, nền nút ra `--accent-strong`, đỏ lỗi ở theme tối là `#ff6961`.
- **Áp theme:**
  - `src/js/theme.js`: sáng / tối / theo hệ thống; lắng nghe khi macOS đổi giao diện.
  - Cache trong localStorage; script inline trong `<head>` áp theme trước lần vẽ đầu, nên không nháy.
  - `setTheme` gốc của cửa sổ (quyền `core:window:allow-set-theme`) cho vùng traffic lights, thanh cuộn và ô nhập.
- **Giao diện chọn:** Cài đặt › Hiển thị › Giao diện, và mục ⋯ "🌙/☀️ Giao diện tối/sáng".
- **Bỏ:**
  - Thanh "Opacity": mặc định làm mờ cả giao diện còn 85 %, vừa làm nhạt chữ vừa tạo thêm một lớp GPU.
  - Ô "Show original text": không còn tác dụng.

  Hai trường `overlay_opacity` / `show_original` bị bỏ khỏi struct settings; file cũ vẫn nạp được, có unit test.
- **Cỡ chữ bản dịch mặc định 16 → 18 px** (chỉ áp cho cài mới).
- **QA trên Mac, chụp màn hình cả hai theme:**
  - Live (đang dịch, có ⭐), Thư viện › ôn bài, Cài đặt (thẻ + tab Model/Micro), modal chọn engine, chế độ Đọc (đoạn đang đọc).
  - Kiểm: không còn chữ trắng trên nền trắng; traffic lights và thanh cuộn đổi theo theme; *Theo hệ thống* theo đúng khi đổi trong System Settings.

---

### Model dịch Local: Qwen2.5-3B → Hy-MT2-1.8B Q6_K — đã làm (kỹ sư trưởng, 2026-09-26; Kiên chốt)

- **Lý do (đo trên WSL CPU, greedy, 25 câu bài giảng tài chính, cùng đường gọi như `llm.rs`):**

  | Model | File | Câu lẫn chữ Hán | Thời gian/câu (CPU) |
  |---|---|---|---|
  | Qwen2.5-3B Q4_K_M (cũ) | 2,1 GB | 15/25, thêm 1 câu ra tiếng Anh | 2,0 s |
  | **Hy-MT2-1.8B Q6_K** | 1,47 GB | 0/25 | 1,4 s |
  | Hy-MT2-1.8B Q4_K_M | 1,13 GB | 0/25 | 1,2 s |

  Bản Q4_K_M có câu bị mất chữ số (3,2 lần → "3 lần"), nên chọn Q6_K.

  Đã loại (đo cùng bộ câu):
  - Qwen3-4B-2507: sai nội dung.
  - Qwen3.5-4B: chậm hơn, sai thứ trong tuần.
  - Gemma-3-4B: tự thêm "đô la".
  - Qwen3-1.7B: sai số liệu.
  - Gemma-4-E4B: template chưa được llama.cpp hỗ trợ, nặng 5 GB.

  Kiên không cần tuỳ chọn 7B.
- **`models.rs`:** model `hy-mt2-1.8b-q6`, tải từ `tencent/Hy-MT2-1.8B-GGUF`, dự phòng hf-mirror.
  - SHA `d98fe604…`, 1 474 785 120 B, giấy phép Apache-2.0.
  - Sau khi tải xong, tự xoá `qwen2.5-3b-instruct-q4_k_m.gguf` cũ (giải phóng 2,1 GB), trừ khi GGUF tuỳ chỉnh đang trỏ vào file đó.
- **`llm.rs`, prompt theo họ model:**
  - Hy-MT: không có system prompt. Câu lệnh cố định lấy nguyên văn model card, đặt trong lượt user; glossary theo mẫu `参考下面的翻译：`. Dùng câu lệnh tiếng Trung khi một phía là tiếng Trung, còn lại dùng tiếng Anh.
  - Model khác: system prompt như cũ.
- **`llm.rs`, ba lỗi template/tokenizer phát hiện khi đo:**
  1. llama.cpp (template legacy) nhận nhầm template Hy-MT2 thành HunyuanVL, ghép chữ trước `<｜hy_User｜>` và không có lượt assistant. Đã tự dựng đúng theo Jinja của GGUF.
  2. App luôn tokenize với `AddBos::Never`, nên GGUF Gemma (cần `<bos>`) ra câu rỗng 9/15. Nay theo `tokenizer.ggml.add_bos_token`.
  3. GGUF Qwen3 / Qwen3.5 dạng hybrid tự "suy nghĩ" trước khi dịch. Nay chèn sẵn khối `<think></think>` rỗng.

  Unit test không cần model: nhận diện họ, prompt đúng model card, template, BOS. Test `translates_finance_sentence` (ignored) kiểm cả không còn chữ Hán trong bản dịch; đã chạy qua trên Hy-MT2 Q6, Gemma-3-4B, Qwen3-1.7B.
- **UI/tài liệu:** kích thước tải 2,3 → 1,6 GB; các chữ "Qwen2.5" trong Cài đặt, modal và README đổi thành Hy-MT2; status nạp là "Đang nạp model dịch…".
- **QA trên Mac cần đo:**
  - Cài đặt › Model › Local › Tải model: tải đúng `Hy-MT2-1.8B-Q6_K.gguf`, file Qwen cũ bị xoá.
  - `MT_TEST_GGUF=…/Hy-MT2-1.8B-Q6_K.gguf cargo test --release --lib local::llm -- --ignored --nocapture`. Ghi: thời gian load, ms/câu trên Metal (Qwen2.5 cũ: 0,4–0,5 s/câu) và thời gian warm-up lần đầu.
  - Dịch một buổi thật bằng Local: có còn câu lẫn chữ Hán không, tốc độ có theo kịp giảng viên không.

---

### Nhận dạng: SenseVoice-small → X-ASR Zipformer zh-en; micro mặc định — đã làm (kỹ sư trưởng, 2026-09-26; Kiên chốt)

Số liệu đầy đủ: README › *Kết quả đo model Local* (10 model nhận dạng trên 480 câu + 2 bài giảng thật 25 phút; GTCRN/AGC; hotword).

- **`models.rs`:** model `x-asr-zh-en-punct-int8` (asset sherpa-onnx `…zh-en-punct-int8-2026-06-03.tar.bz2`, 136 MB, SHA `5d02c36d…`, Apache-2.0). Sau khi giải nén, sinh `bpe.vocab` từ `bpe.model` (`spm.rs`, bộ đọc protobuf tối giản — đối chiếu với sentencepiece: 5 000 mục trùng khớp). Tải xong thì xoá `sensevoice-int8/` cũ.
- **`asr.rs`:** transducer offline; hotword = thuật ngữ trong từ điển hồ sơ có ≥ 3 chữ Hán, mọi chữ nằm trong `tokens.txt`, ghi mỗi chữ cách nhau một dấu cách (BPE mới khớp token `▁X` model phát ra); `modified_beam_search`, 4 path, điểm 2,0. Không có thuật ngữ nào dùng được thì về `greedy_search`. Đầu ra bỏ dấu cách quanh chữ Hán/dấu câu ("不便 ， 所以" → "不便，所以"). Đoạn > 30 s chia đôi trước khi đưa vào model (X-ASR sập từ 50 s).
- **`pipeline.rs`, ngắt câu:** `max_speech_duration` của sherpa chỉ nới điều kiện kết thúc; dưới tiếng ồn liên tục đo được đoạn 46 s. Nay `Cutter`: quá 8 s thì `vad.flush()` ở chunk có mức thấp hơn đỉnh ≥ 15 dB, quá 12 s thì ngắt ngay. Test tích hợp `tests/local_pipeline.rs` (ignored) chạy đúng file từng gây sập: 130 s → 12 câu, 0 lỗi (trước: 4 câu rồi sập).
- **`settings.rs`:** `mic_denoise` và `mic_agc` mặc định tắt; thêm `settings_schema` (=2), file cũ được chuyển đổi một lần khi nạp (tắt hai mục đó, giữ nguyên các lựa chọn khác); có unit test.
- **Không làm:** chế độ streaming của X-ASR (Kiên chốt sau khi xem số: 480 ms streaming lỗi 9,1 % so với 7,1 % offline).
- **QA trên Mac cần đo:**
  - Cài đặt › Model › Local › Tải model: tải `x-asr-zh-en-punct-int8/` (có `bpe.vocab`, `.complete`), thư mục SenseVoice cũ bị xoá.
  - `MT_TEST_XASR_DIR=… cargo test --release --lib local:: -- --ignored --nocapture`: ms/câu trên chip M (x86: 65 ms greedy, 79 ms có hotword).
  - Dịch một buổi thật bằng Local với hồ sơ có từ điển tài chính: thuật ngữ có ra đúng không; câu có bị cắt giữa từ khi lớp ồn không (dấu hiệu của `Cutter`: câu dài đúng 8–12 s).
  - Cài đặt › Micro: sau khi cập nhật, Khử ồn và AGC phải hiện tắt.

### Từ điển ~480 thuật ngữ + ngân sách Soniox — đã làm (kỹ sư trưởng, 2026-09-26; Kiên yêu cầu)

- `src/js/glossary/finance-advanced-zh-vi.js` (mới): ~170 thuật ngữ bậc thạc sĩ + bộ CUFE (中央财经大学: học viện, cơ sở, từ vựng sau đại học). Tên học viện viết theo hiểu biết, trang cufe.edu.cn trả 404 lúc kiểm — Kiên đối chiếu giúp.
- `src/js/glossary/index.js` (mới): gộp 3 bộ, khử trùng; `budgetContext()` cắt `terms`/`translation_terms` cho vừa 8 000 token ước lượng (đã hiệu chỉnh bằng key Soniox thật của Kiên: Soniox đếm ≈ 0,87 lần ước lượng; 8 025 được chấp nhận, 9 225 bị từ chối ở 8 061 thật; cả bộ 480 mục bị từ chối ở 9 958): 35 % cho từ nhận dạng (giữ đủ cả 406 từ ≥ 3 chữ), phần còn lại cho cặp dịch dài nhất (282 cặp, từ 4 chữ Hán trở lên). Đo Soniox cùng audio: thuật ngữ 93,0 % → 97,2 % có từ điển; bài giảng thật 5 phút 3,0 % (X-ASR 11,4 %). Số liệu trong README › Kết quả đo model Local › Mốc tham chiếu cloud. Ước lượng token: 1/chữ Hán, 1/2,5 ký tự tiếng Việt. Soniox nhận `budgetContext()` thay cho cắt theo số lượng cũ (300/500). Nút "Nạp từ điển" nạp cả 3 bộ; chỉ thuật ngữ ≥ 3 chữ Hán vào `terms`.
- Test: `npm run test:js` (node --test). QA: sau khi nạp từ điển, mở Soniox và kiểm console không có lỗi context quá lớn; bấm nạp lần hai phải báo "đã có đủ".

---

### Bug IMK log spam (`qa-reports/2026-09-26-bug-imk-log-spam.md`) — đã xử lý (kỹ sư trưởng, 2026-09-26)

- **Log:** `IMKCFRunLoopWakeUpReliable` / `getApplicationProperty: called with invalid property` là nhiễu của Input Method Kit macOS khi có bộ gõ hoạt động; Electron (issue #45002), Qt và các app Java báo y như vậy, bản `.app` cũng in, không tắt được từ phía app. Đã ghi vào README › Troubleshooting (Anh/Việt). Không cần Kiên thử (a)/(b)/(c) nữa.
- **Chức năng (mục 3–4 của QA):** rà JS: handler phím tắt toàn cục (`app.js`), ô tên hồ sơ (Enter xác nhận) và menu ⋯ (Escape đóng) chưa bỏ qua sự kiện khi bộ gõ đang ghép chữ. Nay cả ba bỏ qua khi `e.isComposing || e.keyCode === 229`. Các handler còn lại vốn đã bỏ qua khi tiêu điểm nằm trong INPUT/TEXTAREA. Không có chỗ nào ghi `textarea.value` trong lúc gõ (chỉ khi bấm ⌘⇧C).
- **QA/Kiên kiểm trên Mac (tiêu chí đóng bug):** gõ "Tiếng Việt có dấu đầy đủ" bằng Simple Telex vào ô ghi chú (⌘⇧N), ô ghi chú ôn bài và ô tên hồ sơ (kết thúc bằng Enter): chữ đúng, không lặp, không mất dấu, không có chữ gạch chân kẹt lại. Nếu vẫn lỗi, ghi rõ ô nào và chuỗi gõ.

---

### Đổi tên app: My Translator → MeowLaoshi 猫老师 — đã làm (kỹ sư trưởng, 2026-09-26; Kiên chốt tên)

- Đổi: `productName` và tiêu đề cửa sổ (`tauri.conf.json`), `<title>`, mục Giới thiệu, hộp thoại xác nhận, README (Anh/Việt), changelog v1.0.0, hướng dẫn cài đặt (Markdown + PDF), hướng dẫn TTS. File build tự đổi theo: `MeowLaoshi_1.0.0_aarch64.dmg`, `/Applications/MeowLaoshi.app`, bản dev là "MeowLaoshi Dev".
- **Giữ nguyên có chủ đích** (để không mất dữ liệu và không hỏng cập nhật): `identifier` `com.personal.translator` (settings, API key, hồ sơ, buổi học, localStorage của WebView), thư mục model `~/Library/Application Support/My Translator` (có chú thích trong `commands/mod.rs`), repo GitHub `ttkien2035/my-translator` (endpoint updater), tên gói Cargo/npm `my-translator`, dòng ghi công bản gốc (MIT).
- QA trên Mac: build lại, kiểm tên app trong Dock/Finder/menu, mục Giới thiệu; app đã có dữ liệu từ bản cũ vẫn thấy API key, hồ sơ, buổi học và model đã tải (không phải tải lại). Quyền Micro có thể phải cấp lại vì tên bundle đổi.

### MeowLaoshi — icon, mã định danh, thư mục dữ liệu, repo (kỹ sư trưởng, 2026-09-26; Kiên quyết định "coi như app mới hoàn toàn")

Thay cho mục "Giữ nguyên có chủ đích" ở trên.

- **Icon:** emoji 🐱 "cat face" của Noto Emoji (Google, Apache-2.0), dựng từ bản vector gốc (`src-tauri/icons/source/`) trên nền bo góc xanh trời theo lưới icon macOS (1024, ô 824), để macOS 26+ không bọc khung xám. `python3 scripts/build-icon.py [sky|cream|mint|ink]` dựng lại toàn bộ cỡ (`.icns` tới 512@2x, `.ico`, PNG). File tham khảo `cat_face_emoji.jpg` đã bỏ.
- **Mã định danh:** `com.ttkien2035.meowlaoshi` — một hằng số `APP_ID` (`lib.rs`), test `app_id_matches_tauri_config` bắt lệch với `tauri.conf.json`.
- **Một thư mục dữ liệu duy nhất:** `~/Library/Application Support/com.ttkien2035.meowlaoshi/` chứa `settings.json`, `transcripts/`, `audio-models/`, `local-models/`, `piper-models/`. Không chuyển dữ liệu từ bản cũ: cài lại là app mới (dán lại key, nạp lại từ điển, tải lại model).
- **Repo:** đã đổi tên thành `github.com/ttkien2035/meowlaoshi` (2026-09-26); URL trong app/updater/workflow/README đã trỏ sang đó, URL cũ tự chuyển hướng. QA trên Mac: `git remote set-url origin git@github.com:ttkien2035/meowlaoshi.git` (hoặc URL https tương ứng).
- **Ghi công:** giữ dòng bản quyền gốc trong `LICENSE` theo yêu cầu của giấy phép MIT; README và mục Giới thiệu ghi rõ điều đó, kèm ghi công icon Noto.
- **QA trên Mac:** build lại; icon mèo hiện đúng trong Dock/Finder/Launchpad (không có khung xám); app mở như lần đầu (hộp chọn cách dịch); dữ liệu nằm trong thư mục mới. Thư mục cũ có thể xoá tay: `~/Library/Application Support/com.personal.translator`, `~/Library/Application Support/My Translator`, `~/Library/WebKit/com.personal.translator`.

---

## Commit E — Người dùng phổ thông: cài dễ, dùng dễ (Kiên giao, 2026-09-26) — **ĐÃ LÀM, chờ QA** (xem mục trạng thái cuối file)

**Kiên:** *"làm người dùng dễ bị kẹt … xử lý làm sao cho người dùng (non-tech user) dễ cài đặt, dễ xài nhất."*

Bằng chứng: Kiên cài bản release 1.0.0 như người dùng phổ thông (báo cáo `qa-reports/2026-09-26-install-ux-dmg.md`). Cài và mở được, nhưng kẹt ở bước 2 (tháo đĩa), và sau khi "thiết lập xong" thì Local **không chạy được**: đã tải 1,6 GB model ở **Cài đặt › Model › Local** nhưng thiếu Silero VAD (1 MB) nằm ở màn hình khác (**Cài đặt › Micro**). App chỉ báo lỗi bằng toast chỉ đường menu.

### Nguyên tắc (áp cho mọi mục bên dưới)

1. **Không bắt người dùng biết cấu trúc app.** Không có thông báo nào chỉ nói "vào Cài đặt › X › Y". Mọi lỗi người dùng tự sửa được phải kèm **nút sửa ngay** (Tải ngay / Mở cài đặt quyền / Dán key).
2. **Một việc = một nút.** Một tính năng cần nhiều file thì một nút tải tất cả.
3. **Mặc định đúng cho người dùng mục tiêu** (sinh viên Việt học tài chính ở Trung Quốc): Trung → Việt, từ điển tài chính, micro.
4. **Lần đầu có dẫn đường; sau đó không làm phiền.**

### Việc cần làm (thứ tự ưu tiên)

| # | Ưu tiên | Việc | Chi tiết / tiêu chí |
|---|---|---|---|
| E1 | P0 | **Một nút tải gói offline** | Nút tải Local tải **cả** X-ASR + Hy-MT2 + Silero VAD (và GTCRN nếu cần). Trạng thái hiển thị một dòng: "Offline: sẵn sàng" / "chưa tải (1,6 GB)". Giữ nút tải riêng ở Micro nếu muốn, nhưng Local không bao giờ còn thiếu VAD sau khi bấm nút Local. |
| E2 | P0 | **Lỗi có nút sửa** | Bấm Bắt đầu mà thiếu model → hộp thoại "Cần tải gói offline (1,6 GB)" + nút **Tải ngay** (hiện tiến độ, xong thì tự bắt đầu). Soniox thiếu key → hộp thoại có ô dán key + nút **Lưu & bắt đầu**. Thay các toast `models_missing` hiện tại (`app.js` quanh dòng 3123 và 2507). |
| E3 | P0 | **Trình hướng dẫn lần đầu** thay hộp "Chọn cách dịch" | 3–4 màn, chữ tiếng Việt đơn giản, có nút Bỏ qua: ① "Bạn có key Soniox không?" → dán key, **kiểm tra key ngay** (kết nối thử) → ✓/✗ có lời giải thích; "Chưa có" → chọn Offline. ② "Tải gói offline để dùng khi mất mạng?" (khuyên có, nói rõ 1,6 GB, tải nền). ③ "Bạn học môn gì?" → Tài chính (nạp sẵn ~480 thuật ngữ) / Khác. ④ Cho phép micro + **nói thử** có thanh mức âm để biết micro chạy. Kết thúc ở màn chính với nút Bắt đầu nổi bật. |
| E4 | P0 | **Sửa hướng dẫn cài + cửa sổ DMG** | I1–I4 trong báo cáo cài đặt: bỏ bước tháo đĩa khỏi luồng chính; ảnh nền DMG có mũi tên và 3 dòng tiếng Việt (bước tiếp theo, cả bước "Vẫn mở"); ảnh chụp trong hướng dẫn; "M1 trở lên". Hướng dẫn viết lại theo trình hướng dẫn mới (E3), ngắn hơn. |
| E5 | P1 | **Quyền micro bị từ chối** | Phát hiện không có quyền (hoặc luồng micro toàn 0) → hộp thoại giải thích + nút mở thẳng **Quyền riêng tư & Bảo mật › Micrô** (`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`). Hiện chưa thấy xử lý riêng trong code. |
| E6 | P1 | **Cài đặt không mất khi đóng** | Hiện phải bấm **Lưu & đóng**; kiểm tra đóng bằng ✕/Esc có lưu không. Nên tự lưu từng thay đổi, hoặc hỏi trước khi đóng nếu có thay đổi chưa lưu. |
| E7 | P1 | **Từ điển tài chính mặc định** | Hồ sơ mặc định có sẵn từ điển tài chính (hoặc do E3 chọn), thay vì phải tạo hồ sơ rồi bấm nạp. |
| E8 | P1 | **Mất mạng khi dùng Soniox** | Nếu gói offline đã tải: đề nghị chuyển sang Local bằng một nút (hoặc tự chuyển, báo rõ). Nếu chưa tải: nói rõ lý do và cách khắc phục. |
| E9 | P2 | **Bỏ bước "Vẫn mở"** | Chỉ có cách ký Developer ID + notarize (Apple Developer Program, 99 USD/năm). **Kiên quyết định**; lead chỉ ghi phương án và việc cần làm trong CI nếu Kiên đồng ý. |
| E10 | P2 | Tên file chạy | I5: `Contents/MacOS/my-translator` → `meowlaoshi` (`mainBinaryName`), nếu không ảnh hưởng updater. |
| E11 | P1 | **Hướng dẫn "Gỡ cài đặt"** (Kiên thêm, 2026-09-26) — **ĐÃ LÀM, chờ QA** | Kéo app vào Thùng rác **không xoá dữ liệu**. QA đo trên máy Kiên: `~/Library/Application Support/com.ttkien2035.meowlaoshi` 1,5 GB (cài đặt, **API key Soniox**, buổi học, model offline), `~/Library/WebKit/com.ttkien2035.meowlaoshi` 368 KB, `~/Library/Caches/com.ttkien2035.meowlaoshi` 68 KB; quyền Micro vẫn được macOS nhớ. Thêm mục **6. Gỡ cài đặt** vào `docs/huong-dan-cai-dat.md` (+ PDF, README Anh/Việt), viết cho người dùng phổ thông: ① **Gỡ app nhưng giữ dữ liệu** (để cài lại không phải tải lại 1,6 GB / dán lại key): chỉ kéo app vào Thùng rác. ② **Gỡ sạch** (máy cho mượn/bán, không để lại key): Finder › Đi › Đi tới thư mục (⌘⇧G) → `~/Library/Application Support` → xoá thư mục `com.ttkien2035.meowlaoshi`; làm tương tự với `~/Library/WebKit` và `~/Library/Caches`; dọn Thùng rác. Kèm khối lệnh Terminal cho người quen dùng:
`rm -rf ~/Library/Application\ Support/com.ttkien2035.meowlaoshi ~/Library/WebKit/com.ttkien2035.meowlaoshi ~/Library/Caches/com.ttkien2035.meowlaoshi` và `tccutil reset All com.ttkien2035.meowlaoshi` (xoá quyền Micro đã cấp). Nói rõ: gỡ sạch là mất luôn các buổi học đã lưu, nên xuất Markdown trước nếu cần. Windows: ghi đường dẫn tương ứng (`%APPDATA%\com.ttkien2035.meowlaoshi`, WebView2 trong `%LOCALAPPDATA%`) sau khi kiểm. |

### Tiêu chí nghiệm thu (QA chạy trên Mac)

"Bài test người mới": xoá dữ liệu app (thư mục `com.ttkien2035.meowlaoshi`, có sao lưu) hoặc dùng tài khoản macOS mới; cài từ DMG release; **không đọc hướng dẫn**, chỉ làm theo chữ trên màn hình.

- Có key Soniox trong tay: từ lúc mở DMG tới bản dịch đầu tiên **≤ 5 phút**, không phải hỏi ai.
- Không key, chọn offline: tới bản dịch đầu tiên chỉ tốn thời gian tải 1,6 GB, **không có ngõ cụt**.
- Cố tình gây lỗi (thiếu model, key sai, từ chối micro, tắt Wi-Fi giữa chừng): **mọi thông báo lỗi đều có nút sửa**, sửa xong dùng tiếp không cần khởi động lại app.
- Mở app lần 2: không hiện lại trình hướng dẫn; mọi thiết lập còn nguyên.

### Trạng thái Commit E — đã làm (kỹ sư trưởng, 2026-09-26)

| # | Kết quả |
|---|---|
| E1 | `local_models_status` / `local_models_download` = **gói offline**: X-ASR + Hy-MT2 + **Silero VAD** (VAD tải trước, 0,6 MB). Nút ở Cài đặt › Model › Local và mọi hộp thoại dùng chung một lượt tải (`onboarding.js › downloadOfflinePack`), có chip "📦 Gói offline 42 %" ở góc khi hộp thoại đã đóng. Trạng thái: "Offline: sẵn sàng" / "Offline: chưa tải (1,6 GB)". |
| E2 | `start()` không còn toast chỉ đường menu: thiếu gói → hộp thoại **Tải ngay** (xong tự bắt đầu); thiếu key Soniox/OpenAI/Qwen → hộp thoại dán key + **Kiểm tra & lưu** (Soniox/OpenAI kết nối thử), hoặc **Dùng offline thay thế**. `models_missing` từ Rust → cùng hộp thoại. Soniox 401 / 4001 / 4003 → hỏi key; 402 / 4002 → "hết hạn mức, hỏi người cấp key"; nối lại thất bại 3 lần → **Mất kết nối** (Thử lại / Dịch offline hoặc Tải gói offline). Thông báo lỗi Soniox dịch sang tiếng Việt. |
| E3 | Trình hướng dẫn 4 bước thay hộp "Chọn cách dịch" (đã bỏ markup + CSS cũ): key Soniox (kiểm tra ngay) → gói offline (tải nền) → môn học (Tài chính = hồ sơ ~480 thuật ngữ / Môn khác) → thử micro (thanh mức âm, phát hiện bị chặn). "Bỏ qua" ở mọi bước; kết thúc: có key → Soniox, không → Local; nguồn micro; nút Bắt đầu nhấp nháy 3 lần (tắt nếu reduce motion). Hồ sơ có sẵn không bao giờ bị ghi đè. |
| E4 | Nền DMG `src-tauri/dmg/background.png` (mũi tên + 3 bước, có "Vẫn mở"), `bundle.macOS.dmg` trong `tauri.conf.json`; `scripts/build-dmg-background.py` vẽ lại. Hướng dẫn viết lại theo trình hướng dẫn (bỏ bước tháo đĩa, "M1 trở lên"), PDF dựng lại; README Anh/Việt cùng sửa. **Chưa có ảnh chụp** (I3): nhờ QA chụp cửa sổ DMG thật và màn "Vẫn mở" trên macOS 27, bỏ vào `docs/images/`, kỹ sư trưởng chèn vào hướng dẫn. |
| E5 | `MicSilenceWatch`: micro/cả hai (không bật cổng VAD) mà 4 s liền toàn mẫu 0 → tạm dừng + hộp thoại **Mở cài đặt quyền Micrô** (lệnh Rust `open_privacy_settings`, URL cố định) + **Đã bật, thử lại**. |
| E6 | Cài đặt tự lưu khi rời màn hình (Esc, nút quay lại, ⌘1…), chỉ khi người dùng thật sự thay đổi (sự kiện `isTrusted`). |
| E7 | Cài mới: hồ sơ "Tài chính – kinh tế" có sẵn từ điển (từ trình hướng dẫn, kể cả khi bấm Bỏ qua). |
| E8 | Xem E2 (mất kết nối Soniox → chuyển offline một nút). |
| E9 | Kiên quyết định **giữ như hiện tại** (không Developer ID, tránh chi phí; app cho Kiên và bạn bè). Cửa sổ DMG + hướng dẫn nói rõ bước "Vẫn mở". |
| E10 | `mainBinaryName: "meowlaoshi"` → `Contents/MacOS/meowlaoshi`. Updater thay cả bundle nên không ảnh hưởng. |

Kiểm: `npm run test:js` (8 test, gồm phát hiện micro bị chặn và hồ sơ mặc định); smoke test jsdom (không commit) chạy qua hộp thoại gói offline, key sai/đúng/chọn offline, quyền micro, trình hướng dẫn có/không key; `cargo clippy --all-targets` sạch, `cargo test` qua. **Chưa chạy trên Mac.**

QA chạy "bài test người mới" ở tiêu chí nghiệm thu Commit E, thêm:
- Cửa sổ DMG ở **cả chế độ sáng và tối**: chữ tên hai biểu tượng (Finder tự vẽ) còn đọc được trên nền xanh nhạt không.
- Trình hướng dẫn: key sai → thông báo; Wi-Fi tắt khi kiểm tra key → câu "Máy đang mất mạng…".
- Từ chối quyền micro ở bước 4, rồi bấm Bắt đầu với nguồn Mic → sau ~4 s phải hiện hộp thoại quyền micro.
- Sửa một ô trong Cài đặt rồi thoát bằng Esc → mở lại vẫn còn.
- `ls /Applications/MeowLaoshi.app/Contents/MacOS/` → `meowlaoshi`; cập nhật từ bản 1.0.0 cũ lên bản mới vẫn chạy.

**E11 (Gỡ cài đặt) thêm sau khi Commit E xong — kỹ sư trưởng làm tiếp.** QA kiểm: làm đúng từng bước "Gỡ sạch" trong hướng dẫn, sau đó không còn thư mục `com.ttkien2035.meowlaoshi` nào trong `~/Library`, và cài lại thì app mở như lần đầu (trình hướng dẫn, hỏi lại quyền Micro).

### Trạng thái E11 — đã làm (kỹ sư trưởng, 2026-09-26)

- `docs/huong-dan-cai-dat.md` › **6. Gỡ cài đặt** (+ PDF): hai cách, viết cho người dùng phổ thông. **Giữ dữ liệu** = thoát app, kéo vào Thùng rác. **Gỡ sạch** = chép buổi học ra trước (Thư viện › Chép), thoát, bỏ app, `⌘⇧G` tới từng `~/Library/Application Support`, `~/Library/WebKit`, `~/Library/Caches` và bỏ `com.ttkien2035.meowlaoshi`, dọn Thùng rác; khối lệnh `rm -rf …` + `tccutil reset All com.ttkien2035.meowlaoshi` (không bắt buộc) cho người dùng Terminal.
- README Anh/Việt: mục con **Uninstalling / Gỡ cài đặt** dưới "Dữ liệu nằm ở đâu"; Windows ghi `%APPDATA%\…` và `%LOCALAPPDATA%\…` (WebView2), **chưa kiểm trên Windows**.
- `scripts/build-guide-pdf.py` bật `fenced_code`: khối lệnh ```` ``` ```` trước đây bị dồn thành một dòng trong PDF.
- QA kiểm theo tiêu chí E11 ở trên; thêm: sau "Gỡ sạch", `ls ~/Library/Preferences | grep meowlaoshi` và `ls ~/Library/"Saved Application State" | grep meowlaoshi` — nếu còn file thì báo để thêm vào hướng dẫn.

---

### Theo dõi câu vừa dịch — đã làm (kỹ sư trưởng, 2026-09-27; Kiên yêu cầu)

- Câu dịch mới nhất có class `.latest`: nền nhạt màu nhấn + vạch dọc bên trái (token `--latest-bg` / `--latest-bar` cho sáng và tối, chữ giữ màu cũ nên tương phản không đổi). Chuyển sang câu mới chỉ bỏ/thêm class ở 2 câu, không duyệt lịch sử.
- Đang ở cuối: vẫn tự cuộn theo như cũ. Đã cuộn lên đọc lại: không giật màn hình; hiện nút nổi **"↓ N câu mới"**, bấm → cuộn mượt tới câu mới nhất (không mượt nếu bật giảm chuyển động); tự cuộn xuống cuối bằng tay cũng làm nút biến mất. Áp dụng cho cả một cột và hai cột.
- Kiểm bằng jsdom (không commit). **QA trên Mac:** buổi dài (≥ 200 câu), sáng/tối, một cột/hai cột: câu mới nổi bật vừa đủ, không nhấp nháy; cuộn lên → nút hiện đúng số câu; bấm nút về đúng câu mới.

### Soniox nhanh hơn + 5 cài đặt bị mất — đã làm (kỹ sư trưởng, 2026-09-27; tiêu chí của Kiên: "theo kịp giảng viên")

- Đo `max_endpoint_delay_ms` trên 5 phút bài giảng thật (key thật, tốc độ thực): 1,5 s → bản dịch trễ 0,79 s trung vị, 90 % trong 1,0 s, lỗi 2,7 %; mặc định cũ 3 s → 1,51 s / 3,23 s, cùng lỗi; 0,5 s làm câu vụn và chậm hơn. Mặc định mới **1500** (Rust, JS, thanh trượt "Chờ chốt câu", đổi nhãn tiếng Việt).
- Lỗi có sẵn: `endpoint_delay`, `translation_type`, `language_a`, `language_b`, `language_hints_strict` được form lưu nhưng **không có trong `Settings` (Rust)** nên serde bỏ đi mỗi lần lưu — thanh trượt và chế độ dịch hai chiều không bao giờ được nhớ. Đã thêm 5 trường (mặc định 1500 / one_way / zh / vi / false) + test round-trip.
- QA trên Mac: chỉnh "Chờ chốt câu", thoát app, mở lại → giá trị còn; nghe một đoạn giảng thật, bản dịch phải theo sát lời nói (~1 s).
