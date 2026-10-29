# Danh mục Kiểm thử Thủ công trên Thiết bị Thật — PackingProof Web

> **Lưu ý quan trọng về tính trung thực nghiệm thu:**
> Kiểm thử tự động (Vitest / xUnit / Playwright với camera giả lập và mobile viewport) chỉ chứng minh tính đúng đắn của logic phần mềm, phân quyền và máy trạng thái, **không thay thế** việc kiểm chứng phần cứng camera, bộ mã hóa video phần cứng (`MediaRecorder`), giới hạn bộ nhớ và hành vi quản lý tiến trình nền trên **Chrome Android** và **Safari iPhone** thật.
> Chỉ đánh dấu `[x]` và điền vào bảng nhật ký cuối tài liệu sau khi đã thực hiện trực tiếp trên điện thoại vật lý qua kết nối HTTPS thật.

---

## 1. Điều kiện tiên quyết & Tin cậy Chứng chỉ HTTPS

- [ ] **Truy cập qua HTTPS có chứng chỉ được điện thoại tin cậy**:
  - Mở trang web bằng tên miền nội bộ/công khai qua `https://...` (chứng chỉ Let's Encrypt, CA doanh nghiệp hoặc Root CA nội bộ đã cài và bật tin cậy đầy đủ trong *Cài đặt -> Đã tải về hồ sơ -> Tin cậy chứng chỉ gốc* trên iOS / *CA Certificate* trên Android).
  - Xác nhận trình duyệt không hiện cảnh báo đỏ `Not Secure` và ứng dụng không báo lỗi `window.isSecureContext = false`.
  - *(Kiểm chứng đối chứng)*: Thử mở qua địa chỉ `http://192.168.x.x` (không HTTPS) trên điện thoại -> xác nhận màn hình **Quay đóng gói** chặn ngay từ bước kiểm tra môi trường với hướng dẫn tiếng Việt rõ ràng về yêu cầu HTTPS.
- [ ] **Chế độ lưu trữ hiển thị trung thực**:
  - Khi chạy `STORAGE_MODE=LocalDevelopment`: thanh cảnh báo đầu trang hiển thị rõ **"Chế độ thử nghiệm — lưu local"**, tuyệt đối không hiển thị "Đã lưu NAS".

---

## 2. Quyền Camera, Chọn ống kính, Đèn Flash & Chế độ Không thu âm

- [ ] **Cấp quyền Camera lần đầu**:
  - Đăng nhập tài khoản nhân viên (`Active`, có quyền `recording.create`), mở `/record`.
  - Trình duyệt hiển thị hộp thoại xin quyền Camera -> bấm **Cho phép (Allow)** -> khung ngắm mở đúng **camera sau** (`environment`).
- [ ] **Từ chối quyền Camera và khôi phục**:
  - Thử chặn quyền Camera trong cài đặt trang web của Chrome Android / Safari iPhone -> tải lại `/record` -> giao diện hiển thị thông báo tiếng Việt hướng dẫn mở lại quyền Camera và nút **Thử mở lại camera** hoạt động bình thường sau khi cấp lại quyền.
- [ ] **Chuyển đổi Camera trên máy nhiều ống kính**:
  - Trên điện thoại có nhiều camera sau (góc rộng / chính / tele), kiểm tra menu **Chọn camera** chuyển đúng ống kính, lấy nét rõ tem vận đơn ở khoảng cách 15–30 cm.
- [ ] **Đèn Flash (Torch)**:
  - Trên Chrome Android (ống kính sau có đèn LED hỗ trợ `torch`): nút **Bật đèn Flash / Tắt đèn Flash** hiển thị và bật/tắt đèn thật.
  - Trên thiết bị hoặc ống kính không hỗ trợ `torch` (ví dụ camera trước hoặc phiên bản Safari iOS không mở capability `torch`): nút đèn Flash **tự động ẩn**, không hiển thị nút chết.
- [ ] **Mặc định không thu âm & Fallback khi thiếu quyền Micro**:
  - Mặc định khi quay **không** hỏi quyền Microphone.
  - Khi cấu hình bật tùy chọn thu âm (`ENABLE_AUDIO_RECORDING=true`) và người dùng tích chọn thu âm nhưng bấm **Từ chối quyền Micro**: ứng dụng tự động chuyển sang quay video không tiếng kèm thông báo vàng rõ ràng, không làm hỏng phiên quay.

---

## 3. Quét Tem Đơn Hàng TikTok Thật (Mã vạch 1D & Mã QR)

- [ ] **Quét mã vạch 1D của nhiều đơn vị vận chuyển thực tế** (SPX Express, J&T, GHN, GHTK, Viettel Post, Best, Ninja Van...):
  - Nhận diện nhanh dưới ánh sáng bàn đóng gói thực tế (tem in nhiệt hơi bóng hoặc hơi nhăn).
  - **Mã bắt đầu bằng số `0`** (ví dụ `00123456789`): hiển thị và lưu chính xác chuỗi gốc có đầy đủ số `0` ở đầu, giữ nguyên chữ hoa/thường.
- [ ] **Chống nhận lặp liên tục (Debounce 2.5 giây)**:
  - Giữ nguyên tem trước camera sau khi đã nhận diện: giao diện không nhấp nháy hay gửi request kiểm tra lặp liên tục.
- [ ] **Quét mã QR chứa URL hoặc dữ liệu tổng hợp lạ trên tem**:
  - Đưa camera vào mã QR dẫn tới trang web (`https://...`) hoặc QR khuyến mãi/tra cứu không thuộc chuẩn vận đơn đã đăng ký: ứng dụng báo rõ **không nhận dạng được mã vận đơn từ QR**, hướng dẫn quét mã vạch 1D trên tem, **tuyệt đối không tự mở trình duyệt truy cập URL và không đoán bừa mã từ đường dẫn URL**.
- [ ] **Cảnh báo đơn hàng đã từng quay video**:
  - Quét lại một tem vận đơn đã có phiên quay trước đó trong cùng Shop: hiển thị cảnh báo màu vàng ghi rõ số phiên đã có, nhưng vẫn cho phép xác nhận tạo phiên quay mới độc lập (không ghi đè bản cũ).
- [ ] **Kiểm soát nhập mã thủ công**:
  - Tài khoản `Operator` mặc định: **không** thấy nút nhập mã thủ công.
  - Tài khoản được cấp quyền `recording.manual_code`: mở được hộp thoại nhập tay, bắt buộc nhập lý do rõ ràng mới tạo được phiên.

---

## 4. Phiên Quay Thực Tế 1 Phút / 5 Phút / 10 Phút & Quản lý Tài nguyên

- [ ] **Chuyển giao Camera đơn luồng (ZXing -> MediaRecorder)**:
  - Khi bấm **Xác nhận mã & Tạo phiên quay** rồi bấm **Bắt đầu quay đóng gói**: bộ quét mã dừng hẳn trước khi mở luồng ghi hình, không xảy ra lỗi treo camera (`NotReadableError`) trên cả Android và iPhone.
  - Nhãn đỏ **"Đang quay"**, đồng hồ đếm giây và nút **"Kết thúc & Lưu video"** chỉ xuất hiện sau khi camera thực sự bắt đầu ghi hình. Không có nút tạm dừng.
- [ ] **Quay thử nghiệm 1 phút**:
  - Đồng hồ thời gian và dung lượng **"Đã lưu tạm"** tăng đều mỗi giây; bấm **Kết thúc & Lưu video** chốt đủ những giây cuối cùng (kiểm tra bằng cách đọc rõ 3 giây cuối trước khi bấm dừng).
- [ ] **Quay thử nghiệm 5 phút liên tục**:
  - Máy không bị giật khung hình hoặc tràn RAM tab trình duyệt; dữ liệu được ghi tuần tự xuống IndexedDB thay vì dồn toàn bộ trong RAM.
- [ ] **Quay thử nghiệm chạm trần 10 phút (hoặc giới hạn `MAX_RECORDING_SECONDS` / `512 MiB`)**:
  - Khi còn 60 giây cuối (hoặc đạt >85% giới hạn dung lượng): hiển thị cảnh báo sắp chạm giới hạn.
  - Khi chạm đúng 10:00 (hoặc chạm ngưỡng dung lượng): hệ thống **tự động kết thúc có kiểm soát**, lưu trọn vẹn chunk cuối vào IndexedDB và đưa vào hàng đợi tải lên.

---

## 5. Xoay Hướng Màn Hình (Portrait & Landscape)

- [ ] **Chọn hướng trước khi quay**:
  - Thử quay 1 phiên ở chế độ **Khung dọc (Điện thoại đứng)** và 1 phiên ở chế độ **Khung ngang (Góc bàn rộng)** đặt trên giá đỡ bàn đóng gói.
  - Mọi nút thao tác chính (**Bắt đầu quay**, **Kết thúc & Lưu video**) đều có vùng chạm `>= 44px`, không bị che khuất bởi thanh điều hướng hệ điều hành hoặc tai thỏ (`safe-area-inset`).
- [ ] **Xoay ngang/dọc bất ngờ trong lúc đang quay**:
  - Kiểm tra khi vô tình xoay điện thoại giữa phiên quay: giao diện không bị vỡ bố cục, nút **Kết thúc & Lưu video** vẫn bấm được ngay lập tức và file video đầu ra không bị hỏng container.

---

## 6. Kịch bản Gián đoạn Thực tế trên Điện thoại

- [ ] **Cuộc gọi đến (GSM / Zalo / Messenger) khi đang quay**:
  - Gọi điện tới máy đang quay -> khi luồng camera bị hệ điều hành thu hồi hoặc tạm câm (`track.onended` / `track.onmute`), bộ đếm thời gian **dừng ngay lập tức** (không chạy ảo tiếp), phiên chuyển sang **"Phiên quay đã bị gián đoạn"** (`Interrupted`), giữ lại phần dữ liệu đã kịp lưu vào IndexedDB và không bao giờ gắn nhãn video hoàn chỉnh (`Captured`).
- [ ] **Chuyển ứng dụng (Vuốt về màn hình chính / Mở app khác)**:
  - Đang quay, vuốt chuyển sang ứng dụng khác rồi quay lại trình duyệt -> xác nhận trạng thái hiển thị trung thực nếu trình duyệt đã ngắt luồng ghi hình ở nền.
- [ ] **Khóa màn hình (Bấm nút nguồn hoặc để tự tắt màn hình)**:
  - Kiểm tra dòng trạng thái `Screen Wake Lock` khi đang quay.
  - Chủ động bấm nút nguồn khóa máy khi đang quay -> mở khóa lại -> phiên được đánh dấu **Bị gián đoạn** rõ ràng cùng thời điểm dừng thực tế.
- [ ] **Mất Wi-Fi / Chuyển mạng Wi-Fi sang 4G trong lúc quay và tải lên**:
  - Đang quay giữa chừng thì tắt Wi-Fi: quá trình quay và lưu tạm vào IndexedDB vẫn tiếp tục bình thường đến khi bấm **Kết thúc**.
  - Bật lại Wi-Fi: bản ghi trong **Hàng đợi tải lên** vẫn còn nguyên vẹn (ở Giai đoạn 3 sẽ tự động tiếp tục upload `tus` từ đúng byte offset trên server).
- [ ] **Tải lại trang (Reload) hoặc Đóng tab đột ngột khi đang quay**:
  - Đang ở trạng thái **Đang quay** được ~20 giây -> vuốt tải lại trang (F5 / Pull-to-refresh) hoặc đóng tab mở lại -> hệ thống tự động phát hiện phiên kẹt và chuyển sang **Bị gián đoạn (`Interrupted`)**, hiển thị cảnh báo rõ rằng không thể đảm bảo video hoàn chỉnh cho đến khi kiểm tra.
- [ ] **Cô lập đa tài khoản & Cảnh báo đăng xuất trên cùng điện thoại**:
  - Khi còn bản ghi chờ trên máy, bấm **Đăng xuất** -> hiện hộp thoại cảnh báo đúng số lượng bản ghi đang chờ.
  - Đăng nhập bằng tài khoản nhân viên B trên cùng trình duyệt điện thoại đó -> mở `/uploads` không nhìn thấy và không thao tác được bản ghi tạm của nhân viên A. Đăng nhập lại tài khoản A -> dữ liệu tạm của A vẫn còn nguyên.

---

## 7. Phát lại Video trên Thiết bị Khác (Cross-Device Playback)

- [ ] Video quay từ **Chrome Android** (thường xuất WebM VP8/VP9 hoặc MP4 AVC1) mở xem lại được trên:
  - [ ] Máy tính Windows / macOS (Chrome / Edge)
  - [ ] iPhone (Safari iOS — thông qua bản gốc tương thích hoặc bản xem `_preview.mp4` H.264 sau khi hoàn tất Giai đoạn 3–5)
- [ ] Video quay từ **Safari iPhone** (thường xuất MP4 H.264) mở xem lại được trên:
  - [ ] Máy tính Windows / macOS
  - [ ] Điện thoại Android (Chrome)
- [ ] Kiểm tra tua nhanh/lùi (`HTTP Range`), độ nét mã vận đơn khi soi cận cảnh trước ống kính và đúng chiều khung hình.

---

## 8. Bảng Nhật ký Thiết bị Đã Kiểm chứng Thực tế

> *Chỉ ghi thông tin thiết bị thật sau khi đã trực tiếp thực thi các mục trên. Hiện tại môi trường phát triển chỉ chạy kiểm thử tự động cục bộ nên bảng dưới đây để trống chờ nghiệm thu thiết bị vật lý.*

| Ngày kiểm tra | Thiết bị (Model) | Hệ điều hành (Phiên bản) | Trình duyệt (Phiên bản) | Định dạng MIME thực tế | Kết quả (Đạt / Ghi chú lỗi) | Người kiểm tra |
| --- | --- | --- | --- | --- | --- | --- |
| *(Chưa chạy trên máy thật)* | *(Ví dụ: Samsung Galaxy A54)* | *(Ví dụ: Android 15)* | *(Ví dụ: Chrome 135)* | *(Chờ ghi nhận)* | *(Chờ kiểm thử thiết bị thật)* | |
| *(Chưa chạy trên máy thật)* | *(Ví dụ: iPhone 14)* | *(Ví dụ: iOS 18.3)* | *(Ví dụ: Safari 18.3)* | *(Chờ ghi nhận)* | *(Chờ kiểm thử thiết bị thật)* | |

