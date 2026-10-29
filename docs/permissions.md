# Tài liệu Tài khoản, Phân quyền, Phạm vi & Bảo mật Vận hành (`PackingProof Web`)

Tài liệu này mô tả chi tiết mô hình xác thực, phân quyền theo phạm vi tài nguyên (`Resource-Scoped RBAC`), trần cấp quyền (`Grant Ceiling`), thu hồi phiên tức thì, xác thực hai lớp (`TOTP 2FA`) và các quy tắc bảo toàn bằng chứng video trong **PackingProof Web**.

---

## 1. Quy trình Đăng ký, Bootstrap `SuperAdmin` & Trạng thái Tài khoản

1. **Đăng ký công khai (`/register`)**:
   - Người dùng chỉ nhập Họ tên, Email, Mật khẩu và Xác nhận mật khẩu.
   - Tài khoản mới luôn mang trạng thái `ApprovalStatus = PendingApproval`, **không** được tự chọn vai trò và **không** được tự tham gia Shop hay Kho.
   - Mọi request tới các API nghiệp vụ (`/api/recordings`, `/api/uploads`, `/api/videos`, `/api/shops`, `/api/dashboard`, `/api/admin`) từ tài khoản chưa ở trạng thái `Active` đều bị chặn bởi `ActiveAccountEnforcementMiddleware` với mã lỗi HTTP `403 ACCOUNT_NOT_ACTIVE`. Người dùng chỉ thấy màn hình **"Tài khoản đang chờ phê duyệt"**.
2. **Bootstrap `SuperAdmin` đầu tiên**:
   - Không có tài khoản hoặc mật khẩu mặc định gắn cứng trong source code.
   - Chỉ khi hệ thống chưa tồn tại bất kỳ `SuperAdmin` nào có phạm vi `All`, `SystemSeeder` mới đọc `INITIAL_ADMIN_EMAIL` và `INITIAL_ADMIN_PASSWORD` từ biến môi trường để khởi tạo `SuperAdmin` đầu tiên.
3. **Bảo vệ `SuperAdmin` cuối cùng**:
   - Hệ thống từ chối mọi thao tác tự khóa, tự hạ quyền hoặc thu hồi phạm vi `SuperAdmin (All)` của quản trị viên tối cao cuối cùng đang hoạt động (`LAST_SUPERADMIN_PROTECTED`), ngăn nguy cơ khóa trắng hệ thống.

---

## 2. Xác thực Cookie, CSRF, Thu hồi phiên tức thì & TOTP 2FA

### 2.1. Cookie phiên & Chống giả mạo CSRF
- Sử dụng ASP.NET Core Identity với mật khẩu băm chuẩn PBKDF2, giới hạn đăng nhập sai (khóa tạm thời sau 5 lần thử sai liên tiếp).
- Phiên đăng nhập lưu trong Cookie `HttpOnly`, `SameSite=Lax`, `Secure` bắt buộc trên môi trường Production (triển khai Frontend và API cùng origin qua HTTPS).
- Mọi request thay đổi dữ liệu (`POST`, `PUT`, `PATCH`, `DELETE`), bao gồm cả các request nhị phân của giao thức **`tus` (`/api/uploads`)**, đều bắt buộc gửi kèm header `X-CSRF-Token` hợp lệ. Middleware kiểm tra header `X-CSRF-Token` trên `/api/uploads` mà không đọc hay đệm (buffer) luồng body video.

### 2.2. Hiệu lực tức thì khi đổi quyền, khóa tài khoản hoặc thu hồi phiên (`SecurityStamp`)
- `ImmediateCookieEvents` đối chiếu `SecurityStamp`, trạng thái `ApprovalStatus == Active` và `LockoutEnd` trong cơ sở dữ liệu trên **mỗi request xác thực**.
- Khi quản trị viên đổi vai trò/phạm vi, khóa tài khoản hoặc bấm **"Thu hồi phiên"**, hệ thống xoay vòng `SecurityStamp` ngay lập tức.
- Hệ quả: **Ngay ở request kế tiếp** (kể cả một chunk `PATCH /api/uploads/{id}` đang tải dở hoặc một request `GET /api/videos/{id}/stream` HTTP Range đang phát), phiên cũ bị từ chối tức thì. Ở phía trình duyệt, `TusQueueManager` tự động tạm dừng hàng đợi upload mà **không làm mất dữ liệu chunks đã lưu trong IndexedDB**, cho phép nhân viên đăng nhập lại để tiếp tục nếu tài khoản hợp lệ.

