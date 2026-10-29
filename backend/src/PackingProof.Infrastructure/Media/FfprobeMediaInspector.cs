using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PackingProof.Core.Storage;
using PackingProof.Infrastructure.Configuration;

namespace PackingProof.Infrastructure.Media;

public sealed class FfprobeMediaInspector : IMediaInspector
{
    private static readonly TimeSpan InspectionTimeout = TimeSpan.FromSeconds(20);

    private readonly PackingProofOptions _options;
    private readonly ILogger<FfprobeMediaInspector> _logger;

    public FfprobeMediaInspector(
        PackingProofOptions options,
        ILogger<FfprobeMediaInspector> logger)
    {
        _options = options;
        _logger = logger;
    }

    public async Task<MediaInspectionResult> InspectAsync(string filePath, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return InvalidResult("Đường dẫn tệp kiểm tra media không hợp lệ.");
        }

        var fullPath = Path.GetFullPath(filePath);
        if (!File.Exists(fullPath))
        {
            return InvalidResult("Không tìm thấy tệp dữ liệu tạm trên máy chủ để kiểm tra định dạng.");
        }

        var info = new FileInfo(fullPath);
        if (info.Length <= 0)
        {
            return InvalidResult("Tệp tải lên rỗng (0 byte), không chứa dữ liệu video hợp lệ.");
        }

