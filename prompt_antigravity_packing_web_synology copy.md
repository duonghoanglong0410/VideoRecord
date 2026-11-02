# PROMPT ANTIGRAVITY — WEB QUAY ĐÓNG GÓI VÀ LƯU VIDEO TRÊN SYNOLOGY

Bạn là kỹ sư full-stack chịu trách nhiệm xây dựng một ứng dụng chạy được, có backend thật, database thật, kiểm thử và hướng dẫn triển khai. Hãy đọc toàn bộ yêu cầu dưới đây, lập kế hoạch ngắn trong repository rồi triển khai lần lượt đến khi hoàn thành phạm vi đã nêu.

Tên làm việc: PackingProof Web. Giao diện và thông báo dành cho người dùng bằng tiếng Việt. Trả lời và viết tài liệu triển khai bằng tiếng Việt; tên biến, class, API dùng tiếng Anh.

## 1. Mục tiêu và phạm vi đã chốt

- Người dùng mở website trên điện thoại, đăng nhập, quét QR/mã vạch trên tem đơn TikTok để lấy mã vận đơn, sau đó quay quá trình đóng gói bằng camera điện thoại.
- Khi bấm kết thúc, hệ thống tự upload video, đặt tên có mã vận đơn và lưu vào NAS Synology theo đường dẫn cấu hình sẵn.
- Có đăng ký, đăng nhập, duyệt tài khoản, phân quyền linh hoạt, tìm kiếm và xem video trên điện thoại/máy tính.
- Nền tảng đã chọn là WEB. PWA để thêm vào màn hình chính là tiện ích bổ sung, không thay đổi giới hạn camera/upload của trình duyệt.
- Bản đầu hoạt động bằng mã vận đơn, độc lập với TikTok API. Chừa điểm mở rộng để liên kết DTD Commerce sau này; không tự thêm chức năng đồng bộ đơn hoặc kho hàng.
- Chưa biết model Synology, phiên bản DSM, địa chỉ NAS, thông tin đăng nhập, domain và hệ điều hành điện thoại. Tiếp tục phát triển bằng cấu hình local; để các thông số triển khai thực tế trong biến môi trường và tài liệu. Chỉ hỏi khi thực sự không thể tiếp tục phần việc đang làm.
- Những mặc định kỹ thuật dưới đây là quyết định triển khai cho bản đầu, cần ghi trong tài liệu để có thể chỉnh.

## 2. Công nghệ và cách tổ chức

Chọn kiến trúc modular monolith, gồm một API, một tiến trình xử lý nền và PostgreSQL. Tiến trình nền có thể chạy trong cùng dịch vụ ASP.NET Core ở bản đầu; hàng đợi phải lưu bền vững trong database.

| Thành phần | Công nghệ |
| --- | --- |
| Frontend | React, TypeScript, Vite; giao diện responsive ưu tiên điện thoại |
| Camera | getUserMedia và MediaRecorder |
| Quét mã | @zxing/browser; không phụ thuộc duy nhất vào BarcodeDetector |
| Lưu tạm thiết bị | IndexedDB; lưu cả bytes video và metadata, không chỉ upload URL |
| Upload | tus-js-client ở frontend, tusdotnet ở backend |
| API | ASP.NET Core trên .NET 10 LTS |
| Tài khoản | ASP.NET Core Identity, cookie xác thực và Authorization Policies |
| Database | PostgreSQL và Entity Framework Core |
| Kiểm tra media | ffprobe; FFmpeg để tạo bản xem MP4 khi cần |
| Kiểm thử | xUnit cho backend, Vitest cho frontend, Playwright cho các luồng trình duyệt |
| Triển khai | Docker Compose cho môi trường local/Linux; tài liệu chạy IIS nếu dùng Windows |

Dùng phiên bản stable tương thích, ghi phiên bản thực tế và commit lockfile. Không tự chuyển backend sang nền tảng khác. Một ứng dụng frontend dùng chung cho nhân viên, viewer và quản trị.

Cấu trúc đề xuất, điều chỉnh theo repository hiện có nếu cần:

- frontend/src/features/auth/: đăng nhập, đăng ký, trạng thái tài khoản.
- frontend/src/features/recording/: quét mã, camera, trạng thái quay.
- frontend/src/features/upload-queue/: IndexedDB, hàng đợi, khôi phục upload.
- frontend/src/features/videos/: danh sách, tìm kiếm, trình phát, chi tiết.
- frontend/src/features/admin/: tài khoản, vai trò, cấu hình, nhật ký.
- backend/src/PackingProof.Api/: API, auth, policies, các module nghiệp vụ.
- backend/src/PackingProof.Infrastructure/: EF Core, tus, storage, media và worker.
- backend/tests/: unit/integration tests cho quyền truy cập, upload và storage.
- frontend/tests/ và e2e/: kiểm thử frontend và luồng sử dụng.
- deploy/: Docker, reverse proxy và ví dụ cấu hình.
- docs/: thiết kế, kế hoạch, tiến độ, triển khai, kiểm thử và giới hạn.

