namespace PackingProof.Core.Permissions;

public sealed record SystemRoleDefinition(
    string Name,
    string Description,
    IReadOnlyList<string> DefaultPermissions);

public static class SystemRoles
{
    public const string SuperAdmin = "SuperAdmin";
    public const string Admin = "Admin";
    public const string Manager = "Manager";
    public const string Operator = "Operator";
    public const string Viewer = "Viewer";
    public const string Auditor = "Auditor";

    public static readonly IReadOnlyList<SystemRoleDefinition> All =
    [
        new(
            SuperAdmin,
            "Quản trị toàn hệ thống, cấu hình lưu trữ, vai trò, chính sách và tài khoản; không chỉnh sửa/xóa nhật ký kiểm toán.",
            [
                PermissionCatalog.RecordingCreate,
                PermissionCatalog.RecordingManualCode,
                PermissionCatalog.VideoUpload,
                PermissionCatalog.VideoImport,
                PermissionCatalog.VideoView,
                PermissionCatalog.VideoDownload,
                PermissionCatalog.VideoNote,
                PermissionCatalog.VideoHold,
                PermissionCatalog.VideoDeleteRequest,
                PermissionCatalog.VideoDeleteApprove,
                PermissionCatalog.UserManage,
                PermissionCatalog.RoleManage,
                PermissionCatalog.StorageManage,
                PermissionCatalog.AuditView
            ]),
        new(
            Admin,
            "Quản trị người dùng và video trong shop được giao; không tự cấp SuperAdmin, phạm vi ngoài shop hoặc quyền lưu trữ hệ thống.",
            [
                PermissionCatalog.RecordingCreate,
                PermissionCatalog.RecordingManualCode,
                PermissionCatalog.VideoUpload,
                PermissionCatalog.VideoImport,
                PermissionCatalog.VideoView,
                PermissionCatalog.VideoDownload,
                PermissionCatalog.VideoNote,
                PermissionCatalog.VideoHold,
                PermissionCatalog.VideoDeleteRequest,
                PermissionCatalog.VideoDeleteApprove,
                PermissionCatalog.UserManage,
                PermissionCatalog.RoleManage,
                PermissionCatalog.AuditView
            ]),
        new(
            Manager,
            "Xem video trong kho, thêm ghi chú, đánh dấu giữ lại (Hold) và theo dõi hoạt động; quyền tải tệp gốc được cấp riêng.",
            [
                PermissionCatalog.VideoView,
                PermissionCatalog.VideoNote,
                PermissionCatalog.VideoHold,
                PermissionCatalog.VideoDeleteRequest,
                PermissionCatalog.AuditView
            ]),
        new(
            Operator,
            "Quét mã, quay đóng gói, tải lên và xem video của mình; mặc định tắt nhập mã thủ công và tải tệp có sẵn.",
            [
                PermissionCatalog.RecordingCreate,
                PermissionCatalog.VideoUpload,
                PermissionCatalog.VideoView,
                PermissionCatalog.VideoNote
            ]),
        new(
            Viewer,
            "Tìm kiếm và phát video trong phạm vi được cấp; không quay, tải lên, sửa, xóa hoặc tải tệp gốc.",
            [
                PermissionCatalog.VideoView
            ]),
        new(
            Auditor,
            "Xem video và nhật ký kiểm toán trong phạm vi được cấp; không sửa đổi dữ liệu nghiệp vụ.",
            [
                PermissionCatalog.VideoView,
                PermissionCatalog.AuditView
            ])
    ];
}

