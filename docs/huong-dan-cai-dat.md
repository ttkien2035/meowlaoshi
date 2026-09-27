# MeowLaoshi 猫老师

*Hướng dẫn cài đặt và sử dụng · bản 1.0 · cập nhật 26-09-2026*

MeowLaoshi (猫老师, “thầy mèo”) nghe giảng viên nói tiếng Trung và hiện bản dịch tiếng Việt ngay trên máy Mac, kèm ghi chú theo từng câu. Cài mất khoảng 5 phút; app tự dẫn bạn qua phần thiết lập.

**Cần có:** máy Mac chạy macOS 13 (Ventura) trở lên, mật khẩu đăng nhập máy. Muốn dịch qua mạng (chính xác nhất) thì cần thêm API key Soniox: hỏi người đã gửi app cho bạn.

---

## 1. Chọn đúng file

Xem loại chip: bấm biểu tượng quả táo ở góc trên bên trái màn hình → **Giới thiệu về máy Mac này** → dòng **Chip**.

| Máy của bạn | File cần mở |
|---|---|
| Chip Apple (M1 trở lên) | `MeowLaoshi_1.1.0_aarch64.dmg` |
| Chip Intel | `MeowLaoshi_1.1.0_x64.dmg` |

## 2. Cài đặt và mở lần đầu

1. Nháy đúp file `.dmg`. Cửa sổ hiện ra có mũi tên: kéo biểu tượng **MeowLaoshi** vào thư mục **Applications**, rồi đóng cửa sổ đó.
2. Mở **Applications** → nháy đúp **MeowLaoshi**.
3. Lần đầu, macOS báo không mở được, vì app phát hành miễn phí, không qua App Store. Đây là bình thường và chỉ làm một lần:
    1. Bấm **Xong** (không bấm “Chuyển vào Thùng rác”).
    2. Mở **Cài đặt hệ thống** → **Quyền riêng tư & Bảo mật** → kéo xuống mục **Bảo mật**.
    3. Bấm **Vẫn mở** cạnh dòng “MeowLaoshi bị chặn…” → nhập mật khẩu máy → **Mở**.

> Quen dùng Terminal thì thay bước 3 bằng lệnh:
> `xattr -dr com.apple.quarantine /Applications/MeowLaoshi.app`

## 3. Thiết lập lần đầu (app tự dẫn đường)

Lần đầu mở, app hỏi 4 câu. Bước nào cũng bỏ qua được và làm lại sau trong **Cài đặt**.

1. **Key Soniox.** Dán key tác giả cấp cho bạn, bấm **Kiểm tra key**. App thử kết nối ngay và báo ✓ nếu key dùng được. Chưa có key thì bấm **Chưa có key**: bạn vẫn dịch được bằng chế độ offline.
2. **Gói offline.** Tải một lần khoảng 1,6 GB để dịch cả khi mất mạng. Gói tải trong nền; góc dưới màn hình hiện phần trăm. Nên tải khi có Wi-Fi ổn định.
3. **Môn học.** Chọn **Tài chính – kinh tế** để nạp sẵn khoảng 480 thuật ngữ (gồm tên các học viện của ĐH Tài chính Kinh tế Trung ương), giúp app nhận đúng và dịch đúng từ chuyên ngành.
4. **Thử micro.** macOS hỏi quyền dùng micro: bấm **Cho phép**. Nói thử vài câu: thanh màu nhảy theo giọng là micro đã chạy.

Có key thì app dùng Soniox; không có key thì dùng chế độ offline. Đổi lúc nào cũng được bằng nút trên thanh công cụ.

**Micro:** ngồi gần bục giảng, hoặc dùng micro rời (loại kẹp áo không dây). Micro MacBook đặt cách giảng viên 5–10 m sẽ nhận sai nhiều hơn rõ rệt.

## 4. Dùng trên lớp

1. Bấm **▶ Bắt đầu** (hoặc `⌘↩`). Câu tiếng Trung và bản dịch hiện dần theo lời giảng viên.
2. Ghi chú và đánh dấu trong lúc nghe bằng các phím tắt dưới đây.
3. Hết buổi bấm **Dừng**. Buổi học tự lưu vào **📚 Thư viện**.

| Phím | Tác dụng |
|---|---|
| `⌘↩` | Bắt đầu / Dừng |
| `⌘⇧N` | Mở / đóng khung ghi chú |
| `⌘⇧C` | Chép câu vừa dịch vào ghi chú, kèm giờ |
| `⌘⇧1` | Đánh dấu ⭐ ý quan trọng |
| `⌘⇧2` | Đánh dấu ❓ chưa hiểu, cần hỏi lại |
| `⌘⇧3` | Đánh dấu 📝 sẽ thi (app cũng tự đánh dấu khi giảng viên nói 会考 / 考点) |
| `⌘,` | Mở Cài đặt |
| `?` | Xem toàn bộ phím tắt |

