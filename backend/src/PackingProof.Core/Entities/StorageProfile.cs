using PackingProof.Core.Enums;

namespace PackingProof.Core.Entities;

public class StorageProfile
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "Default";
    public StorageMode Mode { get; set; } = StorageMode.LocalDevelopment;
    public string ExpectedStorageId { get; set; } = string.Empty;
    public string AllowedSubdirectoriesJson { get; set; } = "[]";
    public int MaxRecordingSeconds { get; set; } = 600;
    public long MaxUploadBytes { get; set; } = 536_870_912;
    public int MaxLocalPendingRecordings { get; set; } = 3;
    public bool RetentionEnabled { get; set; }
    public int RetentionDays { get; set; } = 90;
    public bool EnableAudioRecording { get; set; }
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
    public Guid? UpdatedByUserId { get; set; }
}

