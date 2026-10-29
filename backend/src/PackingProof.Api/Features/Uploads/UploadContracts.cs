using PackingProof.Core.Enums;

namespace PackingProof.Api.Features.Uploads;

public sealed record CreateUploadSessionRequest(
    long ExpectedBytes,
    string? ClientSha256 = null);

public sealed record UploadSessionDto(
    Guid UploadSessionId,
    Guid RecordingId,
    string? TusResourceId,
    string? TusUploadUrl,
    long ExpectedBytes,
    long ReceivedBytes,
    int RecommendedChunkBytes,
    UploadSessionStatus SessionStatus,
    StorageStatus RecordingStorageStatus,
    DateTime ExpiresAtUtc);

