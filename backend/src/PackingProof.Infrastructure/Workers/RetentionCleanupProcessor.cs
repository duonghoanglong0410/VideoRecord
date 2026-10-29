using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Enums;
using PackingProof.Core.Storage;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Infrastructure.Workers;

public sealed record RetentionSweepResult(
    bool RetentionEnabled,
    int RetentionDays,
    DateTime? CutoffUtc,
    int EvaluatedCount,
    int DeletedCount,
    int SkippedHoldCount,
    int FailedCount);

public sealed class RetentionCleanupProcessor
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IVideoStorage _videoStorage;
    private readonly ILogger<RetentionCleanupProcessor> _logger;

    public RetentionCleanupProcessor(
        IServiceScopeFactory scopeFactory,
        IVideoStorage videoStorage,
        ILogger<RetentionCleanupProcessor> logger)
    {
        _scopeFactory = scopeFactory;
        _videoStorage = videoStorage;
        _logger = logger;
    }

    public async Task<RetentionSweepResult> RunSweepOnceAsync(
        bool skipRecentHoldAuditWindow = false,
        CancellationToken ct = default)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

        var profile = await db.StorageProfiles
            .AsNoTracking()
            .OrderBy(p => p.Name)
            .FirstOrDefaultAsync(ct);

        if (profile is null || !profile.RetentionEnabled)
        {
            return new RetentionSweepResult(
                RetentionEnabled: false,
                RetentionDays: profile?.RetentionDays ?? 0,
                CutoffUtc: null,
                EvaluatedCount: 0,
                DeletedCount: 0,
                SkippedHoldCount: 0,
                FailedCount: 0);
        }

        var retentionDays = Math.Max(1, profile.RetentionDays);
        var now = DateTime.UtcNow;
        var cutoffUtc = now.AddDays(-retentionDays);

        var candidateIds = await db.Recordings
            .AsNoTracking()
            .Where(r =>
                !r.IsSoftDeleted &&
                r.StorageStatus == StorageStatus.Stored &&
                (r.StoredAtUtc ?? r.CreatedAtUtc) <= cutoffUtc)
            .OrderBy(r => r.CreatedAtUtc)
            .Select(r => r.Id)
            .ToListAsync(ct);

        var evaluated = 0;
        var deleted = 0;
        var skippedHold = 0;
        var failed = 0;

        foreach (var candidateId in candidateIds)
        {
            ct.ThrowIfCancellationRequested();

            using var itemScope = _scopeFactory.CreateScope();
            var itemDb = itemScope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
            var auditLogger = itemScope.ServiceProvider.GetRequiredService<IAuditLogger>();

            var recording = await itemDb.Recordings
                .Include(r => r.VideoAssets)
                .FirstOrDefaultAsync(r => r.Id == candidateId, ct);

            if (recording is null || recording.IsSoftDeleted || recording.StorageStatus != StorageStatus.Stored)
            {
                continue;
            }

            var effectiveStoredUtc = recording.StoredAtUtc ?? recording.CreatedAtUtc;
            if (effectiveStoredUtc > cutoffUtc)
            {
                continue;
            }

            evaluated++;

            if (recording.Hold)
            {
                skippedHold++;

                var shouldAppendHoldAudit = true;
                if (skipRecentHoldAuditWindow)
                {
                    var entityIdStr = recording.Id.ToString();
                    var recentWindow = DateTime.UtcNow.AddHours(-12);
                    shouldAppendHoldAudit = !await itemDb.AuditEvents
                        .AsNoTracking()
                        .AnyAsync(a =>
                            a.Action == "retention.skipped_hold" &&
                            a.EntityId == entityIdStr &&
                            a.OccurredAtUtc >= recentWindow, ct);
                }

                if (shouldAppendHoldAudit)
                {
                    await auditLogger.AppendAsync(new AuditEntryRequest(
                        Action: "retention.skipped_hold",
                        EntityType: "Recording",
                        EntityId: recording.Id.ToString(),
                        Outcome: AuditOutcome.Success,
                        ShopId: recording.ShopId,
                        WarehouseId: recording.WarehouseId,
                        Metadata: new
                        {
                            trackingNumber = recording.TrackingNumber,
                            holdReason = recording.HoldReason,
                            retentionDays,
                            storedAtUtc = recording.StoredAtUtc,
                            decision = "retained_due_to_active_hold"
                        }), ct);
                }

                continue;
            }

            try
            {
                var deletedFiles = 0;
                foreach (var asset in recording.VideoAssets)
                {
                    if (!string.IsNullOrWhiteSpace(asset.RelativePath))
                    {
                        var existed = await _videoStorage.DeleteIfExistsAsync(asset.RelativePath, ct);
                        if (existed)
                        {
                            deletedFiles++;
                        }
                    }
                }

                var deletedAt = DateTime.UtcNow;
                recording.IsSoftDeleted = true;
                recording.DeletedAtUtc ??= deletedAt;
                recording.PhysicalDeletedAtUtc = deletedAt;
                recording.UpdatedAtUtc = deletedAt;

                await itemDb.SaveChangesAsync(ct);
                deleted++;

                await auditLogger.AppendAsync(new AuditEntryRequest(
                    Action: "retention.deleted",
                    EntityType: "Recording",
                    EntityId: recording.Id.ToString(),
                    Outcome: AuditOutcome.Success,
                    ShopId: recording.ShopId,
                    WarehouseId: recording.WarehouseId,
                    Metadata: new
                    {
                        trackingNumber = recording.TrackingNumber,
                        retentionDays,
                        storedAtUtc = recording.StoredAtUtc,
                        deletedPhysicalAssetCount = deletedFiles
                    }), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed++;
                _logger.LogWarning(
                    ex,
                    "Retention cleanup failed for Recording '{RecordingId}'.",
                    recording.Id);

                await auditLogger.AppendAsync(new AuditEntryRequest(
                    Action: "retention.delete_failed",
                    EntityType: "Recording",
                    EntityId: recording.Id.ToString(),
                    Outcome: AuditOutcome.Failed,
                    ShopId: recording.ShopId,
                    WarehouseId: recording.WarehouseId,
                    Metadata: new
                    {
                        trackingNumber = recording.TrackingNumber,
                        retentionDays,
                        errorType = ex.GetType().Name
                    }), ct);
            }
        }

        return new RetentionSweepResult(
            RetentionEnabled: true,
            RetentionDays: retentionDays,
            CutoffUtc: cutoffUtc,
            EvaluatedCount: evaluated,
            DeletedCount: deleted,
            SkippedHoldCount: skippedHold,
            FailedCount: failed);
    }
}
