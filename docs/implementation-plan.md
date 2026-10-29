# Kế hoạch triển khai chi tiết — PackingProof Web

> Tài liệu này quy định lộ trình xây dựng **PackingProof Web** qua 5 giai đoạn. Mỗi tác vụ chỉ rõ **File/Module**, **Interface/Contract chính** và **Kiểm thử chứng minh kết quả**, đối chiếu trực tiếp với 19 kịch bản nghiệm thu bắt buộc.

---

## Khảo sát môi trường thực tế trên máy phát triển

| Thành phần | Trạng thái trên máy | Cách sử dụng trong kế hoạch |
| --- | --- | --- |
| .NET 10 LTS SDK | Đã cài `10.0.301` (`AspNetCore.App 10.0.11`) | Target `net10.0` cho toàn bộ solution `PackingProof.slnx` |
| Node.js & npm | Đã cài `Node v24.16.0`, `npm 11.13.0` | Xây dựng frontend React + TypeScript + Vite, Vitest và Playwright |
| PostgreSQL | Dịch vụ `postgresql-x64-18` đang chạy (`psql.exe` tại `C:\Program Files\PostgreSQL\18\bin`) | Dùng cho dev/integration test khi có cấu hình `DATABASE_CONNECTION`, kết hợp Docker Compose PostgreSQL 18 |
| Docker & Compose | Đã cài `Docker 29.8.2`, `Compose v5.6.0` (daemon hiện đang tắt) | Cung cấp `deploy/docker-compose.yml` đầy đủ; bật Docker Desktop khi test container |
| FFmpeg & ffprobe | Đã cài `9.0-full_build` trong `PATH` | Kiểm thử thật `FfprobeMediaInspector` và `FfmpegPreviewTranscoder` bằng file media thật |

---

## Giai đoạn 1 — Nền tảng, Cơ sở dữ liệu, Xác thực và Phân quyền theo Scope

### Task 1.1: Khởi tạo cấu trúc Repository, Cấu hình môi trường và Domain Core
- **File / Module**:
  - `.gitignore`, `.env.example`, `backend/PackingProof.slnx`
  - `backend/src/PackingProof.Core/Permissions/PermissionCatalog.cs`
  - `backend/src/PackingProof.Core/Entities/{ApplicationUser,ApplicationRole,UserScopeGrant,Shop,Warehouse,PackingStation,Recording,UploadSession,VideoAsset,ProcessingJob,VideoNote,DeletionRequest,StorageProfile,AuditEvent}.cs`
  - `backend/src/PackingProof.Core/Enums/{ApprovalStatus,ScopeType,CaptureStatus,StorageStatus,PreviewStatus,RecordingSource,AssetKind,ProcessingJobType}.cs`
  - `backend/src/PackingProof.Core/Abstractions/{IScopeAuthorizationService,IGrantCeilingValidator,IAuditLogger,IOrderLinkResolver}.cs`
- **Interface / Contract chính**:
  - `PermissionCatalog.All`: danh mục cố định 14 quyền (`recording.create`, `recording.manual_code`, `video.upload`, `video.import`, `video.view`, `video.download`, `video.note`, `video.hold`, `video.delete.request`, `video.delete.approve`, `user.manage`, `role.manage`, `storage.manage`, `audit.view`).
  - `IScopeAuthorizationService.HasPermissionAsync(ClaimsPrincipal user, string permission, ResourceScopeContext resource, CancellationToken ct)`
  - `IGrantCeilingValidator.ValidateRoleAssignmentAsync(Guid actorUserId, Guid targetUserId, Guid roleId, ScopeType scopeType, Guid? shopId, Guid? warehouseId, CancellationToken ct)`
  - `IOrderLinkResolver.ResolveAsync(Guid shopId, string trackingNumber, CancellationToken ct)` (No-op adapter mặc định, mở rộng cho DTD Commerce sau này).
- **Kiểm thử chứng minh kết quả**:
  - `PackingProof.UnitTests/Authorization/GrantCeilingValidatorTests.cs`:
    - Chứng minh `Admin` thuộc `ShopA` không thể tự cấp `SuperAdmin`, không thể cấp quyền ở `ShopB` hoặc scope `All`, không thể cấp quyền nằm ngoài tập quyền của mình.
    - Chứng minh không thể xóa, khóa hoặc hạ quyền `SuperAdmin` hoạt động cuối cùng.

### Task 1.2: EF Core PostgreSQL DbContext, Migrations & Bootstrap SuperAdmin an toàn
- **File / Module**:
  - `backend/src/PackingProof.Infrastructure/Persistence/PackingProofDbContext.cs`
  - `backend/src/PackingProof.Infrastructure/Persistence/Configurations/*.cs`
  - `backend/src/PackingProof.Infrastructure/Persistence/Migrations/*`
  - `backend/src/PackingProof.Infrastructure/Identity/SystemSeeder.cs`
  - `backend/src/PackingProof.Infrastructure/Auditing/AuditLogger.cs`
