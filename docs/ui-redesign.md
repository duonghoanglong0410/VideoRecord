# Tài liệu Thiết kế Giao diện Mới — PackingProof Web (`UI/UX Redesign Specification`)

- **Ngày chốt thiết kế:** 2026-10-31
- **Quy trình:** `@brainstorming` + `ui-ux-pro-max` (`design-system/packingproof-web/MASTER.md`)
- **Trạng thái:** Đã khóa phạm vi (*Understanding Lock*), phê duyệt phương án kiến trúc (*Phương án 1*) và duyệt chi tiết toàn bộ 5 phần thiết kế.

---

## 1. Tóm tắt Mục tiêu & Phạm vi (Understanding Summary)

1. **Mục tiêu cốt lõi:** Xây dựng lại toàn bộ giao diện 14 màn hình của **PackingProof Web** để **trực quan, dễ sử dụng ngay cho nhân viên kho và quản lý không rành công nghệ**, **hiển thị đầy đủ dữ liệu nghiệp vụ bằng hình ảnh/màu sắc/tiến trình**, và **loại bỏ triệt để mọi thành phần chữ nghĩa kỹ thuật dư thừa**.
2. **Định hướng thị giác (Hybrid Thực chiến):**
   - **Quản lý, Tra cứu, Hàng đợi & Xác thực:** Phong cách **Modern Flat SaaS (Light Mode)** sáng sủa, tương phản chữ đạt chuẩn `WCAG AAA`, dùng biểu tượng SVG `lucide-react` đồng bộ.
   - **Quét mã, Quay Video (`/record`) & Khung phát Video (`/videos/:id`):** Bề mặt tối chuyên dụng (**Dark Camera HUD / Cinema `#09090B`**) giúp nổi bật tem vận đơn dưới đèn kho và tập trung thao tác 1 tay.
3. **Công nghệ UI:** **Tailwind CSS v4 (`@tailwindcss/vite`)** + **`lucide-react`** + bộ **UI Primitives nội bộ chuẩn Shadcn** (`frontend/src/components/ui/`) + phông chữ đóng gói nội bộ hỗ trợ hoàn hảo tiếng Việt (**`Be Vietnam Pro`** + **`JetBrains Mono`**).
4. **Ràng buộc bất biến:** Giữ nguyên **100%** Backend APIs (`.NET 10` / `PostgreSQL 18`), schema cơ sở dữ liệu, cơ chế Cookie + `X-CSRF-Token`, phân quyền `14 Permissions × 4 Scopes`, và toàn bộ lõi quay/tải phía Frontend (`RecorderController`, `mediaCapabilities`, `ScannerView` barcode engine, Web Worker `chunkWriter.worker`, `TusQueueManager`, `TusUploadCoordinator`).
5. **Những gì KHÔNG làm (Explicit Non-Goals):**
   - Không sửa đổi Backend, giao thức `tus` hay cấu trúc lưu trữ Synology NAS.
   - Không xây hệ thống đổi Dark Mode toàn ứng dụng cho các bảng quản trị (áp dụng YAGNI).
   - Không cài các thư viện UI cồng kềnh (MUI, Ant Design) làm nặng tốc độ tải trên điện thoại kho.

---

## 2. Danh sách Giả định & Yêu cầu Phi chức năng (Explicit Assumptions)

