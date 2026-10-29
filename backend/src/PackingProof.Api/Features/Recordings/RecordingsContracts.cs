using PackingProof.Core.Enums;
using PackingProof.Core.Tracking;

namespace PackingProof.Api.Features.Recordings;

public sealed record InspectTrackingCodeRequest(
    Guid ShopId,
    Guid WarehouseId,
    string RawCode,
    BarcodeFormatHint FormatHint = BarcodeFormatHint.Unknown);

public sealed record InspectTrackingCodeResponse(
    bool IsValid,
    string? TrackingNumber,
    string? CarrierCode,
    string? TikTokOrderId,
    string? MatchedRule,
    int ExistingRecordingCount,
    string? WarningMessage,
    string? ErrorCode = null,
    string? ErrorMessage = null);

public sealed record RecordingRuntimeLimitsDto(
    int MaxRecordingSeconds,
    long MaxUploadBytes,
    int MaxLocalPendingRecordings,
    bool EnableAudioRecording);

public sealed record CreateRecordingRequest(
    Guid ShopId,
    Guid WarehouseId,
    string RawCode,
    Guid? PackingStationId = null,
    BarcodeFormatHint FormatHint = BarcodeFormatHint.Unknown,
    bool IsManualEntry = false,
    string? ManualEntryReason = null,
    Guid? LinkedFromRecordingId = null,
    string? ClientMimeType = null);

public sealed record RecordingDto(
    Guid Id,
    Guid OwnerUserId,
    string OwnerEmail,
    string OwnerFullName,
    Guid ShopId,
    string ShopName,
    Guid WarehouseId,
    string WarehouseName,
    Guid? PackingStationId,
    string TrackingNumber,
    string SafeTrackingSegment,
    string? CarrierCode,
    string? TikTokOrderId,
    RecordingSource Source,
    string? ManualEntryReason,
    Guid? LinkedFromRecordingId,
    CaptureStatus CaptureStatus,
    StorageStatus StorageStatus,
    PreviewStatus PreviewStatus,
    string? ClientMimeType,
    double? DurationSeconds,
    DateTime? StartedAtUtc,
    DateTime? EndedAtUtc,
    DateTime? StoredAtUtc,
    bool Hold,
    string? LastErrorCode,
    string? UserSafeErrorMessage,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    bool IsRetryable = false,
    DateTime? ServerReceivedAtUtc = null,
    string? ActualContainer = null,
    string? VideoCodec = null,
    StorageMode? StorageMode = null);

public sealed record CreateRecordingResponse(
    RecordingDto Recording,
    int ExistingRecordingCount,
    string? WarningMessage,
    RecordingRuntimeLimitsDto Limits);

public sealed record RecordingEventRequest(
    string EventType,
    string? ClientMimeType = null,
    double? DurationSeconds = null,
    string? ErrorCode = null,
    string? Reason = null,
    string? TrackingNumber = null,
    string? StorageStatus = null);

public sealed record PagedRecordingsResponse(
    IReadOnlyList<RecordingDto> Items,
    int Page,
    int PageSize,
    int TotalCount,
    int TotalPages);

