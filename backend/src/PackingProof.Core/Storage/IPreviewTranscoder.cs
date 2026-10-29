namespace PackingProof.Core.Storage;

public sealed record PreviewTranscodeRequest(
    string InputFilePath,
    string OutputMp4FilePath,
    bool HasAudio);

public sealed record PreviewTranscodeResult(
    string OutputMp4FilePath,
    long SizeBytes);

public interface IPreviewTranscoder
{
    Task<PreviewTranscodeResult> TranscodeToMp4Async(
        PreviewTranscodeRequest request,
        CancellationToken ct = default);
}
