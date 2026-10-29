using PackingProof.Core.Enums;

namespace PackingProof.Core.Entities;

public class UploadSession
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid RecordingId { get; set; }
    public Recording Recording { get; set; } = null!;

    public Guid OwnerUserId { get; set; }
    public ApplicationUser OwnerUser { get; set; } = null!;

    public string TusResourceId { get; set; } = string.Empty;
    public long ExpectedBytes { get; set; }
    public long ReceivedBytes { get; set; }
    public string? ClientSha256 { get; set; }
    public UploadSessionStatus Status { get; set; } = UploadSessionStatus.Initiated;
    public string StagingFilePath { get; set; } = string.Empty;
    public DateTime ExpiresAtUtc { get; set; }
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAtUtc { get; set; }
}

