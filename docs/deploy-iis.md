# Hướng dẫn Triển khai trên Windows Server & IIS Kết nối NAS Synology (`docs/deploy-iis.md`)

Tài liệu này hướng dẫn triển khai **PackingProof Web** trực tiếp trên máy chủ **Windows Server (2022 / 2025) sử dụng IIS** làm Reverse Proxy / In-Process Host và lưu trữ video sang NAS Synology qua đường dẫn mạng **UNC (`\\<IP-hoặc-Hostname-NAS>\PackingVideos`)**.

---

## 1. Yêu cầu Phần mềm trên Máy chủ Windows

1. **IIS (Internet Information Services)** với tính năng WebSocket & Static Content.
2. **.NET 10.0 Windows Server Hosting Bundle** (`dotnet-hosting-10.0.x-win.exe`) — cài đặt *sau khi* đã bật IIS để đăng ký mô-đun `AspNetCoreModuleV2`.
3. **PostgreSQL 18** (`postgresql-x64-18`) cài trên ổ đĩa SSD cục bộ của máy chủ Windows (hoặc máy chủ DB chuyên dụng qua mạng LAN tốc độ cao; **không** đặt thư mục `data` của PostgreSQL trên share SMB của NAS).
4. **FFmpeg & ffprobe (bản build 64-bit Windows)**:
   - Giải nén `ffmpeg.exe` và `ffprobe.exe` vào đường dẫn cố định (ví dụ `C:\Tools\ffmpeg\bin\`), cấp quyền `Read & Execute` cho tài khoản dịch vụ IIS.

---

## 2. Thiết lập Tài khoản Dịch vụ (`Service Identity`) Truy cập UNC Share NAS

> **CẢNH BÁO QUAN TRỌNG**:
> **TUYỆT ĐỐI KHÔNG** sử dụng ổ đĩa ánh xạ (`Mapped Network Drive` như `Z:\`) được tạo trong phiên Remote Desktop của cá nhân quản trị viên!
> Dịch vụ IIS chạy ở Session 0 không nhìn thấy ổ `Z:\` của phiên đăng nhập cá nhân, và ổ `Z:\` sẽ biến mất ngay khi máy chủ khởi động lại. Luôn sử dụng **tài khoản dịch vụ riêng + đường dẫn UNC trực tiếp (`\\nas-ip\PackingVideos`)**.

### Các bước cấu hình tài khoản dịch vụ chuẩn:
1. **Trong môi trường không có Active Directory (Workgroup)**:
   - Tạo cùng một tài khoản dịch vụ (cùng Username `svc_packingproof` và cùng mật khẩu mạnh không hết hạn đột ngột) trên **cả NAS Synology DSM** lẫn **Local Users của Windows Server**.
   - Trên Synology DSM: Chỉ cấp quyền `Read/Write` cho `svc_packingproof` trên duy nhất Shared Folder `PackingVideos`.
   - *(Nếu doanh nghiệp đã join cả Windows Server và Synology NAS vào cùng miền **Active Directory**, sử dụng tài khoản Domain Service Account hoặc gMSA `DOMAIN\svc_packingproof$`)*.
2. **Gán Identity cho IIS Application Pool**:
   - Mở **IIS Manager** -> **Application Pools** -> Tạo AppPool tên `PackingProofPool`:
     - **.NET CLR version**: `No Managed Code`
     - **Managed pipeline mode**: `Integrated`
   - Bấm chuột phải vào `PackingProofPool` -> **Advanced Settings** -> **Process Model -> Identity**:
     - Chọn **Custom account** -> Nhập `svc_packingproof` và mật khẩu.
     - Đặt **Load User Profile** = `True`.
3. **Phân quyền thư mục cục bộ trên Windows Server cho `svc_packingproof`**:
   - Tạo các thư mục cục bộ trên ổ đĩa nhanh (ví dụ ổ `D:\` hoặc `C:\`):
     - `C:\inetpub\packingproof\app` *(chứa mã publish Backend + `wwwroot` Frontend)* -> Quyền `Read & Execute`.
     - `D:\PackingProofData\staging` *(vùng đệm nhận upload `tus`)* -> Quyền `Modify / Read & Write`.
     - `D:\PackingProofData\dataprotection-keys` *(lưu khóa mã hóa cookie & TOTP)* -> Quyền `Modify / Read & Write` (chỉ `svc_packingproof` và `Administrators` được đọc!).
4. **Kiểm tra tệp định danh `.packingproof-storage-id` trên UNC Share**:
   - Đảm bảo tại `\\<NAS_HOST>\PackingVideos\.packingproof-storage-id` đã có tệp chứa đúng mã định danh (ví dụ `synology-kho-hcm-prod-01`) không xuống dòng thừa.

---

## 3. Đóng gói (Publish) Ứng dụng Single-Origin cho IIS

Thực hiện build cả Frontend và Backend thành một gói triển khai cùng origin (`PackingProof.Api` tự động phục vụ giao diện SPA từ thư mục `wwwroot`):

```powershell
# 1. Build Frontend React PWA
npm --prefix frontend ci
npm --prefix frontend run build

# 2. Publish Backend .NET 10 ở chế độ Release
dotnet restore backend/PackingProof.slnx --locked-mode
dotnet publish backend/src/PackingProof.Api/PackingProof.Api.csproj -c Release -o ./publish/iis

# 3. Đưa bản build Frontend vào thư mục wwwroot của gói publish
New-Item -ItemType Directory -Force -Path ./publish/iis/wwwroot | Out-Null
Copy-Item -Path ./frontend/dist/* -Destination ./publish/iis/wwwroot -Recurse -Force
```

Sao chép toàn bộ nội dung `./publish/iis/*` vào `C:\inetpub\packingproof\app` trên máy chủ Windows.

---

## 4. Cấu hình `web.config` cho `tus` Resumable Upload & Dung lượng Tệp Lớn

Mặc định IIS giới hạn kích thước request ở mức **30 MB** (`maxAllowedContentLength = 30000000`) và một số module WebDAV mặc định của IIS có thể chặn các phương thức `PATCH` / `DELETE` của giao thức `tus`.

Tại `C:\inetpub\packingproof\app\web.config`, đảm bảo cấu hình chuẩn như sau (gỡ `WebDAVModule`, nâng `maxAllowedContentLength` lên ~600 MiB = `629145600` bytes và khai báo biến môi trường hoặc nạp từ System/AppPool Environment):

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <modules>
        <!-- Gỡ WebDAVModule nếu máy chủ có cài sẵn để không chặn HTTP PATCH/DELETE của tus -->
        <remove name="WebDAVModule" />
      </modules>

      <security>
        <requestFiltering>
          <!-- Cho phép request lên tới 600 MiB (vượt ngưỡng MAX_UPLOAD_BYTES = 512 MiB) -->
          <requestLimits maxAllowedContentLength="629145600" />
          <verbs allowUnlisted="true">
            <add verb="GET" allowed="true" />
            <add verb="POST" allowed="true" />
            <add verb="PUT" allowed="true" />
            <add verb="PATCH" allowed="true" />
            <add verb="HEAD" allowed="true" />
            <add verb="DELETE" allowed="true" />
            <add verb="OPTIONS" allowed="true" />
          </verbs>
        </requestFiltering>
      </security>

      <handlers>
        <remove name="WebDAV" />
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>

      <aspNetCore processPath="dotnet"
                  arguments=".\PackingProof.Api.dll"
                  stdoutLogEnabled="false"
                  stdoutLogFile="\\?\%home%\LogFiles\stdout"
                  hostingModel="inprocess">
        <environmentVariables>
          <environmentVariable name="ASPNETCORE_ENVIRONMENT" value="Production" />
          <environmentVariable name="APP_PUBLIC_ORIGIN" value="https://packing.ten-mien-cua-ban.vn" />
          <environmentVariable name="STORAGE_MODE" value="SynologyMounted" />
          <environmentVariable name="NAS_ROOT_PATH" value="\\192.168.1.50\PackingVideos" />
          <environmentVariable name="STORAGE_ID" value="synology-kho-hcm-prod-01" />
          <environmentVariable name="STAGING_ROOT_PATH" value="D:\PackingProofData\staging" />
          <environmentVariable name="DATA_PROTECTION_KEYS_PATH" value="D:\PackingProofData\dataprotection-keys" />
          <environmentVariable name="FFPROBE_PATH" value="C:\Tools\ffmpeg\bin\ffprobe.exe" />
          <environmentVariable name="FFMPEG_PATH" value="C:\Tools\ffmpeg\bin\ffmpeg.exe" />
          <environmentVariable name="PROCESSING_CONCURRENCY" value="2" />
          <environmentVariable name="RETENTION_ENABLED" value="false" />
        </environmentVariables>
      </aspNetCore>
    </system.webServer>
  </location>
</configuration>
```

> **Bảo mật chuỗi kết nối & mật khẩu**: Không lưu `DATABASE_CONNECTION` và `INITIAL_ADMIN_PASSWORD` vào kho mã nguồn. Trên Windows Server, hãy cấu hình các biến nhạy cảm này trong **IIS Manager -> Configuration Editor (`system.webServer/aspNetCore/environmentVariables`)** hoặc biến môi trường cấp AppPool/Machine với phân quyền NTFS chỉ cho phép `svc_packingproof` và `Administrators` truy cập. Xóa `INITIAL_ADMIN_PASSWORD` sau khi đã đăng nhập `SuperAdmin` lần đầu và bật TOTP 2FA.

---

## 5. Cấu hình HTTPS Binding & Kiểm tra Sau Triển khai

1. **Gắn chứng chỉ HTTPS trong IIS**:
   - Cài đặt chứng chỉ TLS hợp lệ (file `.pfx` từ Let's Encrypt `win-acme` / Certify The Web hoặc CA doanh nghiệp được điện thoại Android & iPhone tin cậy) vào kho **Local Machine -> Web Hosting / Personal**.
   - Trong IIS -> chuột phải vào Website `PackingProof` -> **Edit Bindings** -> Thêm `https`, Port `443`, Host name `packing.ten-mien-cua-ban.vn`, tích chọn **Require Server Name Indication (SNI)** và chọn chứng chỉ TLS.
   - Chuyển hướng cổng `80` sang `https://` bằng IIS URL Rewrite.
2. **Kiểm tra vận hành ngay sau khi khởi động Website**:
   - Mở `https://packing.ten-mien-cua-ban.vn/health/ready` -> Xác nhận trả về HTTP `200` (`Healthy`).
   - Đăng nhập bằng `SuperAdmin` -> Mở `/admin/storage` -> Bấm **"Kiểm tra kết nối lưu trữ ngay"**:
     - Xác nhận hệ thống đọc thành công `\\<NAS_IP>\PackingVideos\.packingproof-storage-id`, ghi thử file kiểm tra thành công và không còn hiển thị cảnh báo chế độ lưu cục bộ.
   - Mở trang `/record` trên điện thoại thật kết nối Wi-Fi kho -> Xác nhận trình duyệt xin quyền camera qua HTTPS và quay thử 1 video kiểm tra đầu-cuối.