Nếu workspace đã có code: đọc README, quy ước và cấu trúc trước; bảo toàn thay đổi của người dùng. Chỉ sửa những phần phục vụ project này.

## 3. Luồng quét mã và quay

1. Người dùng đăng nhập bằng tài khoản Active, được cấp quyền quay/upload và thuộc shop/kho hợp lệ.
2. Mở màn hình Quay đóng gói, kiểm tra HTTPS, quyền camera, khả năng ghi video và dung lượng lưu tạm.
3. Mở camera sau; cho chọn camera khi thiết bị có nhiều camera. Đèn flash chỉ hiển thị nếu thiết bị hỗ trợ.
4. Quét QR hoặc mã vạch. Chống nhận lặp cùng một mã liên tục và hiển thị mã vận đơn rõ ràng để xác nhận.
5. Backend kiểm tra mã và tạo RecordingId UUID. Bản đầu yêu cầu kết nối backend để bắt đầu phiên mới; mất mạng trong phiên đang quay được xử lý bằng lưu tạm.
6. Sau khi phiên được tạo, người dùng bấm Bắt đầu quay. Dừng decoder và quản lý stream camera đúng cách; không để hai bộ điều khiển camera tranh tài nguyên.
7. Chỉ hiển thị Đang quay khi MediaRecorder đã thực sự bắt đầu. Khóa mã vận đơn của phiên, hiển thị thời lượng, chỉ báo ghi hình và nút Kết thúc lớn.
8. Ghi nhận dữ liệu từ MediaRecorder theo từng chunk vào IndexedDB theo thứ tự. Không giữ toàn bộ video chỉ trong RAM.
9. Khi bấm Kết thúc, đợi chunk cuối và tất cả thao tác ghi IndexedDB hoàn tất, tạo manifest bản ghi, rồi tự enqueue upload.
10. Có thể quay đơn tiếp theo trong khi file trước upload nếu hàng đợi và dung lượng còn trong giới hạn. Mỗi thiết bị chỉ có một phiên quay đang hoạt động; chỉ upload một file tại một thời điểm ở bản đầu.

Quy tắc cho mã vận đơn:

- Không mặc định mọi QR chứa trực tiếp mã vận đơn: QR có thể là URL hoặc payload tổng hợp. Tạo parser có thể mở rộng theo mẫu tem/nhà vận chuyển.
- Khi chưa xác định được parser, yêu cầu quét đúng mã hoặc thông báo không nhận dạng được; không đoán mã và không tự truy cập URL nằm trong QR.
- Lưu giá trị mã gốc đã nhận dạng; giữ số 0 ở đầu, không ép thành số, không tự đổi hoa/thường nếu chưa có quy tắc nhà vận chuyển.
- Chuỗi mã tối đa 128 ký tự; từ chối ký tự điều khiển, ký tự phân cách đường dẫn và chuỗi không hợp lệ. Tên file an toàn do backend tạo riêng.
- Nhập mã thủ công là quyền riêng, mặc định tắt; khi được bật phải nhập lý do và lưu audit. Không cho dùng API upload để bỏ qua bước tạo phiên hợp lệ.
- Mã vận đơn khác với mã đơn TikTok. Hai trường dữ liệu phải tách biệt.
- Một mã vận đơn được có nhiều phiên quay. Cảnh báo đã có video, nhưng không ghi đè hoặc chặn việc quay lại hợp lệ.

## 4. Camera và giới hạn trình duyệt điện thoại

