using System.Diagnostics;
using System.Globalization;
using System.Text;
using Microsoft.Extensions.Logging;
using PackingProof.Core.Storage;
using PackingProof.Infrastructure.Configuration;

namespace PackingProof.Infrastructure.Media;

public sealed class FfmpegPreviewTranscoder : IPreviewTranscoder
{
    private readonly PackingProofOptions _options;
    private readonly ILogger<FfmpegPreviewTranscoder> _logger;

    public FfmpegPreviewTranscoder(
        PackingProofOptions options,
        ILogger<FfmpegPreviewTranscoder> logger)
    {
        _options = options;
        _logger = logger;
    }

    public async Task<PreviewTranscodeResult> TranscodeToMp4Async(
        PreviewTranscodeRequest request,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (string.IsNullOrWhiteSpace(request.InputFilePath))
        {
            throw new PreviewTranscodeException(
                "PREVIEW_INPUT_INVALID",
                "Đường dẫn tệp video gốc đầu vào để chuyển mã bản xem không hợp lệ.",
                isRetryable: false);
        }

        if (string.IsNullOrWhiteSpace(request.OutputMp4FilePath) ||
            !request.OutputMp4FilePath.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase))
        {
            throw new PreviewTranscodeException(
                "PREVIEW_OUTPUT_INVALID",
                "Đường dẫn tệp đầu ra chuyển mã bản xem phải có định dạng .mp4.",
                isRetryable: false);
        }

        var fullInputPath = Path.GetFullPath(request.InputFilePath);
        var fullOutputPath = Path.GetFullPath(request.OutputMp4FilePath);

        if (string.Equals(fullInputPath, fullOutputPath, StringComparison.OrdinalIgnoreCase))
        {
            throw new PreviewTranscodeException(
                "PREVIEW_OUTPUT_CONFLICT",
                "Đường dẫn tệp bản xem chuyển mã không được trùng với tệp video gốc.",
                isRetryable: false);
        }

        if (!File.Exists(fullInputPath))
        {
            throw new PreviewTranscodeException(
                "PREVIEW_INPUT_MISSING",
                "Không tìm thấy tệp tạm đầu vào để chuyển mã bản xem MP4.",
                isRetryable: true);
        }

        var inputInfo = new FileInfo(fullInputPath);
        if (inputInfo.Length <= 0)
        {
            throw new PreviewTranscodeException(
                "PREVIEW_INPUT_EMPTY",
                "Tệp đầu vào chuyển mã bản xem đang rỗng (0 byte).",
                isRetryable: false);
        }

        var outputDir = Path.GetDirectoryName(fullOutputPath);
        if (!string.IsNullOrWhiteSpace(outputDir))
        {
            Directory.CreateDirectory(outputDir);
        }

        // Cap FFmpeg threads per job so Synology NAS / host CPU is never saturated
        var concurrency = Math.Clamp(_options.ProcessingConcurrency, 1, 8);
        var perJobThreads = Math.Clamp(Environment.ProcessorCount / concurrency, 1, 2);
        var timeoutSeconds = Math.Clamp(_options.PreviewTranscodeTimeoutSeconds, 10, 3600);