- **A1 (Bảo toàn Route):** Giữ nguyên toàn bộ đường dẫn URL trong `frontend/src/app/router.tsx` (`/login`, `/register`, `/reset-password`, `/pending-approval`, `/`, `/record`, `/uploads`, `/videos`, `/videos/:id`, `/security/mfa`, `/admin/users`, `/admin/roles`, `/admin/storage`, `/admin/audit`).
- **A2 (Ẩn chi tiết kỹ thuật theo tầng):** Mọi thông số phục vụ kỹ thuật/kiểm định (`MIME/codec`, `WakeLock`, `SHA-256`, `JSON` nhật ký gốc) được cất gọn vào thẻ `<details>` / ngăn mở rộng `(i)` — không phô ra mặt chính gây rối nhân viên, nhưng vẫn có mặt trong DOM khi cần kiểm tra hoặc chạy test tự động.
- **A3 (Offline LAN Ready):** Đóng gói trực tiếp phông chữ tiếng Việt (`@fontsource/be-vietnam-pro`, `@fontsource/jetbrains-mono`) vào bundle tĩnh để mở tức thì trong mạng LAN nội bộ nối NAS ngay cả khi kho không mở Internet ra ngoài.
- **A4 (Hiệu năng Camera Mobile):** Bảo toàn tốc độ `24–30 FPS` trên Android/iOS; giữ nguyên quy tắc CSS `.camera-video` chống lỗi `Android SurfaceControl` và không dùng `backdrop-blur` đè lên luồng `<video>`.
- **A5 (Tương thích Kiểm thử 100%):** Toàn bộ bộ test tự động hiện có (`28` Vitest tests + `3` Playwright E2E specs) phải tiếp tục vượt qua `100%`.

---

## 3. Nhật ký Quyết định & Phản biện Rủi ro (Decision Log)