- Website triển khai thật bắt buộc HTTPS với chứng chỉ được điện thoại tin cậy. HTTP localhost trên máy dev không chứng minh được camera sẽ chạy khi điện thoại mở bằng IP LAN.
- Dùng MediaRecorder.isTypeSupported để chọn MIME/codec. Kiểm tra runtime và xử lý lỗi thiếu tài nguyên dù API báo hỗ trợ.
- Ưu tiên 1080p/30fps nếu thiết bị đáp ứng; fallback 720p/30fps. Chất lượng thực tế và bitrate phải được kiểm tra trên thiết bị, không chỉ dựa vào constraints yêu cầu.
- Mặc định không thu âm; có cấu hình cho phép bật microphone. Thiếu quyền mic không được làm hỏng chế độ quay không tiếng.
- Giới hạn mặc định có thể chỉnh: 10 phút/phiên, 512 MiB/file, tối đa 3 bản ghi đang chờ trên thiết bị. Cảnh báo trước giới hạn, cố gắng kết thúc file có kiểm soát khi đạt giới hạn.
- Không có nút tạm dừng ở bản đầu. Phiên bị gián đoạn có trạng thái riêng; không tự nối hai lần quay và trình bày như video liên tục.
- Dùng Screen Wake Lock nếu hỗ trợ, theo dõi lúc bị thu hồi và hiển thị trạng thái phù hợp. Không hứa ngăn được mọi lần khóa màn hình.
- Xử lý page visibility, camera track ended/mute, cuộc gọi, chuyển ứng dụng, reload, đóng tab và recorder error. Cố gắng lưu phần dữ liệu còn hợp lệ; đánh dấu Interrupted nếu có gián đoạn. Sau crash không mặc định rằng các chunk còn lại tạo thành video hoàn chỉnh.
- Trình duyệt có thể ngừng quay/upload khi ở nền. Không dùng PWA hoặc service worker như lời bảo đảm quay/upload nền liên tục.
- Khi quay, giao diện nhắc ngắn gọn giữ trang đang mở. Khi quay dừng bất thường, thông báo rõ thay vì tiếp tục chạy bộ đếm như vẫn ghi hình.
- Chuyển hướng màn hình phải được thử nghiệm; chọn hướng trước khi quay và giữ bố cục điều khiển sử dụng được.

## 5. Lưu tạm và upload có thể tiếp tục

IndexedDB lưu metadata theo UserId, RecordingId, seq, MIME, kích thước và trạng thái, cùng bytes từng chunk. Không lưu mật khẩu hoặc token đăng nhập ở đây.

- Serialize thao tác ghi chunk, đợi transaction commit trước khi báo đã lưu tạm. Chunk MediaRecorder không nhất thiết là file video độc lập và thời gian phát sinh chunk không chính xác tuyệt đối.
- Khi stop, ghép đúng thứ tự thành bản ghi có manifest; sử dụng byte count thực tế. Tách kích thước HTTP upload chunk khỏi chunk do MediaRecorder tạo.
- Kiểm tra storage estimate và xử lý QuotaExceededError. Đề nghị persistent storage khi hỗ trợ nhưng vẫn coi đó là cơ chế có thể bị từ chối.
- Mất hoặc bị xóa dữ liệu trình duyệt phải hiển thị đúng khả năng khôi phục; không hứa phục hồi video nếu bytes không còn.
- Bản ghi cục bộ gắn với tài khoản tạo. Tài khoản khác trên cùng trình duyệt không được xem, upload hoặc gán lại bản ghi đó. Cảnh báo còn file chờ khi đăng xuất; cho đăng nhập lại đúng tài khoản để tiếp tục.
- tus upload bắt đầu sau khi kết thúc và hoàn tất lưu cục bộ. Gợi ý HTTP chunk 5 MiB, retry tăng dần và dừng để người dùng xử lý nếu lỗi kéo dài.
- Lưu RecordingId, tus upload resource, fingerprint và tiến độ. Khi resume, lấy offset thật từ server; không lấy phần trăm cũ làm bằng chứng bytes đã được nhận.
- Server gắn upload với tài khoản, shop/kho và RecordingId đã xác thực; không tin owner, đường dẫn, quyền hay tên file từ upload metadata.
- Xác thực và phân quyền mọi request tus, bao gồm POST, HEAD, PATCH, DELETE và các extension được bật. Cấu hình CSRF phù hợp cho các request thay đổi dữ liệu dùng cookie.
- Server kiểm tra giới hạn dung lượng, định dạng/container thực tế và nội dung video; không chỉ kiểm tra phần mở rộng hoặc Content-Type từ client.
- Nếu phiên đăng nhập hết hạn, tạm dừng và yêu cầu đăng nhập lại để tiếp tục; giữ nguyên bytes đã lưu, không tạo video trùng.
- Double-click, retry, refresh hoặc callback hoàn tất lặp phải idempotent theo RecordingId và UploadSessionId. Mỗi phiên chỉ có một upload chính đang hoạt động.
- Hoàn tất tus chỉ có nghĩa Đã nhận trên máy chủ. Chỉ hiển thị Đã lưu NAS khi bước kiểm tra và lưu NAS thành công.

## 6. Kết nối và lưu Synology

Tạo abstraction IVideoStorage với các thao tác health check, write temporary, commit, read và delete có kiểm soát. Bản đầu triển khai storage qua filesystem; SMB/NFS được mount hoặc cấu hình ở hệ điều hành, không truyền tài khoản NAS xuống trình duyệt.

Hai chế độ chạy:

- LocalDevelopment: dùng thư mục local và badge rõ Chế độ thử nghiệm — lưu local. Không hiển thị Đã lưu NAS cho file local.
- SynologyMounted: dùng share thật. Nếu backend chạy trong Container Manager, bind mount shared folder vào container; nếu backend ở máy khác, dùng mount hoặc UNC path và tài khoản dịch vụ có quyền phù hợp.

Không tự giả định mọi model Synology đều chạy Container Manager hoặc đủ CPU/RAM. Chuẩn bị cả hướng dẫn NAS-hosted và server riêng; model/DSM quyết định lựa chọn cuối. NAS qua File Station API là extension sau, không cần triển khai adapter chưa dùng ở bản đầu.

Biến môi trường/configuration cần có:

- APP_PUBLIC_ORIGIN, DATABASE_CONNECTION, AUTH_COOKIE_NAME.
- STORAGE_MODE, NAS_ROOT_PATH, STORAGE_ID, STAGING_ROOT_PATH.
- MAX_RECORDING_SECONDS, MAX_UPLOAD_BYTES, MAX_LOCAL_PENDING_RECORDINGS.
- UPLOAD_CHUNK_BYTES, STAGING_MAX_BYTES, PROCESSING_CONCURRENCY.
- RETENTION_ENABLED, RETENTION_DAYS, INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD.

Giá trị bí mật chỉ ở environment/secret store và không xuất vào frontend, log hoặc source control. File .env.example chứa placeholder, không chứa tài khoản thật. Admin ứng dụng cấu hình thư mục con trong root được phép; uploader không được cung cấp đường dẫn tùy ý.

Đường dẫn tương đối mẫu:

    ShopA/2026/10/29/MAVANDON/MAVANDON_<RecordingId>.<ext>

Root do deployment cấu hình. Shop slug và mã vận đơn được tạo thành thành phần đường dẫn an toàn ở backend, không dùng trực tiếp chuỗi quét. RecordingId đầy đủ giúp tránh trùng tên. Ngày chia thư mục theo Asia/Ho_Chi_Minh; timestamp trong database lưu UTC.

Quy trình xử lý server:

1. Nhận đủ file vào vùng staging bền vững trên máy chủ; lưu ProcessingJob trong PostgreSQL.
2. Kiểm tra kích thước, media và SHA-256. Worker dùng lease/claim job để tránh hai tiến trình cùng xử lý một phiên.
3. Kiểm tra storage đúng vị trí bằng marker STORAGE_ID trên share cùng khả năng đọc/ghi. Nếu mount biến mất, không tự tạo thư mục local rồi coi đó là NAS.
4. Ghi file .partial vào chính share đích. Copy theo stream và bảo đảm dữ liệu được flush theo khả năng filesystem.
5. Đọc lại file đích, đối chiếu kích thước/hash; commit bằng rename trên cùng filesystem khi được hỗ trợ. Chỉ cập nhật Stored sau khi file đích đã được xác minh và hoàn tất commit.
6. Nếu file đích đã tồn tại: cùng RecordingId và hash thì reconcile; khác hash thì báo conflict, không overwrite.
7. Nếu NAS lỗi/đầy/mất kết nối: giữ staging, ghi lỗi rõ, retry có backoff. Giới hạn vùng staging; từ chối upload mới có kiểm soát khi không đủ chỗ.
8. Nếu server crash sau khi ghi NAS nhưng trước khi cập nhật database, lần chạy lại phải reconcile được, không nhân đôi hoặc ghi đè.
9. File NAS đã lưu nhưng tạm thời không đọc được phải hiện không khả dụng; không âm thầm đổi sang bản local chưa được xác minh.

Giữ bản gốc đúng định dạng. Nếu cần để phát trên trình duyệt đích, worker tạo bản xem MP4 H.264, AAC khi có âm thanh; giữ bản gốc và hash riêng. Dùng ProcessStartInfo.ArgumentList hoặc cách tương đương để gọi ffprobe/FFmpeg, không nội suy mã quét thành shell command.

Tách trạng thái đã lưu bản gốc khỏi trạng thái chuẩn bị bản xem. Trên NAS cấu hình hạn chế CPU/concurrency cho chuyển mã. Không đổi tên .webm thành .mp4 để giả chuyển định dạng.

Chỉ dọn bản tạm thiết bị sau khi server xác nhận Stored; dọn staging sau xác minh theo cấu hình. Tự động xóa video theo thời hạn mặc định TẮT. Khi bật, bỏ qua video đang hold/khiếu nại và ghi audit mọi thao tác xóa.

## 7. Tài khoản và phân quyền

