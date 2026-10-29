# PackingProof Web — Hệ thống Quay Bằng chứng Đóng gói Đơn TikTok & Lưu trữ NAS Synology

**PackingProof Web** là ứng dụng web ưu tiên điện thoại (Mobile-First Web + PWA App Shell) cho phép nhân viên kho mở trình duyệt trên điện thoại qua HTTPS, quét mã vận đơn QR/Barcode trên tem đơn hàng TikTok, quay video quá trình đóng gói trực tiếp bằng camera điện thoại, lưu tạm tuần tự vào `IndexedDB`, tự động tải nối lại (`tus` resumable upload) lên máy chủ, kiểm định media bằng `ffprobe`, lưu trữ an toàn kèm kiểm tra `SHA-256` vào NAS Synology (hoặc thư mục cục bộ khi phát triển) và tạo bản xem MP4 (`H.264`/`AAC`) độc lập bằng `FFmpeg` khi cần.

---

## 1. Kiến trúc tổng quan & Phiên bản công nghệ đã kiểm chứng

Hệ thống sử dụng kiến trúc **Modular Monolith** gồm 1 dịch vụ API (`PackingProof.Api`) tích hợp worker xử lý nền bền vững qua PostgreSQL (`ProcessingJobWorker`), 1 cơ sở dữ liệu PostgreSQL và 1 giao diện SPA/PWA (`React + TypeScript + Vite`) chạy cùng origin qua HTTPS.

| Thành phần | Công nghệ / Thư viện | Phiên bản thực tế đã khóa (`lockfile`) |
| --- | --- | --- |
| Backend Runtime & SDK | ASP.NET Core / .NET 10 LTS | `.NET SDK 10.0.301` (`EF Core / Identity 10.0.14`) |
| Cơ sở dữ liệu | PostgreSQL + `Npgsql.EntityFrameworkCore.PostgreSQL` | `PostgreSQL 18.4` (`Npgsql 10.0.3`) |
| Resumable Upload | `tusdotnet` (Backend) / `tus-js-client` (Frontend) | `tusdotnet 2.12.0` / `tus-js-client 4.3.1` |
| Kiểm định & Chuyển mã Video | `ffprobe` & `FFmpeg` (`ProcessStartInfo.ArgumentList`) | `FFmpeg / ffprobe 9.0` |
| Frontend & PWA Shell | React, TypeScript, Vite, Service Worker tĩnh | `Node.js v24.16.0`, `React 19.1.0`, `Vite 6.3.5`, `TS 5.8.3` |
| Quét mã vận đơn | `@zxing/browser` + `@zxing/library` | `@zxing/browser 0.2.1` (`@zxing/library 0.23.0`) |
| Kiểm thử tự động | `xUnit` (Backend), `Vitest` + `ESLint` (Frontend), `Playwright` (E2E) | `Vitest 3.2.4`, `ESLint 10.13.0`, `@playwright/test 1.64.1` |
| Đóng gói & Proxy | Docker Compose, Caddy 2, Nginx mẫu | `Docker 29.8.2`, `Docker Compose v5.6.0` |