| Mã | Quyết định đã chốt | Phương án thay thế đã cân nhắc | Lý do chọn & Xử lý phản biện (Edge-Case Resolution) |
| :--- | :--- | :--- | :--- |
| **D1** | Thiết kế lại toàn bộ 14 màn hình, giữ nguyên 100% Backend & Engine quay/upload | Chỉ sửa màn hình Mobile; hoặc sửa cả API Backend | Mang lại trải nghiệm đồng bộ từ nhân viên đóng gói đến quản lý/admin mà không gây rủi ro đứt gãy luồng ghi hình & lưu trữ NAS đã qua kiểm thử. |
| **D2** | Phong cách **Hybrid Thực chiến** (Light SaaS trên Desktop + Dark Camera HUD trên Mobile) | SaaS thuần mọi nơi; hoặc Industrial nút vàng/đen hầm hố toàn app | Tối ưu mật độ bảng biểu cho quản lý trên máy tính và tối ưu tầm nhìn khung ngắm camera cho công nhân tại bàn đóng gói. |
| **D3** | Dùng **Tailwind CSS v4 + `lucide-react` + Internal Shadcn UI Primitives** | Full Radix/UI framework lớn (AntD/MUI); hoặc CSS thuần thủ công | Bundle cực nhẹ cho điện thoại tầm trung tại kho, đồng bộ 100% với tiêu chuẩn `ui-ux-pro-max`, dễ tái sử dụng. |
| **D4** | Light Mode cố định cho quản trị + Dark surface riêng cho Camera & Video Player | Làm công tắc chuyển Light/Dark Mode toàn ứng dụng | Tuân thủ triệt để **YAGNI**: giảm một nửa độ phức tạp CSS mà vẫn đúng ngữ cảnh ánh sáng thực tế của từng tác vụ. |
| **D5** | Chọn **Phương án 1**: Bố cục **3 Tầng Ưu tiên** + Tách nhỏ các file JSX lớn (`RecordingPage`, `VideoDetailPage`) + Từ điển Việt hóa tập trung | Phương án 2 (Sửa CSS tại chỗ trên file 2.000 dòng); Phương án 3 (Tách 2 AppLayout theo Role) | Giúp loại bỏ sạch chữ thừa, dễ bảo trì lâu dài (`< 250–350` dòng/component), không phá vỡ điều hướng của các vai trò tùy chỉnh (`Custom Role`) và E2E tests. |
| **D6** | *(Phản biện Test Contract #1)* Giữ cụm từ **`"Chế độ thử nghiệm — lưu local"`** trên `StorageModeBanner` và **tuyệt đối không** chứa chữ `"NAS"` trong nội dung banner này | Viết câu `"Chưa nối kho NAS"` ngay trong banner | Bài test `authGuardsAndFlows.test.tsx:101` kiểm tra chặt `expect(banner.textContent).not.toMatch(/NAS/i)` để chống gây hiểu lầm với NAS thật. Dùng câu: *"Chế độ thử nghiệm — lưu local (dữ liệu chỉ lưu tạm trên máy chủ cục bộ)"*. |
| **D7** | *(Phản biện Test Contract #2)* Dùng thẻ `<details>` gốc của HTML cho các khối thông tin phụ/kỹ thuật (`detail-sha256`, thông số camera) và giữ `video-import-panel` gắn sẵn trong DOM dạng thẻ phụ gọn khi tài khoản có quyền `video.import` | Không render vào DOM cho đến khi bấm state React `isOpen` | Đảm bảo giao diện mặt chính siêu gọn cho nhân viên kho nhưng các bài test tự động (`videoLibraryAndDetail.test.tsx:574`, `detail-sha256`) luôn truy xuất được phần tử ngay lập tức mà không gãy test. |
| **D8** | *(Phản biện Test Contract #3)* Bảo toàn thứ tự 3 thẻ `<select>` trong hộp thoại Duyệt/Phân quyền trên `UsersAdminPage` và các lớp bọc `.desktop-table-wrap` / `.mobile-card-list` / `.mono-code` / `.brand-badge` / `.note-item` | Đổi sang custom div dropdown hoặc bỏ toàn bộ tên class cũ | Giữ tương thích tuyệt đối với 3 kịch bản Playwright E2E (`authAndGovernance.spec.ts`, `permissionsAndHoldProtection.spec.ts`, `recordUploadAndPlayback.spec.ts`). |
| **D9** | **Gỡ bỏ hoàn toàn tương thích / can thiệp phần cứng Camera** (cả UI `wakelock-status` / `encoder-mode-status`, cả hàm JS `applyAndroidIndoorShutterClamp` / `sampleVideoLumaAverage` / `applyDefaultCameraVideoTrackOptimizations` và CSS hack `.camera-video`) | Giữ lại CSS/JS hack cho Android hoặc chỉ ẩn UI | Theo yêu cầu trực tiếp của người dùng (2026-11-02): trả luồng camera về chuẩn trình duyệt mặc định, sạch gọn, loại bỏ hoàn toàn các thông số kỹ thuật dư thừa trên màn hình quay. |
| **D10** | **Áp dụng Phương án A (Compact Toolbar + Progressive Disclosure)** trên `/record` | Tách bước cứng (Stepped Wizard) hoặc chỉ giảm cỡ chữ | Gom bộ chọn `Shop/Kho` vào `<details>` 1 dòng khi đã có kho mặc định; gom nút chọn `1080p/720p` + `Khung dọc/ngang` + `Thu âm` thành 1 thanh công cụ ngang; ẩn khối `video-import-panel` vào `<details>` thu gọn mặc định. |
| **D11** | **Triệt tiêu trùng lặp trên các trang Quản trị & Tra cứu** (`StorageAdminPage`, `RolesAdminPage`, `AccountProfilePage`, `AuditLogPage`) | Giữ nguyên cả 2 nơi tạo Shop/Kho và hiển thị lặp danh sách quyền | Gỡ bỏ nút/modal tạo Shop & Kho bị trùng ở `StorageAdminPage` (chuyển hẳn về `WarehousesAdminPage`); rút gọn thẻ vai trò và đưa bảng ma trận đối chiếu ở `RolesAdminPage` vào `<details>`; gộp thông tin vai trò gọn vào thẻ Hồ sơ trên `AccountProfilePage`. |

---

## 4. Thiết kế Chi tiết Toàn Hệ thống (Final Design)

### 4.1. Kiến trúc Thư mục Giao diện (`frontend/src/`)
- **`styles/app.css`:** Cấu hình `@import "tailwindcss";` (Tailwind v4), khai báo biến màu chuẩn `MASTER.md`, nạp `@fontsource/be-vietnam-pro` & `@fontsource/jetbrains-mono`, và giữ nguyên khối CSS bất biến `.camera-video` chống lỗi `Android SurfaceControl` cùng các utility hook tương thích test (`.desktop-table-wrap`, `.mobile-card-list`, `.mono-code`, `.brand-badge`, `.note-item`).
- **`components/ui/`:** Bộ UI Primitives nội bộ gọn nhẹ:
  - `Button.tsx`, `Badge.tsx`, `Card.tsx`, `PageHeader.tsx`, `StatCard.tsx`, `StatusStepper.tsx`, `Dialog.tsx`, `EmptyState.tsx`, `ResponsiveDataView.tsx`.
- **`shared/labels/`:** Bộ từ điển Việt hóa không thuật ngữ:
  - `auditLabels.ts`: Dịch toàn bộ mã `action` (ví dụ `auth.login_succeeded` → *Đăng nhập thành công*, `video.hold_updated` → *Cập nhật khóa giữ bằng chứng*, `recording.manual_code_entered` → *Nhập mã vận đơn thủ công*...) và `entityType` (`Recording` → *Video đơn hàng*, `User` → *Tài khoản*, `StorageProfile` → *Cấu hình lưu trữ*...), kèm hàm trích xuất `metadataJson` thành danh sách thông tin tiếng Việt dễ đọc.
  - `permissionLabels.ts`: Nhóm 14 quyền thành 4 nhóm nghiệp vụ tiếng Việt dễ hiểu (*Quay đóng gói*, *Xem & Đối soát video*, *Quản lý nhân sự*, *Cấu hình & Nhật ký hệ thống*).

### 4.2. Khung Điều hướng & An toàn Phiên (`AppLayout.tsx`, `StorageModeBanner.tsx`)
- **Desktop (`>= 1024px`):** Sidebar trái cố định `240px` sáng sủa:
  - Logo + Tên hệ thống gọn trên đỉnh.
  - Nhóm **Vận hành**: *Tổng quan* (`/`), *Quay đóng gói* (`/record`), *Tiến trình tải lên* (`/uploads` kèm badge đếm số đơn đang chờ/tải trực tiếp từ `TusUploadCoordinator`), *Thư viện video* (`/videos`).
  - Nhóm **Quản trị** (tự ẩn hoàn toàn nếu không có quyền): *Nhân sự & Duyệt tài khoản* (`/admin/users`), *Vai trò & Quyền hạn* (`/admin/roles`), *Kho lưu trữ & Shop* (`/admin/storage`), *Nhật ký hoạt động* (`/admin/audit`).
  - Chân Sidebar: Thẻ người dùng hiện tại + link *Bảo mật 2 lớp* (`/security/mfa`) + nút *Đăng xuất* (kích hoạt hộp thoại cảnh báo nếu còn video chưa tải xong).
- **Mobile (`< 1024px`):**
  - Header mỏng trên đỉnh + **Bottom Navigation Bar** cố định dưới đáy (`>= 56px`, 4 tab chạm lớn, có menu mở rộng cho Quản trị/Tài khoản). Tự ẩn Bottom Bar khi đang trong pha `recording` trên `/record`.
- **`StorageModeBanner.tsx`:** Dải cảnh báo màu hổ phách gọn 1 dòng có icon `AlertTriangle` khi chạy `LocalDevelopment`: *"Chế độ thử nghiệm — lưu local: Video hiện chỉ lưu tạm trên máy chủ cục bộ."*

### 4.3. Luồng Nhân viên Kho trên Điện thoại (`/record` & `/uploads`)
- **Tách nhỏ `RecordingPage.tsx` (`2.027` dòng) thành các sub-components rõ ràng trong `features/recording/components/`:**
  1. `RecordingContextBar.tsx`: Hiển thị Chip `Shop • Kho` + chip dung lượng trống (`available-storage-chip`). Nếu nhân viên chỉ có 1 Shop & 1 Kho, tự khóa gọn thành 1 dòng thông tin sạch sẽ; nếu có nhiều Shop/Kho, hiển thị nút *"Đổi kho"* mở ô chọn `#recording-shop-select` và `#recording-warehouse-select` (hoặc hiện sẵn khi chưa chọn).
  2. `TrackingConfirmCard.tsx`: Tấm xác nhận mã vận đơn cỡ lớn `JetBrains Mono` (`recognized-tracking-banner`), chip ĐVVC & Mã đơn TikTok, cảnh báo trùng đơn (`duplicate-recording-warning`), nút chính cỡ lớn **`Xác nhận mã & Tạo phiên quay`**, nút **`Quét lại mã khác`**, và thẻ phụ gọn gàng **`Nhập tệp video có sẵn`** (`video-import-panel`) khi tài khoản được cấp quyền `video.import`.
  3. `CameraHudStage.tsx`: Bề mặt tối `#09090B` (`recording-session-stage`):
     - Thanh đỉnh khóa mã vận đơn (`locked-tracking-number`) + huy hiệu `Đang quay` nháy đỏ (`recording-active-badge`) + đồng hồ lớn (`recording-timer`) + dung lượng (`recording-bytes`).
     - Hàng nút gạt nhanh trước khi quay (`1080p / 720p`, `Khung dọc / Khung ngang`, `Thu âm` nếu bật) — xóa hoàn toàn đoạn thuyết minh kỹ thuật Android dài dòng.
     - Khung ngắm `<video className="camera-video">` chiếm trọn tâm điểm + nút Đèn Flash nổi + dòng nhắc ngắn gọn *"Giữ trang này đang mở trong khi quay"*.
     - Vùng nút ngón cái dưới đáy: **`Bắt đầu quay đóng gói`** (`>= 56px`) → **`Kết thúc & Lưu video`** → Thẻ hoàn tất xanh lá (`recording-completed-banner`) với nút lớn **`Quét & Quay đơn tiếp theo`** và link **`Xem Hàng đợi tải lên`**.
     - Ngăn `<details>` nhỏ gọn *"Thông tin thiết bị"* ở chân khung cất gọn `wakelock-status` và `encoder-mode-status`.
- **`UploadQueuePage.tsx` (`/uploads`):**
  - Xóa sạch chữ `IndexedDB`, `giao thức tus`, `chunks`.
  - Thanh 3 thẻ chỉ số trên đầu: *Đơn chờ hoàn tất (`x / tối đa`)*, *Trạng thái truyền tải* (`queue-active-transfer-indicator`), *Bộ nhớ thiết bị còn trống*.
  - Mỗi thẻ đơn hàng có **Thanh tiến trình 3 bước trực quan (`StatusStepper`)**:
    1. *Đã lưu trên máy* → 2. *Đang gửi lên hệ thống (`%`)* → 3. *Đã lưu an toàn* (`storage-badge-*`), kèm nút **`Thử tải lại`** nổi bật khi mạng gián đoạn.

### 4.4. Luồng Quản lý & Đối soát (`/`, `/videos`, `/videos/:id`)
- **`DashboardPage.tsx` (`/`):**
  - Xóa hàng nút thao tác nhanh bị trùng lặp với Sidebar/Bottom Bar và xóa hoàn toàn thẻ *"Phạm vi phân quyền hiện tại của tài khoản"* ở cuối trang.
  - **5 Thẻ KPI tương tác có Icon màu (`dashboard-metrics-grid`)**: Bấm vào từng thẻ điều hướng thẳng tới `/videos` với bộ lọc tương ứng.
  - **Hộp thông báo "Việc cần phê duyệt"** (chỉ hiện khi có nhân viên chờ duyệt hoặc yêu cầu xóa chờ xử lý) + **Danh sách Video gần đây** sạch gọn.
- **`VideoListPage.tsx` (`/videos`):**
  - Thanh tìm kiếm trung tâm nổi bật (`#video-search-tracking`, bảo toàn số `0` đầu mã) + nút chọn *Khớp chính xác mã vận đơn* + các tab phạm vi (*Tất cả trong phạm vi*, *Video của tôi*, *Duyệt yêu cầu xóa*).
  - Dải **Chip lọc nhanh 1 chạm** (*Tất cả*, *Hoàn chỉnh*, *Bị gián đoạn*, *Đang giữ bằng chứng*) + 3 ô lọc chính (*Shop, Kho, Khoảng ngày*); các ô lọc phụ thu gọn vào `<details>` *"Bộ lọc nâng cao"*.
- **`VideoDetailPage.tsx` (`/videos/:id`):**
  - Tách thành các sub-components sạch trong `features/videos/components/`.
  - **Cột trái:** Khung trình phát video nền tối `#09090B` (`authenticated-video-player`) + nút chuyển nguồn phát (*Tự động / Bản xem MP4 / Tệp gốc*) — xóa chú thích kỹ thuật `HTTP Range 206` — bên dưới là khung **Ghi chú đối chiếu & khiếu nại** dạng dòng thời gian dễ đọc.
  - **Cột phải:** Thẻ **Thông tin đơn hàng & Bảo vệ bằng chứng** (Mã vận đơn có nút Copy nhanh, ĐVVC, Mã đơn TikTok, Shop/Kho, Nhân viên đóng gói, Thời điểm quay, Thời lượng, Dung lượng) + cụm nút thao tác rõ ràng (*Tải video gốc*, *Giữ bằng chứng (Bật Hold)*, *Quay lại với mã đúng*, *Yêu cầu xóa video*). Khối thông số sâu (*Độ phân giải, Định dạng Codec, Mã băm toàn vẹn `detail-sha256`*) đặt gọn trong `<details>` *"Thông số kiểm định kỹ thuật"*.

### 4.5. Luồng Quản trị Không Thuật Ngữ & Xác thực (`/admin/*`, Auth, MFA)
- **`AuditLogPage.tsx` (`/admin/audit`):**
  - Đổi tiêu đề thành **Nhật ký hoạt động**; thay các ô bắt gõ mã code thô bằng dropdown chọn **Nhóm hoạt động** và **Loại đối tượng** bằng tiếng Việt thân thiện (kèm tùy chọn tìm nâng cao).
  - Bảng nhật ký hiển thị tên hành động đã dịch sang tiếng Việt có icon màu + tự động bóc tách `metadataJson` thành các nhãn thông tin tiếng Việt dễ đọc (*Mã vận đơn, Lý do, Quyền đã cấp...*); dữ liệu JSON gốc cất vào `<details>` nhỏ khi cần tra cứu kỹ thuật.
- **`UsersAdminPage.tsx` (`/admin/users`):** Tab lọc trạng thái nổi bật số người *Chờ duyệt*; giữ nổi nút **`Duyệt & Gán quyền`** / **`Sửa phân quyền`**, gom các thao tác phụ (*Khóa/Mở khóa, Thu hồi phiên, Đặt lại mật khẩu*) vào menu gọn gàng.
- **`RolesAdminPage.tsx` (`/admin/roles`):** Xóa 4 thẻ lý thuyết đầu trang và chữ `Grant Ceiling`; hiển thị ma trận vai trò chia theo 4 nhóm nghiệp vụ có biểu tượng dấu tích xanh trực quan.
- **`StorageAdminPage.tsx` (`/admin/storage`):** Đèn tín hiệu kết nối lưu trữ + Thanh đo dung lượng vùng đệm đổi màu trực quan + Cây thẻ **Shop & danh sách Kho** dễ thao tác.
- **Cụm Auth (`LoginPage`, `RegisterPage`, `ResetPasswordPage`, `PendingApprovalPage`, `MfaSecurityPage`):** Thẻ căn giữa sáng sủa, có nút hiện/ẩn mật khẩu, bỏ thuật ngữ `RFC 6238`, thêm nút sao chép nhanh bộ mã khôi phục dự phòng.

---

## 5. Ma trận Bảo toàn Hợp đồng Kiểm thử Tự động (Test Preservation Matrix)

| Nhóm Kiểm thử | File Test | Các `id` / `data-testid` / Nhãn bắt buộc giữ nguyên 100% |
| :--- | :--- | :--- |
| **Auth, Banner & Logout Guard** | `authGuardsAndFlows.test.tsx`, `authAndGovernance.spec.ts` | `storage-mode-banner` (chứa `"Chế độ thử nghiệm — lưu local"`, không chứa `"NAS"`), `#login-email`, `#login-password`, `#reg-name`, `#reg-email`, `#reg-password`, `#reg-confirm`, `.brand-badge` (`"Chờ phê duyệt"`), heading `"Bảng điều khiển vận hành"`, `"Tài khoản đang chờ phê duyệt"`, `"Đăng nhập hệ thống"`, `"Xác thực hai lớp (2FA)"`, dialog cảnh báo đăng xuất (`"Cảnh báo còn video chờ tải lên"`, `"Ở lại trang"`, `"Vẫn đăng xuất"`). |
| **Quét mã & Quay Video HUD** | `recordingFlow.test.tsx`, `recordUploadAndPlayback.spec.ts` | `scanner-view`, `scan-error-banner`, `recognized-tracking-banner`, `duplicate-recording-warning`, `linked-from-banner`, `video-import-panel`, `import-enqueued-banner`, `recording-session-stage`, `locked-tracking-number`, `recording-active-badge` (`"Đang quay"`), `recording-timer`, `recording-bytes`, `recording-completed-banner`, `recording-interrupted-banner`, `preflight-blocking-error`, `available-storage-chip`, `wakelock-status`, `encoder-mode-status`, các nút `"Xác nhận mã & Tạo phiên quay"`, `"Bắt đầu quay đóng gói"`, `"Kết thúc & Lưu video"`, `"Quét & Quay đơn tiếp theo"`, nhắc `"Giữ trang này đang mở trong khi quay"`. |
| **Hàng đợi Tải lên** | `tusQueueRecovery.test.tsx`, `recordUploadAndPlayback.spec.ts` | `queue-active-transfer-indicator`, `queue-paused-auth-banner`, `local-upload-queue-list`, `queue-item-*`, `capture-badge-*`, `storage-badge-*` (`"Đã lưu cục bộ (Local)"` / `"Đã lưu NAS"`), `upload-progress-*`, `upload-bytes-*`, `upload-percent-*`. |
| **Thư viện, Chi tiết & Phân quyền** | `videoLibraryAndDetail.test.tsx`, `permissionsAndHoldProtection.spec.ts`, `authAndGovernance.spec.ts` | Heading `"Thư viện video bằng chứng đóng gói"`, `#video-search-tracking`, tab `"Video của tôi"`, `.desktop-table-wrap`, `.mobile-card-list`, `.mono-code`, link `"Xem chi tiết"`, `detail-tracking-number`, `detail-capture-badge`, `detail-storage-badge`, `detail-source-badge`, `detail-interrupted-banner`, `detail-hold-banner`, `authenticated-video-player`, `video-playback-error`, `download-original-btn`, `rerecord-correct-code-link`, `request-delete-btn`, `delete-blocked-by-hold-notice`, `detail-sha256`, `#video-note-input`, `.note-item`, `"Giữ bằng chứng (Bật Hold)"`, `#hold-reason-textarea`, `"Xác nhận bật Hold"`, và hộp thoại `"Duyệt & Gán quyền"` trên `/admin/users`. |