        var psi = new ProcessStartInfo
        {
            FileName = string.IsNullOrWhiteSpace(_options.FfprobePath) ? "ffprobe" : _options.FfprobePath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        // Strict ArgumentList invocation — zero shell interpolation!
        psi.ArgumentList.Add("-v");
        psi.ArgumentList.Add("error");
        psi.ArgumentList.Add("-show_format");
        psi.ArgumentList.Add("-show_streams");
        psi.ArgumentList.Add("-of");
        psi.ArgumentList.Add("json");
        psi.ArgumentList.Add("-i");
        psi.ArgumentList.Add(fullPath);

        using var process = new Process { StartInfo = psi };
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(InspectionTimeout);

        string stdout;
        string stderr;

        try
        {
            if (!process.Start())
            {
                throw new StorageUnavailableException(
                    "MEDIA_TOOL_UNAVAILABLE",
                    "Không thể khởi chạy công cụ kiểm tra media ffprobe trên máy chủ.");
            }

            var stdoutTask = process.StandardOutput.ReadToEndAsync(timeoutCts.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(timeoutCts.Token);

            await process.WaitForExitAsync(timeoutCts.Token);
            stdout = await stdoutTask;
            stderr = await stderrTask;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            TryKillProcessTree(process);
            _logger.LogWarning("ffprobe timed out after {Seconds}s while inspecting staging file.", InspectionTimeout.TotalSeconds);
            return InvalidResult("Quá thời gian kiểm tra cấu trúc video (tệp có thể bị hỏng nặng).");
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            _logger.LogError(ex, "ffprobe binary '{FfprobePath}' could not be executed.", psi.FileName);
            throw new StorageUnavailableException(
                "MEDIA_TOOL_UNAVAILABLE",
                "Công cụ kiểm tra media (ffprobe) chưa sẵn sàng trên máy chủ. Dữ liệu vẫn được giữ ở vùng đệm để thử lại.",
                ex.Message,
                ex);
        }

        if (process.ExitCode != 0 || string.IsNullOrWhiteSpace(stdout))
        {
            _logger.LogInformation(
                "ffprobe rejected file (exitCode={ExitCode}): {Stderr}",
                process.ExitCode,
                stderr?.Trim());
            return InvalidResult("Tệp tải lên không phải là tệp video hợp lệ hoặc dữ liệu container bị hỏng.");
        }

        try
        {
            using var doc = JsonDocument.Parse(stdout);
            var root = doc.RootElement;

            if (!root.TryGetProperty("format", out var formatEl) ||
                !root.TryGetProperty("streams", out var streamsEl) ||
                streamsEl.ValueKind != JsonValueKind.Array)
            {
                return InvalidResult("Tệp tải lên thiếu thông tin định dạng container hoặc luồng media.");
            }

            var formatNameRaw = GetOptionalString(formatEl, "format_name") ?? string.Empty;
            if (string.IsNullOrWhiteSpace(formatNameRaw))
            {
                return InvalidResult("Không xác định được định dạng container thực tế của tệp.");
            }

            var probeScore = GetOptionalInt(formatEl, "probe_score");
            if (probeScore.HasValue && probeScore.Value < 25)
            {
                return InvalidResult("Độ tin cậy định dạng media quá thấp; tệp không phải là video hợp lệ.");
            }

            JsonElement? primaryVideoStream = null;
            string? videoCodec = null;
            int width = 0;
            int height = 0;
            string? audioCodec = null;

            foreach (var stream in streamsEl.EnumerateArray())
            {
                var codecType = GetOptionalString(stream, "codec_type");
                var codecName = GetOptionalString(stream, "codec_name")?.Trim().ToLowerInvariant();

                if (string.Equals(codecType, "video", StringComparison.OrdinalIgnoreCase))
                {
                    if (IsAttachedPicture(stream))
                    {
                        continue;
                    }

                    var w = GetOptionalInt(stream, "width") ?? 0;
                    var h = GetOptionalInt(stream, "height") ?? 0;

                    if (primaryVideoStream is null && !string.IsNullOrWhiteSpace(codecName) && w > 0 && h > 0)
                    {
                        primaryVideoStream = stream;
                        videoCodec = codecName;
                        width = w;
                        height = h;
                    }
                }
                else if (string.Equals(codecType, "audio", StringComparison.OrdinalIgnoreCase))
                {
                    if (audioCodec is null && !string.IsNullOrWhiteSpace(codecName))
                    {
                        audioCodec = codecName;
                    }
                }
            }

            if (primaryVideoStream is null || string.IsNullOrWhiteSpace(videoCodec) || width <= 0 || height <= 0)
            {
                return InvalidResult("Tệp tải lên không chứa luồng hình ảnh video hợp lệ (width/height > 0).");
            }

            var containerInfo = await ClassifyVerifiedContainerAsync(
                fullPath,
                formatNameRaw,
                formatEl,
                videoCodec,
                ct);

            if (containerInfo is null)
            {
                return InvalidResult(
                    "Định dạng container của tệp không nằm trong danh mục video được hỗ trợ (WebM, MP4, MKV, MOV).");
            }

            var durationSeconds = ExtractDurationSeconds(formatEl, primaryVideoStream.Value);

            return new MediaInspectionResult(
                IsValid: true,
                NormalizedContainer: containerInfo.Value.Container,
                FileExtension: containerInfo.Value.Extension,
                ActualMimeType: containerInfo.Value.MimeType,
                VideoCodec: videoCodec,
                AudioCodec: audioCodec,
                Width: width,
                Height: height,
                DurationSeconds: durationSeconds);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to parse ffprobe JSON output.");
            return InvalidResult("Không thể phân tích thông tin cấu trúc media của tệp tải lên.");
        }
    }

    private static async Task<(string Container, string Extension, string MimeType)?> ClassifyVerifiedContainerAsync(
        string fullPath,
        string formatNameRaw,
        JsonElement formatEl,
        string videoCodec,
        CancellationToken ct)
    {
        var tokens = formatNameRaw
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(t => t.ToLowerInvariant())
            .ToHashSet(StringComparer.Ordinal);

        if (tokens.Contains("webm") || tokens.Contains("matroska"))
        {
            // Inspect EBML header bytes (first 128 bytes) to distinguish WebM vs Matroska (.mkv)
            // even when staging file on disk has no file extension.
            var headerAscii = await ReadHeaderAsciiAsync(fullPath, 128, ct);
            if (headerAscii.Contains("matroska", StringComparison.OrdinalIgnoreCase))
            {
                return ("mkv", ".mkv", "video/x-matroska");
            }

            if (headerAscii.Contains("webm", StringComparison.OrdinalIgnoreCase) ||
                videoCodec is "vp8" or "vp9" or "av1")
            {
                return ("webm", ".webm", "video/webm");
            }

            return ("mkv", ".mkv", "video/x-matroska");
        }

        if (tokens.Contains("mp4") || tokens.Contains("mov"))
        {
            string? majorBrand = null;
            if (formatEl.TryGetProperty("tags", out var tagsEl) && tagsEl.ValueKind == JsonValueKind.Object)
            {
                majorBrand = GetOptionalStringCaseInsensitive(tagsEl, "major_brand");
            }

            if (!string.IsNullOrWhiteSpace(majorBrand) &&
                majorBrand.TrimStart().StartsWith("qt", StringComparison.OrdinalIgnoreCase))
            {
                return ("mov", ".mov", "video/quicktime");
            }

            return ("mp4", ".mp4", "video/mp4");
        }

        return null;
    }

    private static async Task<string> ReadHeaderAsciiAsync(string fullPath, int maxBytes, CancellationToken ct)
    {
        var buffer = new byte[maxBytes];
        await using var fs = new FileStream(
            fullPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: maxBytes,
            options: FileOptions.Asynchronous);

        var read = await fs.ReadAsync(buffer.AsMemory(0, maxBytes), ct);
        if (read <= 0)
        {
            return string.Empty;
        }

        var sb = new StringBuilder(read);
        for (var i = 0; i < read; i++)
        {
            var b = buffer[i];
            sb.Append(b is >= 32 and <= 126 ? (char)b : ' ');
        }

        return sb.ToString();
    }

    private static double? ExtractDurationSeconds(JsonElement formatEl, JsonElement videoStreamEl)
    {
        if (TryParsePositiveDouble(GetOptionalString(formatEl, "duration"), out var fmtDur))
        {
            return fmtDur;
        }

        if (TryParsePositiveDouble(GetOptionalString(videoStreamEl, "duration"), out var streamDur))
        {
            return streamDur;
        }

        if (videoStreamEl.TryGetProperty("tags", out var tagsEl) && tagsEl.ValueKind == JsonValueKind.Object)
        {
            var tagDuration = GetOptionalStringCaseInsensitive(tagsEl, "DURATION");
            if (!string.IsNullOrWhiteSpace(tagDuration) &&
                TimeSpan.TryParse(tagDuration.Trim(), CultureInfo.InvariantCulture, out var parsedTs) &&
                parsedTs.TotalSeconds > 0)
            {
                return parsedTs.TotalSeconds;
            }
        }

        return null;
    }

    private static bool TryParsePositiveDouble(string? raw, out double value)
    {
        if (!string.IsNullOrWhiteSpace(raw) &&
            double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) &&
            double.IsFinite(parsed) &&
            parsed > 0)
        {
            value = parsed;
            return true;
        }

        value = 0;
        return false;
    }

