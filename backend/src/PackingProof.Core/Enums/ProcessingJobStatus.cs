namespace PackingProof.Core.Enums;

public enum ProcessingJobStatus
{
    Queued = 0,
    Running = 1,
    Succeeded = 2,
    Failed = 3,
    DeadLetter = 4
}

