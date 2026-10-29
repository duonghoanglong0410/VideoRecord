# Hướng dẫn Triển khai Thực tế với NAS Synology (`docs/deploy-synology.md`)

Do chưa chốt model phần cứng Synology, phiên bản DSM, dung lượng RAM/CPU, địa chỉ mạng nội bộ và tên miền thực tế, tài liệu này bao phủ đầy đủ **cả hai mô hình triển khai chuẩn** tùy theo năng lực thiết bị NAS của doanh nghiệp, kèm cơ chế bảo vệ chống ghi nhầm ổ đĩa (`.packingproof-storage-id`), cấu hình HTTPS cho điện thoại và quy trình Sao lưu / Phục hồi / Đối chiếu dữ liệu.

---

## 1. Lựa chọn Kiến trúc Triển khai theo Model Synology

| Tiêu chí | Phương án A — Chạy trực tiếp trên **Synology Container Manager** | Phương án B — Chạy Backend/DB trên **Máy chủ Linux riêng**, lưu video qua SMB/NFS sang NAS |
| --- | --- | --- |
| **Model Synology phù hợp** | Dòng **`+` / `xs` / `xs+` kiến trúc `x86_64`** (ví dụ DS923+, DS1522+, RS1221+), DSM 7.2+, khuyến nghị RAM **>= 8 GB** | Mọi dòng Synology (kể cả dòng `J` / `Value` dùng chip ARM hoặc NAS có ít RAM chỉ chuyên lưu trữ file) |
| **Nơi chạy PostgreSQL 18** | Container `postgres:18-alpine` đặt `PGDATA` trên volume Btrfs/ext4 nội bộ của NAS (ưu tiên SSD cache/volume SSD) | Trên đĩa SSD cục bộ của máy chủ Linux (**tuyệt đối không** đặt `PGDATA` qua mạng SMB lên NAS) |
| **Nơi chạy FFmpeg Preview** | Ngay trên NAS — **bắt buộc** giới hạn `PROCESSING_CONCURRENCY=1` để không làm nghẽn CPU NAS | Trên CPU của máy chủ Linux (`PROCESSING_CONCURRENCY=2` hoặc theo số nhân thực tế) |
| **Cách kết nối vùng lưu video** | Bind mount trực tiếp Shared Folder `/volume1/PackingVideos` vào `/mnt/nas/packingproof` của container `backend` | Mount SMB3 hoặc NFSv4 từ NAS vào `/mnt/synology-packing` trên Linux, rồi bind mount vào container `backend` |

---

## 2. Nguyên tắc Tách biệt Tài khoản & An ninh Mạng NAS (Bắt buộc)

1. **Tách biệt hoàn toàn tài khoản DSM/SMB và tài khoản ứng dụng Web**:
   - Nhân viên đóng gói, quản lý kho và viewer chỉ đăng nhập vào giao diện web HTTPS của **PackingProof Web** bằng tài khoản ứng dụng riêng.
   - Trình duyệt điện thoại **không bao giờ** nhận thông tin tài khoản NAS, đường dẫn SMB hay địa chỉ IP quản trị DSM.
2. **Không mở SMB (cổng 445) hoặc trang quản trị DSM (cổng 5000/5001) ra Internet**:
   - Không dùng việc mở thẳng SMB hoặc QuickConnect File Station cho nhân viên tải file nhằm thay thế quy trình upload có kiểm soát.
   - Mọi truy cập quay/upload/xem từ điện thoại đi qua cổng HTTPS (`443`) của Reverse Proxy ứng dụng (hoặc qua mạng Wi-Fi kho nội bộ / VPN doanh nghiệp như WireGuard / Tailscale).
3. **Tài khoản dịch vụ tối thiểu quyền (`Least Privilege`)**:
   - Nếu dùng Phương án B (SMB), tạo một tài khoản dịch vụ riêng trên DSM (ví dụ `svc_packingproof_nas`), **chỉ** cấp quyền `Read/Write` duy nhất trên Shared Folder `PackingVideos`, tắt quyền truy cập tất cả các Shared Folder khác và tắt quyền đăng nhập giao diện quản trị DSM.

---

## 3. Khởi tạo Shared Folder & Tệp Định danh `.packingproof-storage-id`

Cơ chế `STORAGE_MODE=SynologyMounted` của PackingProof Web **từ chối lưu trữ và không tự tạo thư mục cục bộ** nếu mount bị đứt hoặc trỏ nhầm ổ đĩa. Backend xác minh tính chính danh của vùng lưu trữ thông qua tệp ẩn `.packingproof-storage-id` đặt ngay tại thư mục gốc của share.