### Điểm nhấn an toàn dữ liệu & bảo mật
- **Bảo toàn mã vận đơn**: Không ép kiểu số (giữ nguyên số `0` ở đầu như `00849201923`), tách biệt `TrackingNumber` với `TikTokOrderId`, từ chối QR chứa URL khi chưa có parser hợp lệ và không tự truy cập URL trong mã quét.
- **Chống mất dữ liệu khi quay & upload**: Ghi từng chunk từ `MediaRecorder` tuần tự vào `IndexedDB` theo tài khoản (`OwnerUserId`), dừng đồng hồ ngay khi camera bị ngắt (`Interrupted`), và chỉ xóa chunks tạm trên máy sau khi máy chủ xác nhận `StorageStatus = Stored`.
- **Lưu trữ NAS hai pha & đối chiếu `SHA-256`**: Kiểm tra định danh share `.packingproof-storage-id` (tránh ghi nhầm ổ cục bộ khi NAS rớt mount), ghi `.partial` -> flush đĩa -> đọc lại đối chiếu `SHA-256` -> đổi tên nguyên tử (`atomic move`) và tự động đối chiếu (`reconcile`) sau sự cố sập nguồn/restart.
- **Chuyển mã bản xem độc lập**: Giữ nguyên 100% tệp gốc (`.webm`/`.mp4`) và mã băm `SHA-256` gốc; worker chạy `FFmpeg` với `PROCESSING_CONCURRENCY` giới hạn để sinh bản xem `_preview.mp4` (`H.264` + `faststart`) phát tương thích mọi trình duyệt qua HTTP `206 Partial Content`.
- **PWA App Shell an toàn**: Service Worker (`sw.js`) chỉ cache khung tĩnh (`/index.html`, `/assets/*`, `/icons/*`), tuyệt đối bỏ qua `/api/*`, `/health/*`, các request `Range` phát video và luồng `tus` upload.

---

## 2. Cấu trúc thư mục Repository

```text
├── backend/
│   ├── Dockerfile                          # Multi-stage .NET 10 + FFmpeg runtime image
│   ├── PackingProof.slnx                   # Solution Backend & Tests
│   ├── src/
│   │   ├── PackingProof.Core/              # Entities, Enums, Permissions, Storage & Media interfaces
│   │   ├── PackingProof.Infrastructure/    # EF Core PostgreSQL, Migrations, tus, FileSystemVideoStorage, ffprobe/FFmpeg, Workers
│   │   └── PackingProof.Api/               # Controllers, Cookie Auth + CSRF + SecurityStamp, Resource Policies, SPA Hosting
│   └── tests/
│       ├── PackingProof.UnitTests/         # Unit tests cho parser, path builder, grant ceiling, state machine
│       └── PackingProof.IntegrationTests/  # Integration tests với PostgreSQL 18 thật, tus, ffprobe, FFmpeg, NAS storage
├── frontend/
│   ├── Dockerfile                          # Multi-stage Node 24 build -> Caddy 2 static + reverse proxy
│   ├── public/                             # PWA manifest.webmanifest, icons/*.svg, sw.js
│   ├── src/features/                       # auth, dashboard, recording, upload-queue, videos, admin
│   └── tests/                              # Vitest tests cho camera lifecycle, IndexedDB, tus recovery, PWA policy
├── e2e/
│   ├── playwright.config.ts                # Cấu hình Playwright Chromium fake media stream
│   ├── support/                            # Fixture khởi tạo API + DB tạm packingproof_e2e_<guid> + QR stream
│   └── specs/                              # 3 bộ kiểm thử E2E luồng trình duyệt đầu-cuối
├── deploy/
│   ├── docker-compose.yml                  # PostgreSQL 18 + Backend/Worker + Caddy HTTPS cùng origin
│   ├── Caddyfile                           # Reverse proxy HTTPS unbuffered cho tus & HTTP Range
│   └── nginx.conf.example                  # Cấu hình mẫu cho Nginx / Cloudflare / Synology Reverse Proxy
├── docs/                                   # Toàn bộ tài liệu thiết kế, phân quyền, triển khai NAS/IIS & nghiệm thu
└── .env.example                            # Mẫu cấu hình biến môi trường (không chứa bí mật thật)
```

---

## 3. Hướng dẫn cài đặt & chạy Local trên Windows (với PostgreSQL 18)

### Bước 1: Chuẩn bị công cụ
1. **.NET 10 SDK** (`10.0.x`), **Node.js 24 LTS** (`v24.x`) và **FFmpeg / ffprobe** có sẵn trong biến môi trường `PATH`.
2. Dịch vụ **PostgreSQL 18** (`postgresql-x64-18`) đang chạy trên cổng `5432`.

Kiểm tra nhanh trên PowerShell:
```powershell
dotnet --version
node --version
ffmpeg -version
Get-Service postgresql-x64-18
```

