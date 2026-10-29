# Theo dõi tiến độ triển khai — PackingProof Web

## Khảo sát Workspace & Môi trường (Hoàn tất 2026-10-29)
- [x] Đọc và phân tích đầy đủ yêu cầu kỹ thuật từ prompt dự án.
- [x] Khảo sát công cụ trên máy:
  - `.NET SDK`: `10.0.301` (`AspNetCore.App 10.0.11`)
  - `Node.js / npm`: `v24.16.0` / `11.13.0`
  - `PostgreSQL`: dịch vụ `postgresql-x64-18` đang chạy (`C:\Program Files\PostgreSQL\18\bin\psql.exe`)
  - `FFmpeg / ffprobe`: `9.0-full_build` sẵn sàng trong `PATH`
  - `Docker / Docker Compose`: `29.8.2` / `v5.6.0` (lưu ý: Docker Desktop Engine hiện đang tắt, cần khởi động khi chạy container)
- [x] Viết tài liệu thiết kế kiến trúc `docs/design.md`.
- [x] Viết kế hoạch triển khai chi tiết `docs/implementation-plan.md`.

---

## Checklist 5 Giai đoạn

- [x] **Giai đoạn 1 — Nền tảng và quyền truy cập**
  - [x] Khảo sát workspace; viết `docs/design.md` và `docs/implementation-plan.md`
  - [x] Khởi tạo solution `.NET 10`, React + Vite + TypeScript, `.env.example` và lockfiles
  - [x] Thiết lập EF Core + PostgreSQL migrations & ràng buộc dữ liệu (`xmin`, `UX_VideoAssets_RecordingId_Kind`, non-unique `TrackingNumber`)
  - [x] Bootstrap `SuperAdmin` an toàn từ biến môi trường; luồng đăng ký `PendingApproval`
  - [x] Cookie Auth + CSRF + TOTP 2FA + thu hồi phiên tức thì + Resource Scope Authorization + Grant Ceiling
  - [x] Chạy và vượt qua toàn bộ Auth & Policy unit/integration/frontend tests (100% pass)

- [x] **Giai đoạn 2 — Quay trên web**
  - [x] Mở rộng `TrackingCodeParser` (giữ số `0` đầu, giữ nguyên hoa/thường, chặn path traversal/control chars, tách biệt `TrackingNumber` với `TikTokOrderId`, từ chối đoán URL QR) & `PathSegmentSanitizer`
  - [x] API kiểm tra mã (`POST /api/recordings/inspect-code`), tạo phiên quay (`POST /api/recordings` kèm kiểm tra `recording.manual_code` + audit + `IOrderLinkResolver`), chuyển trạng thái (`POST /api/recordings/{id}/events`) và truy vấn theo scope (`GET /api/recordings`, `GET /api/recordings/{id}`)
  - [x] Kho lưu tạm IndexedDB (`packingproof_local_db`) cô lập nghiêm ngặt theo `ownerUserId`, kết nối live counter với hộp thoại xác nhận đăng xuất & tuần tự hóa ghi chunk (`SerializedChunkWriter`)
  - [x] Quản lý camera đơn luồng (`@zxing/browser` dừng trước khi `MediaRecorder` mở stream), chỉ hiện `Đang quay` sau `MediaRecorder.onstart`, `WakeLock`, cảnh báo & tự dừng có kiểm soát ở giới hạn 10p/512MiB, xử lý gián đoạn (`Interrupted`) và phục hồi sau crash/reload
  - [x] Kiểm thử tự động đầy đủ (xUnit Unit + Integration PostgreSQL, Vitest + `fake-indexeddb`) & hoàn thiện `docs/manual-device-checklist.md`

- [x] **Giai đoạn 3 — Upload và storage**
  - [x] `tusdotnet` thật tại `/api/uploads` + xác thực/phân quyền/CSRF mọi method (`POST/HEAD/PATCH/DELETE`), `POST /api/recordings/{id}/upload-session` idempotent & `POST /api/recordings/{id}/retry-storage`
  - [x] Khôi phục upload (`tus-js-client` + `IndexedDbTusFileSource` cắt slice 5 MiB từ IndexedDB không nạp toàn bộ video vào RAM) theo offset thực từ `HEAD`, phân biệt tus 100% với server `Stored`, chỉ xóa chunk IndexedDB sau khi `Stored`, và xử lý hết hạn cookie (`401`) tạm dừng an toàn không mất dữ liệu
  - [x] Vùng `Staging` bền vững có giới hạn `STAGING_MAX_BYTES` (`507 STAGING_CAPACITY_EXCEEDED`) + `ProcessingJobWorker` lease PostgreSQL `FOR UPDATE SKIP LOCKED` idempotent và tự thu hồi lease hết hạn sau crash
  - [x] `FileSystemVideoStorage` (`LocalDevelopment` & `SynologyMounted` kiểm tra `.packingproof-storage-id == STORAGE_ID`, không bao giờ tự tạo `NAS_ROOT_PATH`, đường dẫn `<ShopSlug>/<yyyy>/<MM>/<dd>/<SafeTracking>/<SafeTracking>_<RecordingId>.<ext>` theo múi giờ `Asia/Ho_Chi_Minh`, ghi `.partial` -> flush -> đọc lại verify `SHA-256` -> atomic rename, reconcile sau crash và chặn ghi đè `STORAGE_HASH_CONFLICT`)
  - [x] Kiểm tra media thật bằng `ffprobe` (`ProcessStartInfo.ArgumentList`), cập nhật `/health/ready` với `IVideoStorage.CheckHealthAsync` & vượt qua toàn bộ 105/105 automated tests (62 Unit + 21 Integration PostgreSQL/ffmpeg/ffprobe + 22 Frontend Vitest)