**Ôn bài:** mở **📚 Thư viện** → chọn buổi. Lọc 📝 để xem phần sẽ thi, lọc ❓ để chuẩn bị câu hỏi, viết tiếp ghi chú. Bấm **Chép** để lấy nội dung dạng Markdown, dán vào Notion hoặc Apple Notes.

Nên xin phép giảng viên trước khi ghi âm trong lớp.

## 5. Khi gặp lỗi

Phần lớn lỗi, app tự hiện hộp thoại kèm nút sửa ngay: **Tải ngay** khi thiếu gói offline, ô dán key khi key sai, **Mở cài đặt quyền Micrô** khi macOS chặn micro, **Dịch offline** khi mất mạng. Những trường hợp còn lại:

| Hiện tượng | Cách xử lý |
|---|---|
| macOS báo “MeowLaoshi bị hỏng và không thể mở” | App không hỏng; đây là cảnh báo với app chưa qua App Store. Làm lại bước 3 ở mục 2, hoặc chạy lệnh `xattr` ở cuối mục 2 |
| Bản dịch bỏ qua vài câu | Khi máy hoặc mạng chậm, app bỏ câu cũ để theo kịp giảng viên. Bình thường; ngồi gần hơn hoặc dùng Soniox sẽ ít gặp |
| Nhận dạng sai nhiều | Ngồi gần giảng viên hoặc dùng micro rời; kiểm tra thanh công cụ đang chọn đúng môn |

**Cập nhật app:** **Cài đặt › Giới thiệu › Kiểm tra bản mới**. App tự tải và cài bản mới, không phải làm lại bước 3.

**Dữ liệu của bạn:** API key, hồ sơ, từ điển và các buổi học đều nằm trên máy bạn. Âm thanh chỉ gửi tới Soniox khi bạn dùng Soniox.

Vẫn kẹt thì nhắn cho người gửi bạn file này, kèm ảnh chụp màn hình lỗi.

## 6. Gỡ cài đặt

Kéo app vào Thùng rác chỉ gỡ phần app. Dữ liệu vẫn ở lại trên máy: API key Soniox, cài đặt, các buổi học và gói offline (khoảng 1,5 GB). Chọn một trong hai cách:

**Gỡ app nhưng giữ dữ liệu** (định cài lại sau, không muốn tải lại 1,6 GB hay dán lại key):

1. Thoát app (`⌘Q`).
2. Mở **Applications**, kéo **MeowLaoshi** vào **Thùng rác**.

Cài lại thì mọi thứ còn nguyên như trước.

**Gỡ sạch** (cho mượn hoặc bán máy, không muốn để lại key và buổi học):

1. Muốn giữ các buổi học thì lưu ra trước: mở **📚 Thư viện**, chọn từng buổi, bấm **Chép** rồi dán vào Notion hoặc Apple Notes. Gỡ sạch là mất hết các buổi học đã lưu trong app.
2. Thoát app (`⌘Q`), kéo **MeowLaoshi** từ **Applications** vào **Thùng rác**.
3. Trong Finder, bấm `⌘⇧G` (menu **Đi › Đi tới thư mục**), dán từng đường dẫn dưới đây, bấm Return, rồi kéo thư mục `com.ttkien2035.meowlaoshi` trong đó vào **Thùng rác**:
    1. `~/Library/Application Support`: cài đặt, API key, buổi học, gói offline (thư mục lớn nhất).
    2. `~/Library/WebKit`
    3. `~/Library/Caches`
4. Dọn Thùng rác: chuột phải vào biểu tượng Thùng rác trên Dock → **Dọn sạch Thùng rác**.

Quen dùng Terminal thì thay bước 3 bằng lệnh thứ nhất dưới đây. Lệnh thứ hai xoá luôn quyền micro mà macOS vẫn nhớ cho app (không bắt buộc):

```bash
rm -rf ~/Library/Application\ Support/com.ttkien2035.meowlaoshi ~/Library/WebKit/com.ttkien2035.meowlaoshi ~/Library/Caches/com.ttkien2035.meowlaoshi
tccutil reset All com.ttkien2035.meowlaoshi
```

Sau khi gỡ sạch, cài lại thì app mở như lần đầu: có trình hướng dẫn và hỏi lại quyền micro.