### Bước 2: Khôi phục dependencies theo đúng Lockfile
```powershell
dotnet restore backend/PackingProof.slnx --locked-mode
npm --prefix frontend ci
npm --prefix e2e ci
```

### Bước 3: Cấu hình biến môi trường & Bootstrap `SuperAdmin` đầu tiên an toàn
Sao chép `.env.example` thành `.env` (file `.env` đã được chặn trong `.gitignore`):
```powershell
Copy-Item .env.example .env
```

> **Cơ chế Bootstrap `SuperAdmin` đầu tiên**:
> - Hệ thống **không** có tài khoản quản trị mặc định trong mã nguồn và **không** cho phép nâng quyền qua trang đăng ký công khai (`/register`).
> - Ở lần khởi chạy đầu tiên (khi bảng `UserScopeGrants` chưa có `SuperAdmin` nào mang phạm vi `All`), `SystemSeeder` đọc hai biến môi trường `INITIAL_ADMIN_EMAIL` và `INITIAL_ADMIN_PASSWORD` để tạo tài khoản `SuperAdmin` duy nhất ở trạng thái `Active`.
> - Ngay sau khi đăng nhập thành công và bật **2FA TOTP** tại trang Bảo mật tài khoản (`/account/security`), bạn nên xóa biến `INITIAL_ADMIN_PASSWORD` khỏi môi trường chạy.

### Bước 4A: Chạy chế độ Phát triển (Backend API + Vite Dev Server)
Mở Terminal 1 — Chạy Backend API (tự động chạy EF Core Migrations & Seed `ShopA` ở chế độ `LocalDevelopment`):
```powershell
$env:DATABASE_CONNECTION="Host=localhost;Port=5432;Database=packingproof_dev;Username=postgres;Password=YOUR_LOCAL_PG_PASSWORD"
$env:STORAGE_MODE="LocalDevelopment"
$env:INITIAL_ADMIN_EMAIL="admin@congty.local"
$env:INITIAL_ADMIN_PASSWORD="ChangeMe_StrongAdminPass!2026"
dotnet run --project backend/src/PackingProof.Api --urls http://localhost:5095
```

Mở Terminal 2 — Chạy Frontend Vite (tự động proxy `/api`, `/health`, `/openapi` sang `http://localhost:5095`):
```powershell
npm --prefix frontend run dev
```
Truy cập `http://localhost:5173`. Giao diện sẽ hiển thị rõ thanh cảnh báo **"Chế độ thử nghiệm — lưu local"**.

### Bước 4B: Chạy chế độ Single-Origin (API phục vụ trực tiếp bản build Frontend)
```powershell
npm --prefix frontend run build

$env:FRONTEND_DIST_PATH=(Resolve-Path frontend/dist).Path
$env:DATABASE_CONNECTION="Host=localhost;Port=5432;Database=packingproof_dev;Username=postgres;Password=YOUR_LOCAL_PG_PASSWORD"
$env:STORAGE_MODE="LocalDevelopment"
$env:INITIAL_ADMIN_EMAIL="admin@congty.local"
$env:INITIAL_ADMIN_PASSWORD="ChangeMe_StrongAdminPass!2026"
dotnet run --project backend/src/PackingProof.Api --urls http://localhost:5095
```
Truy cập trực tiếp `http://localhost:5095` (cùng origin cho cả SPA, PWA App Shell, cookie xác thực, `tus` upload và phát video HTTP Range).

> **Lưu ý về Camera trên điện thoại thật**: Trình duyệt di động (Chrome Android / Safari iPhone) chỉ cấp quyền `navigator.mediaDevices.getUserMedia` trên ngữ cảnh bảo mật (**HTTPS với chứng chỉ được điện thoại tin cậy**). Mở bằng `http://<IP-LAN>:5173` trên điện thoại sẽ bị trình duyệt chặn camera — xem hướng dẫn cấu hình HTTPS trong [`docs/deploy-synology.md`](docs/deploy-synology.md).