### Các bước chuẩn bị trên NAS Synology:
1. Đăng nhập DSM -> **Control Panel** -> **Shared Folder** -> Tạo thư mục dùng chung tên `PackingVideos` (ví dụ nằm tại `/volume1/PackingVideos`).
   - Khuyến nghị bật **Data Checksum for advanced data integrity** (trên phân vùng Btrfs) và **Snapshot Replication** theo lịch để chống xóa nhầm cấp hệ điều hành.
   - Không bật tính năng tự động dọn Recycle Bin không kiểm soát nếu chưa thống nhất chính sách lưu giữ.
2. Tạo chuỗi định danh duy nhất cho kho lưu trữ (ví dụ `synology-kho-hcm-prod-01`) và ghi vào tệp `.packingproof-storage-id` ở gốc thư mục `PackingVideos`:
   ```bash
   echo -n "synology-kho-hcm-prod-01" > /volume1/PackingVideos/.packingproof-storage-id
   chmod 640 /volume1/PackingVideos/.packingproof-storage-id
   ```
3. Khai báo đúng giá trị này trong file `.env` của ứng dụng:
   ```dotenv
   STORAGE_MODE=SynologyMounted
   STORAGE_ID=synology-kho-hcm-prod-01
   ```
   > Khi `STORAGE_MODE=SynologyMounted`, nếu kết nối mạng tới NAS bị ngắt khiến `/mnt/nas/packingproof/.packingproof-storage-id` biến mất, worker sẽ giữ nguyên video an toàn tại vùng `staging` (`StorageStatus = WaitingForStorage`), ghi lỗi rõ ràng và tự động thử lại theo chu kỳ backoff khi mount phục hồi — **tuyệt đối không ghi nhầm vào ổ đĩa hệ điều hành rồi báo "Đã lưu NAS"**.

---

## 4. Triển khai chi tiết cho từng Phương án

### 4.1. Phương án A — Chạy trực tiếp trên Synology Container Manager

1. Cài gói **Container Manager** từ DSM Package Center.
2. Tạo các thư mục lưu trữ bền vững trên volume cục bộ của NAS:
   ```bash
   mkdir -p /volume1/docker/packingproof/{pgdata,staging,dataprotection-keys,deploy}
   ```
3. Sao chép mã nguồn dự án (hoặc image đã build) lên `/volume1/docker/packingproof/`, tạo file `.env` từ `.env.example` với các thông số:
   ```dotenv
   ASPNETCORE_ENVIRONMENT=Production
   APP_PUBLIC_ORIGIN=https://packing.ten-mien-cua-ban.vn
   POSTGRES_DB=packingproof
   POSTGRES_USER=packingproof
   POSTGRES_PASSWORD=<MAT_KHAU_DB_MANH_32_KY_TU>

   STORAGE_MODE=SynologyMounted
   STORAGE_ID=synology-kho-hcm-prod-01
   PROCESSING_CONCURRENCY=1

   RETENTION_ENABLED=false
   RETENTION_DAYS=90

   INITIAL_ADMIN_EMAIL=admin@ten-mien-cua-ban.vn
   INITIAL_ADMIN_PASSWORD=<MAT_KHAU_SUPERADMIN_LAN_DAU>
   ```
4. Trong `deploy/docker-compose.yml`, cập nhật mục `volumes` của `postgres` và `backend` sang đường dẫn thực trên `/volume1`:
   ```yaml
   # Trong service postgres (bắt buộc nằm trên volume nội bộ của NAS, KHÔNG qua SMB):
   volumes:
     - /volume1/docker/packingproof/pgdata:/var/lib/postgresql/data

   # Trong service backend:
   volumes:
     - /volume1/docker/packingproof/staging:/var/lib/packingproof/staging
     - /volume1/docker/packingproof/dataprotection-keys:/var/lib/packingproof/dataprotection-keys
     - /volume1/PackingVideos:/mnt/nas/packingproof
   ```
5. Nếu dùng **Synology Built-in Reverse Proxy** (DSM -> Control Panel -> Login Portal -> Advanced -> Reverse Proxy) chiếm cổng `443`, đổi cổng host của container `proxy` trong `docker-compose.yml` thành `HTTP_PORT=8088` / `HTTPS_PORT=8443` (hoặc trỏ Reverse Proxy thẳng vào cổng nội bộ kèm cấu hình timeout & header tương đương `deploy/nginx.conf.example`), sau đó chạy:
   ```bash
   docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
   ```

### 4.2. Phương án B — Máy chủ Linux (Ubuntu 24.04 / Debian 12) kết nối NAS qua SMB3 hoặc NFS

