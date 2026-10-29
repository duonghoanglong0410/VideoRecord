using PackingProof.Core.Tracking;

namespace PackingProof.Infrastructure.Storage;

public static class StoragePathBuilder
{
    private static readonly TimeZoneInfo HoChiMinhTimeZone = ResolveHoChiMinhTimeZone();

    /// <summary>
    /// Builds canonical forward-slash relative path:
    /// &lt;ShopSlug&gt;/&lt;yyyy&gt;/&lt;MM&gt;/&lt;dd&gt;/&lt;SafeTrackingSegment&gt;/&lt;SafeTrackingSegment&gt;_&lt;RecordingId&gt;.&lt;ext&gt;
    /// where &lt;yyyy&gt;/&lt;MM&gt;/&lt;dd&gt; is converted from UTC to Asia/Ho_Chi_Minh (UTC+7),
    /// and &lt;ext&gt; is derived exclusively from the ffprobe-verified container.
    /// </summary>
    public static string BuildOriginalRelativePath(
        string shopSlug,
        DateTime utcTimestamp,
        string safeTrackingSegment,
        Guid recordingId,
        string verifiedContainer)
    {
        if (recordingId == Guid.Empty)
        {
            throw new ArgumentException("RecordingId must not be empty.", nameof(recordingId));
        }

        var extension = ResolveVerifiedExtension(verifiedContainer);
        var safeShop = PathSegmentSanitizer.ToSafeSegment(shopSlug);
        var safeTracking = PathSegmentSanitizer.ToSafeSegment(safeTrackingSegment);
        var hcmTime = ConvertUtcToHoChiMinh(utcTimestamp);

        var year = hcmTime.ToString("yyyy", System.Globalization.CultureInfo.InvariantCulture);
        var month = hcmTime.ToString("MM", System.Globalization.CultureInfo.InvariantCulture);
        var day = hcmTime.ToString("dd", System.Globalization.CultureInfo.InvariantCulture);
        var fileName = $"{safeTracking}_{recordingId:D}{extension}";

        return $"{safeShop}/{year}/{month}/{day}/{safeTracking}/{fileName}";
    }

    /// <summary>
    /// Builds canonical forward-slash relative path for transcoded MP4 H.264 preview asset:
    /// &lt;ShopSlug&gt;/&lt;yyyy&gt;/&lt;MM&gt;/&lt;dd&gt;/&lt;SafeTrackingSegment&gt;/&lt;SafeTrackingSegment&gt;_&lt;RecordingId&gt;_preview.mp4
    /// </summary>
    public static string BuildPreviewRelativePath(
        string shopSlug,
        DateTime utcTimestamp,
        string safeTrackingSegment,
        Guid recordingId)
    {
        if (recordingId == Guid.Empty)
        {
            throw new ArgumentException("RecordingId must not be empty.", nameof(recordingId));
        }

        var safeShop = PathSegmentSanitizer.ToSafeSegment(shopSlug);
        var safeTracking = PathSegmentSanitizer.ToSafeSegment(safeTrackingSegment);
        var hcmTime = ConvertUtcToHoChiMinh(utcTimestamp);

        var year = hcmTime.ToString("yyyy", System.Globalization.CultureInfo.InvariantCulture);
        var month = hcmTime.ToString("MM", System.Globalization.CultureInfo.InvariantCulture);
        var day = hcmTime.ToString("dd", System.Globalization.CultureInfo.InvariantCulture);
        var fileName = $"{safeTracking}_{recordingId:D}_preview.mp4";

        return $"{safeShop}/{year}/{month}/{day}/{safeTracking}/{fileName}";
    }

    public static DateTime ConvertUtcToHoChiMinh(DateTime utcTimestamp)
    {
        var normalizedUtc = utcTimestamp.Kind switch
        {
            DateTimeKind.Utc => utcTimestamp,
            DateTimeKind.Local => utcTimestamp.ToUniversalTime(),
            _ => DateTime.SpecifyKind(utcTimestamp, DateTimeKind.Utc)
        };

        return TimeZoneInfo.ConvertTimeFromUtc(normalizedUtc, HoChiMinhTimeZone);
    }

