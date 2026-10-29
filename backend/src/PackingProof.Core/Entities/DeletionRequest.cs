using PackingProof.Core.Enums;

namespace PackingProof.Core.Entities;

public class DeletionRequest
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid RecordingId { get; set; }
    public Recording Recording { get; set; } = null!;

    public Guid RequestedByUserId { get; set; }
    public ApplicationUser RequestedByUser { get; set; } = null!;

    public string Reason { get; set; } = string.Empty;
    public DeletionRequestStatus Status { get; set; } = DeletionRequestStatus.Pending;

    public Guid? ReviewedByUserId { get; set; }
    public ApplicationUser? ReviewedByUser { get; set; }
    public string? ReviewNote { get; set; }
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime? ReviewedAtUtc { get; set; }
}

