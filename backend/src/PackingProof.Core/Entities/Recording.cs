using PackingProof.Core.Enums;

namespace PackingProof.Core.Entities;

public class Recording
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid OwnerUserId { get; set; }
    public ApplicationUser OwnerUser { get; set; } = null!;

    public Guid ShopId { get; set; }
    public Shop Shop { get; set; } = null!;

    public Guid WarehouseId { get; set; }
    public Warehouse Warehouse { get; set; } = null!;

    public Guid? PackingStationId { get; set; }
    public PackingStation? PackingStation { get; set; }

    /// <summary>
    /// Raw tracking number preserving leading zeros and original casing. Not globally unique.
    /// </summary>
    public string TrackingNumber { get; set; } = string.Empty;
    public string SafeTrackingSegment { get; set; } = string.Empty;
    public string? CarrierCode { get; set; }
    public string? TikTokOrderId { get; set; }

    public RecordingSource Source { get; set; } = RecordingSource.RecordedInBrowser;
    public string? ManualEntryReason { get; set; }
    public Guid? LinkedFromRecordingId { get; set; }
    public Recording? LinkedFromRecording { get; set; }

    public CaptureStatus CaptureStatus { get; set; } = CaptureStatus.Created;
    public StorageStatus StorageStatus { get; set; } = StorageStatus.AwaitingUpload;
    public PreviewStatus PreviewStatus { get; set; } = PreviewStatus.NotRequired;

    public string? ClientMimeType { get; set; }
    public string? ActualMimeType { get; set; }
    public string? ActualContainer { get; set; }
    public string? VideoCodec { get; set; }
    public string? AudioCodec { get; set; }

    public double? DurationSeconds { get; set; }
    public int? Width { get; set; }
    public int? Height { get; set; }

    public DateTime? StartedAtUtc { get; set; }
    public DateTime? EndedAtUtc { get; set; }
    public DateTime? ServerReceivedAtUtc { get; set; }
    public DateTime? StoredAtUtc { get; set; }

    public bool Hold { get; set; }
    public string? HoldReason { get; set; }
    public Guid? HoldUpdatedByUserId { get; set; }
    public DateTime? HoldUpdatedAtUtc { get; set; }

    public bool IsSoftDeleted { get; set; }
    public DateTime? DeletedAtUtc { get; set; }
    public DateTime? PhysicalDeletedAtUtc { get; set; }

    public string? LastErrorCode { get; set; }
    public string? UserSafeErrorMessage { get; set; }
    public bool IsRetryable { get; set; }

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Mapped to PostgreSQL system column xmin as optimistic concurrency token.
    /// </summary>
    public uint Version { get; set; }

    public ICollection<UploadSession> UploadSessions { get; set; } = new List<UploadSession>();
    public ICollection<VideoAsset> VideoAssets { get; set; } = new List<VideoAsset>();
    public ICollection<ProcessingJob> ProcessingJobs { get; set; } = new List<ProcessingJob>();
    public ICollection<VideoNote> Notes { get; set; } = new List<VideoNote>();
    public ICollection<DeletionRequest> DeletionRequests { get; set; } = new List<DeletionRequest>();
}

