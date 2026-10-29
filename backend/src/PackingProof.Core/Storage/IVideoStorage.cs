using PackingProof.Core.Enums;

namespace PackingProof.Core.Storage;

public sealed record StorageHealthReport(
    StorageMode Mode,
    bool IsHealthy,
    bool RootExists,
    bool MarkerValid,
    bool CanReadWrite,
    string? ErrorCode,
    string? ErrorDetail,
    DateTime CheckedAtUtc);

public sealed record StoredFileReceipt(
    string RelativePath,
    long SizeBytes,
    string Sha256,
    bool ReconciledExisting,
    DateTime VerifiedAtUtc);

public interface IVideoStorage
{
    StorageMode Mode { get; }

    Task<StorageHealthReport> CheckHealthAsync(CancellationToken ct = default);

    Task<StoredFileReceipt> CommitFromStagingAsync(
        string stagingFilePath,
        string targetRelativePath,
        long expectedBytes,
        string expectedSha256,
        string leaseToken,
        CancellationToken ct = default);

    Task<Stream> OpenReadAsync(string relativePath, CancellationToken ct = default);

    Task<bool> DeleteIfExistsAsync(string relativePath, CancellationToken ct = default);
}

