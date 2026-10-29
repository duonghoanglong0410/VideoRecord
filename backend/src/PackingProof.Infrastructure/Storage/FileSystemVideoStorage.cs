using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using PackingProof.Core.Enums;
using PackingProof.Core.Storage;
using PackingProof.Core.Tracking;
using PackingProof.Infrastructure.Configuration;

namespace PackingProof.Infrastructure.Storage;

public sealed class FileSystemVideoStorage : IVideoStorage
{
    public const string StorageMarkerFileName = ".packingproof-storage-id";
    private const int StreamBufferBytes = 131_072;

    private readonly PackingProofOptions _options;
    private readonly ILogger<FileSystemVideoStorage> _logger;

    public FileSystemVideoStorage(
        PackingProofOptions options,
        ILogger<FileSystemVideoStorage> logger)
    {
        _options = options;
        _logger = logger;
    }

    public StorageMode Mode => _options.StorageMode;

    public async Task<StorageHealthReport> CheckHealthAsync(CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        string fullRoot;

        try
        {
            fullRoot = Path.GetFullPath(_options.NasRootPath);
        }
        catch (Exception ex)
        {
            return new StorageHealthReport(
                Mode: _options.StorageMode,
                IsHealthy: false,
                RootExists: false,
                MarkerValid: false,
                CanReadWrite: false,
                ErrorCode: "STORAGE_PATH_INVALID",
                ErrorDetail: ex.Message,
                CheckedAtUtc: now);
        }

        if (_options.StorageMode == StorageMode.LocalDevelopment)
        {
            try
            {
                Directory.CreateDirectory(fullRoot);
                await EnsureLocalDevelopmentMarkerAsync(fullRoot, ct);
                var canRw = await ProbeReadWriteCapabilityAsync(fullRoot, ct);
                return new StorageHealthReport(
                    Mode: StorageMode.LocalDevelopment,
                    IsHealthy: canRw,
                    RootExists: true,
                    MarkerValid: true,
                    CanReadWrite: canRw,
                    ErrorCode: canRw ? null : "LOCAL_STORAGE_WRITE_FAILED",
                    ErrorDetail: canRw ? null : "Unable to write/read probe file in local storage root.",
                    CheckedAtUtc: now);
            }
            catch (Exception ex)
            {
                return new StorageHealthReport(
                    Mode: StorageMode.LocalDevelopment,
                    IsHealthy: false,
                    RootExists: Directory.Exists(fullRoot),
                    MarkerValid: false,
                    CanReadWrite: false,
                    ErrorCode: "LOCAL_STORAGE_UNAVAILABLE",
                    ErrorDetail: ex.Message,
                    CheckedAtUtc: now);
            }
        }

        // SynologyMounted mode: NEVER auto-create NAS_ROOT_PATH!
        if (!Directory.Exists(fullRoot))
        {
            return new StorageHealthReport(
                Mode: StorageMode.SynologyMounted,
                IsHealthy: false,
                RootExists: false,
                MarkerValid: false,
                CanReadWrite: false,
                ErrorCode: "NAS_STORAGE_MARKER_INVALID",
                ErrorDetail: "Configured NAS_ROOT_PATH directory does not exist (mount missing).",
                CheckedAtUtc: now);
        }

        var (markerValid, markerError) = await ValidateSynologyMarkerAsync(fullRoot, ct);
        if (!markerValid)
        {
            return new StorageHealthReport(
                Mode: StorageMode.SynologyMounted,
                IsHealthy: false,
                RootExists: true,
                MarkerValid: false,
                CanReadWrite: false,
                ErrorCode: "NAS_STORAGE_MARKER_INVALID",
                ErrorDetail: markerError,
                CheckedAtUtc: now);
        }

        var writable = await ProbeReadWriteCapabilityAsync(fullRoot, ct);
        return new StorageHealthReport(
            Mode: StorageMode.SynologyMounted,
            IsHealthy: writable,
            RootExists: true,
            MarkerValid: true,
            CanReadWrite: writable,
            ErrorCode: writable ? null : "NAS_WRITE_UNAVAILABLE",
            ErrorDetail: writable ? null : "Read/write verification probe failed on Synology share.",
            CheckedAtUtc: now);
    }