Đăng ký gồm tên, email, mật khẩu, xác nhận mật khẩu. Tài khoản mới PendingApproval, chỉ xem thông báo chờ duyệt; không truy cập dữ liệu nghiệp vụ. Không cho tự chọn vai trò hoặc tự tham gia shop/kho. SuperAdmin đầu tiên được bootstrap bằng cấu hình an toàn, không qua đăng ký công khai và không có mật khẩu mặc định trong source.

Đăng nhập dùng Identity với password hashing, giới hạn thử sai, lockout, cookie HttpOnly/Secure/SameSite phù hợp, CSRF và thu hồi phiên. Triển khai frontend/API cùng origin để đơn giản hóa. Đổi quyền, khóa tài khoản hoặc thu hồi phiên phải có hiệu lực trên request tiếp theo sau khi thay đổi được lưu, kể cả request tus và phát video.

Đặt lại mật khẩu: dùng reset token và email provider khi đã cấu hình; nếu chưa có SMTP, cung cấp luồng admin khởi tạo đặt lại có kiểm soát, không dùng link/token giả hoặc log token production. Triển khai TOTP 2FA cho SuperAdmin/Admin và tài liệu bootstrap/khôi phục.

Phân quyền = hành động được cấp + phạm vi tài nguyên. Các scope: Own, Warehouse, Shop; All chỉ dành cho SuperAdmin. Các thao tác trên tài khoản/role cũng phải bị giới hạn scope và giới hạn quyền có thể cấp.

| Vai trò mặc định | Quyền |
| --- | --- |
| SuperAdmin | Toàn hệ thống, cấu hình storage, vai trò, chính sách và tài khoản; không chỉnh sửa/xóa nhật ký qua ứng dụng |
| Admin | Quản trị người dùng/video trong shop được giao; không tự cấp SuperAdmin, scope ngoài phạm vi hoặc quyền storage hệ thống |
| Manager | Xem video trong kho, ghi chú, đánh dấu hold và theo dõi hoạt động; quyền download cấp riêng |
| User/Operator | Quét, quay, upload và xem video của mình; không xóa bản gốc hoặc sửa mã vận đơn của phiên đã quay |
| Viewer | Tìm kiếm/xem video được cấp; không quay, upload, sửa, xóa hoặc sử dụng chức năng tải file gốc |
| Auditor | Xem video và audit trong scope; không sửa dữ liệu nghiệp vụ |

Danh mục permission ổn định:

    recording.create, recording.manual_code
    video.upload, video.import, video.view, video.download
    video.note, video.hold
    video.delete.request, video.delete.approve
    user.manage, role.manage, storage.manage, audit.view

Cho tạo role tùy chỉnh từ danh mục trên. Người cấp quyền chỉ được cấp quyền nằm trong grant ceiling và scope của mình. Không cho tự nâng quyền hoặc xóa/khóa SuperAdmin cuối cùng. Các permission không được cấp thì deny mặc định.

User có video.upload cho phiên hợp lệ của mình. video.import là tùy chọn mặc định tắt: khi bật cho phép tải file có sẵn sau khi xác nhận mã, nhưng phải gắn source=Imported khác source=RecordedInBrowser. Đây không phải chứng minh mật mã rằng video phản ánh đúng kiện hàng.

Xem, download, stream HTTP Range, thumbnail, danh sách, export dữ liệu, audit và tus đều kiểm tra quyền phía backend. Không phục vụ share NAS hoặc thư mục video như static public folder. Không trả đường dẫn vật lý/credentials cho client.

Viewer bị giới hạn chức năng tải file gốc trong app. Không mô tả cơ chế này là có thể ngăn tuyệt đối việc lưu lại nội dung đã được phát hoặc quay màn hình.

Luồng xóa dùng yêu cầu, duyệt và soft-delete trước. Không cho xóa video đang hold. Chia sẻ link công khai và tự động xuất video lên TikTok nằm ngoài bản đầu; không tạo nút không hoạt động.

## 8. Trạng thái, dữ liệu và API

Tách ba nhóm trạng thái:

- CaptureStatus: Created, Recording, Captured, Interrupted, Cancelled.
- StorageStatus: AwaitingUpload, Uploading, Validating, WaitingForStorage, CopyingToStorage, Stored, Failed.
- PreviewStatus: NotRequired, Pending, Processing, Ready, Failed.

Failed phải có ErrorCode, thông báo an toàn cho người dùng và Retryable. Một phiên Interrupted có thể giữ được video một phần nhưng không được hiển thị như Captured hoàn chỉnh. Không cho client tự đặt Stored hoặc quyết định quyền truy cập bằng status.

Model tối thiểu:

