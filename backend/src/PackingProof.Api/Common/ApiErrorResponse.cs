namespace PackingProof.Api.Common;

public sealed record ApiErrorResponse(
    string ErrorCode,
    string Message,
    IReadOnlyList<string>? Details = null);

