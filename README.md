# Giấy đi đường

App cá nhân (PWA) theo dõi hạn giấy đi đường và hạn bảo hiểm vật chất xe (ngân hàng thụ hưởng) của khách vay mua xe. Cài lên màn hình chính iPhone, chạy được khi không có mạng. Dữ liệu chỉ lưu trên điện thoại (IndexedDB), không gửi đi đâu.

## Các file trong thư mục

| File | Dùng để làm gì |
|---|---|
| `index.html` | Khung trang: các nút, ô nhập, bảng trượt |
| `style.css` | Giao diện: màu sắc, cỡ chữ, hỗ trợ tai thỏ, chế độ tối |
| `app.js` | Toàn bộ chức năng: lưu dữ liệu, tính ngày (giờ VN), lọc, tìm, gia hạn, file Lịch, sao lưu |
| `sw.js` | Service worker: lưu sẵn app để mở được khi mất mạng |
| `manifest.webmanifest` | Tên app, icon, màu, chế độ toàn màn hình khi cài |
| `icon-*.png` | Icon app |
| `ocr/` | Cho nút "Chụp giấy để tự điền": bộ đọc mã QR (jsQR 1.4.0) và bộ đọc chữ (Tesseract.js 6.0.1, dữ liệu tiếng Việt), đều giấy phép Apache-2.0. App đọc mã QR trên giấy biên nhận trước (nhanh, đúng từng chữ); không có QR mới đọc chữ (~5 MB, tải khi cần lần đầu). Ảnh chỉ đọc trên máy, không lưu, không gửi đi đâu. |

## Cập nhật app sau này

1. Sửa code.
2. Mở `sw.js`, tăng số phiên bản (hiện là `giay-di-duong-v8` → lần sau đổi thành `giay-di-duong-v9`). Không cần đổi `giay-di-duong-ocr-v1` trừ khi thay file trong `ocr/`.
3. Tải các file đã sửa lên GitHub (Add file → Upload files → Commit changes).
4. Mở app trên iPhone; khi thấy thông báo "Đã có bản cập nhật mới" thì bấm **Tải lại**.

## Lưu ý quan trọng

- **Không bao giờ tải file sao lưu (`giay-di-duong-sao-luu-*.json`) lên GitHub.** File đó chứa dữ liệu khách; kho GitHub Pages miễn phí là công khai.
- Dữ liệu trong Safari và trong app ở màn hình chính là **riêng biệt**. Hãy nhập dữ liệu trong app đã cài.
- Xóa app khỏi màn hình chính sẽ xóa luôn dữ liệu. Hãy sao lưu hằng tuần.