        var psi = new ProcessStartInfo
        {
            FileName = string.IsNullOrWhiteSpace(_options.FfmpegPath) ? "ffmpeg" : _options.FfmpegPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        // Strict ProcessStartInfo.ArgumentList invocation — zero shell interpolation!
        psi.ArgumentList.Add("-y");
        psi.ArgumentList.Add("-hide_banner");
        psi.ArgumentList.Add("-loglevel");
        psi.ArgumentList.Add("error");
        psi.ArgumentList.Add("-i");
        psi.ArgumentList.Add(fullInputPath);
        psi.ArgumentList.Add("-map");
        psi.ArgumentList.Add("0:v:0");
        psi.ArgumentList.Add("-vf");
        psi.ArgumentList.Add("scale=trunc(iw/2)*2:trunc(ih/2)*2");
        psi.ArgumentList.Add("-c:v");
        psi.ArgumentList.Add("libx264");
        psi.ArgumentList.Add("-preset");
        psi.ArgumentList.Add("veryfast");
        psi.ArgumentList.Add("-pix_fmt");
        psi.ArgumentList.Add("yuv420p");
        psi.ArgumentList.Add("-movflags");
        psi.ArgumentList.Add("+faststart");

        if (request.HasAudio)
        {
            psi.ArgumentList.Add("-map");
            psi.ArgumentList.Add("0:a:0?");
            psi.ArgumentList.Add("-c:a");
            psi.ArgumentList.Add("aac");
            psi.ArgumentList.Add("-b:a");
            psi.ArgumentList.Add("128k");
            psi.ArgumentList.Add("-ac");
            psi.ArgumentList.Add("2");
        }
        else
        {
            psi.ArgumentList.Add("-an");
        }

        psi.ArgumentList.Add("-threads");
        psi.ArgumentList.Add(perJobThreads.ToString(CultureInfo.InvariantCulture));
        psi.ArgumentList.Add("-f");
        psi.ArgumentList.Add("mp4");
        psi.ArgumentList.Add(fullOutputPath);

        using var process = new Process { StartInfo = psi };
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));

        string stderr;
        try
        {
            if (!process.Start())
            {
                throw new PreviewTranscodeException(
                    "FFMPEG_TOOL_UNAVAILABLE",
                    "Không thể khởi chạy công cụ FFmpeg để tạo bản xem MP4 tương thích.",
                    isRetryable: true);
            }

            var stdoutTask = process.StandardOutput.ReadToEndAsync(timeoutCts.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(timeoutCts.Token);

            await process.WaitForExitAsync(timeoutCts.Token);
            _ = await stdoutTask;
            stderr = await stderrTask;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            TryKillProcessTree(process);
            TryDeleteBestEffort(fullOutputPath);
            _logger.LogWarning(
                "FFmpeg preview transcode timed out after {TimeoutSeconds}s.",
                timeoutSeconds);

            throw new PreviewTranscodeException(
                "PREVIEW_TRANSCODE_TIMEOUT",
                "Quá thời gian chuyển mã bản xem MP4 tương thích. Tệp video gốc vẫn được lưu an toàn.",
                isRetryable: true,
                detail: $"FFmpeg exceeded {timeoutSeconds}s timeout.");
        }
        catch (OperationCanceledException)
        {
            TryKillProcessTree(process);
            TryDeleteBestEffort(fullOutputPath);
            throw;
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            TryDeleteBestEffort(fullOutputPath);
            _logger.LogError(ex, "FFmpeg binary '{FfmpegPath}' could not be executed.", psi.FileName);
            throw new PreviewTranscodeException(
                "FFMPEG_TOOL_UNAVAILABLE",
                "Công cụ chuyển mã FFmpeg chưa sẵn sàng trên máy chủ. Tệp video gốc vẫn được lưu an toàn.",
                isRetryable: true,
                detail: ex.Message,
                innerException: ex);
        }

        if (process.ExitCode != 0 || !File.Exists(fullOutputPath))
        {
            TryDeleteBestEffort(fullOutputPath);
            _logger.LogWarning(
                "FFmpeg failed preview transcoding (exitCode={ExitCode}): {Stderr}",
                process.ExitCode,
                stderr?.Trim());

            throw new PreviewTranscodeException(
                "PREVIEW_TRANSCODE_FAILED",
                "Không thể chuyển mã video sang bản xem MP4 (H.264). Tệp video gốc vẫn được bảo toàn nguyên vẹn.",
                isRetryable: false,
                detail: $"FFmpeg exit code {process.ExitCode}: {stderr?.Trim()}");
        }

        var outputInfo = new FileInfo(fullOutputPath);
        if (outputInfo.Length <= 0)
        {
            TryDeleteBestEffort(fullOutputPath);
            throw new PreviewTranscodeException(
                "PREVIEW_OUTPUT_EMPTY",
                "Tệp bản xem MP4 sau chuyển mã bị rỗng (0 byte). Tệp video gốc vẫn được bảo toàn nguyên vẹn.",
                isRetryable: false);
        }

        return new PreviewTranscodeResult(
            OutputMp4FilePath: fullOutputPath,
            SizeBytes: outputInfo.Length);
    }

    private static void TryKillProcessTree(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Ignore cleanup errors if process already exited
        }
    }

    private static void TryDeleteBestEffort(string filePath)
    {
        try
        {
            if (File.Exists(filePath))
            {
                File.Delete(filePath);
            }
        }
        catch
        {
            // Ignore temp file cleanup errors
        }
    }
}