    public async Task<StoredFileReceipt> CommitFromStagingAsync(
        string stagingFilePath,
        string targetRelativePath,
        long expectedBytes,
        string expectedSha256,
        string leaseToken,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(stagingFilePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(targetRelativePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedSha256);

        if (expectedBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(expectedBytes), "Expected bytes must be positive.");
        }

        var normalizedExpectedHash = expectedSha256.Trim().ToLowerInvariant();
        var fullRoot = await EnsureVerifiedRootForWriteAsync(ct);

        var relativeSegments = SplitAndValidateRelativeSegments(targetRelativePath);
        var canonicalRelativePath = string.Join('/', relativeSegments);
        var targetFullPath = PathSegmentSanitizer.CombineWithinRoot(fullRoot, relativeSegments);

        // Step 2: Crash recovery — check if final destination file already exists on the share
        if (File.Exists(targetFullPath))
        {
            return await ReconcileOrThrowConflictAsync(
                targetFullPath,
                canonicalRelativePath,
                expectedBytes,
                normalizedExpectedHash,
                ct);
        }

        var targetDirectory = Path.GetDirectoryName(targetFullPath)
            ?? throw new InvalidOperationException("Target file path has no parent directory.");

        // Safe to create subdirectories underneath fullRoot because EnsureVerifiedRootForWriteAsync
        // already verified fullRoot exists AND .packingproof-storage-id matches STORAGE_ID!
        try
        {
            Directory.CreateDirectory(targetDirectory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StorageUnavailableException(
                "NAS_WRITE_UNAVAILABLE",
                "Không thể tạo thư mục lưu trữ trên kho lưu trữ (thiếu quyền ghi hoặc mất kết nối).",
                ex.Message,
                ex);
        }

        var safeLease = PathSegmentSanitizer.ToSafeSegment(
            string.IsNullOrWhiteSpace(leaseToken) ? Guid.NewGuid().ToString("N") : leaseToken);
        var partialFileName = $"{Path.GetFileName(targetFullPath)}.{safeLease}.partial";
        var partialSegments = relativeSegments[..^1].Append(partialFileName).ToArray();
        var partialFullPath = PathSegmentSanitizer.CombineWithinRoot(fullRoot, partialSegments);

        try
        {
            // Step 3: Stream staging file to <target>.<leaseToken>.partial on target share and flush to disk
            await using (var sourceStream = new FileStream(
                stagingFilePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: StreamBufferBytes,
                options: FileOptions.Asynchronous | FileOptions.SequentialScan))
            await using (var partialWriteStream = new FileStream(
                partialFullPath,
                FileMode.Create,
                FileAccess.Write,
                FileShare.None,
                bufferSize: StreamBufferBytes,
                options: FileOptions.Asynchronous))
            {
                await sourceStream.CopyToAsync(partialWriteStream, StreamBufferBytes, ct);
                await partialWriteStream.FlushAsync(ct);
                partialWriteStream.Flush(flushToDisk: true);
            }

            // Step 4: Re-open <target>.<leaseToken>.partial from the share, read back ALL bytes,
            // verify exact byte count and recompute SHA-256!
            var (verifiedBytes, verifiedSha256) = await ComputeFileSizeAndSha256Async(partialFullPath, ct);

            if (verifiedBytes != expectedBytes ||
                !string.Equals(verifiedSha256, normalizedExpectedHash, StringComparison.OrdinalIgnoreCase))
            {
                TryDeleteFileBestEffort(partialFullPath);
                throw new StorageUnavailableException(
                    "STORAGE_VERIFY_MISMATCH",
                    "Dữ liệu đọc lại từ kho lưu trữ sau khi ghi không khớp kích thước hoặc mã băm SHA-256. Hệ thống sẽ thử lại an toàn.",
                    $"Expected {expectedBytes} bytes / {normalizedExpectedHash}, got {verifiedBytes} bytes / {verifiedSha256}.");
            }

            // Step 5: Atomic rename on the same filesystem without overwriting
            try
            {
                File.Move(partialFullPath, targetFullPath, overwrite: false);
            }
            catch (IOException) when (File.Exists(targetFullPath))
            {
                TryDeleteFileBestEffort(partialFullPath);
                return await ReconcileOrThrowConflictAsync(
                    targetFullPath,
                    canonicalRelativePath,
                    expectedBytes,
                    normalizedExpectedHash,
                    ct);
            }

            return new StoredFileReceipt(
                RelativePath: canonicalRelativePath,
                SizeBytes: verifiedBytes,
                Sha256: verifiedSha256,
                ReconciledExisting: false,
                VerifiedAtUtc: DateTime.UtcNow);
        }
        catch (StorageConflictException)
        {
            TryDeleteFileBestEffort(partialFullPath);
            throw;
        }
        catch (StorageUnavailableException)
        {
            TryDeleteFileBestEffort(partialFullPath);
            throw;
        }
        catch (OperationCanceledException)
        {
            TryDeleteFileBestEffort(partialFullPath);
            throw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            TryDeleteFileBestEffort(partialFullPath);
            _logger.LogWarning(ex, "I/O error while committing video to storage target '{RelativePath}'.", canonicalRelativePath);
            throw new StorageUnavailableException(
                "STORAGE_IO_ERROR",
                "Lỗi đọc/ghi kho lưu trữ (có thể do đầy dung lượng, mất mount NAS hoặc thiếu quyền ghi). Bản lưu đệm trên máy chủ vẫn được giữ nguyên để thử lại.",
                ex.Message,
                ex);
        }
    }

    public async Task<Stream> OpenReadAsync(string relativePath, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(relativePath);

        var fullRoot = await EnsureVerifiedRootForReadAsync(ct);
        var segments = SplitAndValidateRelativeSegments(relativePath);
        var targetFullPath = PathSegmentSanitizer.CombineWithinRoot(fullRoot, segments);

        if (!File.Exists(targetFullPath))
        {
            throw new StorageUnavailableException(
                "STORAGE_FILE_UNAVAILABLE",
                "Tệp video đã lưu hiện không khả dụng trên kho lưu trữ. Vui lòng kiểm tra kết nối lưu trữ.",
                $"Target file '{relativePath}' does not exist under verified storage root.");
        }

        try
        {
            return new FileStream(
                targetFullPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 65_536,
                options: FileOptions.Asynchronous | FileOptions.SequentialScan);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StorageUnavailableException(
                "STORAGE_FILE_UNAVAILABLE",
                "Không thể đọc tệp video từ kho lưu trữ vào lúc này.",
                ex.Message,
                ex);
        }
    }

    public async Task<bool> DeleteIfExistsAsync(string relativePath, CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(relativePath);

        var fullRoot = await EnsureVerifiedRootForWriteAsync(ct);
        var segments = SplitAndValidateRelativeSegments(relativePath);
        var targetFullPath = PathSegmentSanitizer.CombineWithinRoot(fullRoot, segments);

        if (!File.Exists(targetFullPath))
        {
            return false;
        }

        try
        {
            File.Delete(targetFullPath);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StorageUnavailableException(
                "STORAGE_DELETE_FAILED",
                "Không thể xóa tệp vật lý trên kho lưu trữ.",
                ex.Message,
                ex);
        }
    }

    public static async Task<(long SizeBytes, string Sha256Hex)> ComputeFileSizeAndSha256Async(
        string filePath,
        CancellationToken ct = default)
    {
        await using var stream = new FileStream(
            filePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: StreamBufferBytes,
            options: FileOptions.Asynchronous | FileOptions.SequentialScan);

        using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[StreamBufferBytes];
        long totalBytes = 0;

        while (true)
        {
            var read = await stream.ReadAsync(buffer, ct);
            if (read <= 0)
            {
                break;
            }

            hasher.AppendData(buffer.AsSpan(0, read));
            totalBytes += read;
        }

        var hashBytes = hasher.GetHashAndReset();
        return (totalBytes, Convert.ToHexStringLower(hashBytes));
    }

    private async Task<StoredFileReceipt> ReconcileOrThrowConflictAsync(
        string targetFullPath,
        string canonicalRelativePath,
        long expectedBytes,
        string normalizedExpectedHash,
        CancellationToken ct)
    {
        long actualBytes;
        string actualSha256;

        try
        {
            (actualBytes, actualSha256) = await ComputeFileSizeAndSha256Async(targetFullPath, ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new StorageUnavailableException(
                "STORAGE_IO_ERROR",
                "Không thể đọc tệp đích hiện có trên kho lưu trữ để đối chiếu mã băm SHA-256.",
                ex.Message,
                ex);
        }

        if (actualBytes == expectedBytes &&
            string.Equals(actualSha256, normalizedExpectedHash, StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogInformation(
                "Reconciled pre-existing storage file '{RelativePath}' with matching SHA-256 '{Sha256}'.",
                canonicalRelativePath,
                actualSha256);

            return new StoredFileReceipt(
                RelativePath: canonicalRelativePath,
                SizeBytes: actualBytes,
                Sha256: actualSha256,
                ReconciledExisting: true,
                VerifiedAtUtc: DateTime.UtcNow);
        }

        throw new StorageConflictException(
            "STORAGE_HASH_CONFLICT",
            "Tệp đích trên kho lưu trữ đã tồn tại nhưng có nội dung/mã băm SHA-256 khác với bản ghi này. Hệ thống từ chối ghi đè để bảo toàn dữ liệu.",
            $"Hash conflict at '{canonicalRelativePath}': existing ({actualBytes} bytes, {actualSha256}) vs expected ({expectedBytes} bytes, {normalizedExpectedHash}).");
    }

    private async Task<string> EnsureVerifiedRootForWriteAsync(CancellationToken ct)
    {
        var fullRoot = Path.GetFullPath(_options.NasRootPath);

        if (_options.StorageMode == StorageMode.LocalDevelopment)
        {
            try
            {
                Directory.CreateDirectory(fullRoot);
                await EnsureLocalDevelopmentMarkerAsync(fullRoot, ct);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                throw new StorageUnavailableException(
                    "LOCAL_STORAGE_UNAVAILABLE",
                    "Không thể truy cập hoặc ghi vào thư mục lưu trữ cục bộ (LocalDevelopment).",
                    ex.Message,
                    ex);
            }

            if (!await ProbeReadWriteCapabilityAsync(fullRoot, ct))
            {
                throw new StorageUnavailableException(
                    "LOCAL_STORAGE_WRITE_FAILED",
                    "Kiểm tra đọc/ghi thư mục lưu trữ cục bộ thất bại.");
            }

            return fullRoot;
        }

        // SynologyMounted mode: NEVER create NAS_ROOT_PATH!
        if (!Directory.Exists(fullRoot))
        {
            throw new StorageUnavailableException(
                "NAS_STORAGE_MARKER_INVALID",
                "Không tìm thấy thư mục mount Synology NAS. Hệ thống không tự tạo thư mục cục bộ thay thế và sẽ giữ nguyên dữ liệu ở vùng đệm.");
        }

        var (markerValid, markerError) = await ValidateSynologyMarkerAsync(fullRoot, ct);
        if (!markerValid)
        {
            throw new StorageUnavailableException(
                "NAS_STORAGE_MARKER_INVALID",
                "Tệp định danh kho lưu trữ Synology NAS (.packingproof-storage-id) bị thiếu hoặc không khớp cấu hình STORAGE_ID.",
                markerError);
        }

        if (!await ProbeReadWriteCapabilityAsync(fullRoot, ct))
        {
            throw new StorageUnavailableException(
                "NAS_WRITE_UNAVAILABLE",
                "Kho lưu trữ Synology NAS hiện không thể ghi/đọc (thiếu quyền ghi, ổ đĩa đầy hoặc gián đoạn mạng).");
        }

        return fullRoot;
    }

    private async Task<string> EnsureVerifiedRootForReadAsync(CancellationToken ct)
    {
        var fullRoot = Path.GetFullPath(_options.NasRootPath);

        if (_options.StorageMode == StorageMode.LocalDevelopment)
        {
            if (!Directory.Exists(fullRoot))
            {
                throw new StorageUnavailableException(
                    "LOCAL_STORAGE_UNAVAILABLE",
                    "Thư mục lưu trữ cục bộ hiện không tồn tại.");
            }

            return fullRoot;
        }

        // SynologyMounted mode: verify mount & marker before serving reads
        if (!Directory.Exists(fullRoot))
        {
            throw new StorageUnavailableException(
                "NAS_STORAGE_MARKER_INVALID",
                "Kết nối đến thư mục lưu trữ Synology NAS hiện không khả dụng.");
        }

        var (markerValid, markerError) = await ValidateSynologyMarkerAsync(fullRoot, ct);
        if (!markerValid)
        {
            throw new StorageUnavailableException(
                "NAS_STORAGE_MARKER_INVALID",
                "Không thể xác minh định danh kho lưu trữ Synology NAS (.packingproof-storage-id).",
                markerError);
        }

        return fullRoot;
    }

    private async Task<(bool IsValid, string? ErrorDetail)> ValidateSynologyMarkerAsync(
        string fullRoot,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_options.StorageId))
        {
            return (false, "STORAGE_ID configuration is empty.");
        }

        var markerPath = PathSegmentSanitizer.CombineWithinRoot(fullRoot, StorageMarkerFileName);
        if (!File.Exists(markerPath))
        {
            return (false, $"Marker file '{StorageMarkerFileName}' is missing in NAS_ROOT_PATH.");
        }

        try
        {
            var markerText = (await File.ReadAllTextAsync(markerPath, Encoding.UTF8, ct)).Trim();
            if (!string.Equals(markerText, _options.StorageId, StringComparison.Ordinal))
            {
                return (false, "Marker file content does not match configured STORAGE_ID.");
            }

            return (true, null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return (false, $"Failed to read marker file: {ex.Message}");
        }
    }

    private async Task EnsureLocalDevelopmentMarkerAsync(string fullRoot, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_options.StorageId))
        {
            return;
        }

        var markerPath = PathSegmentSanitizer.CombineWithinRoot(fullRoot, StorageMarkerFileName);
        if (!File.Exists(markerPath))
        {
            await File.WriteAllTextAsync(markerPath, _options.StorageId, Encoding.UTF8, ct);
        }
    }

