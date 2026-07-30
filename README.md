# YouTube Shopping Browser Worker

Phiên bản browser-only của hệ thống gắn sản phẩm YouTube Shopping.

## Kiến trúc

- Backend Node.js chạy relay, trang public và trang quản trị.
- Worker Windows mở các Chrome profile đã đăng nhập YouTube Studio.
- Mỗi request được chuyển qua WebSocket tới đúng browser đang giữ URL video.

## Chạy backend

```bash
npm ci
npm run build
npm start
```

## Build worker Windows

Tạo `.env` từ `.env.example`, sau đó:

```bash
npm ci
npm run build-launcher
```

File portable được tạo trong thư mục `dist/`.