- Identity Users/Roles; Permissions; RolePermissions; UserScopeGrants.
- Shops, Warehouses và tùy chọn PackingStations.
- Recordings: Id, OwnerUserId, ShopId, WarehouseId, TrackingNumber, CarrierCode nullable, TikTokOrderId nullable, Source, CaptureStatus, StorageStatus, PreviewStatus, StartedAtUtc, EndedAtUtc, Duration, ActualMime, Hold, timestamps và concurrency token.
- UploadSessions: Id, RecordingId, TusResourceId, expected/received bytes, trạng thái, thời hạn.
- VideoAssets: Id, RecordingId, Kind Original/Preview, storage profile, relative path, MIME, bytes, SHA-256, verified timestamp.
- ProcessingJobs: RecordingId, loại job, trạng thái, attempt count, next attempt, lease owner/expiry, last error.
- VideoNotes, DeletionRequests, AuditEvents và StorageProfiles.

Unique RecordingId/TusResourceId và ràng buộc một asset gốc được commit cho mỗi phiên. Index tra cứu theo shop + mã vận đơn, thời gian, người tạo và trạng thái; không đặt mã vận đơn unique toàn hệ thống. Mọi danh sách phân trang và scope trước khi trả dữ liệu.

API tối thiểu, viết OpenAPI và mô tả request/response thực tế:

- /api/auth/register, login, logout, me, reset-password và các endpoint MFA.
- /api/recordings: tạo phiên, danh sách, chi tiết và các sự kiện started/captured/interrupted hợp lệ.
- /api/recordings/{id}/upload-session: tạo/lấy upload session idempotent đã gắn owner.
- /api/uploads: tus endpoint có xác thực/phân quyền đầy đủ.
- /api/videos/{id}/stream và /download: kiểm tra quyền, HTTP Range đúng; download có permission riêng.
- /api/videos/{id}/notes, /hold, /deletion-requests và API duyệt xóa.
- /api/admin/users, /roles, /permissions, /storage, /audit.
- /health/live và /health/ready: public chỉ trả trạng thái tối thiểu; chi tiết nội bộ chỉ cho admin.

Không tin timestamps, MIME hay thông tin nguồn client như bằng chứng độc lập. Server lưu thời gian nhận, kết quả validation và audit riêng. Giữ mã vận đơn của bản đã quay bất biến; sai mã thì tạo phiên mới và lưu liên kết/ghi chú có audit.

## 9. Giao diện phải có

1. Đăng nhập/đăng ký/quên mật khẩu/chờ duyệt/MFA.
2. Dashboard theo quyền, số liệu lấy từ database.
3. Quay đóng gói: camera chiếm phần chính, mã vận đơn nổi bật, nút bắt đầu/kết thúc lớn; trạng thái rõ bằng cả chữ và màu.
4. Hàng đợi upload: mã vận đơn, dung lượng, tiến độ gửi, trạng thái lưu NAS, lỗi và thử lại.
5. Video của tôi/danh sách video được phép xem: tìm chính xác hoặc theo phần mã, lọc ngày, kho, người tạo, trạng thái; phân trang.
6. Chi tiết video: trình phát, mã vận đơn, người quay, thời gian, nguồn, tình trạng gián đoạn, ghi chú, hold và thao tác đúng quyền.
7. Quản trị tài khoản: duyệt, khóa, scope, role và thu hồi phiên.
8. Quản trị vai trò: permission matrix, grant ceiling và giải thích scope.
9. Cấu hình lưu trữ: profile, thư mục con được phép, kiểm tra kết nối, cảnh báo dung lượng, cấu hình retention có xác nhận khi bật.
10. Audit log có bộ lọc trong phạm vi được cấp.

Thiết kế ưu tiên màn hình 360–430px, nút chạm tối thiểu 44px, safe area và bàn phím điện thoại. Desktop có bảng dữ liệu dễ tra cứu. Chọn giao diện sáng, xanh navy/cyan làm điểm nhấn. Không giả định cần dùng logo của thương hiệu khác.

Loading, empty, error, camera denied, codec unsupported, thiếu dung lượng và upload gián đoạn đều cần trạng thái sử dụng được. Các nút hiển thị phải có hành vi thật; không dùng số liệu giả như dữ liệu vận hành.

PWA chỉ cache app shell và tài nguyên tĩnh cần thiết. Không cache API riêng tư hoặc nội dung video bằng service worker; không hứa dùng đầy đủ khi ngoại tuyến. Bộ lưu tạm phiên quay được quản lý riêng trong IndexedDB theo tài khoản.

## 10. Kiểm thử bắt buộc và nghiệm thu

Viết kiểm thử có ý nghĩa cho những hành vi dưới đây. Unit/integration dùng storage test và database test tách biệt. Playwright với camera giả kiểm tra luồng logic; không coi mobile viewport là kiểm chứng camera Android/iPhone thật.

