# Báo cáo Kiểm thử & Nghiệm thu Kỹ thuật — PackingProof Web (`docs/test-report.md`)

Ngày thực hiện kiểm chứng: **2026-10-29**  
Môi trường thực thi: **Windows (PowerShell) • `.NET SDK 10.0.301` • `PostgreSQL 18.4` (`postgresql-x64-18`) • `Node.js v24.16.0` • `FFmpeg / ffprobe 9.0` • `Playwright Chromium 156.0.8078.4` • `Docker CLI 29.8.2` / `Docker Compose v5.6.0`**

---

## 1. Tổng hợp Lệnh Kiểm chứng & Kết quả Thực tế

Toàn bộ các bộ kiểm thử tự động dưới đây đã được chạy thật và vượt qua **100% (`126/126` test cases tự động + Build/Typecheck/Lint/Compose Config sạch `0` lỗi, `0` cảnh báo)**:

| Hạng mục kiểm tra | Lệnh thực thi chính xác | Số lượng & Kết quả thực tế |
| --- | --- | --- |
| **1. Backend Lockfile Restore & Build** | `dotnet restore backend/PackingProof.slnx --locked-mode`<br>`dotnet build backend/PackingProof.slnx --no-restore` | **PASS** — `0 Warning(s), 0 Error(s)` |
| **2. Backend Unit Tests (`xUnit`)** | `dotnet test backend/tests/PackingProof.UnitTests --no-build` | **PASS** — **`63 / 63`** tests passed |
| **3. Backend Integration Tests (`xUnit` + `PostgreSQL 18.4` + `tusdotnet` + `ffprobe` + `FFmpeg`)** | `dotnet test backend/tests/PackingProof.IntegrationTests --no-build` | **PASS** — **`32 / 32`** tests passed *(mỗi bộ test khởi tạo DB PostgreSQL 18 riêng và dọn sạch sau khi chạy)* |
| **4. Frontend TypeScript Typecheck** | `npm --prefix frontend run typecheck` | **PASS** — `0` lỗi kiểu dữ liệu (`tsc --noEmit`) |
| **5. Frontend ESLint** | `npm --prefix frontend run lint` | **PASS** — `0` errors, `0` warnings (`src/`, `tests/`, `public/sw.js`) |
| **6. Frontend Unit/Component Tests (`Vitest` + `fake-indexeddb`)** | `npm --prefix frontend test` | **PASS** — **`28 / 28`** tests passed (`7` test files) |
| **7. Frontend Production Build (Vite + PWA App Shell)** | `npm --prefix frontend run build` | **PASS** — xuất gói tĩnh `frontend/dist` kèm `manifest.webmanifest`, `sw.js`, `icons/*` |
| **8. Playwright E2E Browser Suite (`Chromium` + Fake Camera + `PostgreSQL 18.4` + `FFmpeg`)** | `npm --prefix e2e run typecheck`<br>`npx --prefix e2e playwright test` | **PASS** — **`3 / 3`** luồng trình duyệt đầu-cuối passed *(tự tạo & tự `DROP` DB `packingproof_e2e_<guid>`)* |
| **9. Kiểm tra Cú pháp Docker Compose** | `docker compose --env-file .env.example -f deploy/docker-compose.yml config` | **PASS** — cấu hình YAML hợp lệ hoàn toàn cho `postgres`, `backend`, `proxy` |

---

## 2. Đối chiếu Đầy đủ 19 Tình huống Nghiệm thu Bắt buộc (Mục 10)