1. Trên máy chủ Linux, tạo thông tin đăng nhập SMB bảo mật tại `/etc/samba/packingproof-nas.creds` (chỉ `root` đọc được):
   ```ini
   username=svc_packingproof_nas
   password=MAT_KHAU_DICH_VU_NAS_RIENG
   domain=WORKGROUP
   ```
   ```bash
   sudo chmod 600 /etc/samba/packingproof-nas.creds
   sudo mkdir -p /mnt/synology-packing
   ```
   > **Mẹo bảo vệ chống ghi đè thư mục rỗng**: Khi chưa mount, hãy khóa quyền ghi trên thư mục mount point trống (`sudo chattr +i /mnt/synology-packing` hoặc `chmod 555 /mnt/synology-packing`). Kết hợp với kiểm tra `.packingproof-storage-id` của ứng dụng, hệ thống có 2 tầng bảo vệ độc lập khi rớt mạng NAS.

2. Khai báo mount tự động trong `/etc/fstab` (sử dụng SMB 3.1.1):
   ```fstab
   //<IP_NOI_BO_SYNOLOGY>/PackingVideos  /mnt/synology-packing  cifs  vers=3.1.1,credentials=/etc/samba/packingproof-nas.creds,uid=0,gid=0,file_mode=0640,dir_mode=0750,nofail,_netdev,noserverino  0  0
   ```
   Thực thi mount và kiểm tra file marker:
   ```bash
   sudo mount -a
   cat /mnt/synology-packing/.packingproof-storage-id
   ```
3. Trong `deploy/docker-compose.yml`:
   - **Giữ nguyên** `pgdata:/var/lib/postgresql/data` trên ổ SSD cục bộ của máy chủ Linux (**không** đưa `pgdata` vào `/mnt/synology-packing`).
   - **Giữ nguyên** `staging_data:/var/lib/packingproof/staging` trên ổ SSD cục bộ để nhận `tus` upload tốc độ cao.
   - Đổi dòng volume lưu trữ của `backend` thành:
     ```yaml
     - /mnt/synology-packing:/mnt/nas/packingproof
     ```
4. Khởi chạy stack:
   ```bash
   docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
   ```
5. Đăng nhập bằng `SuperAdmin`, vào **Cấu hình lưu trữ (`/admin/storage`)** -> bấm **"Kiểm tra kết nối lưu trữ ngay"**: xác nhận `Mode = SynologyMounted`, `MarkerValid = true`, `CanReadWrite = true` và thêm/kiểm tra thư mục con được phép cho từng Shop (ví dụ `shop-a`).

---

## 5. Cấu hình HTTPS Được Điện thoại Tin cậy (Bắt buộc cho Camera Web)

Trình duyệt Chrome trên Android và Safari trên iPhone **từ chối `getUserMedia` (camera)** nếu truy cập qua `http://192.168.x.x` hoặc chứng chỉ tự ký (`self-signed`) chưa được cài Root CA tin cậy. Hãy chọn một trong hai cách chuẩn sau:

1. **Cách 1 — Khuyến nghị (Tên miền thật + Let's Encrypt DNS-01 hoặc HTTP-01)**:
   - Tạo bản ghi DNS cho tên miền nội bộ hoặc công khai (ví dụ `packing.congty.vn` trỏ về IP LAN của máy chủ cho mạng Wi-Fi kho, dùng **DNS-01 Challenge** qua Cloudflare/Route53 trong Caddy hoặc Synology DSM Certificate).
   - Ưu điểm: Chứng chỉ Let's Encrypt được mọi điện thoại Android và iPhone tin cậy sẵn 100%, **không cần cài đặt thủ công chứng chỉ lên từng máy nhân viên** và không bắt buộc phải mở cổng 80/443 ra ngoài Internet nếu dùng DNS-01.
2. **Cách 2 — Mạng LAN thuần không có tên miền công khai (Internal Root CA)**:
   - Sử dụng `mkcert` hoặc Root CA nội bộ của Caddy (`tls internal`).
   - Trích xuất tệp `root.crt` (Root CA) và cài đặt lên điện thoại kho:
     - **iPhone (iOS)**: Cài đặt Profile cấu hình -> Vào *Cài đặt -> Cài đặt chung -> Giới thiệu -> Cài đặt tin cậy chứng nhận (Certificate Trust Settings)* -> Bật tin cậy toàn phần cho Root CA.
     - **Android**: Vào *Cài đặt -> Bảo mật & Quyền riêng tư -> Mã hóa & Thông tin xác thực -> Cài đặt chứng chỉ -> Chứng chỉ CA*.

---

## 6. Kế hoạch Sao lưu (Backup), Khôi phục (Restore) & Đối chiếu Dữ liệu

Một hệ thống hoàn chỉnh có **4 thành phần trạng thái** bắt buộc phải sao lưu đồng bộ:

| Thành phần | Vị trí | Tần suất khuyến nghị | Ghi chú quan trọng |
| --- | --- | --- | --- |
| 1. Cơ sở dữ liệu PostgreSQL | Container/Service `postgres` | Hàng ngày (`pg_dump -Fc`) + lưu 14–30 bản | Chứa tài khoản, quyền, mã vận đơn, đường dẫn file, mã băm `SHA-256` và `AuditEvents` |
| 2. Khóa ASP.NET Data Protection | Volume `dataprotection_keys` | Mỗi tuần & khi cài đặt mới | Dùng giải mã cookie phiên và secret TOTP 2FA |
| 3. File cấu hình môi trường | `.env`, `deploy/Caddyfile` | Mỗi lần thay đổi cấu hình | Lưu trong kho quản lý bí mật an toàn của doanh nghiệp |
| 4. Thư mục Video trên NAS | `/volume1/PackingVideos` | Snapshot Btrfs hàng ngày + Hyper Backup sang ổ ngoài/cloud | Chứa tệp video gốc và bản xem `_preview.mp4` |

### 6.1. Lệnh Sao lưu & Khôi phục PostgreSQL
```bash
# Sao lưu định dạng nén chuẩn custom (-Fc)
docker compose -f deploy/docker-compose.yml exec -T postgres \
  pg_dump -U packingproof -d packingproof -Fc > backup_packingproof_$(date +%Y%m%d_%H%M%S).dump

# Khôi phục vào database mới/trống khi cần phục hồi thảm họa
cat backup_packingproof_YYYYMMDD_HHMMSS.dump | \
  docker compose -f deploy/docker-compose.yml exec -T postgres \
  pg_restore -U packingproof -d packingproof --clean --if-exists
```

### 6.2. Quy trình Đối chiếu Metadata PostgreSQL với Tệp thực tế trên NAS sau Khôi phục (`Reconciliation`)

Khi khôi phục từ bản backup database (ví dụ bản backup DB lúc 02:00 sáng trong khi trên NAS đã có thêm file video quay lúc 09:00 sáng, hoặc ngược lại), cần chạy quy trình đối chiếu 3 trường hợp sau trước khi mở lại hệ thống cho kho:

1. **Xuất danh sách đối chiếu từ PostgreSQL**:
   ```sql
   SELECT
       r."Id" AS recording_id,
       r."TrackingNumber" AS tracking_number,
       r."StorageStatus" AS storage_status,
       va."Kind" AS asset_kind,
       va."RelativePath" AS relative_path,
       va."SizeBytes" AS expected_bytes,
       va."Sha256" AS expected_sha256
   FROM "Recordings" r
   LEFT JOIN "VideoAssets" va ON va."RecordingId" = r."Id"
   WHERE r."DeletedAtUtc" IS NULL
   ORDER BY r."CreatedAtUtc" DESC;
   ```
2. **Kiểm tra 3 tình huống lệch pha**:
   - **Trường hợp 1 — DB ghi `Stored` nhưng file trên NAS bị thiếu hoặc sai `SHA-256`**:
     - Kiểm tra mã băm thực tế trên NAS bằng `sha256sum /volume1/PackingVideos/<RelativePath>`.
     - Nếu file thiếu trên NAS chính, khôi phục riêng file đó từ Btrfs Snapshot hoặc Hyper Backup của Synology và kiểm tra lại `sha256sum` khớp đúng `expected_sha256`. Trong thời gian file chưa khôi phục, API phát video của PackingProof sẽ trả lỗi `503 VIDEO_STORAGE_UNAVAILABLE` minh bạch (không âm thầm phát file chưa xác minh).
   - **Trường hợp 2 — File đã nằm trên NAS (từ 02:00–09:00) nhưng bản backup DB cũ chưa có bản ghi (`Orphaned NAS Files`)**:
     - Do đường dẫn file được thiết kế tự mô tả `<ShopSubdir>/<yyyy>/<MM>/<dd>/<SafeTracking>/<SafeTracking>_<RecordingId>.<ext>`, quản trị viên dễ dàng nhận diện chính xác `Shop`, ngày đóng gói, mã vận đơn và `RecordingId` ngay từ tên tệp trên NAS để di chuyển sang thư mục lưu trữ bổ sung (`_recovered_post_backup/`) phục vụ tra cứu thủ công khi có khiếu nại mà không bị ghi đè.
   - **Trường hợp 3 — Bản ghi trong DB đang ở `Validating` / `WaitingForStorage` / `CopyingToStorage`**:
     - Nếu tệp trên NAS đã kịp commit trước lúc sự cố và khớp `RecordingId`, khi khởi động lại `PackingProof.Api`, `ProcessingJobWorker` sẽ tự động phát hiện tệp đích tồn tại, tính lại `SHA-256`, đối chiếu và hoàn tất trạng thái `Stored` (`idempotent crash reconciliation`) mà không tạo bản sao trùng lặp.