    public static (DateTime StartUtc, DateTime EndExclusiveUtc) GetHoChiMinhDayUtcRange(DateOnly hcmDate)
    {
        var startLocalUnspecified = hcmDate.ToDateTime(TimeOnly.MinValue, DateTimeKind.Unspecified);
        var endLocalUnspecified = hcmDate.AddDays(1).ToDateTime(TimeOnly.MinValue, DateTimeKind.Unspecified);

        var startUtc = TimeZoneInfo.ConvertTimeToUtc(startLocalUnspecified, HoChiMinhTimeZone);
        var endExclusiveUtc = TimeZoneInfo.ConvertTimeToUtc(endLocalUnspecified, HoChiMinhTimeZone);
        return (startUtc, endExclusiveUtc);
    }

    public static (DateTime StartUtc, DateTime EndExclusiveUtc) GetHoChiMinhTodayUtcRange(DateTime utcNow)
    {
        var hcmNow = ConvertUtcToHoChiMinh(utcNow);
        return GetHoChiMinhDayUtcRange(DateOnly.FromDateTime(hcmNow));
    }

    public static bool TryParseHoChiMinhFromDateUtc(string? rawDate, out DateTime? fromUtc)
    {
        fromUtc = null;
        if (string.IsNullOrWhiteSpace(rawDate))
        {
            return true;
        }

        var trimmed = rawDate.Trim();
        if (DateOnly.TryParseExact(
            trimmed,
            "yyyy-MM-dd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None,
            out var dateOnly))
        {
            fromUtc = GetHoChiMinhDayUtcRange(dateOnly).StartUtc;
            return true;
        }

        if (DateTimeOffset.TryParse(
            trimmed,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal,
            out var dto))
        {
            fromUtc = dto.UtcDateTime;
            return true;
        }

        return false;
    }

    public static bool TryParseHoChiMinhToDateExclusiveUtc(string? rawDate, out DateTime? toExclusiveUtc)
    {
        toExclusiveUtc = null;
        if (string.IsNullOrWhiteSpace(rawDate))
        {
            return true;
        }

        var trimmed = rawDate.Trim();
        if (DateOnly.TryParseExact(
            trimmed,
            "yyyy-MM-dd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None,
            out var dateOnly))
        {
            toExclusiveUtc = GetHoChiMinhDayUtcRange(dateOnly).EndExclusiveUtc;
            return true;
        }

        if (DateTimeOffset.TryParse(
            trimmed,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal,
            out var dto))
        {
            toExclusiveUtc = dto.UtcDateTime.AddTicks(1);
            return true;
        }

        return false;
    }

    public static string ResolveVerifiedExtension(string? verifiedContainer)
    {
        var normalized = verifiedContainer?.Trim().ToLowerInvariant();
        return normalized switch
        {
            "webm" => ".webm",
            "mp4" => ".mp4",
            "mkv" => ".mkv",
            "mov" => ".mov",
            _ => throw new ArgumentException(
                $"Unsupported or unverified media container '{verifiedContainer}'.",
                nameof(verifiedContainer))
        };
    }

    private static TimeZoneInfo ResolveHoChiMinhTimeZone()
    {
        if (TimeZoneInfo.TryFindSystemTimeZoneById("Asia/Ho_Chi_Minh", out var ianaTz))
        {
            return ianaTz;
        }

        if (TimeZoneInfo.TryFindSystemTimeZoneById("SE Asia Standard Time", out var windowsTz))
        {
            return windowsTz;
        }

        return TimeZoneInfo.CreateCustomTimeZone(
            id: "Asia/Ho_Chi_Minh",
            baseUtcOffset: TimeSpan.FromHours(7),
            displayName: "(UTC+07:00) Ho Chi Minh City",
            standardDisplayName: "Indochina Time");
    }
}

