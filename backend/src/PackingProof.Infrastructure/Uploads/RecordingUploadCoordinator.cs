using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Tracking;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Workers;
using tusdotnet.Stores;

namespace PackingProof.Infrastructure.Uploads;

public sealed class RecordingUploadCoordinator
{
    private readonly PackingProofDbContext _db;
    private readonly PackingProofOptions _options;
    private readonly IProcessingJobSignal _jobSignal;
    private readonly ILogger<RecordingUploadCoordinator> _logger;

    public RecordingUploadCoordinator(
        PackingProofDbContext db,
        PackingProofOptions options,
        IProcessingJobSignal jobSignal,
        ILogger<RecordingUploadCoordinator> logger)
    {
        _db = db;
        _options = options;
        _jobSignal = jobSignal;
        _logger = logger;
    }

    public async Task BindTusFileCreatedAsync(
        Guid uploadSessionId,
        string tusFileId,
        CancellationToken ct = default)
    {
        var stagingRoot = Path.GetFullPath(_options.StagingRootPath);
        var stagingFilePath = PathSegmentSanitizer.CombineWithinRoot(stagingRoot, tusFileId);

        for (var attempt = 0; attempt < 3; attempt++)
        {
            var session = await _db.UploadSessions
                .Include(u => u.Recording)
                .FirstOrDefaultAsync(u => u.Id == uploadSessionId, ct);

            if (session is null)
            {
                throw new InvalidOperationException($"UploadSession '{uploadSessionId}' no longer exists.");
            }

            var previousTusId = session.TusResourceId;
            session.TusResourceId = tusFileId;
            session.StagingFilePath = stagingFilePath;
            session.Status = UploadSessionStatus.Receiving;

            if (session.Recording.StorageStatus != StorageStatus.Stored)
            {
                session.Recording.StorageStatus = StorageStatus.Uploading;
                session.Recording.UpdatedAtUtc = DateTime.UtcNow;
            }

            try
            {
                await _db.SaveChangesAsync(ct);

                // Clean up any obsolete abandoned tus file for this session
                if (!string.IsNullOrWhiteSpace(previousTusId) &&
                    !previousTusId.StartsWith(StagingQuotaGuard.PendingResourcePrefix, StringComparison.Ordinal) &&
                    !string.Equals(previousTusId, tusFileId, StringComparison.Ordinal))
                {
                    await TryDeleteTusFileBestEffortAsync(stagingRoot, previousTusId);
                }

                return;
            }
            catch (DbUpdateConcurrencyException) when (attempt < 2)
            {
                _db.ChangeTracker.Clear();
            }
        }
    }

