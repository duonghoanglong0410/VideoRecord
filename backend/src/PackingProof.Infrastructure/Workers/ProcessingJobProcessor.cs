using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Npgsql;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Storage;
using PackingProof.Core.Tracking;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Storage;
using PackingProof.Infrastructure.Uploads;

namespace PackingProof.Infrastructure.Workers;

public sealed class ProcessingJobProcessor
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly PackingProofOptions _options;
    private readonly IVideoStorage _videoStorage;
    private readonly IMediaInspector _mediaInspector;
    private readonly IPreviewTranscoder _previewTranscoder;
    private readonly IProcessingJobSignal _jobSignal;
    private readonly ILogger<ProcessingJobProcessor> _logger;
    private readonly SemaphoreSlim _concurrencyGate;

    public ProcessingJobProcessor(
        IServiceScopeFactory scopeFactory,
        PackingProofOptions options,
        IVideoStorage videoStorage,
        IMediaInspector mediaInspector,
        IPreviewTranscoder previewTranscoder,
        IProcessingJobSignal jobSignal,
        ILogger<ProcessingJobProcessor> logger)
    {
        _scopeFactory = scopeFactory;
        _options = options;
        _videoStorage = videoStorage;
        _mediaInspector = mediaInspector;
        _previewTranscoder = previewTranscoder;
        _jobSignal = jobSignal;
        _logger = logger;

        var maxConcurrency = Math.Clamp(options.ProcessingConcurrency, 1, 8);
        _concurrencyGate = new SemaphoreSlim(maxConcurrency, maxConcurrency);
    }

    /// <summary>
    /// Atomically claims at most one due or lease-expired ProcessingJob (prioritizing
    /// ValidateAndStoreOriginal over GeneratePreview) using PostgreSQL FOR UPDATE SKIP LOCKED,
    /// enforcing bounded concurrency via PROCESSING_CONCURRENCY SemaphoreSlim.
    /// Returns true if a job was claimed and processed; false if no eligible job was available.
    /// </summary>
    public async Task<bool> TryClaimAndProcessNextAsync(
        string workerId,
        CancellationToken ct = default)
    {
        await _concurrencyGate.WaitAsync(ct);
        try
        {
            var leaseToken = $"{workerId}-{Guid.NewGuid():N}";
            var claimedJobId = await TryClaimNextJobIdAsync(leaseToken, ct);
            if (!claimedJobId.HasValue)
            {
                return false;
            }

            await ExecuteClaimedJobAsync(claimedJobId.Value, leaseToken, ct);
            return true;
        }
        finally
        {
            _concurrencyGate.Release();
        }
    }

    public async Task<int> DrainAvailableJobsAsync(
        string workerId,
        int maxJobs = 50,
        CancellationToken ct = default)
    {
        var processed = 0;
        while (processed < maxJobs && !ct.IsCancellationRequested)
        {
            var claimed = await TryClaimAndProcessNextAsync(workerId, ct);
            if (!claimed)
            {
                break;
            }
            processed++;
        }

        return processed;
    }

    private async Task<Guid?> TryClaimNextJobIdAsync(string leaseOwner, CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

        var now = DateTime.UtcNow;
        var leaseExpires = now.AddSeconds(Math.Max(5, _options.WorkerLeaseSeconds));

        const string claimSql = """
            WITH candidate AS (
                SELECT "Id"
                FROM "ProcessingJobs"
                WHERE "JobType" IN ('ValidateAndStoreOriginal', 'GeneratePreview')
                  AND (
                      ("Status" = 'Queued' AND "NextAttemptAtUtc" <= @now)
                      OR ("Status" = 'Running' AND "LeaseExpiresAtUtc" IS NOT NULL AND "LeaseExpiresAtUtc" <= @now)
                  )
                ORDER BY
                    CASE WHEN "JobType" = 'ValidateAndStoreOriginal' THEN 0 ELSE 1 END ASC,
                    "NextAttemptAtUtc" ASC,
                    "CreatedAtUtc" ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            UPDATE "ProcessingJobs" AS j
            SET "Status" = 'Running',
                "LeaseOwner" = @leaseOwner,
                "LeaseExpiresAtUtc" = @leaseExpires,
                "AttemptCount" = j."AttemptCount" + 1
            FROM candidate
            WHERE j."Id" = candidate."Id"
            RETURNING j."Id";
            """;

        var conn = db.Database.GetDbConnection();
        var shouldClose = conn.State != ConnectionState.Open;
        if (shouldClose)
        {
            await conn.OpenAsync(ct);
        }

        try
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = claimSql;
            cmd.Parameters.Add(new NpgsqlParameter("now", now));
            cmd.Parameters.Add(new NpgsqlParameter("leaseOwner", leaseOwner));
            cmd.Parameters.Add(new NpgsqlParameter("leaseExpires", leaseExpires));

            var scalar = await cmd.ExecuteScalarAsync(ct);
            return scalar is Guid id ? id : null;
        }
        finally
        {
            if (shouldClose)
            {
                await conn.CloseAsync();
            }
        }
    }

    private async Task ExecuteClaimedJobAsync(
        Guid jobId,
        string leaseOwner,
        CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
        var auditLogger = scope.ServiceProvider.GetRequiredService<IAuditLogger>();

        var job = await db.ProcessingJobs
            .FirstOrDefaultAsync(j => j.Id == jobId, ct);

        if (job is null || !string.Equals(job.LeaseOwner, leaseOwner, StringComparison.Ordinal))
        {
            return;
        }

        switch (job.JobType)
        {
            case ProcessingJobType.ValidateAndStoreOriginal:
                await ExecuteValidateAndStoreOriginalAsync(db, auditLogger, job, leaseOwner, ct);
                break;

            case ProcessingJobType.GeneratePreview:
                await ExecuteGeneratePreviewAsync(db, auditLogger, job, leaseOwner, ct);
                break;

            default:
                job.Status = ProcessingJobStatus.DeadLetter;
                job.LastErrorCode = "UNSUPPORTED_JOB_TYPE";
                job.LastErrorDetail = $"Unsupported ProcessingJobType '{job.JobType}'.";
                job.LeaseOwner = null;
                job.LeaseExpiresAtUtc = null;
                await db.SaveChangesAsync(ct);
                break;
        }
    }

    private async Task ExecuteValidateAndStoreOriginalAsync(
        PackingProofDbContext db,
        IAuditLogger auditLogger,
        ProcessingJob job,
        string leaseOwner,
        CancellationToken ct)
    {
        var recording = await db.Recordings
            .Include(r => r.Shop)
            .Include(r => r.OwnerUser)
            .FirstOrDefaultAsync(r => r.Id == job.RecordingId, ct);

        if (recording is null)
        {
            job.Status = ProcessingJobStatus.DeadLetter;
            job.LastErrorCode = "RECORDING_NOT_FOUND";
            job.LastErrorDetail = "Associated Recording was not found.";
            job.LeaseOwner = null;
            job.LeaseExpiresAtUtc = null;
            await db.SaveChangesAsync(ct);
            return;
        }

        var uploadSession = await db.UploadSessions
            .FirstOrDefaultAsync(u => u.RecordingId == recording.Id, ct);

        var stagingRoot = Path.GetFullPath(_options.StagingRootPath);

        // Idempotency fast-path: if Original asset is already persisted and Recording is Stored
        var existingOriginalAsset = await db.VideoAssets
            .FirstOrDefaultAsync(v => v.RecordingId == recording.Id && v.Kind == AssetKind.Original, ct);

        if (existingOriginalAsset is not null && recording.StorageStatus == StorageStatus.Stored)
        {
            var enqueuedPreview = false;
            if (recording.PreviewStatus == PreviewStatus.Pending)
            {
                var existingPreviewJob = await db.ProcessingJobs.FirstOrDefaultAsync(
                    j => j.RecordingId == recording.Id && j.JobType == ProcessingJobType.GeneratePreview,
                    ct);
                if (existingPreviewJob is null)
                {
                    var now = DateTime.UtcNow;
                    db.ProcessingJobs.Add(new ProcessingJob
                    {
                        Id = Guid.NewGuid(),
                        RecordingId = recording.Id,
                        JobType = ProcessingJobType.GeneratePreview,
                        Status = ProcessingJobStatus.Queued,
                        AttemptCount = 0,
                        MaxAttempts = Math.Max(1, _options.WorkerMaxAttempts),
                        NextAttemptAtUtc = now,
                        CreatedAtUtc = now
                    });
                    enqueuedPreview = true;
                }
            }

            job.Status = ProcessingJobStatus.Succeeded;
            job.CompletedAtUtc ??= DateTime.UtcNow;
            job.LeaseOwner = null;
            job.LeaseExpiresAtUtc = null;
            job.LastErrorCode = null;
            job.LastErrorDetail = null;
            await db.SaveChangesAsync(ct);

            if (enqueuedPreview)
            {
                _jobSignal.NotifyNewWork();
            }

            await CleanupStagingAfterStoredAsync(stagingRoot, uploadSession);
            return;
        }

        var stagingFilePath = ResolveStagingFilePath(stagingRoot, uploadSession);
        if (string.IsNullOrWhiteSpace(stagingFilePath) || !File.Exists(stagingFilePath))
        {
            await FailPermanentlyAsync(
                db,
                auditLogger,
                job,
                recording,
                errorCode: "STAGING_FILE_MISSING",
                userSafeMessage: "Tệp dữ liệu tạm trên máy chủ không còn tồn tại để xác minh và lưu trữ.",
                detail: "Staging file path could not be found on disk.",
                cleanupStaging: false,
                stagingRoot: stagingRoot,
                uploadSession: uploadSession,
                ct: ct);
            return;
        }

        var storageProfile = await db.StorageProfiles.FirstOrDefaultAsync(ct);
        var maxUploadBytes = storageProfile?.MaxUploadBytes ?? _options.MaxUploadBytes;

        var fileInfo = new FileInfo(stagingFilePath);
        if (fileInfo.Length <= 0 || fileInfo.Length > maxUploadBytes)
        {
            await FailPermanentlyAsync(
                db,
                auditLogger,
                job,
                recording,
                errorCode: "INVALID_UPLOAD_SIZE",
                userSafeMessage: "Dung lượng tệp nhận được không hợp lệ hoặc vượt quá giới hạn tối đa cho phép.",
                detail: $"Staging file size {fileInfo.Length} bytes is outside [1..{maxUploadBytes}].",
                cleanupStaging: true,
                stagingRoot: stagingRoot,
                uploadSession: uploadSession,
                ct: ct);
            return;
        }

        if (uploadSession is not null &&
            uploadSession.ExpectedBytes > 0 &&
            fileInfo.Length != uploadSession.ExpectedBytes)
        {
            await FailPermanentlyAsync(
                db,
                auditLogger,
                job,
                recording,
                errorCode: "UPLOAD_SIZE_MISMATCH",
                userSafeMessage: "Dung lượng tệp nhận được không khớp với dung lượng đã khai báo cho phiên tải lên.",
                detail: $"Expected {uploadSession.ExpectedBytes} bytes, found {fileInfo.Length} bytes.",
                cleanupStaging: true,
                stagingRoot: stagingRoot,
                uploadSession: uploadSession,
                ct: ct);
            return;
        }

        try
        {
            // Step 1: Compute SHA-256 of staging file & run real ffprobe media inspection
            var (stagingBytes, stagingSha256) = await FileSystemVideoStorage.ComputeFileSizeAndSha256Async(
                stagingFilePath,
                ct);

            var mediaResult = await _mediaInspector.InspectAsync(stagingFilePath, ct);
            if (!mediaResult.IsValid ||
                string.IsNullOrWhiteSpace(mediaResult.NormalizedContainer) ||
                string.IsNullOrWhiteSpace(mediaResult.ActualMimeType))
            {
                await FailPermanentlyAsync(
                    db,
                    auditLogger,
                    job,
                    recording,
                    errorCode: mediaResult.ErrorCode ?? "INVALID_MEDIA_CONTAINER",
                    userSafeMessage: mediaResult.UserSafeErrorMessage ??
                        "Tệp tải lên không phải là video hợp lệ hoặc định dạng không được hỗ trợ.",
                    detail: "ffprobe validation rejected the uploaded staging file.",
                    cleanupStaging: true,
                    stagingRoot: stagingRoot,
                    uploadSession: uploadSession,
                    ct: ct);
                return;
            }

            // Step 2: Build target relative path in Asia/Ho_Chi_Minh timezone using ffprobe-verified container
            var referenceUtc = recording.StartedAtUtc ?? recording.CreatedAtUtc;
            var configuredShopSubdir = string.IsNullOrWhiteSpace(recording.Shop.AllowedStorageSubdir)
                ? recording.Shop.Slug
                : recording.Shop.AllowedStorageSubdir;
            var relativePath = StoragePathBuilder.BuildOriginalRelativePath(
                shopSlug: configuredShopSubdir,
                utcTimestamp: referenceUtc,
                safeTrackingSegment: recording.SafeTrackingSegment,
                recordingId: recording.Id,
                verifiedContainer: mediaResult.NormalizedContainer);

            // Step 3: Commit atomically via IVideoStorage (.partial -> flush -> read-back SHA-256 -> rename, or crash reconcile)
            var receipt = await _videoStorage.CommitFromStagingAsync(
                stagingFilePath: stagingFilePath,
                targetRelativePath: relativePath,
                expectedBytes: stagingBytes,
                expectedSha256: stagingSha256,
                leaseToken: leaseOwner,
                ct: ct);

            // Step 4: Persist VideoAsset(Original), Recording(Stored), ProcessingJob(Succeeded),
            // and idempotently enqueue GeneratePreview when PreviewStatus == Pending
            var shouldGeneratePreview = await PersistStoredOutcomeAsync(
                jobId: job.Id,
                recordingId: recording.Id,
                receipt: receipt,
                mediaResult: mediaResult,
                ct: ct);

            await auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.stored",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Success,
                ActorUserId: recording.OwnerUserId,
                ActorEmail: recording.OwnerUser.Email,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                Metadata: new
                {
                    trackingNumber = recording.TrackingNumber,
                    relativePath = receipt.RelativePath,
                    sizeBytes = receipt.SizeBytes,
                    sha256 = receipt.Sha256,
                    reconciledExisting = receipt.ReconciledExisting,
                    container = mediaResult.NormalizedContainer,
                    videoCodec = mediaResult.VideoCodec,
                    audioCodec = mediaResult.AudioCodec,
                    width = mediaResult.Width,
                    height = mediaResult.Height,
                    storageMode = _videoStorage.Mode.ToString()
                }), ct);

            // Step 5: Clean up staging file & tus metadata ONLY AFTER Stored is durably persisted!
            await CleanupStagingAfterStoredAsync(stagingRoot, uploadSession);

            if (shouldGeneratePreview)
            {
                _jobSignal.NotifyNewWork();
            }
        }
        catch (StorageConflictException conflictEx)
        {
            _logger.LogError(
                conflictEx,
                "Non-retryable storage hash conflict for Recording '{RecordingId}'.",
                recording.Id);

            // Keep staging file intact on hash conflict for admin investigation; never overwrite target!
            await FailPermanentlyAsync(
                db,
                auditLogger,
                job,
                recording,
                errorCode: conflictEx.ErrorCode,
                userSafeMessage: conflictEx.UserSafeMessage,
                detail: conflictEx.Message,
                cleanupStaging: false,
                stagingRoot: stagingRoot,
                uploadSession: uploadSession,
                ct: ct);
        }
        catch (StorageUnavailableException unavailableEx)
        {
            _logger.LogWarning(
                unavailableEx,
                "Retryable storage unavailability ({ErrorCode}) for Recording '{RecordingId}' (attempt {Attempt}/{MaxAttempts}).",
                unavailableEx.ErrorCode,
                recording.Id,
                job.AttemptCount,
                job.MaxAttempts);

            await ScheduleRetryOrMarkRetryableFailureAsync(
                jobId: job.Id,
                recordingId: recording.Id,
                errorCode: unavailableEx.ErrorCode,
                userSafeMessage: unavailableEx.UserSafeMessage,
                detail: unavailableEx.Message,
                ct: ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception unexpectedEx)
        {
            _logger.LogError(
                unexpectedEx,
                "Unexpected error while processing storage job '{JobId}' for Recording '{RecordingId}'.",
                job.Id,
                recording.Id);

            await ScheduleRetryOrMarkRetryableFailureAsync(
                jobId: job.Id,
                recordingId: recording.Id,
                errorCode: "STORAGE_PROCESSING_ERROR",
                userSafeMessage: "Đã xảy ra lỗi tạm thời trong quá trình xác minh và lưu trữ video. Hệ thống vẫn giữ bản lưu đệm để thử lại.",
                detail: unexpectedEx.Message,
                ct: ct);
        }
    }

    private async Task ExecuteGeneratePreviewAsync(
        PackingProofDbContext db,
        IAuditLogger auditLogger,
        ProcessingJob job,
        string leaseOwner,
        CancellationToken ct)
    {
        var recording = await db.Recordings
            .Include(r => r.Shop)
            .Include(r => r.OwnerUser)
            .FirstOrDefaultAsync(r => r.Id == job.RecordingId, ct);

        if (recording is null)
        {
            job.Status = ProcessingJobStatus.DeadLetter;
            job.LastErrorCode = "RECORDING_NOT_FOUND";
            job.LastErrorDetail = "Associated Recording was not found.";
            job.LeaseOwner = null;
            job.LeaseExpiresAtUtc = null;
            await db.SaveChangesAsync(ct);
            return;
        }

        // Idempotency fast-path: if Preview asset is already persisted and PreviewStatus == Ready
        var existingPreviewAsset = await db.VideoAssets
            .AsNoTracking()
            .FirstOrDefaultAsync(v => v.RecordingId == recording.Id && v.Kind == AssetKind.Preview, ct);

        if (existingPreviewAsset is not null && recording.PreviewStatus == PreviewStatus.Ready)
        {
            job.Status = ProcessingJobStatus.Succeeded;
            job.CompletedAtUtc ??= DateTime.UtcNow;
            job.LeaseOwner = null;
            job.LeaseExpiresAtUtc = null;
            job.LastErrorCode = null;
            job.LastErrorDetail = null;
            await db.SaveChangesAsync(ct);
            return;
        }

        var originalAsset = await db.VideoAssets
            .AsNoTracking()
            .FirstOrDefaultAsync(v => v.RecordingId == recording.Id && v.Kind == AssetKind.Original, ct);

        if (recording.StorageStatus != StorageStatus.Stored ||
            originalAsset is null ||
            string.IsNullOrWhiteSpace(originalAsset.RelativePath))
        {
            job.Status = ProcessingJobStatus.DeadLetter;
            job.CompletedAtUtc = DateTime.UtcNow;
            job.LeaseOwner = null;
            job.LeaseExpiresAtUtc = null;
            job.LastErrorCode = "ORIGINAL_ASSET_NOT_STORED";
            job.LastErrorDetail = "Cannot generate preview before verified Original asset is stored.";
            await db.SaveChangesAsync(ct);
            return;
        }

        var isAlreadyCompatibleMp4 =
            string.Equals(recording.ActualContainer, "mp4", StringComparison.OrdinalIgnoreCase) &&
            string.Equals(recording.VideoCodec, "h264", StringComparison.OrdinalIgnoreCase);

        if (isAlreadyCompatibleMp4)
        {
            await SetPreviewNotRequiredAndCompleteJobAsync(job.Id, recording.Id, ct);
            return;
        }

        // Step 1 & 2: Mark PreviewStatus = Processing while keeping StorageStatus = Stored
        // and VideoAsset(Original) + its SHA-256 100% untouched!
        await SetPreviewProcessingStatusAsync(recording.Id, ct);

        var stagingRoot = Path.GetFullPath(_options.StagingRootPath);
        Directory.CreateDirectory(stagingRoot);

        var origExt = ResolveSafeTempInputExtension(recording.ActualContainer, originalAsset.RelativePath);
        var tempToken = $"{recording.Id:N}_{Guid.NewGuid():N}";
        var tempInputPath = PathSegmentSanitizer.CombineWithinRoot(stagingRoot, $"preview_in_{tempToken}{origExt}");
        var tempOutputMp4Path = PathSegmentSanitizer.CombineWithinRoot(stagingRoot, $"preview_out_{tempToken}.mp4");

        try
        {
            // Step 3a: Read verified original via IVideoStorage.OpenReadAsync to temp working input in STAGING_ROOT_PATH
            await using (var originalReadStream = await _videoStorage.OpenReadAsync(originalAsset.RelativePath, ct))
            await using (var tempInputWriteStream = new FileStream(
                tempInputPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 131_072,
                options: FileOptions.Asynchronous))
            {
                await originalReadStream.CopyToAsync(tempInputWriteStream, 131_072, ct);
                await tempInputWriteStream.FlushAsync(ct);
            }

            // Step 3b: Transcode via FFmpeg (libx264, veryfast, yuv420p, +faststart, aac 128k if audio or -an)
            var hasAudio = !string.IsNullOrWhiteSpace(recording.AudioCodec);
            await _previewTranscoder.TranscodeToMp4Async(
                new PreviewTranscodeRequest(
                    InputFilePath: tempInputPath,
                    OutputMp4FilePath: tempOutputMp4Path,
                    HasAudio: hasAudio),
                ct);

            // Step 3c: Verify transcoded output with IMediaInspector (ffprobe: mp4 container + h264 video stream)
            var previewInspection = await _mediaInspector.InspectAsync(tempOutputMp4Path, ct);
            if (!previewInspection.IsValid ||
                !string.Equals(previewInspection.NormalizedContainer, "mp4", StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(previewInspection.VideoCodec, "h264", StringComparison.OrdinalIgnoreCase))
            {
                throw new PreviewTranscodeException(
                    "PREVIEW_VERIFICATION_FAILED",
                    "Tệp bản xem sau chuyển mã không đạt chuẩn container MP4 (H.264). Tệp video gốc vẫn an toàn.",
                    isRetryable: false,
                    detail: $"ffprobe inspection of preview output returned valid={previewInspection.IsValid}, container={previewInspection.NormalizedContainer}, videoCodec={previewInspection.VideoCodec}.");
            }

            // Step 3d: Compute independent SHA-256 and SizeBytes of transcoded MP4
            var (previewBytes, previewSha256) = await FileSystemVideoStorage.ComputeFileSizeAndSha256Async(
                tempOutputMp4Path,
                ct);

            // Step 4: Commit preview to IVideoStorage (.partial -> flush -> re-read SHA-256 verify -> atomic rename -> crash reconcile)
            var referenceUtc = recording.StartedAtUtc ?? recording.CreatedAtUtc;
            var configuredShopSubdir = string.IsNullOrWhiteSpace(recording.Shop.AllowedStorageSubdir)
                ? recording.Shop.Slug
                : recording.Shop.AllowedStorageSubdir;
            var previewRelativePath = StoragePathBuilder.BuildPreviewRelativePath(
                shopSlug: configuredShopSubdir,
                utcTimestamp: referenceUtc,
                safeTrackingSegment: recording.SafeTrackingSegment,
                recordingId: recording.Id);

            var previewReceipt = await _videoStorage.CommitFromStagingAsync(
                stagingFilePath: tempOutputMp4Path,
                targetRelativePath: previewRelativePath,
                expectedBytes: previewBytes,
                expectedSha256: previewSha256,
                leaseToken: leaseOwner,
                ct: ct);

            // Step 5: Upsert VideoAsset(Kind = Preview) idempotently, set PreviewStatus = Ready,
            // keep StorageStatus = Stored & Original VideoAsset untouched, and write AuditEvent("video.preview_ready")
            await PersistPreviewReadyOutcomeAsync(
                jobId: job.Id,
                recordingId: recording.Id,
                previewReceipt: previewReceipt,
                ct: ct);

            await auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.preview_ready",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Success,
                ActorUserId: recording.OwnerUserId,
                ActorEmail: recording.OwnerUser.Email,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                Metadata: new
                {
                    trackingNumber = recording.TrackingNumber,
                    previewRelativePath = previewReceipt.RelativePath,
                    previewSizeBytes = previewReceipt.SizeBytes,
                    previewSha256 = previewReceipt.Sha256,
                    originalSha256 = originalAsset.Sha256,
                    reconciledExisting = previewReceipt.ReconciledExisting,
                    videoCodec = previewInspection.VideoCodec,
                    audioCodec = previewInspection.AudioCodec,
                    width = previewInspection.Width,
                    height = previewInspection.Height,
                    storageMode = _videoStorage.Mode.ToString()
                }), ct);
        }
        catch (StorageConflictException conflictEx)
        {
            _logger.LogError(
                conflictEx,
                "Non-retryable storage hash conflict while committing preview MP4 for Recording '{RecordingId}'.",
                recording.Id);

            await HandlePreviewFailureAsync(
                auditLogger: auditLogger,
                jobId: job.Id,
                recording: recording,
                errorCode: conflictEx.ErrorCode,
                detail: conflictEx.Message,
                isRetryable: false,
                ct: ct);
        }
        catch (StorageUnavailableException unavailableEx)
        {
            _logger.LogWarning(
                unavailableEx,
                "Retryable storage unavailability ({ErrorCode}) during preview generation for Recording '{RecordingId}' (attempt {Attempt}/{MaxAttempts}).",
                unavailableEx.ErrorCode,
                recording.Id,
                job.AttemptCount,
                job.MaxAttempts);

            await HandlePreviewFailureAsync(
                auditLogger: auditLogger,
                jobId: job.Id,
                recording: recording,
                errorCode: unavailableEx.ErrorCode,
                detail: unavailableEx.Message,
                isRetryable: true,
                ct: ct);
        }
        catch (PreviewTranscodeException transcodeEx)
        {
            _logger.LogWarning(
                transcodeEx,
                "Preview transcode failed ({ErrorCode}, retryable={Retryable}) for Recording '{RecordingId}' (attempt {Attempt}/{MaxAttempts}).",
                transcodeEx.ErrorCode,
                transcodeEx.IsRetryable,
                recording.Id,
                job.AttemptCount,
                job.MaxAttempts);

            await HandlePreviewFailureAsync(
                auditLogger: auditLogger,
                jobId: job.Id,
                recording: recording,
                errorCode: transcodeEx.ErrorCode,
                detail: transcodeEx.Message,
                isRetryable: transcodeEx.IsRetryable,
                ct: ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception unexpectedEx)
        {
            _logger.LogError(
                unexpectedEx,
                "Unexpected error during GeneratePreview job '{JobId}' for Recording '{RecordingId}'.",
                job.Id,
                recording.Id);

            await HandlePreviewFailureAsync(
                auditLogger: auditLogger,
                jobId: job.Id,
                recording: recording,
                errorCode: "PREVIEW_PROCESSING_ERROR",
                detail: unexpectedEx.Message,
                isRetryable: true,
                ct: ct);
        }
        finally
        {
            TryDeleteTempFileBestEffort(tempInputPath);
            TryDeleteTempFileBestEffort(tempOutputMp4Path);
        }
    }

    private async Task<bool> PersistStoredOutcomeAsync(
        Guid jobId,
        Guid recordingId,
        StoredFileReceipt receipt,
        MediaInspectionResult mediaResult,
        CancellationToken ct)
    {
        var isAlreadyBrowserCompatibleMp4 =
            string.Equals(mediaResult.NormalizedContainer, "mp4", StringComparison.OrdinalIgnoreCase) &&
            string.Equals(mediaResult.VideoCodec, "h264", StringComparison.OrdinalIgnoreCase);

        for (var attempt = 0; attempt < 3; attempt++)
        {
            using var saveScope = _scopeFactory.CreateScope();
            var db = saveScope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

            var recording = await db.Recordings.FirstAsync(r => r.Id == recordingId, ct);
            var job = await db.ProcessingJobs.FirstAsync(j => j.Id == jobId, ct);
            var profile = await db.StorageProfiles.FirstOrDefaultAsync(ct);

            if (profile is null)
            {
                profile = new StorageProfile
                {
                    Name = "Default",
                    Mode = _options.StorageMode,
                    ExpectedStorageId = _options.StorageId,
                    MaxRecordingSeconds = _options.MaxRecordingSeconds,
                    MaxUploadBytes = _options.MaxUploadBytes,
                    MaxLocalPendingRecordings = _options.MaxLocalPendingRecordings
                };
                db.StorageProfiles.Add(profile);
            }

            var existingAsset = await db.VideoAssets
                .FirstOrDefaultAsync(v => v.RecordingId == recordingId && v.Kind == AssetKind.Original, ct);

            if (existingAsset is null)
            {
                db.VideoAssets.Add(new VideoAsset
                {
                    Id = Guid.NewGuid(),
                    RecordingId = recordingId,
                    Kind = AssetKind.Original,
                    StorageProfileId = profile.Id,
                    RelativePath = receipt.RelativePath,
                    MimeType = mediaResult.ActualMimeType!,
                    SizeBytes = receipt.SizeBytes,
                    Sha256 = receipt.Sha256,
                    VerifiedAtUtc = receipt.VerifiedAtUtc,
                    CreatedAtUtc = DateTime.UtcNow
                });
            }
            else
            {
                existingAsset.StorageProfileId = profile.Id;
                existingAsset.RelativePath = receipt.RelativePath;
                existingAsset.MimeType = mediaResult.ActualMimeType!;
                existingAsset.SizeBytes = receipt.SizeBytes;
                existingAsset.Sha256 = receipt.Sha256;
                existingAsset.VerifiedAtUtc = receipt.VerifiedAtUtc;
            }

            var now = DateTime.UtcNow;
            recording.StorageStatus = StorageStatus.Stored;
            recording.StoredAtUtc = receipt.VerifiedAtUtc;
            recording.ServerReceivedAtUtc ??= now;
            recording.ActualMimeType = mediaResult.ActualMimeType;
            recording.ActualContainer = mediaResult.NormalizedContainer;
            recording.VideoCodec = mediaResult.VideoCodec;
            recording.AudioCodec = mediaResult.AudioCodec;
            recording.Width = mediaResult.Width;
            recording.Height = mediaResult.Height;
            if (mediaResult.DurationSeconds.HasValue && mediaResult.DurationSeconds.Value > 0)
            {
                recording.DurationSeconds = Math.Round(mediaResult.DurationSeconds.Value, 2);
            }
            recording.PreviewStatus = isAlreadyBrowserCompatibleMp4
                ? PreviewStatus.NotRequired
                : PreviewStatus.Pending;
            recording.LastErrorCode = null;
            recording.UserSafeErrorMessage = null;
            recording.IsRetryable = false;
            recording.UpdatedAtUtc = now;

            job.Status = ProcessingJobStatus.Succeeded;
            job.CompletedAtUtc = now;
            job.LeaseOwner = null;
            job.LeaseExpiresAtUtc = null;
            job.LastErrorCode = null;
            job.LastErrorDetail = null;

            var shouldSignalPreview = false;
            if (!isAlreadyBrowserCompatibleMp4)
            {
                var existingPreviewJob = await db.ProcessingJobs.FirstOrDefaultAsync(
                    j => j.RecordingId == recordingId && j.JobType == ProcessingJobType.GeneratePreview,
                    ct);

                if (existingPreviewJob is null)
                {
                    db.ProcessingJobs.Add(new ProcessingJob
                    {
                        Id = Guid.NewGuid(),
                        RecordingId = recordingId,
                        JobType = ProcessingJobType.GeneratePreview,
                        Status = ProcessingJobStatus.Queued,
                        AttemptCount = 0,
                        MaxAttempts = Math.Max(1, _options.WorkerMaxAttempts),
                        NextAttemptAtUtc = now,
                        CreatedAtUtc = now
                    });
                    shouldSignalPreview = true;
                }
                else if (existingPreviewJob.Status is ProcessingJobStatus.Queued)
                {
                    shouldSignalPreview = true;
                }
            }

            try
            {
                await db.SaveChangesAsync(ct);
                return shouldSignalPreview;
            }
            catch (DbUpdateException) when (attempt < 2)
            {
                // Retry cleanly on xmin concurrency or unique asset/job index race
            }
        }

        return false;
    }

    private async Task SetPreviewProcessingStatusAsync(Guid recordingId, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            using var saveScope = _scopeFactory.CreateScope();
            var db = saveScope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

            var recording = await db.Recordings.FirstOrDefaultAsync(r => r.Id == recordingId, ct);
            if (recording is null ||
                recording.StorageStatus != StorageStatus.Stored ||
                recording.PreviewStatus == PreviewStatus.Ready)
            {
                return;
            }

            recording.PreviewStatus = PreviewStatus.Processing;
            recording.UpdatedAtUtc = DateTime.UtcNow;

            try
            {
                await db.SaveChangesAsync(ct);
                return;
            }
            catch (DbUpdateConcurrencyException) when (attempt < 2)
            {
                // Retry on concurrent Recording xmin update
            }
        }
    }

    private async Task SetPreviewNotRequiredAndCompleteJobAsync(
        Guid jobId,
        Guid recordingId,
        CancellationToken ct)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            using var saveScope = _scopeFactory.CreateScope();
            var db = saveScope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

            var recording = await db.Recordings.FirstAsync(r => r.Id == recordingId, ct);
            var job = await db.ProcessingJobs.FirstAsync(j => j.Id == jobId, ct);

            var now = DateTime.UtcNow;
            recording.PreviewStatus = PreviewStatus.NotRequired;
            recording.UpdatedAtUtc = now;

            job.Status = ProcessingJobStatus.Succeeded;
            job.CompletedAtUtc = now;
            job.LeaseOwner = null;
            job.LeaseExpiresAtUtc = null;
            job.LastErrorCode = null;
            job.LastErrorDetail = null;

            try
            {
                await db.SaveChangesAsync(ct);
                return;
            }
            catch (DbUpdateConcurrencyException) when (attempt < 2)
            {
                // Retry on concurrent Recording xmin update
            }
        }
    }

    private async Task PersistPreviewReadyOutcomeAsync(
        Guid jobId,
        Guid recordingId,
        StoredFileReceipt previewReceipt,
        CancellationToken ct)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            using var saveScope = _scopeFactory.CreateScope();
            var db = saveScope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

            var recording = await db.Recordings.FirstAsync(r => r.Id == recordingId, ct);
            var job = await db.ProcessingJobs.FirstAsync(j => j.Id == jobId, ct);
            var originalAsset = await db.VideoAssets
                .AsNoTracking()
                .FirstOrDefaultAsync(v => v.RecordingId == recordingId && v.Kind == AssetKind.Original, ct);

            Guid storageProfileId;
            if (originalAsset is not null)
            {
                storageProfileId = originalAsset.StorageProfileId;
            }
            else
            {
                var profile = await db.StorageProfiles.FirstAsync(ct);
                storageProfileId = profile.Id;
            }

            var existingPreview = await db.VideoAssets
                .FirstOrDefaultAsync(v => v.RecordingId == recordingId && v.Kind == AssetKind.Preview, ct);

            if (existingPreview is null)
            {
                db.VideoAssets.Add(new VideoAsset
                {
                    Id = Guid.NewGuid(),
                    RecordingId = recordingId,
                    Kind = AssetKind.Preview,
                    StorageProfileId = storageProfileId,
                    RelativePath = previewReceipt.RelativePath,
                    MimeType = "video/mp4",
                    SizeBytes = previewReceipt.SizeBytes,
                    Sha256 = previewReceipt.Sha256,
                    VerifiedAtUtc = previewReceipt.VerifiedAtUtc,
                    CreatedAtUtc = DateTime.UtcNow
                });
            }
            else
            {
                existingPreview.StorageProfileId = storageProfileId;
                existingPreview.RelativePath = previewReceipt.RelativePath;
                existingPreview.MimeType = "video/mp4";
                existingPreview.SizeBytes = previewReceipt.SizeBytes;
                existingPreview.Sha256 = previewReceipt.Sha256;
                existingPreview.VerifiedAtUtc = previewReceipt.VerifiedAtUtc;
            }

            var now = DateTime.UtcNow;
            // CRITICAL: Keep Recording.StorageStatus = Stored and Original VideoAsset 100% untouched!
            recording.PreviewStatus = PreviewStatus.Ready;
            recording.UpdatedAtUtc = now;

            job.Status = ProcessingJobStatus.Succeeded;
            job.CompletedAtUtc = now;
            job.LeaseOwner = null;
            job.LeaseExpiresAtUtc = null;
            job.LastErrorCode = null;
            job.LastErrorDetail = null;

            try
            {
                await db.SaveChangesAsync(ct);
                return;
            }
            catch (DbUpdateException) when (attempt < 2)
            {
                // Retry cleanly on xmin concurrency or unique preview asset index race
            }
        }
    }

    private async Task HandlePreviewFailureAsync(
        IAuditLogger auditLogger,
        Guid jobId,
        Recording recording,
        string errorCode,
        string detail,
        bool isRetryable,
        CancellationToken ct)
    {
        var terminalFailure = false;

        for (var attempt = 0; attempt < 3; attempt++)
        {
            using var saveScope = _scopeFactory.CreateScope();
            var db = saveScope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

            var freshJob = await db.ProcessingJobs.FirstAsync(j => j.Id == jobId, ct);
            var freshRecording = await db.Recordings.FirstAsync(r => r.Id == recording.Id, ct);

            if (freshRecording.PreviewStatus == PreviewStatus.Ready)
            {
                return;
            }

            var now = DateTime.UtcNow;
            var maxAttempts = Math.Max(1, freshJob.MaxAttempts);
            var canAutoRetry = isRetryable && freshJob.AttemptCount < maxAttempts;

            freshJob.LeaseOwner = null;
            freshJob.LeaseExpiresAtUtc = null;
            freshJob.LastErrorCode = errorCode;
            freshJob.LastErrorDetail = Truncate(detail, 2000);

            if (canAutoRetry)
            {
                var baseDelay = Math.Max(1, _options.WorkerRetryBaseDelaySeconds);
                var exponent = Math.Clamp(freshJob.AttemptCount - 1, 0, 8);
                var delaySeconds = Math.Min(300, baseDelay * (1 << exponent));

                freshJob.Status = ProcessingJobStatus.Queued;
                freshJob.NextAttemptAtUtc = now.AddSeconds(delaySeconds);

                // Keep StorageStatus = Stored untouched!
                freshRecording.PreviewStatus = PreviewStatus.Pending;
                freshRecording.UpdatedAtUtc = now;
                terminalFailure = false;
            }
            else
            {
                freshJob.Status = isRetryable ? ProcessingJobStatus.Failed : ProcessingJobStatus.DeadLetter;
                freshJob.CompletedAtUtc = now;

                // CRITICAL: Keep StorageStatus = Stored so Original video remains 100% safe and accessible!
                freshRecording.PreviewStatus = PreviewStatus.Failed;
                freshRecording.UpdatedAtUtc = now;
                terminalFailure = true;
            }

            try
            {
                await db.SaveChangesAsync(ct);
                break;
            }
            catch (DbUpdateConcurrencyException) when (attempt < 2)
            {
                // Retry on concurrent Recording xmin update
            }
        }

        if (terminalFailure)
        {
            await auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.preview_failed",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Failed,
                ActorUserId: recording.OwnerUserId,
                ActorEmail: recording.OwnerUser?.Email,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                Metadata: new
                {
                    trackingNumber = recording.TrackingNumber,
                    errorCode,
                    isRetryable,
                    originalStorageStatus = StorageStatus.Stored.ToString()
                }), ct);
        }
    }

    private async Task ScheduleRetryOrMarkRetryableFailureAsync(
        Guid jobId,
        Guid recordingId,
        string errorCode,
        string userSafeMessage,
        string detail,
        CancellationToken ct)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            using var saveScope = _scopeFactory.CreateScope();
            var db = saveScope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

            var job = await db.ProcessingJobs.FirstAsync(j => j.Id == jobId, ct);
            var recording = await db.Recordings.FirstAsync(r => r.Id == recordingId, ct);

            if (recording.StorageStatus == StorageStatus.Stored)
            {
                return;
            }

            var now = DateTime.UtcNow;
            var maxAttempts = Math.Max(1, job.MaxAttempts);
            var canAutoRetry = job.AttemptCount < maxAttempts;

            job.LeaseOwner = null;
            job.LeaseExpiresAtUtc = null;
            job.LastErrorCode = errorCode;
            job.LastErrorDetail = Truncate(detail, 2000);

            if (canAutoRetry)
            {
                var baseDelay = Math.Max(1, _options.WorkerRetryBaseDelaySeconds);
                var exponent = Math.Clamp(job.AttemptCount - 1, 0, 8);
                var delaySeconds = Math.Min(300, baseDelay * (1 << exponent));

                job.Status = ProcessingJobStatus.Queued;
                job.NextAttemptAtUtc = now.AddSeconds(delaySeconds);

                recording.StorageStatus = StorageStatus.WaitingForStorage;
                recording.LastErrorCode = errorCode;
                recording.UserSafeErrorMessage = Truncate(userSafeMessage, 500);
                recording.IsRetryable = true;
                recording.UpdatedAtUtc = now;
            }
            else
            {
                // Attempts exhausted: mark Failed with IsRetryable = true while keeping staging intact
                // so owner/admin can trigger POST /api/recordings/{id}/retry-storage once NAS is restored!
                job.Status = ProcessingJobStatus.Failed;

                recording.StorageStatus = StorageStatus.Failed;
                recording.LastErrorCode = errorCode;
                recording.UserSafeErrorMessage = Truncate(userSafeMessage, 500);
                recording.IsRetryable = true;
                recording.UpdatedAtUtc = now;
            }

            try
            {
                await db.SaveChangesAsync(ct);
                return;
            }
            catch (DbUpdateConcurrencyException) when (attempt < 2)
            {
                // Retry on concurrent Recording xmin update
            }
        }
    }

    private async Task FailPermanentlyAsync(
        PackingProofDbContext db,
        IAuditLogger auditLogger,
        ProcessingJob job,
        Recording recording,
        string errorCode,
        string userSafeMessage,
        string detail,
        bool cleanupStaging,
        string stagingRoot,
        UploadSession? uploadSession,
        CancellationToken ct)
    {
        db.ChangeTracker.Clear();

        for (var attempt = 0; attempt < 3; attempt++)
        {
            var freshJob = await db.ProcessingJobs.FirstAsync(j => j.Id == job.Id, ct);
            var freshRecording = await db.Recordings.FirstAsync(r => r.Id == recording.Id, ct);

            var now = DateTime.UtcNow;
            freshJob.Status = ProcessingJobStatus.DeadLetter;
            freshJob.CompletedAtUtc = now;
            freshJob.LeaseOwner = null;
            freshJob.LeaseExpiresAtUtc = null;
            freshJob.LastErrorCode = errorCode;
            freshJob.LastErrorDetail = Truncate(detail, 2000);

            freshRecording.StorageStatus = StorageStatus.Failed;
            freshRecording.LastErrorCode = errorCode;
            freshRecording.UserSafeErrorMessage = Truncate(userSafeMessage, 500);
            freshRecording.IsRetryable = false;
            freshRecording.UpdatedAtUtc = now;

            try
            {
                await db.SaveChangesAsync(ct);
                break;
            }
            catch (DbUpdateConcurrencyException) when (attempt < 2)
            {
                db.ChangeTracker.Clear();
            }
        }

        await auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "video.storage_failed",
            EntityType: "Recording",
            EntityId: recording.Id.ToString(),
            Outcome: AuditOutcome.Failed,
            ActorUserId: recording.OwnerUserId,
            ActorEmail: recording.OwnerUser?.Email,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId,
            Metadata: new
            {
                trackingNumber = recording.TrackingNumber,
                errorCode,
                isRetryable = false
            }), ct);

        if (cleanupStaging)
        {
            await CleanupStagingAfterStoredAsync(stagingRoot, uploadSession);
        }
    }

    private static string ResolveSafeTempInputExtension(string? actualContainer, string relativePath)
    {
        if (!string.IsNullOrWhiteSpace(actualContainer))
        {
            try
            {
                return StoragePathBuilder.ResolveVerifiedExtension(actualContainer);
            }
            catch (ArgumentException)
            {
                // Fall back to relative path extension
            }
        }

        var ext = Path.GetExtension(relativePath).ToLowerInvariant();
        return ext is ".webm" or ".mp4" or ".mkv" or ".mov" ? ext : ".webm";
    }

    private static void TryDeleteTempFileBestEffort(string filePath)
    {
        try
        {
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
            }
        }
        catch
        {
            // Ignore temp file cleanup errors
        }
    }

    private static string? ResolveStagingFilePath(string stagingRootFullPath, UploadSession? uploadSession)
    {
        if (uploadSession is null)
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(uploadSession.StagingFilePath))
        {
            try
            {
                var fileName = Path.GetFileName(uploadSession.StagingFilePath);
                var candidate = PathSegmentSanitizer.CombineWithinRoot(stagingRootFullPath, fileName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch
            {
                // Fall through to TusResourceId resolution
            }
        }

        if (!string.IsNullOrWhiteSpace(uploadSession.TusResourceId) &&
            !uploadSession.TusResourceId.StartsWith(StagingQuotaGuard.PendingResourcePrefix, StringComparison.Ordinal))
        {
            try
            {
                return PathSegmentSanitizer.CombineWithinRoot(stagingRootFullPath, uploadSession.TusResourceId);
            }
            catch
            {
                return null;
            }
        }

        return null;
    }

    private static async Task CleanupStagingAfterStoredAsync(
        string stagingRootFullPath,
        UploadSession? uploadSession)
    {
        if (uploadSession is null)
        {
            return;
        }

        await RecordingUploadCoordinator.TryDeleteTusFileBestEffortAsync(
            stagingRootFullPath,
            uploadSession.TusResourceId);

        if (!string.IsNullOrWhiteSpace(uploadSession.StagingFilePath))
        {
            try
            {
                var fileName = Path.GetFileName(uploadSession.StagingFilePath);
                var full = PathSegmentSanitizer.CombineWithinRoot(stagingRootFullPath, fileName);
                if (File.Exists(full))
                {
                    File.Delete(full);
                }
            }
            catch
            {
                // Ignore best-effort cleanup errors
            }
        }
    }

    private static string Truncate(string value, int maxLength) =>
        value.Length <= maxLength ? value : value[..maxLength];
}