### 2.3. Xác thực hai yếu tố (`TOTP 2FA`) & Khôi phục
- Các tài khoản quản trị (`SuperAdmin`, `Admin`) và nhân viên có thể bật **TOTP 2FA** (tương thích Google Authenticator, Microsoft Authenticator, Authy, 1Password) tại trang `/account/security`.
- Khi bật thành công, hệ thống cấp **10 mã khôi phục dùng một lần (`Recovery Codes`)**. Mỗi mã chỉ dùng được một lần khi mất thiết bị tạo mã TOTP.
- **Đặt lại mật khẩu khi chưa cấu hình SMTP**:
  - Nếu hệ thống chưa cấu hình máy chủ email (`SMTP_HOST` để trống), hệ thống **không** sinh đường dẫn giả và **không** ghi token ra log ứng dụng.
  - Thay vào đó, Quản trị viên có thẩm quyền trong phạm vi sử dụng chức năng **"Cấp mã đổi MK"** trên trang Quản trị người dùng (`/admin/users`) để sinh token khôi phục một lần hiển thị trực tiếp qua phiên HTTPS cho quản trị viên chuyển giao nội bộ an toàn; nhân viên dùng mã này tại `/reset-password`.

---

## 3. Danh mục 14 Quyền hạn ổn định (`Permissions`)

Mọi quyền không được cấp tường minh đều bị **từ chối mặc định (`Deny by default`)**:

| Mã Permission | Nhóm | Ý nghĩa nghiệp vụ |
| --- | --- | --- |
| `recording.create` | Quay đóng gói | Quét mã vận đơn, tạo phiên quay mới và ghi nhận sự kiện bắt đầu/kết thúc/gián đoạn |
| `recording.manual_code` | Quay đóng gói | Nhập mã vận đơn thủ công bằng bàn phím (mặc định **TẮT** cho Operator; khi dùng bắt buộc nhập lý do và ghi Audit) |
| `video.upload` | Tải lên & Nhập | Khởi tạo `UploadSession` và tải dữ liệu video qua giao thức `tus` cho phiên hợp lệ |
| `video.import` | Tải lên & Nhập | Tải lên tệp video có sẵn trên máy sau khi xác nhận mã vận đơn (mặc định **TẮT**; luôn gắn nhãn `Source = Imported`) |
| `video.view` | Tra cứu & Phát | Tìm kiếm danh sách video, xem chi tiết metadata và phát trực tuyến qua luồng xác thực HTTP Range |
| `video.download` | Tra cứu & Phát | Tải xuống tệp video gốc (`Content-Disposition: attachment`) — kiểm soát tách biệt khỏi quyền xem `video.view` |
| `video.note` | Đối chiếu | Thêm ghi chú nội bộ, mã khiếu nại hoặc biên bản đối chiếu vào hồ sơ video |
| `video.hold` | Đối chiếu | Bật/gỡ chế độ **Giữ bằng chứng (`Hold`)** để khóa video khỏi mọi yêu cầu xóa và dọn dẹp tự động |
| `video.delete.request` | Vòng đời & Xóa | Gửi yêu cầu xóa mềm video kèm lý do bắt buộc |
| `video.delete.approve` | Vòng đời & Xóa | Phê duyệt hoặc từ chối yêu cầu xóa video (thực hiện xóa mềm `Soft-Delete` có kiểm soát và ghi Audit) |
| `user.manage` | Quản trị | Xem danh sách, phê duyệt tài khoản mới, khóa/mở khóa, gán vai trò/phạm vi, thu hồi phiên và cấp mã đặt lại mật khẩu |
| `role.manage` | Quản trị | Tạo và cập nhật vai trò tùy chỉnh từ danh mục permission nằm trong trần quyền của người tạo |
| `storage.manage` | Quản trị hệ thống | Cấu hình chế độ lưu trữ, thư mục con cho từng Shop, kiểm tra kết nối NAS và bật/tắt chính sách `Retention` |
| `audit.view` | Kiểm toán | Tra cứu nhật ký kiểm toán (`AuditEvents`) trong phạm vi tài nguyên được cấp |

