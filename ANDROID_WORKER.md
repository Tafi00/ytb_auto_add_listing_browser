# Android collection API worker (LDPlayer)

## VMOS Cloud

Launcher hỗ trợ VMOS Cloud làm thiết bị Android chính:

1. Cài Android Platform Tools để có `adb.exe`.
2. Trên VMOS, cài YouTube Studio, đăng nhập sẵn, bật ADB và root.
3. Mở mục **VMOS Cloud & Chrome dự phòng** trong launcher.
4. Chọn **VMOS OpenAPI**, nhập Pad Code, Access Key và Secret Key, rồi bấm
   **Lưu & xác thực tài khoản**.

OpenAPI xin SSH/ADB lease tối đa 7 ngày và tự gia hạn trước khi hết hạn. Có thể
chọn chế độ thủ công để nhập lệnh SSH và connection key 24 giờ do VMOS cung cấp,
nhưng chế độ này không thể tự xin key mới.

Access Key, Secret Key và connection key được mã hóa bằng Windows Safe Storage
trong `vmos-secrets.json`; file này đã bị loại khỏi Git.

Nếu bật **Chrome dự phòng**, nhập ít nhất một URL video YouTube Studio. Relay ưu
tiên VMOS. Khi mobile API lỗi, timeout hoặc mất kết nối, đúng request đó mới được
chuyển sang Chrome worker; khi VMOS online lại, request mới tự quay về VMOS.

Mục **Chế độ chính** cho phép chuyển trực tiếp giữa:

- **Mobile API**: dùng VMOS hoặc Android local; có thể bật Chrome dự phòng.
- **Browser / Chrome**: chỉ chạy worker Chrome cũ, không yêu cầu VMOS/ADB/Python
  mobile online. Bấm **Lưu & xác thực tài khoản** để dừng worker hiện tại và
  chuyển sang Browser ngay. Khi chuyển lại Mobile, nút này xác thực session
  mobile rồi khởi động lại worker.

Worker dùng phiên đăng nhập YouTube Studio trong LDPlayer để gọi trực tiếp
YouTube Shopping protobuf API. Worker không mở Chrome và không điều khiển giao
diện Studio cho từng sản phẩm.

## Chuẩn bị

1. Cài LDPlayer 9, bật **Root permission** và **ADB debugging**.
2. Cài YouTube Studio trong LDPlayer rồi đăng nhập tài khoản quản lý collection.
3. Cài Python 3.11 trở lên.
4. Trong thư mục dự án:

   ```powershell
   python -m pip install -r requirements-android.txt
   Copy-Item android-worker.example.json android-worker.json
   ```

5. Sửa `android-worker.json`:

   - `server_url`: địa chỉ relay WebSocket.
   - `worker_auth_token`: giống `WORKER_AUTH_TOKEN` của relay.
   - `adb_path`: đường dẫn `adb.exe` của LDPlayer.
   - `auto_discover_collections: false`: dùng cố định pool 5 collection đã lưu.
   - `collection_pool_size: 5`: giới hạn đúng 5 slot chạy song song. Chỉ bật
     tự khám phá tạm thời khi cần đổi sang tài khoản hoặc pool khác.
   - `oauth_refresh_seconds: 3000`: chủ động xin token mới sau mỗi 50 phút.
   - `oauth_refresh_retry_seconds: 300`: nếu token chưa đổi hoặc token mới không
     hợp lệ thì giữ token hiện tại và thử lại sau 5 phút.
   - `oauth_refresh_wait_seconds: 30`: chờ tối đa 30 giây để Studio ghi token mới.
   - `devices[].serial`: serial hiển thị bởi `adb devices`.

6. Mở `YT Worker Launcher` rồi bấm **Xác thực tài khoản**. Tool tự mở mục
   Collections một lần, phát hiện danh sách, kiểm tra API và kết nối relay.
   Nút này kiểm tra:

- LDPlayer đang online;
- quyền root đã bật;
- YouTube Studio đã cài;
- đọc được OAuth của tài khoản đã đăng nhập;
- collection protobuf API test thành công.

Xác thực không ngắt worker đang chạy hoặc kết nối relay. Khi nhận job, worker
dùng thẳng phiên đã lưu; chỉ kiểm tra/refresh lại nếu API từ chối phiên đó.
Worker cũng chủ động đánh thức Studio mỗi 50 phút, chờ token thay đổi rồi kiểm
tra token mới bằng API trước khi chia sẻ cho toàn bộ pool collection trên cùng
thiết bị. Nếu refresh nền thất bại, token cũ không bị ghi đè và worker thử lại
sau 5 phút; phản ứng refresh khi gặp HTTP 401/403 vẫn được giữ làm dự phòng.

Khi nhiều request cùng tới một collection, relay xếp hàng tuần tự và worker
giữ khóa collection cho đến khi cleanup xong. Các collection khác nhau có thể
xử lý song song dù dùng chung một LDPlayer/OAuth.

## Luồng xử lý

1. Search bằng nguyên URL sản phẩm với phiên Studio đã lưu.
2. Chỉ chấp nhận protobuf record có đúng Shopee offer ID hoặc Lazada SKU trong
   URL; không match theo title hoặc ảnh.
3. Publish baseline cùng record chính xác vào collection.
4. Đọc collection công khai và trả affiliate ngay khi thấy đúng sản phẩm.
5. Restore collection bằng API ở nền và xác nhận sản phẩm tạm đã biến mất.

LDPlayer chỉ giữ phiên OAuth. Browser Playwright/Chrome không được dùng trong
luồng này.

## Lưu ý

- Hỗ trợ Shopee dạng `https://shopee.vn/product/{shopId}/{offerId}` và Lazada
  dạng `...-i{itemId}-s{skuId}.html`.
- `android-worker.json` có token relay nên không commit file này.
- File `android_worker/mobile-api-template.json` là protobuf template đã bỏ
  Authorization; OAuth thật luôn được đọc tại runtime từ LDPlayer.
- Nếu Google yêu cầu xác minh lại, mở YouTube Studio trong LDPlayer, đăng nhập
  lại rồi bấm **Xác thực tài khoản**.
- Collection được dùng như vùng tạm. Không chỉnh bốn sản phẩm baseline khi
  worker đang chạy.

Để dùng lại worker điều khiển UI cũ, đặt `"mode": "ui"` và dùng cấu hình
`video_urls` cũ.
