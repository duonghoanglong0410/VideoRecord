namespace PackingProof.Core.Storage;

public sealed record MediaInspectionResult(
    bool IsValid,
    string? NormalizedContainer,
    string? FileExtension,
    string? ActualMimeType,
    string? VideoCodec,
    string? AudioCodec,
    int? Width,
    int? Height,
    double? DurationSeconds,
    string? ErrorCode = null,
    string? UserSafeErrorMessage = null);

public interface IMediaInspector
{
    Task<MediaInspectionResult> InspectAsync(string filePath, CancellationToken ct = default);
}