| # | Tình huống bắt buộc | Kết quả cần đạt | Bộ kiểm thử tự động chứng minh | Trạng thái |
| :-: | --- | --- | --- | :-: |
| **1** | Chưa có mã vận đơn hợp lệ | Không bắt đầu quay hoặc tạo upload trái phép | `RecordingSessionLifecycleTests` (chặn tạo phiên/upload khi thiếu mã hoặc thiếu quyền `recording.manual_code`); `TusSecurityAndResumeTests` (chặn `POST /api/uploads` không gắn `UploadSession` hợp lệ); `recordingFlow.test.tsx` | **PASS** |
| **2** | Quét lặp, mã bắt đầu bằng số `0`, QR là URL | Không tạo trùng liên tiếp, không mất số `0`, không suy đoán mã từ URL | `TrackingCodeParserTests`, `trackingParser.test.ts` (giữ nguyên `"00849201923"`, từ chối URL QR); `recordUploadAndPlayback.spec.ts` (quét QR URL bị chặn trên UI tiếng Việt -> quét `"00849201923"` giữ nguyên số `0` tới lúc lưu & tìm kiếm `"008492"`) | **PASS** |
| **3** | Mã chứa `../` hoặc ký tự nguy hiểm | Không thoát storage root, không chạy shell command hoặc tự gọi URL quét | `TrackingCodeParserTests`, `StoragePathBuilderTests` (chặn `../`, `..\`, ký tự điều khiển, chuẩn hóa segment an toàn); `FfprobeMediaInspector` & `FfmpegPreviewTranscoder` chỉ dùng `ProcessStartInfo.ArgumentList` (`UseShellExecute = false`) | **PASS** |
| **4** | Quay bình thường | Đủ chunk cuối, đúng mã, media đọc được, lưu đúng thư mục `<Shop>/<yyyy>/<MM>/<dd>/<SafeTracking>/...` | `serializedChunkWriter.test.ts` (tuần tự hóa toàn bộ chunks + chunk cuối trước khi chốt manifest); `SynologyStorageAndWorkerTests`; `PreviewTranscodingTests`; `recordUploadAndPlayback.spec.ts` | **PASS** |
| **5** | Hai lần quay cùng mã / hai người quay đồng thời | Có `RecordingId` riêng, cảnh báo đã có video nhưng không ghi đè | `DatabaseConstraintsTests` (non-unique index `(ShopId, TrackingNumber)`), `RecordingSessionLifecycleTests` (trả `existingRecordingCount >= 1`, sinh 2 file riêng kèm `_<RecordingId>`) | **PASS** |
| **6** | Mất Wi-Fi trong phiên hoặc khi đang upload | Dữ liệu đã lưu còn nguyên trong hàng đợi; upload tiếp đúng offset thật từ server khi kết nối lại | `TusSecurityAndResumeTests` (ngắt upload giữa chừng -> `HEAD` lấy `Upload-Offset` thật -> `PATCH` nối tiếp khớp `SHA-256`); `tusQueueRecovery.test.tsx` (không tin phần trăm cũ, đọc offset từ `HEAD`) | **PASS** |
| **7** | Reload trang khi đang upload | Cùng người dùng khôi phục bytes từ `IndexedDB` và `UploadSession` hiện có; user khác không thấy | `tusQueueRecovery.test.tsx` (khôi phục hàng đợi theo `ownerUserId`, dùng lại `UploadSession` idempotent, chỉ xóa chunks sau khi server báo `Stored`); `serializedChunkWriter.test.ts` (cô lập đa tài khoản) | **PASS** |
| **8** | Crash / đóng tab / ngắt camera khi đang quay | Báo `Interrupted`, dừng đồng hồ ngay, không trình bày như video `Captured` hoàn chỉnh | `recordingFlow.test.tsx` (`track.onended` dừng bộ đếm ngay lập tức và chuyển `Interrupted`); `serializedChunkWriter.test.ts` (mở lại sau crash tự động đánh dấu phiên dở dang là `Interrupted`) | **PASS** |
| **9** | IndexedDB hết quota / dữ liệu trình duyệt bị xóa | Báo đúng lỗi `QuotaExceededError` / `integrityCorrupted`, không mất âm thầm, không hứa phục hồi khi mất bytes | `serializedChunkWriter.test.ts` (bắt `QuotaExceededError` dừng quay có kiểm soát & phát hiện thiếu chunk khi bị xóa dữ liệu trình duyệt) | **PASS** |
| **10** | Cookie hết hạn hoặc quyền bị thu hồi giữa chừng | Request tiếp theo (kể cả `tus` & `/stream`) bị chặn ngay; không làm mất bytes cục bộ đã lưu | `ImmediateRevocationTests` (xoay `SecurityStamp` chặn tức thì request kế tiếp); `tusQueueRecovery.test.tsx` (nhận `401` tạm dừng hàng đợi, giữ nguyên chunks `IndexedDB`); `authAndGovernance.spec.ts` | **PASS** |
| **11** | `Viewer` gọi API upload / delete / download trực tiếp | Bị backend từ chối `403`, không phụ thuộc việc ẩn nút trên giao diện | `PrivilegeEscalationTests`, `VideoAccessAndRangeTests`, `permissionsAndHoldProtection.spec.ts` (ẩn nút trên UI đồng thời gọi thẳng `fetch` kèm CSRF hợp lệ tới `POST /api/recordings`, `GET /download`, `POST /deletion-requests` đều nhận `403`) | **PASS** |
| **12** | `User A` đọc stream / Range / chi tiết / tus URL của `User B` | Bị từ chối `403/404` nếu không có scope hợp lệ | `TusSecurityAndResumeTests` (`User B` gọi `HEAD/PATCH/DELETE` vào tus URL của `User A` bị chặn `403`); `VideoAccessAndRangeTests` (`User A` đọc `/stream` Range của `User B` ngoài scope bị chặn) | **PASS** |
| **13** | `Admin` tự cấp `SuperAdmin` hoặc mở rộng scope sang Shop khác | Bị từ chối `403` theo `Grant Ceiling` và ghi bản ghi `AuditEvent(Outcome = Denied)` | `GrantCeilingValidatorTests`, `PrivilegeEscalationTests`, `AdminGovernanceTests` (kiểm chứng cả trần quyền, trần scope, bảo vệ `SuperAdmin` cuối cùng và tính bất biến không sửa/xóa của `AuditEvents`) | **PASS** |
| **14** | NAS mất mount (`.packingproof-storage-id`), đầy hoặc mất quyền ghi | Không báo `Stored`, không tự tạo thư mục local giả NAS; giữ staging và xử lý lại được khi phục hồi | `SynologyStorageAndWorkerTests` (mất `.packingproof-storage-id` -> `WaitingForStorage` + retry backoff -> khôi phục marker -> commit thành công; kiểm tra trần `STAGING_MAX_BYTES` `507`) | **PASS** |
| **15** | Restart worker / callback lặp / crash sau khi đã commit file lên NAS | Reconcile idempotent theo `RecordingId` + `SHA-256`, không nhân đôi `VideoAsset` hoặc ghi đè khi lệch hash | `SynologyStorageAndWorkerTests` (crash sau khi file nằm trên NAS trước khi lưu DB -> lần chạy lại đối chiếu `SHA-256` khớp và cập nhật `Stored`; nếu lệch `SHA-256` báo `STORAGE_HASH_CONFLICT`, không ghi đè) | **PASS** |
| **16** | Hash sai / file giả video đổi đuôi `.mp4`/`.webm` / định dạng không hỗ trợ | `ffprobe` bác bỏ, đánh dấu `Failed` kèm mã lỗi an toàn, không chép sang NAS | `SynologyStorageAndWorkerTests` (upload nội dung giả video bị `FfprobeMediaInspector` chặn ngay ở bước `Validating`, không tạo file trên storage đích) | **PASS** |
| **17** | Bản xem cần chuyển mã (`Preview`) + PWA App Shell không cache dữ liệu riêng | Giữ nguyên bản gốc & `SHA-256` gốc; `FFmpeg` tạo `_preview.mp4` (`H.264`/`AAC`) độc lập, phát HTTP `206` Range; `sw.js` không cache `/api/*` hay video | `PreviewTranscodingTests` (upload `.webm` VP8 không tiếng & có tiếng Opus -> giữ nguyên `.webm` gốc, sinh `_preview.mp4` `h264`, phát `206 Partial Content` cả 2 biến thể); `serviceWorkerPolicy.test.ts`; `recordUploadAndPlayback.spec.ts` | **PASS** |
| **18** | `Retention` hoặc yêu cầu xóa gặp video đang bật `Hold` | Giữ nguyên video, chặn cả yêu cầu xóa mới lẫn duyệt xóa (`409 VIDEO_ON_HOLD`), ghi nhật ký audit | `VideoAccessAndRangeTests`, `RetentionAndDeletionWorkflowTests` (`retention.skipped_hold`), `videoLibraryAndDetail.test.tsx`, `permissionsAndHoldProtection.spec.ts` | **PASS** |
| **19** | Chế độ `LocalDevelopment` | UI hiển thị rõ **"Chế độ thử nghiệm — lưu local"** và **"Đã lưu cục bộ (Local)"**, không bao giờ tự nhận là NAS thật | `authGuardsAndFlows.test.tsx`, `videoLibraryAndDetail.test.tsx`, `authAndGovernance.spec.ts`, `recordUploadAndPlayback.spec.ts` | **PASS** |

---

## 3. Báo cáo Trung thực Các Hạng mục Chưa Thể Kiểm chứng Vật lý Tại Môi trường Phát triển

Tuân thủ nguyên tắc minh bạch kỹ thuật (không mô phỏng rồi ghi nhận như đã test phần cứng thật):

1. **Thiết bị NAS Synology vật lý & DSM / SMB Mount thực tế**:
   - Đã kiểm chứng đầy đủ logic `SynologyMounted` (kiểm tra marker `.packingproof-storage-id`, không tự tạo thư mục gốc khi rớt mount, ghi `.partial` -> flush -> đọc lại kiểm tra `SHA-256` -> atomic rename, crash reconciliation, hash conflict) trên filesystem cục bộ giả lập điểm mount.
   - **Chưa kiểm chứng trực tiếp** trên phần cứng Synology thật qua giao thức SMB3/NFS/Container Manager vì chưa có thiết bị NAS vật lý và thông tin kết nối trong môi trường hiện tại.
2. **Khởi chạy Live Docker Containers (`docker compose up`)**:
   - Đã cài đặt `Docker CLI 29.8.2` & `Docker Compose v5.6.0` và đã chạy kiểm chứng thành công cú pháp `docker compose --env-file .env.example -f deploy/docker-compose.yml config`.
   - **Chưa khởi chạy container sống** tại thời điểm chạy test vì tiến trình nền `Docker Desktop Linux Engine` trên máy Windows hiện đang tắt (`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`). Toàn bộ Backend API, Worker, PostgreSQL 18.4, `ffprobe`, `FFmpeg` và giao diện bản build Production đã được chạy sống trực tiếp trên tiến trình host trong bộ kiểm thử Integration & Playwright E2E.
3. **Điện thoại Vật lý (Chrome trên Android & Safari trên iPhone)**:
   - Bộ Playwright E2E sử dụng khung nhìn di động `390x844` kết hợp camera giả của Chromium (`--use-fake-device-for-media-stream`) và luồng canvas QR để kiểm chứng luồng logic trình duyệt, **không thay thế** kiểm chứng phần cứng camera điện thoại thật.
   - Các hành vi đặc thù phần cứng di động — bao gồm lấy nét ống kính cam sau trên tem vận đơn nhiệt thực tế, hỗ trợ đèn flash (`torch`), bitrate/nhiệt độ khi quay liên tục 5–10 phút, cuộc gọi GSM/Zalo chen ngang, khóa màn hình vật lý, chuyển ứng dụng ra nền trên iOS Safari / Android Chrome và phát lại chéo thiết bị — **bắt buộc phải thực hiện nghiệm thu thực địa** theo bảng hướng dẫn chi tiết tại [`docs/manual-device-checklist.md`](manual-device-checklist.md) ngay sau khi dựng HTTPS trên mạng kho.

---

## 4. Danh sách Thông số Thực tế Cần Doanh nghiệp Cung cấp Trước Khi Triển khai Production

Để chuyển từ cấu hình `LocalDevelopment` sang vận hành chính thức (`SynologyMounted`), quản trị viên hạ tầng cần chốt và điền **một lần** các thông số sau vào cấu hình triển khai (`.env` / IIS Environment):

1. **Thông tin phần cứng NAS Synology**: Model thiết bị (ví dụ `DS923+` hay dòng `J/Value`), phiên bản `DSM`, dung lượng RAM/ổ đĩa trống để chốt **Phương án A** (chạy trực tiếp trên *Synology Container Manager*) hay **Phương án B** (chạy trên máy chủ Linux / Windows Server IIS riêng nối SMB/UNC vào NAS).
2. **Đường dẫn lưu trữ & Định danh NAS**: Địa chỉ IP nội bộ / Hostname của NAS, tên Shared Folder dành riêng cho video (ví dụ `PackingVideos`), tài khoản dịch vụ NAS tối thiểu quyền (`svc_packingproof_nas`), và chuỗi định danh `STORAGE_ID` khớp với nội dung file `.packingproof-storage-id` đặt trên gốc share.
3. **Tên miền & Chứng chỉ HTTPS cho Điện thoại**: Tên miền truy cập tại kho (ví dụ `packing.congty.vn`) và phương thức cấp chứng chỉ TLS được Chrome Android / Safari iPhone tin cậy (Let's Encrypt DNS-01/HTTP-01 hoặc Internal Root CA cài lên máy kho).
4. **Danh mục Shop, Kho & Dòng điện thoại thực tế tại bàn đóng gói**: Mã/tên các Shop TikTok, danh sách Kho đóng gói tương ứng (cấu hình thư mục con được phép trên trang `/admin/storage`), các mẫu tem vận chuyển thực tế đang dùng để bổ sung rule parser nếu có mẫu tem đặc thù, và hệ điều hành/trình duyệt của điện thoại nhân viên kho.
5. **Chính sách vận hành & Khôi phục**: Email/mật khẩu khởi tạo `SuperAdmin` đầu tiên (`INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` — xóa mật khẩu khỏi env sau lần đăng nhập đầu và bật 2FA), cấu hình máy chủ `SMTP_*` (nếu muốn gửi email đặt lại mật khẩu tự động thay cho luồng Admin cấp mã nội bộ), và quyết định có bật tự động xóa video cũ (`RETENTION_ENABLED` / `RETENTION_DAYS`) hay giữ tắt mặc định.