    private static async Task<bool> ProbeReadWriteCapabilityAsync(string fullRoot, CancellationToken ct)
    {
        var probeFileName = $".packingproof-rw-probe-{Guid.NewGuid():N}.tmp";
        var probePath = PathSegmentSanitizer.CombineWithinRoot(fullRoot, probeFileName);
        var payload = Encoding.ASCII.GetBytes($"probe:{Guid.NewGuid():N}");

        try
        {
            await using (var writeStream = new FileStream(
                probePath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 4096,
                options: FileOptions.Asynchronous))
            {
                await writeStream.WriteAsync(payload, ct);
                await writeStream.FlushAsync(ct);
                writeStream.Flush(flushToDisk: true);
            }

            var readBack = await File.ReadAllBytesAsync(probePath, ct);
            return readBack.AsSpan().SequenceEqual(payload);
        }
        catch
        {
            return false;
        }
        finally
        {
            TryDeleteFileBestEffort(probePath);
        }
    }

    private static string[] SplitAndValidateRelativeSegments(string relativePath)
    {
        var segments = relativePath
            .Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (segments.Length == 0)
        {
            throw new InvalidOperationException("Storage relative path cannot be empty.");
        }

        foreach (var seg in segments)
        {
            if (seg is "." or ".." || seg.Contains(':'))
            {
                throw new InvalidOperationException($"Unsafe storage relative path segment '{seg}'.");
            }
        }

        return segments;
    }

    private static void TryDeleteFileBestEffort(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // Ignore best-effort cleanup errors
        }
    }
}