    public async Task HandleTusFileCompletedAsync(
        string tusFileId,
        long receivedBytes,
        CancellationToken ct = default)
    {
        var stagingRoot = Path.GetFullPath(_options.StagingRootPath);
        var stagingFilePath = PathSegmentSanitizer.CombineWithinRoot(stagingRoot, tusFileId);

        for (var attempt = 0; attempt < 4; attempt++)
        {
            var session = await _db.UploadSessions
                .Include(u => u.Recording)
                .FirstOrDefaultAsync(u => u.TusResourceId == tusFileId, ct);

            if (session is null)
            {
                _logger.LogWarning("OnFileComplete received for unknown TusResourceId '{TusFileId}'.", tusFileId);
                return;
            }

            var now = DateTime.UtcNow;
            session.ReceivedBytes = receivedBytes > 0 ? receivedBytes : session.ExpectedBytes;
            session.Status = UploadSessionStatus.Completed;
            session.CompletedAtUtc ??= now;

            if (string.IsNullOrWhiteSpace(session.StagingFilePath))
            {
                session.StagingFilePath = stagingFilePath;
            }

            // NEVER mark Recording as Stored on tus completion — transition to Validating!
            if (session.Recording.StorageStatus != StorageStatus.Stored)
            {
                session.Recording.ServerReceivedAtUtc ??= now;
                if (session.Recording.StorageStatus is StorageStatus.AwaitingUpload or StorageStatus.Uploading or StorageStatus.Failed)
                {
                    session.Recording.StorageStatus = StorageStatus.Validating;
                }
                session.Recording.UpdatedAtUtc = now;
            }

            var existingJob = await _db.ProcessingJobs
                .FirstOrDefaultAsync(j =>
                    j.RecordingId == session.RecordingId &&
                    j.JobType == ProcessingJobType.ValidateAndStoreOriginal, ct);

            if (existingJob is null)
            {
                _db.ProcessingJobs.Add(new ProcessingJob
                {
                    Id = Guid.NewGuid(),
                    RecordingId = session.RecordingId,
                    JobType = ProcessingJobType.ValidateAndStoreOriginal,
                    Status = session.Recording.StorageStatus == StorageStatus.Stored
                        ? ProcessingJobStatus.Succeeded
                        : ProcessingJobStatus.Queued,
                    AttemptCount = 0,
                    MaxAttempts = Math.Max(1, _options.WorkerMaxAttempts),
                    NextAttemptAtUtc = now,
                    CreatedAtUtc = now,
                    CompletedAtUtc = session.Recording.StorageStatus == StorageStatus.Stored ? now : null
                });
            }
            else if (session.Recording.StorageStatus != StorageStatus.Stored)
            {
                var hasActiveLease = existingJob.Status == ProcessingJobStatus.Running &&
                                     existingJob.LeaseExpiresAtUtc.HasValue &&
                                     existingJob.LeaseExpiresAtUtc.Value > now;

                if (!hasActiveLease && existingJob.Status != ProcessingJobStatus.Succeeded)
                {
                    existingJob.Status = ProcessingJobStatus.Queued;
                    existingJob.NextAttemptAtUtc = now;
                }
            }

            try
            {
                await _db.SaveChangesAsync(ct);
                _jobSignal.NotifyNewWork();
                return;
            }
            catch (DbUpdateException) when (attempt < 3)
            {
                _db.ChangeTracker.Clear();
            }
        }
    }

    public async Task HandleTusFileDeletedAsync(string tusFileId, CancellationToken ct = default)
    {
        var session = await _db.UploadSessions
            .Include(u => u.Recording)
            .FirstOrDefaultAsync(u => u.TusResourceId == tusFileId, ct);

        if (session is null || session.Recording.StorageStatus == StorageStatus.Stored)
        {
            return;
        }

        session.Status = UploadSessionStatus.Aborted;
        session.TusResourceId = $"{StagingQuotaGuard.PendingResourcePrefix}{session.Id:N}";
        session.ReceivedBytes = 0;
        session.StagingFilePath = string.Empty;

        if (session.Recording.StorageStatus == StorageStatus.Uploading)
        {
            session.Recording.StorageStatus = StorageStatus.AwaitingUpload;
            session.Recording.UpdatedAtUtc = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync(ct);
    }

    public static async Task TryDeleteTusFileBestEffortAsync(string stagingRootFullPath, string? tusFileId)
    {
        if (string.IsNullOrWhiteSpace(tusFileId) ||
            tusFileId.StartsWith(StagingQuotaGuard.PendingResourcePrefix, StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            var store = new TusDiskStore(stagingRootFullPath);
            if (await store.FileExistAsync(tusFileId, CancellationToken.None))
            {
                await store.DeleteFileAsync(tusFileId, CancellationToken.None);
            }
        }
        catch
        {
            // Ignore best-effort tus store cleanup failures
        }

        try
        {
            var safePrefix = PathSegmentSanitizer.ToSafeSegment(tusFileId);
            if (!string.Equals(safePrefix, tusFileId, StringComparison.Ordinal))
            {
                return;
            }

            var dir = new DirectoryInfo(stagingRootFullPath);
            if (!dir.Exists)
            {
                return;
            }

            foreach (var sidecar in dir.EnumerateFiles($"{tusFileId}*"))
            {
                if (string.Equals(sidecar.Name, tusFileId, StringComparison.Ordinal) ||
                    sidecar.Name.StartsWith($"{tusFileId}.", StringComparison.Ordinal))
                {
                    try
                    {
                        sidecar.Delete();
                    }
                    catch
                    {
                        // Ignore locked file
                    }
                }
            }
        }
        catch
        {
            // Ignore best-effort sidecar cleanup failures
        }
    }
}