---

## 4. Các Cấp độ Phạm vi (`ScopeType`)

Quyền thực tế của người dùng là tổ hợp **`(Role -> Permissions) × Scope`**:

1. **`Own` (Cá nhân)**: Chỉ thao tác trên các bản ghi/video do chính tài khoản đó tạo ra (`OwnerUserId == CurrentUserId`) trong Shop (và Kho tùy chọn) được chỉ định.
2. **`Warehouse` (Theo Kho)**: Áp dụng cho toàn bộ dữ liệu thuộc một Kho đóng gói cụ thể (`ShopId` + `WarehouseId`).
3. **`Shop` (Theo Shop)**: Áp dụng cho toàn bộ các Kho và bản ghi thuộc một Shop cụ thể (`ShopId`).
4. **`All` (Toàn hệ thống)**: Áp dụng trên mọi Shop/Kho và cấu hình toàn cục — **chỉ dành riêng cho vai trò `SuperAdmin`**.

Một nhân viên có thể được gán nhiều dòng phạm vi khác nhau (ví dụ: là `Manager` tại `Kho TP.HCM 01` của `ShopA`, đồng thời là `Viewer` trên toàn `ShopB`). Hệ thống tính hợp (`Union`) các quyền hợp lệ trên đúng tài nguyên đang truy cập.

---

## 5. Ma trận 6 Vai trò Mặc định & Vai trò Tùy chỉnh

| Permission | `SuperAdmin` | `Admin` | `Manager` | `Operator` | `Viewer` | `Auditor` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| `recording.create` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `recording.manual_code` | ✅ | ✅ | ✅ | ❌ *(mặc định tắt)* | ❌ | ❌ |
| `video.upload` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `video.import` | ✅ | ✅ | ❌ | ❌ *(mặc định tắt)* | ❌ | ❌ |
| `video.view` | ✅ | ✅ | ✅ | ✅ *(thường scope `Own`)* | ✅ | ✅ |
| `video.download` | ✅ | ✅ | ❌ *(cấp riêng khi cần)* | ❌ | ❌ | ❌ |
| `video.note` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `video.hold` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `video.delete.request` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `video.delete.approve` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `user.manage` | ✅ | ✅ *(trong Shop)* | ❌ | ❌ | ❌ | ❌ |
| `role.manage` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `storage.manage` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `audit.view` | ✅ | ✅ *(trong Shop)* | ❌ | ❌ | ❌ | ✅ |

> **Tính bất biến của Nhật ký Kiểm toán (`AuditEvents`)**: Ngay cả `SuperAdmin` cũng **không** có API hay chức năng nào trên ứng dụng để chỉnh sửa hoặc xóa các bản ghi `AuditEvents`.

### Quy tắc Trần cấp quyền (`Grant Ceiling`)
Khi một người dùng có `user.manage` (ví dụ `Admin` của `ShopA`) duyệt tài khoản hoặc phân quyền cho nhân viên khác, backend kiểm tra nghiêm ngặt:
1. **Trần phạm vi (`Scope Ceiling`)**: Chỉ được cấp phạm vi nằm gọn bên trong phạm vi mà mình sở hữu `user.manage` (ví dụ `Admin` của `ShopA` không thể cấp quyền sang `ShopB` và không bao giờ được cấp `ScopeType.All`).
2. **Trần quyền hạn (`Permission Ceiling`)**: Mọi permission nằm trong vai trò đem gán đều phải là tập con của các permission mà người cấp đang sở hữu tại phạm vi đích. Do đó, `Admin` (vốn không có `storage.manage` và `role.manage`) **không thể** tự cấp vai trò `SuperAdmin` cho mình hoặc cho người khác. Mọi nỗ lực vượt trần đều bị từ chối với HTTP `403` và ghi vào `AuditEvents` (`Outcome = Denied`).

---

## 6. Minh bạch về Nguồn Video, Hạn chế Tải file của `Viewer` & Bảo vệ `Hold`