- **Interface / Contract chính**:
  - Ràng buộc DB: `UX_VideoAssets_RecordingId_Kind`, `UX_UploadSessions_TusResourceId`, non-unique index `(ShopId, TrackingNumber)`, PostgreSQL `xmin` concurrency token trên `Recording`.
  - `SystemSeeder.SeedAsync()`: khởi tạo 14 permissions, 6 vai trò mặc định (`SuperAdmin`, `Admin`, `Manager`, `Operator`, `Viewer`, `Auditor`), shop/kho mặc định khi cấu hình local, và chỉ tạo `SuperAdmin` đầu tiên khi có `INITIAL_ADMIN_EMAIL` + `INITIAL_ADMIN_PASSWORD` hợp lệ từ biến môi trường (tuyệt đối không hardcode mật khẩu trong source).
  - `AuditLogger`: chỉ hỗ trợ `AppendAsync`, tự động lọc bỏ các khóa nhạy cảm (`password`, `token`, `cookie`, `secret`, `authorization`, `qrRawPayload`).
- **Kiểm thử chứng minh kết quả**:
  - `PackingProof.UnitTests/Auditing/AuditScrubberTests.cs`: chứng minh mật khẩu, cookie, reset token không bao giờ lọt vào `MetadataJson`.
  - `PackingProof.IntegrationTests/Persistence/DatabaseConstraintsTests.cs`: chứng minh cùng một `TrackingNumber` tạo được nhiều `Recording`, nhưng một `RecordingId` không thể có 2 `VideoAsset` cùng `Kind = Original`.

### Task 1.3: Auth API, Cookie + CSRF, TOTP 2FA, Thu hồi phiên tức thì & Resource Authorization
- **File / Module**:
  - `backend/src/PackingProof.Api/Security/{ImmediateCookieEvents,CsrfEndpoints,PermissionAuthorizationHandler}.cs`
  - `backend/src/PackingProof.Api/Features/Auth/{AuthController,MfaController,PasswordResetService}.cs`
  - `backend/src/PackingProof.Api/Features/Health/HealthEndpoints.cs`
- **Interface / Contract chính**:
  - Endpoints: `GET /api/auth/csrf`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, `POST /api/auth/mfa/setup`, `POST /api/auth/mfa/verify`, `POST /api/auth/mfa/Challenge`.
  - `GET /health/live` & `GET /health/ready` (public chỉ trả `{ status: "Healthy" | "Unhealthy" }`, chi tiết storage/DB chỉ hiển thị khi user có quyền `storage.manage`).
  - `ImmediateCookieEvents.ValidatePrincipal`: kiểm tra `SecurityStamp` + `ApprovalStatus == Active` + trạng thái khóa trên **mọi HTTP request** (bao gồm `tus` và `/stream`).
  - Luồng reset mật khẩu kép: qua `IEmailSender` khi cấu hình SMTP, hoặc qua lệnh khởi tạo đặt lại có kiểm soát của Admin (`POST /api/admin/users/{id}/initiate-password-reset`) có ghi audit, không in token ra log production.
- **Kiểm thử chứng minh kết quả**:
  - `PackingProof.IntegrationTests/Auth/RegistrationAndApprovalTests.cs`: tài khoản mới đăng ký luôn ở `PendingApproval`, gọi mọi API nghiệp vụ đều nhận `403`, không thể gửi tham số role/shop lúc đăng ký để tự kích hoạt.
  - `PackingProof.IntegrationTests/Auth/ImmediateRevocationTests.cs`: khi Admin khóa tài khoản, đổi role/scope hoặc bấm thu hồi phiên, request kế tiếp bằng cookie đang mở bị từ chối `401/403` ngay lập tức.
  - `PackingProof.IntegrationTests/Auth/PrivilegeEscalationTests.cs`: `Viewer` gọi trực tiếp API tạo phiên/upload/download/delete bị từ chối `403`; `Admin` cố nâng quyền lên `SuperAdmin` bị từ chối `403` và sinh bản ghi `AuditEvent(Outcome = Denied)`.

### Task 1.4: Khởi tạo Frontend App Shell, Auth Flows & Layout Responsive
- **File / Module**:
  - `frontend/package.json`, `frontend/vite.config.ts` (proxy `/api` & `/health` cùng origin)
  - `frontend/src/app/{apiClient.ts,authStore.ts,router.tsx,AppLayout.tsx,StorageModeBanner.tsx}`
  - `frontend/src/features/auth/{LoginPage.tsx,RegisterPage.tsx,PendingApprovalPage.tsx,ResetPasswordPage.tsx,MfaSetupModal.tsx}`
