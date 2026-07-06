# Hướng dẫn gọi (HTTP)

Repo: https://github.com/vuongdaitrang/mentor_club_test

Gọi 1 request là hệ thống chạy trên GitHub, không cần bật máy:
```bash
curl -i -X POST https://api.github.com/repos/vuongdaitrang/mentor_club_test/dispatches \
  -H "Authorization: Bearer <PAT>" -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"<EVENT>","client_payload":{}}'
```
Trả 204 = đã nhận. Xem kết quả ở tab Actions.

| event_type | Việc | payload hay dùng |
|---|---|---|
| fetch-pages | Lấy Page về Base | mode ("--update") |
| fetch-posts | Lấy bài viết về Base | posts_per_page, mode ("--update") |
| dang-bai | Đăng bài (Hình ảnh->feed, Video->Reel) | record_id (đăng 1 dòng), mode ("--dry-run") |
| dang-reel | Đăng Reel (bảng Reel riêng) | mode |

Token FB ~ hết hạn thì chỉ cập nhật lại Secret, không sửa code.