    private static bool IsAttachedPicture(JsonElement streamEl)
    {
        if (streamEl.TryGetProperty("disposition", out var dispEl) && dispEl.ValueKind == JsonValueKind.Object)
        {
            return (GetOptionalInt(dispEl, "attached_pic") ?? 0) == 1;
        }

        return false;
    }

    private static string? GetOptionalString(JsonElement obj, string propName)
    {
        if (obj.TryGetProperty(propName, out var prop) && prop.ValueKind == JsonValueKind.String)
        {
            return prop.GetString();
        }

        return null;
    }

    private static string? GetOptionalStringCaseInsensitive(JsonElement obj, string propName)
    {
        foreach (var prop in obj.EnumerateObject())
        {
            if (string.Equals(prop.Name, propName, StringComparison.OrdinalIgnoreCase) &&
                prop.Value.ValueKind == JsonValueKind.String)
            {
                return prop.Value.GetString();
            }
        }

        return null;
    }

    private static int? GetOptionalInt(JsonElement obj, string propName)
    {
        if (!obj.TryGetProperty(propName, out var prop))
        {
            return null;
        }

        if (prop.ValueKind == JsonValueKind.Number && prop.TryGetInt32(out var num))
        {
            return num;
        }

        if (prop.ValueKind == JsonValueKind.String &&
            int.TryParse(prop.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
        {
            return parsed;
        }

        return null;
    }

    private static MediaInspectionResult InvalidResult(string vietnameseMessage) =>
        new(
            IsValid: false,
            NormalizedContainer: null,
            FileExtension: null,
            ActualMimeType: null,
            VideoCodec: null,
            AudioCodec: null,
            Width: null,
            Height: null,
            DurationSeconds: null,
            ErrorCode: "INVALID_MEDIA_CONTAINER",
            UserSafeErrorMessage: vietnameseMessage);

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
            // Ignore cleanup errors
        }
    }
}

