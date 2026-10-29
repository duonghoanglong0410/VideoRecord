using PackingProof.Api.Features.Auth;
using PackingProof.Core.Enums;

namespace PackingProof.Api.Features.Admin;

public sealed record GrantProposalDto(
    Guid RoleId,
    ScopeType ScopeType,
    Guid? ShopId = null,
    Guid? WarehouseId = null);

public sealed record ApproveUserRequest(
    IReadOnlyList<GrantProposalDto>? Grants = null,
    Guid? DefaultShopId = null,
    Guid? DefaultWarehouseId = null);

public sealed record UpdateUserGrantsRequest(
    IReadOnlyList<GrantProposalDto> Grants,
    Guid? DefaultShopId = null,
    Guid? DefaultWarehouseId = null);

public sealed record AdminUserSummaryDto(
    Guid Id,
    string Email,
    string FullName,
    ApprovalStatus ApprovalStatus,
    bool TwoFactorEnabled,
    bool IsLockedOut,
    bool ForcePasswordReset,
    Guid? DefaultShopId,
    Guid? DefaultWarehouseId,
    DateTime CreatedAtUtc,
    DateTime? ApprovedAtUtc,
    IReadOnlyList<UserGrantDto> Grants);

public sealed record PaginatedResponse<T>(
    IReadOnlyList<T> Items,
    int TotalCount,
    int Page,
    int PageSize);

public sealed record AdminPasswordResetInitiatedResponse(
    Guid UserId,
    string Email,
    string ResetToken,
    string Message);

public sealed record RoleDto(
    Guid Id,
    string Name,
    string Description,
    bool IsSystemRole,
    DateTime CreatedAtUtc,
    IReadOnlyList<string> Permissions);

public sealed record PermissionDto(
    string Code,
    string Group,
    string Description);

public sealed record UpsertCustomRoleRequest(
    string Name,
    string Description,
    IReadOnlyList<string> Permissions);

public sealed record AdminWarehouseStorageDto(
    Guid Id,
    Guid ShopId,
    string Code,
    string Name,
    bool IsActive,
    int PackingStationCount,
    DateTime CreatedAtUtc);

public sealed record AdminShopStorageDto(
    Guid Id,
    string Code,
    string Slug,
    string Name,
    string AllowedStorageSubdir,
    bool IsActive,
    DateTime CreatedAtUtc,
    IReadOnlyList<AdminWarehouseStorageDto> Warehouses);

public sealed record StagingUsageDto(
    long MaxStagingBytes,
    long DiskUsedBytes,
    long ReservedRemainingBytes,
    long TotalFootprintBytes,
    long AvailableBytes);

public sealed record AdminStorageOverviewDto(
    Guid ProfileId,
    string ProfileName,
    StorageMode StorageMode,
    bool ExpectedStorageIdConfigured,
    string MarkerFileName,
    int MaxRecordingSeconds,
    long MaxUploadBytes,
    int MaxLocalPendingRecordings,
    int UploadChunkBytes,
    bool EnableAudioRecording,
    bool RetentionEnabled,
    int RetentionDays,
    StagingUsageDto StagingUsage,
    IReadOnlyList<string> AllowedSubdirectories,
    IReadOnlyList<AdminShopStorageDto> Shops,
    DateTime UpdatedAtUtc);

public sealed record StorageHealthCheckResponseDto(
    StorageMode Mode,
    bool IsHealthy,
    bool RootExists,
    bool MarkerValid,
    bool CanReadWrite,
    long? AvailableFreeBytes,
    long? TotalCapacityBytes,
    bool IsLowSpaceWarning,
    string? CapacityWarningMessage,
    string? ErrorCode,
    string StatusMessage,
    DateTime CheckedAtUtc);

public sealed record ShopStorageSubdirUpdateDto(
    Guid ShopId,
    string AllowedStorageSubdir);

public sealed record UpdateAdminStorageRequest(
    int MaxRecordingSeconds,
    long MaxUploadBytes,
    int MaxLocalPendingRecordings,
    bool EnableAudioRecording,
    bool RetentionEnabled,
    int RetentionDays,
    bool ConfirmRetentionEnable = false,
    IReadOnlyList<ShopStorageSubdirUpdateDto>? ShopSubdirectories = null);

public sealed record CreateAdminShopRequest(
    string Code,
    string Name,
    string? Slug = null,
    string? AllowedStorageSubdir = null);

public sealed record CreateAdminWarehouseRequest(
    string Code,
    string Name,
    bool CreateDefaultStation = true);

public sealed record AuditEventDto(
    long Id,
    DateTime OccurredAtUtc,
    Guid? ActorUserId,
    string? ActorEmail,
    string Action,
    string EntityType,
    string? EntityId,
    Guid? ShopId,
    string? ShopName,
    Guid? WarehouseId,
    string? WarehouseName,
    AuditOutcome Outcome,
    string? IpAddress,
    string? UserAgent,
    string MetadataJson);


