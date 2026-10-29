namespace PackingProof.Core.Storage;

public sealed class StorageUnavailableException : Exception
{
    public string ErrorCode { get; }
    public string UserSafeMessage { get; }
    public bool IsRetryable => true;

    public StorageUnavailableException(
        string errorCode,
        string userSafeMessage,
        string? detail = null,
        Exception? innerException = null)
        : base(string.IsNullOrWhiteSpace(detail) ? userSafeMessage : detail, innerException)
    {
        ErrorCode = errorCode;
        UserSafeMessage = userSafeMessage;
    }
}

public sealed class StorageConflictException : Exception
{
    public string ErrorCode { get; }
    public string UserSafeMessage { get; }
    public bool IsRetryable => false;

    public StorageConflictException(
        string errorCode,
        string userSafeMessage,
        string? detail = null,
        Exception? innerException = null)
        : base(string.IsNullOrWhiteSpace(detail) ? userSafeMessage : detail, innerException)
    {
        ErrorCode = errorCode;
        UserSafeMessage = userSafeMessage;
    }
}

public sealed class MediaValidationException : Exception
{
    public string ErrorCode { get; }
    public string UserSafeMessage { get; }
    public bool IsRetryable => false;

    public MediaValidationException(
        string errorCode,
        string userSafeMessage,
        string? detail = null,
        Exception? innerException = null)
        : base(string.IsNullOrWhiteSpace(detail) ? userSafeMessage : detail, innerException)
    {
        ErrorCode = errorCode;
        UserSafeMessage = userSafeMessage;
    }
}

public sealed class PreviewTranscodeException : Exception
{
    public string ErrorCode { get; }
    public string UserSafeMessage { get; }
    public bool IsRetryable { get; }

    public PreviewTranscodeException(
        string errorCode,
        string userSafeMessage,
        bool isRetryable,
        string? detail = null,
        Exception? innerException = null)
        : base(string.IsNullOrWhiteSpace(detail) ? userSafeMessage : detail, innerException)
    {
        ErrorCode = errorCode;
        UserSafeMessage = userSafeMessage;
        IsRetryable = isRetryable;
    }
}

