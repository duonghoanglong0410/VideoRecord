using PackingProof.Core.Enums;

namespace PackingProof.Core.Entities;

public class VideoAsset
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid RecordingId { get; set; }
    public Recording Recording { get; set; } = null!;

    public AssetKind Kind { get; set; }

    public Guid StorageProfileId { get; set; }
    public StorageProfile StorageProfile { get; set; } = null!;

    public string RelativePath { get; set; } = string.Empty;
    public string MimeType { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public string Sha256 { get; set; } = string.Empty;
    public DateTime VerifiedAtUtc { get; set; }
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}

