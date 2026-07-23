# Android worker (LDPlayer)

Worker này thay phần thao tác YouTube Studio trên browser bằng LDPlayer +
`uiautomator2`. Relay Node.js hiện tại vẫn giữ nguyên API công khai.

## Cài đặt

1. Mở các LDPlayer, đăng nhập cùng tài khoản trong YouTube Studio và bật ADB.
2. Cài Python 3.11 trở lên.
3. Trong thư mục dự án chạy:

   ```powershell
   python -m pip install -r requirements-android.txt
   Copy-Item android-worker.example.json android-worker.json
   ```

4. Sửa `android-worker.json`:

   - `server_url`: địa chỉ relay, ví dụ `wss://domain.example`.
   - `worker_auth_token`: giống `WORKER_AUTH_TOKEN` của relay.
   - `adb_path`: đường dẫn `adb.exe` của LDPlayer.
   - `devices`: danh sách serial lấy từ `adb devices`.
   - `video_ids`: để trống nếu LDPlayer được phép xử lý mọi video; hoặc nhập danh
     sách video ID nếu muốn cố định thiết bị cho một nhóm video.

5. Chạy relay và worker:

   ```powershell
   npm start
   npm run android-worker
   ```

`android-worker.json` chứa token nên không commit file này.

## Luồng một job

1. Relay resolve link rút gọn và chọn video có hàng đợi ngắn nhất.
2. Worker chụp danh sách sản phẩm công khai hiện tại.
3. Mở trực tiếp `https://studio.youtube.com/video/{videoId}/edit` trên LDPlayer.
4. Mở **Tag products**, nhập URL đầy đủ và chọn kết quả đầu tiên.
5. **Done** và **Save**.
6. Poll trang video công khai, tìm product identity mới và lấy URL affiliate.
7. Mở lại Studio, tìm đúng URL vừa thêm, bỏ chọn, **Done** và **Save**.
8. Chỉ trả thành công sau khi public shelf đã mất sản phẩm mới.

## Phục hồi và chẩn đoán

- Trạng thái job nằm trong `data/android-jobs`.
- Nếu process dừng sau khi đã add, lần khởi động sau sẽ chạy cleanup trước khi
  nhận job mới.
- Screenshot và UI hierarchy khi lỗi nằm trong `data/android-artifacts`.
- Một thiết bị chỉ chạy một job tại một thời điểm; cùng một video cũng luôn được
  khóa để tránh xóa nhầm sản phẩm.

## Biến môi trường relay nên dùng

```dotenv
WORKER_JOB_TIMEOUT_MS=420000
QUEUE_WAIT_TIMEOUT_MS=30000
PREFER_ANDROID_WORKERS=1
```

Giữ browser worker tắt nếu chỉ muốn dùng LDPlayer. Nếu chạy đồng thời, relay ưu
tiên Android worker; đặt `PREFER_ANDROID_WORKERS=0` để trở về thứ tự kết nối cũ.

## Danh sách video local

Khai báo các video mặc định của Android worker trong `android-worker.json` bằng
trường `video_urls`. Android worker bỏ qua `config-update` từ server; relay dùng
danh sách worker đã đăng ký để chuyển job xuống. Cấu hình URL trong admin chỉ còn
là phương án dự phòng cho browser worker cũ.
