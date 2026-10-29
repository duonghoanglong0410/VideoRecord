namespace PackingProof.Core.Entities;

public class VideoNote
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid RecordingId { get; set; }
    public Recording Recording { get; set; } = null!;

    public Guid AuthorUserId { get; set; }
    public ApplicationUser AuthorUser { get; set; } = null!;

    public string Content { get; set; } = string.Empty;
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}