| Tình huống | Kết quả cần đạt |
| --- | --- |
| Chưa có mã vận đơn hợp lệ | Không bắt đầu quay hoặc tạo upload trái phép |
| Quét lặp, mã bắt đầu bằng số 0, QR là URL | Không tạo trùng, không mất số 0, không suy đoán mã từ URL |
| Mã chứa ../ hoặc ký tự nguy hiểm | Không thoát storage root, không chạy command hoặc truy cập URL quét |
| Quay bình thường | Đủ chunk cuối, đúng mã, media đọc được, lưu đúng thư mục |
| Hai lần quay cùng mã/hai người quay đồng thời | Có phiên riêng, không ghi đè |
| Mất Wi-Fi trong phiên hoặc upload | Dữ liệu đã lưu còn trong hàng đợi; upload tiếp đúng offset khi kết nối lại |
| Reload khi upload | Cùng người dùng khôi phục bytes và upload session hiện có nếu dữ liệu còn |
| Crash/đóng tab khi đang quay | Báo gián đoạn, không báo có video hoàn chỉnh nếu chưa xác minh |
| IndexedDB hết quota/dữ liệu bị xóa | Báo đúng lỗi, không mất dữ liệu âm thầm hoặc hứa khôi phục không thể thực hiện |
| Cookie hết hạn hoặc quyền bị thu hồi | Request tiếp theo bị chặn phù hợp, không mất bytes cục bộ đã lưu |
| Viewer gọi API upload/delete/download trực tiếp | Bị từ chối, không phụ thuộc ẩn nút |
| User A đọc stream/Range/thumbnail/tus URL của User B | Bị từ chối nếu không có scope hợp lệ |
| Admin tự cấp SuperAdmin hoặc mở rộng scope | Bị từ chối và có audit |
| NAS mất mount, đầy hoặc không có quyền ghi | Không báo Stored; giữ staging và xử lý lại được |
| Restart worker/callback lặp/crash sau commit NAS | Reconcile idempotent, không tạo asset trùng |
| Hash sai/file giả video/định dạng không hỗ trợ | Không đánh dấu lưu hợp lệ; có lỗi rõ |
| Preview cần chuyển mã | Giữ bản gốc; trạng thái bản xem độc lập, có thể phát khi hoàn tất |
| Retention hoặc yêu cầu xóa gặp video hold | Giữ video; lưu nhật ký quyết định |
| LocalDevelopment | UI ghi rõ lưu local, không tự nhận là NAS thật |

Chuẩn bị checklist kiểm tra thủ công trên Chrome Android và Safari iPhone: quyền camera, quét tem thật, quay 1/5/10 phút, xoay máy, cuộc gọi, chuyển ứng dụng, khóa màn hình, mất Wi-Fi, mở lại trang và phát video trên thiết bị khác. Ghi model/OS/browser thực tế khi đã thử.

Chạy build frontend/backend, typecheck, lint và test. Báo rõ từng kiểm thử đã chạy, kết quả và phần chưa thể chạy vì thiếu thiết bị/NAS. Không ghi đã kiểm chứng Synology hoặc điện thoại nếu chỉ dùng mock/local.

## 11. Triển khai và vận hành

- Docker Compose local phải có PostgreSQL, backend/worker, frontend/reverse proxy và volumes bền vững cho database/staging/storage test.
- Frontend và API cùng origin qua HTTPS ở môi trường điện thoại. Hướng dẫn cấu hình chứng chỉ/domain được thiết bị tin cậy; không hardcode domain hay chứng chỉ giả.
- Production SynologyMounted phải kiểm tra đúng share/storage marker trước khi cho phép xử lý lưu trữ. Tài khoản dịch vụ chỉ được quyền trên thư mục được cấu hình.
- Nếu chạy Windows/IIS, hướng dẫn dùng service identity truy cập UNC/SMB phù hợp; không dựa vào ổ đĩa map chỉ có trong phiên đăng nhập của cá nhân.
- Chuẩn bị mapping volumes cho Synology Container Manager nếu model hỗ trợ; database dùng volume bền vững phù hợp, không mặc định đặt PGDATA trên một SMB share từ máy khác.
- Nếu dùng reverse proxy/Cloudflare, cấu hình request size, timeout và phương thức tus theo hạ tầng thực tế; upload chia phần không bỏ qua mọi giới hạn của proxy.
- Tách NAS/DSM credentials khỏi app credentials; không mở SMB/DSM ra Internet để giải quyết upload web. Quyền truy cập từ xa đi qua ứng dụng HTTPS và cấu hình mạng phù hợp.
- Database, Identity Data Protection keys, cấu hình và video cần kế hoạch backup/restore. Có tài liệu đối chiếu metadata với file NAS sau khôi phục.
- Audit không ghi mật khẩu, cookie, NAS credentials, reset token hoặc nội dung QR chứa dữ liệu nhạy cảm không cần thiết.

