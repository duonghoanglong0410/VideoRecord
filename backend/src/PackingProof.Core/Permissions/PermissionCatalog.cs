namespace PackingProof.Core.Permissions;

public sealed record PermissionDefinition(string Code, string Group, string Description);

public static class PermissionCatalog
{
    public const string RecordingCreate = "recording.create";
    public const string RecordingManualCode = "recording.manual_code";
    public const string VideoUpload = "video.upload";
    public const string VideoImport = "video.import";
    public const string VideoView = "video.view";
    public const string VideoDownload = "video.download";
    public const string VideoNote = "video.note";
    public const string VideoHold = "video.hold";
    public const string VideoDeleteRequest = "video.delete.request";
    public const string VideoDeleteApprove = "video.delete.approve";
    public const string UserManage = "user.manage";
    public const string RoleManage = "role.manage";
    public const string StorageManage = "storage.manage";
    public const string AuditView = "audit.view";

    public static readonly IReadOnlyList<PermissionDefinition> All =
    [
        new(RecordingCreate, "Quay & Tải lên", "Tạo phiên quay đóng gói mới từ mã vận đơn hợp lệ"),
        new(RecordingManualCode, "Quay & Tải lên", "Nhập mã vận đơn thủ công kèm lý do có kiểm toán"),
        new(VideoUpload, "Quay & Tải lên", "Tải dữ liệu video của phiên quay lên máy chủ"),
        new(VideoImport, "Quay & Tải lên", "Tải tệp video có sẵn lên hệ thống (gắn nguồn Imported)"),
        new(VideoView, "Tra cứu & Video", "Tìm kiếm, xem chi tiết và phát trực tuyến video trong phạm vi"),
        new(VideoDownload, "Tra cứu & Video", "Tải xuống tệp video gốc"),
        new(VideoNote, "Tra cứu & Video", "Thêm ghi chú nghiệp vụ vào bản ghi video"),
        new(VideoHold, "Tra cứu & Video", "Đánh dấu hoặc gỡ trạng thái giữ lại (Hold) bảo vệ video khiếu nại"),
        new(VideoDeleteRequest, "Xóa dữ liệu", "Tạo yêu cầu xóa bản ghi video"),
        new(VideoDeleteApprove, "Xóa dữ liệu", "Phê duyệt hoặc từ chối yêu cầu xóa bản ghi video"),
        new(UserManage, "Quản trị", "Duyệt, khóa, gán quyền/phạm vi và thu hồi phiên người dùng"),
        new(RoleManage, "Quản trị", "Xem ma trận quyền và quản lý vai trò tùy chỉnh trong giới hạn quyền"),
        new(StorageManage, "Quản trị", "Quản lý cấu hình lưu trữ NAS, kiểm tra kết nối và chính sách lưu giữ"),
        new(AuditView, "Quản trị", "Xem nhật ký kiểm toán (Audit Log) trong phạm vi được cấp")
    ];

    public static readonly IReadOnlySet<string> AllCodes =
        new HashSet<string>(All.Select(p => p.Code), StringComparer.Ordinal);

    public static bool IsValid(string code) => !string.IsNullOrWhiteSpace(code) && AllCodes.Contains(code);
}