### 6.1. Nhập mã thủ công (`recording.manual_code`) & Bất biến mã vận đơn
- Quyền nhập mã bằng bàn phím mặc định **tắt** đối với nhân viên đóng gói (`Operator`) để buộc quét trực tiếp từ tem đơn hàng.
- Khi tài khoản được cấp `recording.manual_code` sử dụng tính năng này, hệ thống bắt buộc nhập lý do (`ManualEntryReason`) và lưu dấu vết rõ ràng trên chi tiết video lẫn `AuditEvents`.
- Mã vận đơn (`TrackingNumber`) của một phiên đã tạo là **bất biến**. Nếu nhân viên dán/quét nhầm tem, không được sửa đè mã cũ mà phải sử dụng luồng **"Quay lại bằng mã vận đơn đúng"** (`linkedFromRecordingId`) để tạo phiên mới có liên kết đối chiếu hai chiều.

### 6.2. Phân biệt `RecordedInBrowser` và `Imported` (`video.import`)
- Quyền `video.import` mặc định **tắt**. Khi được quản trị viên cấp cho các tình huống ngoại lệ, tệp tải lên luôn bị backend gắn cứng `Source = Imported` (hiển thị nhãn cảnh báo riêng trên danh sách và trang chi tiết, tách biệt hoàn toàn với `Source = RecordedInBrowser`).
- **Lưu ý trung thực về mặt kỹ thuật**: Trường `Source` (`RecordedInBrowser` so với `Imported`) cùng dấu thời gian máy chủ (`ServerReceivedAtUtc`) và mã băm `SHA-256` là **dữ liệu kiểm soát vận hành và tính toàn vẹn của tệp sau khi máy chủ tiếp nhận**, **không phải** bằng chứng mật mã học chứng minh tuyệt đối nội dung vật lý bên trong kiện hàng nếu thiết bị đầu cuối bị can thiệp có chủ đích.

### 6.3. Giới hạn chức năng tải file gốc đối với `Viewer`
- Tài khoản `Viewer` có `video.view` nhưng không có `video.download`: giao diện ẩn nút tải tệp gốc, thẻ `<video>` bật `controlsList="nodownload"`, và mọi lời gọi trực tiếp tới `GET /api/videos/{id}/download` đều bị backend từ chối với HTTP `403`.
- **Lưu ý trung thực về giới hạn trình duyệt web**: Khi trình duyệt đã được phép nhận các byte hình ảnh qua `GET /api/videos/{id}/stream` để giải mã và hiển thị lên màn hình cho `Viewer` xem, không một ứng dụng web nào có thể ngăn chặn tuyệt đối việc người xem dùng điện thoại khác quay lại màn hình, dùng phần mềm quay màn hình hệ điều hành hoặc trích xuất bộ đệm trình duyệt bằng công cụ kỹ thuật. Do đó, quyền `Viewer` chỉ nên cấp cho nhân sự được phép xem hình ảnh đơn hàng và mọi lượt truy cập đều được kiểm soát qua phiên đăng nhập.

### 6.4. Luồng Xóa hai bước (`Soft-Delete`) & Chế độ Giữ bằng chứng (`Hold`)
- Không nhân viên nào có thể xóa thẳng tệp video bằng một cú bấm. Việc xóa bắt buộc đi qua 2 bước: `video.delete.request` (tạo `DeletionRequest` kèm lý do) -> `video.delete.approve` (quản trị viên duyệt xóa mềm và ghi `AuditEvents`).
- Khi video đang bật **`Hold = true`** (ví dụ đơn hàng đang có khiếu nại hoàn tiền trên TikTok Shop):
  - Mọi yêu cầu tạo lệnh xóa mới (`POST /api/videos/{id}/deletion-requests`) bị chặn với HTTP `409 VIDEO_ON_HOLD`.
  - Mọi thao tác phê duyệt yêu cầu xóa đang chờ bị chặn với HTTP `409 VIDEO_ON_HOLD`.
  - Tiến trình dọn dẹp tự động theo thời hạn (`RetentionCleanupProcessor`, vốn mặc định **TẮT**) tự động bỏ qua toàn bộ video có `Hold = true` và ghi nhật ký bảo vệ bằng chứng.