---

## 4. Chạy bằng Docker Compose (PostgreSQL 18 + Backend/FFmpeg + Caddy HTTPS)

1. Kiểm tra cú pháp cấu hình Compose:
   ```powershell
   docker compose --env-file .env.example -f deploy/docker-compose.yml config
   ```
2. Sao chép `.env.example` thành `.env`, đặt mật khẩu mạnh cho `POSTGRES_PASSWORD`, `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD`, và đặt `CADDY_SITE_ADDRESS` (ví dụ `packing.congty.vn` hoặc `localhost`).
3. Khởi chạy toàn bộ stack (yêu cầu Docker Engine đang hoạt động):
   ```powershell
   docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
   ```
4. Kiểm tra trạng thái sẵn sàng:
   - Liveness: `https://<domain>/health/live`
   - Readiness (kiểm tra cả PostgreSQL & Storage): `https://<domain>/health/ready`
   - OpenAPI Spec (môi trường Development): `http://localhost:5095/openapi/v1.json`

---

## 5. Lệnh Build, Typecheck, Lint và Kiểm thử tự động

### 5.1. Backend (.NET 10 — Build + Unit Tests + PostgreSQL/FFmpeg Integration Tests)
```powershell
dotnet restore backend/PackingProof.slnx --locked-mode
dotnet build backend/PackingProof.slnx --no-restore
dotnet test backend/PackingProof.slnx --no-build
```

### 5.2. Frontend (TypeScript Typecheck + ESLint + Vitest + Production Build)
```powershell
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
```

### 5.3. Kiểm thử E2E Trình duyệt (Playwright Chromium + Fake Camera + PostgreSQL 18 tạm)
*(Yêu cầu đã chạy `dotnet build backend/PackingProof.slnx` và `npm --prefix frontend run build`, cùng dịch vụ PostgreSQL 18 local hoạt động trên cổng `5432`)*:
```powershell
npm --prefix e2e run typecheck
npx --prefix e2e playwright test
```
Fixture E2E tự động khởi tạo cơ sở dữ liệu riêng `packingproof_e2e_<guid>` cùng thư mục `storage`/`staging` tạm thời và tự động `DROP DATABASE` + dọn sạch thư mục tạm ngay sau khi chạy xong.

---

## 6. Danh mục Tài liệu Chuyên sâu

- [`docs/design.md`](docs/design.md): Thiết kế kiến trúc, mô hình dữ liệu, máy trạng thái 3 trục và luồng lưu trữ 2 pha.
- [`docs/implementation-plan.md`](docs/implementation-plan.md) & [`docs/progress.md`](docs/progress.md): Kế hoạch triển khai chi tiết và nhật ký hoàn thành 5 giai đoạn.
- [`docs/permissions.md`](docs/permissions.md): Mô hình 14 quyền, 6 vai trò mặc định, vai trò tùy chỉnh, phạm vi `Own/Warehouse/Shop/All`, trần cấp quyền `Grant Ceiling`, TOTP 2FA và bảo vệ `Hold`.
- [`docs/deploy-synology.md`](docs/deploy-synology.md): Hướng dẫn triển khai với NAS Synology (cả phương án Container Manager trên NAS lẫn máy chủ Linux mount SMB/NFS, HTTPS cho điện thoại, Backup/Restore & Đối chiếu file).
- [`docs/deploy-iis.md`](docs/deploy-iis.md): Hướng dẫn triển khai trên Windows Server / IIS với Service Identity truy cập đường dẫn UNC `\\nas\share`.
- [`docs/manual-device-checklist.md`](docs/manual-device-checklist.md): Bảng kiểm thử thực địa bắt buộc trên điện thoại Chrome Android & Safari iPhone thật.
- [`docs/test-report.md`](docs/test-report.md): Báo cáo nghiệm thu 19 tình huống bắt buộc, kết quả chạy test thực tế, các giới hạn chưa test phần cứng vật lý và danh sách thông số cần cung cấp trước khi golive.
