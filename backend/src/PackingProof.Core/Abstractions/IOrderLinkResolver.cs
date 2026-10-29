namespace PackingProof.Core.Abstractions;

public sealed record OrderLinkResolution(
    string? TikTokOrderId,
    string? CarrierCode);

/// <summary>
/// Extension seam for future DTD Commerce order/tracking linking.
/// Phase 1 operates purely by TrackingNumber via <see cref="NoOpOrderLinkResolver"/>.
/// </summary>
public interface IOrderLinkResolver
{
    Task<OrderLinkResolution?> ResolveAsync(
        Guid shopId,
        string trackingNumber,
        CancellationToken ct = default);
}

public sealed class NoOpOrderLinkResolver : IOrderLinkResolver
{
    public Task<OrderLinkResolution?> ResolveAsync(
        Guid shopId,
        string trackingNumber,
        CancellationToken ct = default) =>
        Task.FromResult<OrderLinkResolution?>(null);
}