## 12. Cách thực hiện trong Antigravity

Hãy thực hiện công việc theo các giai đoạn dưới đây. Mỗi giai đoạn cập nhật checklist, chạy kiểm tra liên quan, sửa lỗi rồi tiếp tục. Tự quyết các chi tiết kỹ thuật nhỏ trong phạm vi đã chốt; ghi lại giả định. Không dừng ở việc trả một bản kế hoạch hoặc dựng giao diện mẫu.

- [ ] Giai đoạn 1 — Nền tảng và quyền truy cập: khảo sát workspace; viết docs/design.md và docs/implementation-plan.md; dựng frontend/API/PostgreSQL; migrations; bootstrap admin; đăng ký chờ duyệt; auth và policy tests.
- [ ] Giai đoạn 2 — Quay trên web: màn hình scan, parser, tạo phiên, camera, IndexedDB và state machine; kiểm thử điều kiện bắt đầu, chunk cuối, quota và gián đoạn; chuẩn bị manual camera checklist.
- [ ] Giai đoạn 3 — Upload và storage: tus thật, resume, auth mọi thao tác, staging bền vững, worker idempotent, local adapter và SynologyMounted, checksum, media validation, retry và phục hồi sau restart.
- [ ] Giai đoạn 4 — Tra cứu và quản trị: video list/detail, phát Range, download riêng quyền, notes/hold, quản lý user/scope/role, audit, storage settings và deletion workflow.
- [ ] Giai đoạn 5 — Hoàn thiện: bản xem tương thích nếu cần; PWA app shell; kiểm thử tích hợp/E2E; Docker Compose; hướng dẫn NAS/IIS/HTTPS; báo cáo nghiệm thu và thông số còn thiếu để chạy thật.

Đầu ra phải gồm:

1. Source code frontend/backend hoàn chỉnh trong workspace, migrations và lockfiles.
2. README.md với lệnh cài, build, chạy, tạo admin đầu tiên và test chính xác.
3. .env.example không chứa bí mật và cấu hình local chạy được.
4. docs/design.md, docs/implementation-plan.md, docs/progress.md.
5. docs/permissions.md, docs/deploy-synology.md, docs/deploy-iis.md.
6. docs/test-report.md và docs/manual-device-checklist.md.
7. OpenAPI, cấu hình Docker Compose và health checks.

Trong kế hoạch, mỗi task phải nêu file/module, interface chính và kiểm thử chứng minh kết quả; không viết các bước mơ hồ như xử lý lỗi chung chung. Ưu tiên kiểm thử quyền truy cập, dữ liệu và khả năng phục hồi; không thêm test chỉ lặp lại chi tiết giao diện không có rủi ro.

Nếu môi trường thiếu dependency, thiết bị, Docker hoặc quyền kết nối NAS, hoàn thành những phần độc lập, ghi rõ blocker và lệnh/đầu vào cần người dùng cung cấp. Không tự tạo credentials, không giả kết quả test. Chỉ liệt kê một lần các thông tin triển khai thực sự còn thiếu ở báo cáo cuối.

Phạm vi hiện tại cho phép triển khai và kiểm thử trong workspace/local. Chuẩn bị cấu hình production để xem xét; không tự công khai website, thay đổi NAS thật, xóa dữ liệu thật hoặc đưa secrets vào repository.

Hãy bắt đầu bằng việc đọc workspace, xác nhận các giả định trong tối đa 10 dòng, ghi kế hoạch vào repository rồi thực hiện Giai đoạn 1 và tiếp tục các giai đoạn sau.

## 13. Tài liệu gốc để đối chiếu trong lúc triển khai

- Camera và HTTPS: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- Chunk và giới hạn MediaRecorder: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event
- Kiểm tra định dạng: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static
- Giới hạn lưu trữ trình duyệt: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- Giữ màn hình sáng: https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
- ZXing browser: https://github.com/zxing-js/browser
- tus protocol: https://tus.io/protocols/resumable-upload
- tus-js-client: https://github.com/tus/tus-js-client
- tusdotnet: https://github.com/tusdotnet/tusdotnet
- .NET support: https://dotnet.microsoft.com/en-us/platform/support/policy
- ASP.NET resource authorization: https://learn.microsoft.com/en-us/aspnet/core/security/authorization/resource-based?view=aspnetcore-10.0
- Synology Container Manager: https://www.synology.com/en-in/dsm/packages/ContainerManager

Đối chiếu phiên bản thực tế và tài liệu chính thức khi lập trình. Các tài liệu trên là điểm bắt đầu, không thay thế việc chạy kiểm thử và xác nhận cấu hình môi trường.
