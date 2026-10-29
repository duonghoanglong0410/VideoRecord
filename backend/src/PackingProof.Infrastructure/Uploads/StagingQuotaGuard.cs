using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PackingProof.Core.Enums;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Infrastructure.Uploads;

public sealed record StagingQuotaSnapshot(
    long MaxStagingBytes,
    long DiskUsedBytes,
    long ReservedRemainingBytes,
    long TotalFootprintBytes,
    long AvailableBytes);

public sealed class StagingQuotaGuard
{
    public const string PendingResourcePrefix = "pending-";

    private readonly SemaphoreSlim _reservationGate = new(1, 1);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly PackingProofOptions _options;

    public StagingQuotaGuard(
        IServiceScopeFactory scopeFactory,
        PackingProofOptions options)
    {
        _scopeFactory = scopeFactory;
        _options = options;
    }

    public async Task<T> RunUnderReservationLockAsync<T>(
        Func<CancellationToken, Task<T>> action,
        CancellationToken ct = default)
    {
        await _reservationGate.WaitAsync(ct);
        try
        {
            return await action(ct);
        }
        finally
        {
            _reservationGate.Release();
        }
    }

    public async Task<StagingQuotaSnapshot> GetSnapshotAsync(
        Guid? excludeRecordingId = null,
        CancellationToken ct = default)
    {
        var stagingFullPath = Path.GetFullPath(_options.StagingRootPath);
        Directory.CreateDirectory(stagingFullPath);

        var fileSizesByName = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        long diskUsedBytes = 0;

        var dirInfo = new DirectoryInfo(stagingFullPath);
        if (dirInfo.Exists)
        {
            foreach (var file in dirInfo.EnumerateFiles("*", SearchOption.AllDirectories))
            {
                try
                {
                    var len = file.Length;
                    diskUsedBytes += len;
                    if (string.Equals(file.DirectoryName, dirInfo.FullName, StringComparison.OrdinalIgnoreCase))
                    {
                        fileSizesByName[file.Name] = len;
                    }
                }
                catch (IOException)
                {
                    // File deleted concurrently during worker cleanup
                }
            }
        }

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
        var now = DateTime.UtcNow;

        var activeQuery = db.UploadSessions
            .AsNoTracking()
            .Where(u =>
                (u.Status == UploadSessionStatus.Initiated || u.Status == UploadSessionStatus.Receiving) &&
                u.ExpiresAtUtc > now);

        if (excludeRecordingId.HasValue)
        {
            var excluded = excludeRecordingId.Value;
            activeQuery = activeQuery.Where(u => u.RecordingId != excluded);
        }

        var activeSessions = await activeQuery
            .Select(u => new { u.TusResourceId, u.ExpectedBytes })
            .ToListAsync(ct);

        long reservedRemainingBytes = 0;
        foreach (var session in activeSessions)
        {
            long alreadyOnDisk = 0;
            if (!string.IsNullOrWhiteSpace(session.TusResourceId) &&
                !session.TusResourceId.StartsWith(PendingResourcePrefix, StringComparison.Ordinal) &&
                fileSizesByName.TryGetValue(session.TusResourceId, out var diskLen))
            {
                alreadyOnDisk = diskLen;
            }

            var remainingForSession = Math.Max(0L, session.ExpectedBytes - alreadyOnDisk);
            reservedRemainingBytes += remainingForSession;
        }

        var totalFootprint = diskUsedBytes + reservedRemainingBytes;
        var available = Math.Max(0L, _options.StagingMaxBytes - totalFootprint);

        return new StagingQuotaSnapshot(
            MaxStagingBytes: _options.StagingMaxBytes,
            DiskUsedBytes: diskUsedBytes,
            ReservedRemainingBytes: reservedRemainingBytes,
            TotalFootprintBytes: totalFootprint,
            AvailableBytes: available);
    }

    public async Task<(bool Allowed, StagingQuotaSnapshot Snapshot)> CanAccommodateAsync(
        long requestedExpectedBytes,
        Guid? excludeRecordingId = null,
        CancellationToken ct = default)
    {
        var snapshot = await GetSnapshotAsync(excludeRecordingId, ct);
        var allowed = requestedExpectedBytes > 0 &&
                      snapshot.TotalFootprintBytes + requestedExpectedBytes <= snapshot.MaxStagingBytes;
        return (allowed, snapshot);
    }
}