- **Interface / Contract chính**:
  - `apiClient`: tự động đính kèm `X-CSRF-Token` cho các request thay đổi dữ liệu; bắt lỗi `401 SessionExpired` để phát tín hiệu tạm dừng upload mà không xóa dữ liệu IndexedDB.
  - `StorageModeBanner`: hiển thị rõ badge **"Chế độ thử nghiệm — lưu local"** khi backend chạy `STORAGE_MODE=LocalDevelopment`.
  - Thiết kế sáng (Navy `#0F172A` / Cyan `#0891B2`), ưu tiên khung nhìn `360–430px`, kích thước nút chạm tối thiểu `44px`, hỗ trợ `env(safe-area-inset-*)`.
- **Kiểm thử chứng minh kết quả**:
  - `frontend/tests/auth/authGuards.test.tsx`: kiểm chứng hiển thị đúng màn hình `Chờ duyệt` cho user `PendingApproval`, hiển thị badge `LocalDevelopment` và cảnh báo khi đăng xuất lúc còn bản ghi chờ upload.

---

## Giai đoạn 2 — Quét mã vận đơn, Quản lý Camera, Quay Web và Lưu tạm IndexedDB

### Task 2.1: Parser mã vận đơn có khả năng mở rộng & API Phiên quay
- **File / Module**:
  - `backend/src/PackingProof.Core/Tracking/{ITrackingCodeParser,TrackingCodeParser,PathSegmentSanitizer}.cs`
  - `backend/src/PackingProof.Api/Features/Recordings/RecordingsController.cs`
  - `frontend/src/features/recording/trackingParser.ts`
- **Interface / Contract chính**:
  - `ITrackingCodeParser.Parse(string rawInput, BarcodeFormatHint? formatHint)`:
    - Giữ nguyên chuỗi gốc, giữ số `0` ở đầu (`"00394812"`), giữ nguyên chữ hoa/thường, giới hạn `<= 128` ký tự.
    - Từ chối ký tự điều khiển, `/`, `\`, `..`, chuỗi rỗng hoặc vượt độ dài.
    - Với QR chứa URL (`http://`, `https://`) hoặc payload phức hợp: chỉ trích xuất nếu khớp mẫu JSON/key-value nhà vận chuyển đã đăng ký; ngược lại trả lỗi `UNRECOGNIZED_QR_PAYLOAD`, **tuyệt đối không đoán mã và không gửi HTTP request tới URL trong QR**.
  - `POST /api/recordings`: kiểm tra quyền `recording.create` (và `recording.manual_code` + bắt buộc `manualEntryReason` + ghi audit nếu `isManualEntry = true`), kiểm tra scope `ShopId`/`WarehouseId`, trả về `RecordingId` UUID + `existingVideosCount` (cảnh báo nếu mã vận đơn đã có video trước đó nhưng không chặn quay mới).
  - `POST /api/recordings/{id}/events` (`started`, `captured`, `interrupted`, `cancelled`): xác thực chuyển trạng thái `CaptureStatus` hợp lệ; mã vận đơn bị khóa bất biến từ lúc tạo phiên.
