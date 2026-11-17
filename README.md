# Tĩnh Tâm

Ứng dụng web tiếng Việt để gõ mõ, đọc Bát Nhã Tâm Kinh và viết điều ước riêng tư. Giao diện dùng HTML/CSS/JavaScript thuần; máy chủ dùng Node.js và bcryptjs.

## Chạy ứng dụng

Cần Node.js 20 trở lên. Đặt thông tin admin trước khi khởi động:

```sh
ADMIN_USERNAME=admin ADMIN_PASSWORD='change-this-to-a-long-password' npm start
```

Mở `http://localhost:3000`; trang quản trị tại `/admin`. Không có tài khoản admin mặc định. Dùng mật khẩu dài, riêng biệt; HTTPS là bắt buộc khi triển khai công khai.

## Triển khai GitHub Pages + Render

- Workflow `.github/workflows/pages.yml` xuất bản giao diện tại `https://bluexdeev254334.github.io/tinhtam/`. Tệp quản trị được cố ý bỏ khỏi Pages; mở `/admin` trên domain backend để cookie admin là first-party.
- Tạo Blueprint từ `render.yaml` trong Render, nối repository này, rồi đặt `ADMIN_USERNAME`, `ADMIN_PASSWORD` và tùy chọn `ADMIN_TOTP_SECRET`. Blueprint dùng ổ đĩa bền vững cho `DATA_DIR`; gói Render và disk có thể tính phí.
- API URL trong Pages workflow được đặt là `https://tinh-tam-api-bluexdeev254334.onrender.com`; giữ đúng tên service trong blueprint hoặc cập nhật URL trong workflow nếu Render cấp domain khác.
- `ALLOWED_ORIGIN` được cấu hình cho `https://bluexdeev254334.github.io`. Sau khi backend hoạt động, chạy workflow GitHub Pages hoặc push lên `main`.
- Admin đăng nhập tại `https://tinh-tam-api-bluexdeev254334.onrender.com/admin`. Không tạo link admin trong giao diện công khai.

### Cấu hình

| Biến môi trường | Mặc định | Mô tả |
| --- | --- | --- |
| `PORT` | `3000` | Cổng HTTP |
| `DATA_DIR` | `./data` | Thư mục lưu hồ sơ, điều ước và nhật ký JSON |
| `ADMIN_USERNAME` | — | Tên duy nhất của admin |
| `ADMIN_PASSWORD` | — | Mật khẩu admin; máy chủ tạo bản băm bcrypt trong bộ nhớ |
| `ADMIN_TOTP_SECRET` | — | Secret TOTP Base32; bỏ trống để không yêu cầu mã 2 lớp |
| `TRUSTED_PROXY_HEADER` | — | Chỉ đặt khi có proxy tin cậy, ví dụ `x-forwarded-for` |
| `LOG_RETENTION_DAYS` | `90` | Số ngày giữ nhật ký |

`TRUSTED_PROXY_HEADER` không nên được bật nếu máy chủ có thể được truy cập trực tiếp qua header đó. Sao lưu thư mục dữ liệu một cách an toàn; dữ liệu có địa chỉ IP và điều ước riêng tư.

## Quyền riêng tư

Trang chỉ gửi định danh và hoạt động lên máy chủ sau khi người dùng đồng ý. Từ chối vẫn dùng được, với dữ liệu lưu cục bộ. Dấu hiệu khôi phục thiết bị dùng user agent, ngôn ngữ, độ phân giải, múi giờ và tín hiệu canvas/audio nhẹ; các tín hiệu này chỉ được tạo sau khi đồng ý. IP chỉ khớp hồ sơ gợi ý có xác nhận, không tự đăng nhập. Không tra cứu vị trí IP hay sử dụng font/CDN bên thứ ba.

## Âm thanh

Âm mõ được tạo trực tiếp trên trình duyệt. Nếu có tệp lời tụng được cấp phép sử dụng, đặt tệp tại `public/audio/bat-nha-tam-kinh.mp3`; nếu thiếu, trang hiển thị lời kinh và thông báo thân thiện.

## Lưu ý triển khai

- Dữ liệu JSON được ghi nguyên tử vào đĩa nhưng phù hợp quy mô nhỏ/một tiến trình; cần giải pháp cơ sở dữ liệu và sao lưu riêng nếu mở rộng nhiều tiến trình.
- Mật khẩu admin được băm bằng bcrypt (không lưu mật khẩu thô). Phiên admin nằm trong bộ nhớ, hết hạn sau 8 giờ; giới hạn thử đăng nhập áp dụng theo IP trong tiến trình.
- Có thể bật TOTP bằng secret Base32 `ADMIN_TOTP_SECRET`; đăng nhập chấp nhận cửa sổ thời gian ±30 giây.
- Tính năng ước lượng quốc gia/thành phố từ IP chưa được cấu hình; không gửi IP tới dịch vụ định vị bên thứ ba.
