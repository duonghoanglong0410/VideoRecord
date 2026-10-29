using PackingProof.Core.Enums;

namespace PackingProof.Core.Abstractions;

public sealed record AuditEntryRequest(
    string Action,
    string EntityType,
    string? EntityId = null,
    AuditOutcome Outcome = AuditOutcome.Success,
    Guid? ActorUserId = null,
    string? ActorEmail = null,
    Guid? ShopId = null,
    Guid? WarehouseId = null,
    string? IpAddress = null,
    string? UserAgent = null,
    object? Metadata = null);

public interface IAuditLogger
{
    Task AppendAsync(AuditEntryRequest entry, CancellationToken ct = default);
}