- **Kiểm thử chứng minh kết quả**:
  - `PackingProof.UnitTests/Tracking/TrackingCodeParserTests.cs` & `frontend/tests/recording/trackingParser.test.ts`:
    - Mã bắt đầu bằng `0` không bị mất số `0`.
    - QR chứa URL bất kỳ bị từ chối đúng lỗi, không suy đoán mã, không tạo outbound request.
    - Mã chứa `../`, `..\`, `%2e%2e`, null byte, shell metacharacters bị từ chối ở parser và `PathSegmentSanitizer` không bao giờ thoát khỏi storage root.
  - `PackingProof.IntegrationTests/Recordings/RecordingSessionLifecycleTests.cs`:
    - Chưa có mã hợp lệ hoặc thiếu quyền `recording.manual_code` khi nhập tay -> từ chối `400/403`.
    - Hai lần quay cùng mã vận đơn hoặc hai người quay đồng thời -> tạo 2 `RecordingId` riêng biệt, trả đúng `existingVideosCount`, không ghi đè.

### Task 2.2: Kho lưu tạm IndexedDB cô lập theo User & Tuần tự hóa Chunk
- **File / Module**:
  - `frontend/src/features/upload-queue/db/{packingProofIdb.ts,serializedChunkWriter.ts,storageQuotaMonitor.ts}`
- **Interface / Contract chính**:
  - Object stores trong IndexedDB (`packing_proof_local_v1`):
    - `recordings`: key `recordingId`, index `by_owner` (`ownerUserId`), lưu manifest (`ownerUserId`, `shopId`, `warehouseId`, `trackingNumber`, `mimeType`, `captureStatus`, `localSyncState`, `chunkCount`, `totalBytes`, `uploadSessionId?`, `tusUploadUrl?`, `createdAt`, `updatedAt`). Không lưu mật khẩu/token.
    - `chunks`: composite key `[recordingId, seq]`, index `by_recording`, lưu `{ recordingId, seq, ownerUserId, data: ArrayBuffer, byteLength }`.
  - `SerializedChunkWriter`: nối chuỗi transaction `appendChunk(seq, blob)` tuần tự, đợi `tx.oncomplete` trước khi resolve; `finalizeManifest()` chờ toàn bộ chunk cuối commit xong rồi tính tổng `byteLength` thực tế.
  - `storageQuotaMonitor`: gọi `navigator.storage.estimate()` + `navigator.storage.persist()`, bắt `QuotaExceededError` rõ ràng, kiểm tra giới hạn `MAX_LOCAL_PENDING_RECORDINGS` (mặc định 3).
  - Khôi phục sau crash/đóng tab: khi mở lại app, `reconcileUnfinishedSessions(currentUserId)` chuyển mọi bản ghi đang kẹt ở `Recording` sang `Interrupted` (không bao giờ tự gắn nhãn `Captured` hoàn chỉnh).
- **Kiểm thử chứng minh kết quả**:
  - `frontend/tests/upload-queue/serializedChunkWriter.test.ts` (dùng `fake-indexeddb`):
    - Ghi 20 chunks liên tiếp + bấm Stop: đảm bảo đủ chunk cuối cùng, đúng thứ tự `seq 0..19`, đúng tổng byte thực tế.
    - Giả lập `QuotaExceededError` giữa chừng và trường hợp IndexedDB bị xóa rỗng: báo lỗi rõ trạng thái, không hứa khôi phục khi bytes đã mất.
    - Cô lập đa tài khoản: `User A` tạo bản ghi chờ -> đăng xuất -> `User B` đăng nhập trên cùng trình duyệt không nhìn thấy, không upload và không chiếm quyền bản ghi của `User A`.
    - Giả lập crash/reload khi đang quay (`status = Recording`): lần tải trang kế tiếp đánh dấu `Interrupted`, thông báo bản ghi bị gián đoạn.

### Task 2.3: Quản lý Camera đơn luồng, Quét `@zxing/browser`, `MediaRecorder` & Màn hình Quay
- **File / Module**:
  - `frontend/src/features/recording/{PreFlightChecker.ts,ScannerController.ts,RecorderController.ts,useWakeLock.ts,RecordingPage.tsx}`
- **Interface / Contract chính**:
  - `PreFlightChecker`: kiểm tra `window.isSecureContext`, quyền camera, `MediaRecorder.isTypeSupported` theo thứ tự ưu tiên codec, dung lượng lưu tạm và số bản ghi đang chờ.
  - `ScannerController`: dùng `BrowserMultiFormatReader` (`@zxing/browser`), chống nhận lặp cùng một mã liên tục (debounce theo mã + cửa sổ thời gian), hỗ trợ đổi camera và bật đèn flash (`torch`) chỉ khi `track.getCapabilities().torch === true`. Dừng hoàn toàn decoder trước khi chuyển sang `RecorderController`.
  - `RecorderController`: ưu tiên `1080p@30fps` -> fallback `720p@30fps`; mặc định tắt mic (`audio: false`), nếu cấu hình bật mic mà thiết bị từ chối quyền mic thì tự động fallback quay không tiếng; chỉ chuyển UI sang **Đang quay** khi sự kiện `MediaRecorder.onstart` phát sinh; không có nút tạm dừng; tự động cảnh báo ở 90% và kết thúc có kiểm soát khi chạm `MAX_RECORDING_SECONDS` (10 phút) hoặc `MAX_UPLOAD_BYTES` (512 MiB).
  - Xử lý gián đoạn (`visibilitychange`, `pagehide`, `track.onended`, `track.onmute`, `recorder.onerror`): dừng bộ đếm thời gian ngay lập tức, chốt các chunk còn hợp lệ vào IndexedDB, chuyển trạng thái sang `Interrupted` và gửi sự kiện lên server khi có mạng.
- **Kiểm thử chứng minh kết quả**:
  - `frontend/tests/recording/recordingStateMachine.test.ts`:
    - Không thể bấm `Bắt đầu quay` khi chưa có `RecordingId` hợp lệ từ backend.
    - Trạng thái `Đang quay` chỉ kích hoạt sau `MediaRecorder.onstart`; khi `track.onended` xảy ra giữa chừng, bộ đếm dừng ngay và chuyển sang `Interrupted`.
    - Đảm bảo `ScannerController.stop()` luôn được gọi trước khi `MediaRecorder.start()` chạy.

---

## Giai đoạn 3 — Resumable Upload (`tus`), Staging bền vững, Worker và Lưu trữ Synology

### Task 3.1: `tusdotnet` Endpoint có xác thực/phân quyền đầy đủ & Upload Session Idempotent
- **File / Module**:
  - `backend/src/PackingProof.Api/Features/Uploads/{UploadSessionsController.cs,TusConfigurationFactory.cs}`
  - `backend/src/PackingProof.Infrastructure/Uploads/{StagingQuotaGuard.cs,RecordingUploadCoordinator.cs}`
- **Interface / Contract chính**:
  - `POST /api/recordings/{id}/upload-session`: idempotent theo `RecordingId`; xác thực người gọi chính là `OwnerUserId`, có quyền `video.upload` trong scope `ShopId/WarehouseId`, kiểm tra dung lượng trống vùng `STAGING_ROOT_PATH` so với `STAGING_MAX_BYTES`; trả về `UploadSessionId`, `MaxUploadBytes`, `RecommendedChunkBytes` (5 MiB) và trạng thái hiện tại.
  - `/api/uploads` (`tusdotnet`):
    - Xác thực cookie + `ImmediateCookieEvents` + kiểm tra quyền + CSRF trên **mọi method** (`POST`, `HEAD`, `PATCH`, `DELETE`).
    - Bỏ qua mọi đường dẫn/owner/role do client gửi trong `Upload-Metadata`; chỉ lấy `RecordingId` và `UploadSessionId` đã đối chiếu khớp với phiên của user đang đăng nhập.
    - Giới hạn kích thước cứng `MAX_UPLOAD_BYTES`.
    - `OnFileCompleteAsync`: cập nhật `StorageStatus = Validating` (**chưa phải `Stored`**) và enqueue idempotent `ProcessingJob(ValidateAndStoreOriginal)` trong PostgreSQL.
- **Kiểm thử chứng minh kết quả**:
  - `PackingProof.IntegrationTests/Uploads/TusSecurityAndResumeTests.cs`:
    - Upload bị ngắt giữa chừng ở 40% -> gọi `HEAD /api/uploads/{tusId}` trả đúng `Upload-Offset` thực tế -> `PATCH` phần còn lại hoàn tất file khớp byte-for-byte.
    - `User A` tạo tus upload URL -> `User B` gọi `HEAD`, `PATCH` hoặc `DELETE` vào tus URL đó bị từ chối `403`.
    - `POST /api/uploads` không có `UploadSession` hợp lệ (cố bỏ qua bước tạo phiên quay) hoặc vượt `STAGING_MAX_BYTES` bị từ chối.
    - Gọi lặp `POST /api/recordings/{id}/upload-session` hoặc callback hoàn tất lặp không sinh hai `ProcessingJob` hay hai asset.

### Task 3.2: `IVideoStorage` (`LocalDevelopment` & `SynologyMounted`), Kiểm tra Media `ffprobe` & Worker bền vững
- **File / Module**:
  - `backend/src/PackingProof.Core/Storage/{IVideoStorage,IMediaInspector,IPreviewTranscoder}.cs`
  - `backend/src/PackingProof.Infrastructure/Storage/{FileSystemVideoStorage.cs,StoragePathBuilder.cs}`
  - `backend/src/PackingProof.Infrastructure/Media/{FfprobeMediaInspector.cs,FfmpegPreviewTranscoder.cs}`
  - `backend/src/PackingProof.Infrastructure/Workers/ProcessingJobWorker.cs`
- **Interface / Contract chính**:
  - `StoragePathBuilder.BuildRelativePath(string shopSlug, DateTime utcTimestamp, string trackingNumber, Guid recordingId, string extension)`: tạo đường dẫn `<ShopSlug>/<yyyy>/<MM>/<dd>/<SafeTracking>/<SafeTracking>_<RecordingId>.<ext>` theo múi giờ `Asia/Ho_Chi_Minh`.
  - `FileSystemVideoStorage`:
    - Ở chế độ `SynologyMounted`: bắt buộc kiểm tra file `.packingproof-storage-id` tại `NAS_ROOT_PATH` khớp `STORAGE_ID` và quyền đọc/ghi trước mọi thao tác. Nếu mất mount, ném lỗi `STORAGE_MOUNT_MISSING` (`Retryable = true`), **không tự tạo thư mục local thay thế**.
    - Ghi stream vào `<target>.<lease>.partial` trên share đích -> `Flush(true)` -> mở đọc lại kiểm tra đúng kích thước và tính lại `SHA-256` -> rename nguyên tử sang `<target>`.
    - Đối chiếu khi `<target>` đã tồn tại: cùng `SHA-256` thì reconcile thành công; khác `SHA-256` thì báo lỗi `STORAGE_CONFLICT` (`Retryable = false`), không ghi đè.
  - `FfprobeMediaInspector`: chạy `ffprobe` qua `ProcessStartInfo.ArgumentList` (không qua shell), xác minh container thật, có video stream hợp lệ, đọc codec/thời lượng/kích thước khung hình.
  - `ProcessingJobWorker`: claim job bằng PostgreSQL `FOR UPDATE SKIP LOCKED` kèm `LeaseOwner` + `LeaseExpiresAtUtc`, retry exponential backoff khi NAS tạm lỗi, giữ nguyên file staging cho tới khi `Stored`.
- **Kiểm thử chứng minh kết quả**:
  - `PackingProof.IntegrationTests/Storage/SynologyStorageAndWorkerTests.cs`:
    - Upload file văn bản/binary giả đổi đuôi `.mp4` hoặc `.webm` -> `ffprobe` bác bỏ, `StorageStatus = Failed`, `ErrorCode = INVALID_MEDIA_CONTAINER`, không copy sang NAS.
    - Chế độ `SynologyMounted` mất file marker `.packingproof-storage-id` hoặc mất quyền ghi -> không đánh dấu `Stored`, giữ nguyên file ở staging, khi khôi phục marker thì worker retry và commit thành công.
    - Giả lập server crash ngay sau khi file đã commit lên NAS nhưng trước khi DB lưu `VideoAsset`: khi worker chạy lại, phát hiện file đích cùng `RecordingId` + khớp `SHA-256`, reconcile sang `Stored` mà không ghi đè hay báo lỗi.
    - Giả lập file đích tồn tại sẵn nhưng khác `SHA-256`: báo `STORAGE_CONFLICT`, tuyệt đối không ghi đè file cũ.

### Task 3.3: Hàng đợi Upload Frontend (`tus-js-client`), Khôi phục sau Reload & Xử lý hết hạn phiên
- **File / Module**:
  - `frontend/src/features/upload-queue/{TusQueueManager.ts,IndexedDbTusFileSource.ts,UploadQueuePage.tsx}`
- **Interface / Contract chính**:
  - `TusQueueManager`: chỉ chạy 1 upload chính tại một thời điểm trên mỗi thiết bị, cho phép quay đơn tiếp theo song song nếu hàng đợi `<= MAX_LOCAL_PENDING_RECORDINGS`; dùng HTTP chunk `5 MiB` tách biệt với kích thước chunk `MediaRecorder`.
  - Khi reload trang hoặc có lại Wi-Fi: nạp các bản ghi chờ của đúng `currentUserId` từ IndexedDB, truy vấn offset thật từ server qua `tus` `HEAD`, tiếp tục từ đúng byte offset.
  - Khi cookie hết hạn (`401`): tạm dừng hàng đợi, hiển thị thông báo yêu cầu đăng nhập lại đúng tài khoản, giữ nguyên toàn bộ bytes trong IndexedDB, tiếp tục upload sau khi đăng nhập lại mà không tạo phiên trùng.
  - Hiển thị tách bạch: `Đang tải lên (X%)` -> `Đã nhận trên máy chủ — đang xác minh` -> `Đã lưu NAS` (hoặc `Đã lưu cục bộ (Local)` khi `LocalDevelopment`); chỉ xóa chunks IndexedDB khi server trả về `StorageStatus == Stored`.
- **Kiểm thử chứng minh kết quả**:
  - `frontend/tests/upload-queue/tusQueueRecovery.test.ts`:
    - Mất mạng ở giữa quá trình upload -> giữ nguyên chunks, khi mạng khôi phục lấy offset từ `HEAD` thay vì phần trăm cũ.
    - Reload trình duyệt khi đang upload -> cùng user khôi phục lại `UploadSession` và tiếp tục; không xóa chunks IndexedDB khi mới xong `tus` mà server chưa báo `Stored`.
    - Nhận `401` giữa chừng -> tạm dừng an toàn, không xóa dữ liệu cục bộ.

---

## Giai đoạn 4 — Tra cứu, Phát Video Range, Quản trị, Phân quyền và Audit

### Task 4.1: API Danh sách, Phát Video `HTTP Range`, Download riêng quyền, Ghi chú, Hold & Luồng duyệt xóa
- **File / Module**:
  - `backend/src/PackingProof.Api/Features/Videos/{VideosController.cs,VideoNotesController.cs,VideoDeletionController.cs}`
  - `backend/src/PackingProof.Api/Features/Dashboard/DashboardController.cs`
- **Interface / Contract chính**:
  - `GET /api/videos`: phân trang bắt buộc, áp dụng bộ lọc scope (`Own`/`Warehouse`/`Shop`/`All`) ngay trong truy vấn SQL trước khi trả dữ liệu; lọc theo mã vận đơn (chính xác hoặc một phần), khoảng ngày, shop/kho, người quay, trạng thái, `Hold`, `Source`.
  - `GET /api/videos/{id}/stream`: yêu cầu `video.view` trong scope; trả stream qua `FileStreamResult(..., enableRangeProcessing: true)` hỗ trợ đầy đủ `HTTP 206 Partial Content` & `Accept-Ranges: bytes`; ưu tiên asset `Preview` nếu `PreviewStatus == Ready` và trình duyệt yêu cầu bản tương thích, hoặc `Original`; nếu file trên NAS tạm thời không đọc được thì trả `503 STORAGE_TEMPORARILY_UNAVAILABLE` (không âm thầm phát file staging chưa xác minh). Không bao giờ lộ đường dẫn vật lý NAS xuống client.
  - `GET /api/videos/{id}/download`: yêu cầu quyền riêng `video.download` trong scope (`Viewer` bị chặn `403`).
  - `POST /api/videos/{id}/notes` (`video.note`), `PUT /api/videos/{id}/hold` (`video.hold`).
  - `POST /api/videos/{id}/deletion-requests` (`video.delete.request`) & `POST /api/deletion-requests/{requestId}/approve` (`video.delete.approve`): từ chối ngay nếu `Recording.Hold == true`; khi duyệt thực hiện soft-delete trước và ghi đầy đủ `AuditEvent`.
  - tùy chọn `POST /api/recordings/import`: chỉ mở khi user có quyền `video.import` (mặc định tắt), bắt buộc gắn `Source = Imported`.
- **Kiểm thử chứng minh kết quả**:
  - `PackingProof.IntegrationTests/Videos/VideoAccessAndRangeTests.cs`:
    - `User A` cố đọc `/api/videos/{id}/stream` (kể cả gửi header `Range: bytes=0-1023`), `/download` hoặc chi tiết video của `User B` ngoài scope -> bị từ chối `403/404`.
    - `Viewer` xem được stream trong scope (`206 Partial Content` hoạt động đúng byte range) nhưng gọi `/api/videos/{id}/download` hoặc `/deletion-requests` bị chặn `403`.
    - Video đang bật `Hold = true`: cả yêu cầu xóa, duyệt xóa và job tự động dọn dẹp theo thời hạn (`Retention`) đều giữ nguyên video và ghi nhật ký audit quyết định từ chối.

### Task 4.2: API Quản trị Tài khoản, Vai trò tùy chỉnh, Cấu hình Storage & Nhật ký Audit
- **File / Module**:
  - `backend/src/PackingProof.Api/Features/Admin/{AdminUsersController.cs,AdminRolesController.cs,AdminStorageController.cs,AdminAuditController.cs}`
  - `backend/src/PackingProof.Infrastructure/Workers/RetentionCleanupService.cs`
- **Interface / Contract chính**:
  - `/api/admin/users`: duyệt tài khoản `PendingApproval`, khóa/mở khóa, gán/thu hồi `UserScopeGrant`, thu hồi phiên đăng nhập tức thì, khởi tạo đặt lại mật khẩu có kiểm soát. Tất cả đi qua `IGrantCeilingValidator`.
  - `/api/admin/roles` & `/api/admin/permissions`: xem ma trận quyền, tạo/cập nhật role tùy chỉnh từ 14 permissions cố định trong giới hạn grant ceiling của người thao tác.
  - `/api/admin/storage`: xem chế độ `STORAGE_MODE`, danh sách thư mục con cho phép theo Shop, nút kiểm tra kết nối thực tế (`IVideoStorage.CheckHealthAsync`), cảnh báo dung lượng staging/NAS, bật/tắt `Retention` (mặc định TẮT, yêu cầu cờ xác nhận tường minh).
  - `/api/admin/audit`: truy vấn nhật ký `AuditEvents` có bộ lọc trong phạm vi scope được cấp; không có bất kỳ API sửa hay xóa nhật ký nào (kể cả cho `SuperAdmin`).
- **Kiểm thử chứng minh kết quả**:
  - `PackingProof.IntegrationTests/Admin/AdminGovernanceTests.cs`:
    - Kiểm chứng `SuperAdmin` cũng không có endpoint sửa/xóa `AuditEvents`.
    - Kiểm chứng `Admin` của `ShopA` chỉ thấy và quản lý user/audit trong `ShopA`, không thấy dữ liệu `ShopB`.

### Task 4.3: Hoàn thiện 10 Màn hình Giao diện Tiếng Việt (Mobile-First & Desktop Table)
- **File / Module**:
  - `frontend/src/features/dashboard/DashboardPage.tsx`
  - `frontend/src/features/videos/{VideoListPage.tsx,VideoDetailPage.tsx}`
  - `frontend/src/features/admin/{UsersAdminPage.tsx,RolesAdminPage.tsx,StorageAdminPage.tsx,AuditLogPage.tsx}`
- **Interface / Contract chính**:
  - Đủ 10 nhóm màn hình theo yêu cầu: (1) Auth/Chờ duyệt/MFA, (2) Dashboard số liệu thật, (3) Quay đóng gói, (4) Hàng đợi upload, (5) Danh sách & tìm kiếm video, (6) Chi tiết & trình phát video (hiện rõ nguồn `Quay trên trình duyệt` vs `Tải tệp có sẵn`, cảnh báo rõ nếu phiên `Interrupted`), (7) Quản trị tài khoản, (8) Quản trị vai trò & ma trận quyền, (9) Cấu hình lưu trữ & kiểm tra kết nối, (10) Nhật ký audit.
  - Không tạo bất kỳ nút giả/không hoạt động nào (như chia sẻ link công khai hay đồng bộ TikTok).
- **Kiểm thử chứng minh kết quả**:
  - `frontend/tests/videos/videoDetailPermissions.test.tsx`: kiểm chứng nút Tải file gốc, Giữ lại (Hold), Yêu cầu xóa hiển thị đúng quyền nhưng backend vẫn là chốt chặn cuối; hiển thị cảnh báo rõ ràng cho video `Interrupted` và badge `LocalDevelopment`.

---

## Giai đoạn 5 — Chuyển mã Bản xem MP4, PWA App Shell, E2E, Triển khai & Nghiệm thu

### Task 5.1: Chuyển mã Bản xem MP4 (`FFmpeg`) độc lập với Bản gốc
- **File / Module**:
  - `backend/src/PackingProof.Infrastructure/Media/FfmpegPreviewTranscoder.cs`
  - `backend/src/PackingProof.Infrastructure/Workers/ProcessingJobWorker.cs` (nhánh `GeneratePreview`)
- **Interface / Contract chính**:
  - Nếu bản gốc đã là `mp4` với video `h264`: đặt `PreviewStatus = NotRequired`.
  - Nếu bản gốc là `webm` (`vp8`/`vp9`) hoặc codec cần bản tương thích Safari/đa thiết bị: giữ nguyên bản gốc + `SHA-256` riêng, đặt `PreviewStatus = Pending`, worker chuyển mã bằng `FFmpeg` (`libx264`, `yuv420p`, `+faststart`, `aac` nếu có audio) với giới hạn đồng thời `PROCESSING_CONCURRENCY`, lưu thành `VideoAsset(Kind = Preview)` trên storage thông qua cùng cơ chế `.partial` + verify hash + rename, rồi cập nhật `PreviewStatus = Ready`. Tuyệt đối không đổi tên `.webm` thành `.mp4`.
- **Kiểm thử chứng minh kết quả**:
  - `PackingProof.IntegrationTests/Media/PreviewTranscodingTests.cs`: tạo file video `.webm` thật bằng `ffmpeg`, đưa qua luồng upload -> xác nhận bản gốc `.webm` giữ nguyên hash, job `GeneratePreview` tạo ra file `_preview.mp4` thật có codec `h264` đọc được bằng `ffprobe`, `PreviewStatus = Ready`.

### Task 5.2: PWA App Shell an toàn
- **File / Module**:
  - `frontend/public/manifest.webmanifest`
  - `frontend/public/sw.js` (hoặc cấu hình Vite PWA giới hạn nghiêm ngặt phạm vi cache)
- **Interface / Contract chính**:
  - Chỉ cache tài nguyên tĩnh của App Shell (`index.html`, JS/CSS/icons cùng phiên bản).
  - Rule tường minh trong Service Worker: bỏ qua hoàn toàn (`return`) mọi request tới `/api/*`, `/health/*`, request `Range` hoặc stream media.
- **Kiểm thử chứng minh kết quả**:
  - `frontend/tests/pwa/serviceWorkerPolicy.test.ts`: chứng minh Service Worker không bao giờ lưu cache response từ `/api/*` hoặc `/api/videos/*/stream`.

### Task 5.3: Kiểm thử E2E Playwright (Camera giả), Cấu hình Docker Compose & Bộ Tài liệu Vận hành
- **File / Module**:
  - `e2e/playwright.config.ts`, `e2e/specs/{packingFlow.spec.ts,accessControl.spec.ts,interruptionAndResume.spec.ts}`
  - `deploy/{docker-compose.yml,Caddyfile,nginx.conf.example}`, `backend/Dockerfile`, `frontend/Dockerfile`
  - `README.md`, `docs/{permissions.md,deploy-synology.md,deploy-iis.md,manual-device-checklist.md,test-report.md,progress.md}`
- **Interface / Contract chính**:
  - `docker-compose.yml`: định nghĩa `postgres` (volume riêng, không đặt `PGDATA` lên SMB share), `backend` (healthcheck, volumes cho `staging`, `storage`, `dataprotection-keys`), `proxy` (Caddy/Nginx phục vụ frontend + reverse proxy `/api` cùng origin qua HTTPS, cấu hình header/timeout cho `tus`).
  - Tài liệu triển khai đầy đủ cho cả 2 kịch bản Synology (chạy trực tiếp trên Synology Container Manager với bind mount, hoặc chạy trên máy chủ Linux/Windows IIS riêng kết nối SMB/UNC bằng service identity kèm kiểm tra `STORAGE_ID`), hướng dẫn HTTPS/TLS tin cậy cho điện thoại, kế hoạch backup/restore PostgreSQL + Data Protection Keys + đối chiếu file NAS.
- **Kiểm thử chứng minh kết quả**:
  - Chạy toàn bộ `dotnet build`, `dotnet test`, `npm run typecheck`, `npm run lint`, `npm run test`, `npx playwright test`.
  - Tổng hợp trung thực toàn bộ kết quả chạy test tự động và danh mục phần cần thiết bị điện thoại thật / NAS Synology thật vào `docs/test-report.md`.

