namespace PackingProof.Core.Enums;

public enum StorageStatus
{
    AwaitingUpload = 0,
    Uploading = 1,
    Validating = 2,
    WaitingForStorage = 3,
    CopyingToStorage = 4,
    Stored = 5,
    Failed = 6
}