- [x] **Giai đoạn 4 — Tra cứu và quản trị**
  - [x] Danh sách & tìm kiếm video phân trang theo scope (`GET /api/videos` lọc SQL trước phân trang, giữ số `0` đầu cho `exact = true | false`, ngày theo `Asia/Ho_Chi_Minh`); chi tiết video (`GET /api/videos/{id}`), nhập video có sẵn (`POST /api/videos/import` gắn `Source = Imported` qua pipeline `tus` + `ffprobe` + `IVideoStorage`) & trình phát `HTTP Range` (`GET/HEAD /api/videos/{id}/stream` `206 Partial Content`, `Cache-Control: private, no-store`, trả `503 STORAGE_FILE_UNAVAILABLE` khi NAS không khả dụng và tuyệt đối không fallback sang staging chưa xác thực)
  - [x] Tải file gốc (`GET /api/videos/{id}/download` kiểm tra riêng quyền `video.download` + ghi `AuditEvent`), ghi chú (`POST /api/videos/{id}/notes` `video.note`), giữ video chống xóa (`PUT /api/videos/{id}/hold` `video.hold` kèm lý do bắt buộc)
  - [x] Luồng yêu cầu & phê duyệt xóa (`POST /api/videos/{id}/deletion-requests`, `GET /api/deletion-requests`, `POST /api/deletion-requests/{id}/approve|reject`: soft-delete trước, chặn `409 VIDEO_ON_HOLD` cả lúc gửi yêu cầu và lúc phê duyệt) + `RetentionCleanupProcessor`/`RetentionCleanupService` (mặc định tắt, bảo vệ video `Hold = true` với `retention.skipped_hold`, xóa vật lý & soft-delete video quá hạn `Hold = false` với `retention.deleted`)
  - [x] Hoàn thiện toàn bộ 10 màn hình giao diện tiếng Việt (`DashboardPage` số liệu thật từ PostgreSQL, `RecordingPage` hỗ trợ `?linkedFrom` & `video.import`, `VideoListPage`, `VideoDetailPage`, `UsersAdminPage`, `RolesAdminPage` ma trận 14 quyền + grant ceiling, `StorageAdminPage` health-check `.packingproof-storage-id` + xác nhận `confirmRetentionEnable`, `AuditLogPage` append-only theo scope) & vượt qua toàn bộ 118/118 automated tests (62 Unit + 30 Integration PostgreSQL + 26 Frontend Vitest)

- [x] **Giai đoạn 5 — Hoàn thiện**
  - [x] Worker chuyển mã bản xem MP4 (`FFmpeg` H.264/AAC) độc lập với bản gốc khi cần (`IPreviewTranscoder`, `FfmpegPreviewTranscoder`, `ProcessingJobProcessor` giới hạn `PROCESSING_CONCURRENCY`, giữ nguyên 100% file gốc + `SHA-256` gốc, kiểm thử thật bằng `PreviewTranscodingTests`)
  - [x] PWA App Shell (`manifest.webmanifest`, bộ icon SVG, `sw.js` chỉ cache tài nguyên tĩnh App Shell và bỏ qua tuyệt đối `/api/*`, `/health/*`, `/openapi/*`, `Range` & non-`GET`, kiểm thử bằng `serviceWorkerPolicy.test.ts` + cấu hình ESLint sạch `0` lỗi)
  - [x] Kiểm thử tích hợp & Playwright E2E với camera giả (`e2e/specs/authAndGovernance.spec.ts`, `recordUploadAndPlayback.spec.ts`, `permissionsAndHoldProtection.spec.ts` trên PostgreSQL 18.4 thật + `PackingProof.Api` single-origin + `ffprobe`/`FFmpeg`) phủ toàn bộ 19 kịch bản bắt buộc (`126/126` automated tests pass)
  - [x] Hoàn thiện `backend/Dockerfile`, `frontend/Dockerfile`, `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/nginx.conf.example`, `README.md`, `docs/permissions.md`, `docs/deploy-synology.md`, `docs/deploy-iis.md`, `docs/test-report.md`

