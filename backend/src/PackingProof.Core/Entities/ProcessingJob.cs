using PackingProof.Core.Enums;

namespace PackingProof.Core.Entities;

public class ProcessingJob
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid RecordingId { get; set; }
    public Recording Recording { get; set; } = null!;

    public ProcessingJobType JobType { get; set; }
    public ProcessingJobStatus Status { get; set; } = ProcessingJobStatus.Queued;

    public int AttemptCount { get; set; }
    public int MaxAttempts { get; set; } = 5;
    public DateTime NextAttemptAtUtc { get; set; } = DateTime.UtcNow;
    public string? LeaseOwner { get; set; }
    public DateTime? LeaseExpiresAtUtc { get; set; }
    public string? LastErrorCode { get; set; }
    public string? LastErrorDetail { get; set; }
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAtUtc { get; set; }
}

