using PackingProof.Api.Features.Recordings;
using PackingProof.Api.Features.Uploads;
using PackingProof.Core.Enums;
using PackingProof.Core.Tracking;

namespace PackingProof.Api.Features.Videos;

public sealed record VideoListItemDto(
    Guid Id,
    string TrackingNumber,
    string? CarrierCode,
    string? TikTokOrderId,
    Guid ShopId,
    string ShopName,
    Guid WarehouseId,
    string WarehouseName,
    Guid OwnerUserId,
    string OwnerEmail,
    string OwnerFullName,
    RecordingSource Source,
    bool IsManualCode,
    CaptureStatus CaptureStatus,
    StorageStatus StorageStatus,
    PreviewStatus PreviewStatus,
    StorageMode StorageMode,
    double? DurationSeconds,
    int? Width,
    int? Height,
    string? ActualMimeType,
    long? OriginalSizeBytes,
    bool HasPreviewAsset,
    bool Hold,
    string? HoldReason,
    int NoteCount,
    bool HasPendingDeletionRequest,
    DateTime? StartedAtUtc,
    DateTime? EndedAtUtc,
    DateTime? StoredAtUtc,
    DateTime CreatedAtUtc,
    string? LastErrorCode,
    string? UserSafeErrorMessage);

public sealed record PagedVideosResponse(
    IReadOnlyList<VideoListItemDto> Items,
    int Page,
    int PageSize,
    int TotalCount,
    int TotalPages);

public sealed record VideoNoteDto(
    Guid Id,
    Guid RecordingId,
    Guid AuthorUserId,
    string AuthorEmail,
    string AuthorFullName,
    string Content,
    DateTime CreatedAtUtc);

public sealed record VideoDeletionRequestSummaryDto(
    Guid Id,
    Guid RecordingId,
    Guid RequestedByUserId,
    string RequestedByEmail,
    string RequestedByFullName,
    string Reason,
    DeletionRequestStatus Status,
    Guid? ReviewedByUserId,
    string? ReviewedByEmail,
    string? ReviewedByFullName,
    string? ReviewNote,
    DateTime CreatedAtUtc,
    DateTime? ReviewedAtUtc);

public sealed record VideoDetailDto(
    Guid Id,
    string TrackingNumber,
    string? CarrierCode,
    string? TikTokOrderId,
    Guid ShopId,
    string ShopCode,
    string ShopName,
    Guid WarehouseId,
    string WarehouseCode,
    string WarehouseName,
    string? PackingStationName,
    Guid OwnerUserId,
    string OwnerEmail,
    string OwnerFullName,
    RecordingSource Source,
    bool IsManualCode,
    string? ManualEntryReason,
    Guid? LinkedFromRecordingId,
    string? LinkedFromTrackingNumber,
    CaptureStatus CaptureStatus,
    StorageStatus StorageStatus,
    PreviewStatus PreviewStatus,
    StorageMode StorageMode,
    double? DurationSeconds,
    int? Width,
    int? Height,
    string? ActualMimeType,
    string? ActualContainer,
    string? VideoCodec,
    string? AudioCodec,
    long? OriginalSizeBytes,
    string? OriginalSha256,
    bool HasOriginalAsset,
    bool HasPreviewAsset,
    long? PreviewSizeBytes,
    DateTime? StartedAtUtc,
    DateTime? EndedAtUtc,
    DateTime? ServerReceivedAtUtc,
    DateTime? StoredAtUtc,
    DateTime CreatedAtUtc,
    string? LastErrorCode,
    string? UserSafeErrorMessage,
    bool IsRetryable,
    bool Hold,
    string? HoldReason,
    Guid? HoldUpdatedByUserId,
    DateTime? HoldUpdatedAtUtc,
    IReadOnlyList<VideoNoteDto> Notes,
    IReadOnlyList<VideoDeletionRequestSummaryDto> DeletionRequests,
    bool CanDownload,
    bool CanNote,
    bool CanHold,
    bool CanRequestDelete,
    bool CanApproveDelete,
    bool CanReRecordWithCorrectCode);

public sealed record CreateVideoImportRequest(
    Guid ShopId,
    Guid WarehouseId,
    string? RawCode = null,
    string? TrackingNumber = null,
    BarcodeFormatHint FormatHint = BarcodeFormatHint.Unknown,
    bool IsManualEntry = false,
    string? ManualEntryReason = null,
    Guid? PackingStationId = null,
    Guid? LinkedFromRecordingId = null,
    string? ClientMimeType = null,
    long? ExpectedBytes = null,
    string? ClientSha256 = null);

public sealed record CreateVideoImportResponse(
    RecordingDto Recording,
    UploadSessionDto? UploadSession,
    int ExistingRecordingCount,
    string? WarningMessage,
    RecordingRuntimeLimitsDto Limits);

public sealed record CreateVideoNoteRequest(string Content);

public sealed record UpdateVideoHoldRequest(bool Hold, string? Reason = null);

public sealed record VideoHoldStateDto(
    Guid RecordingId,
    bool Hold,
    string? HoldReason,
    Guid? HoldUpdatedByUserId,
    DateTime? HoldUpdatedAtUtc);

public sealed record CreateDeletionRequestPayload(string Reason);

public sealed record ReviewDeletionRequestPayload(string? ReviewNote = null);

public sealed record DeletionRequestListItemDto(
    Guid Id,
    Guid RecordingId,
    string TrackingNumber,
    Guid ShopId,
    string ShopName,
    Guid WarehouseId,
    string WarehouseName,
    bool RecordingHold,
    string? RecordingHoldReason,
    bool RecordingIsSoftDeleted,
    Guid RequestedByUserId,
    string RequestedByEmail,
    string RequestedByFullName,
    string Reason,
    DeletionRequestStatus Status,
    Guid? ReviewedByUserId,
    string? ReviewedByEmail,
    string? ReviewedByFullName,
    string? ReviewNote,
    DateTime CreatedAtUtc,
    DateTime? ReviewedAtUtc);
