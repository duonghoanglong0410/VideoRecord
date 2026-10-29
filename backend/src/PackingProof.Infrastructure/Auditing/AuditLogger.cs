using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Infrastructure.Auditing;

public sealed class AuditLogger : IAuditLogger
{
    private readonly PackingProofDbContext _db;

    public AuditLogger(PackingProofDbContext db)
    {
        _db = db;
    }

    public async Task AppendAsync(AuditEntryRequest entry, CancellationToken ct = default)
    {
        var auditEvent = new AuditEvent
        {
            OccurredAtUtc = DateTime.UtcNow,
            ActorUserId = entry.ActorUserId,
            ActorEmail = entry.ActorEmail,
            Action = entry.Action,
            EntityType = entry.EntityType,
            EntityId = entry.EntityId,
            ShopId = entry.ShopId,
            WarehouseId = entry.WarehouseId,
            Outcome = entry.Outcome,
            IpAddress = Truncate(entry.IpAddress, 64),
            UserAgent = Truncate(entry.UserAgent, 512),
            MetadataJson = AuditMetadataScrubber.ScrubToJson(entry.Metadata)
        };

        _db.AuditEvents.Add(auditEvent);
        await _db.SaveChangesAsync(ct);
    }

    private static string? Truncate(string? input, int maxLength)
    {
        if (string.IsNullOrEmpty(input) || input.Length <= maxLength)
        {
            return input;
        }

        return input[..maxLength];
    }
}

