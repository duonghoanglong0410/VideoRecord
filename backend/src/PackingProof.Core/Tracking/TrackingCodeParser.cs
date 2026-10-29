using System.Text.Json;
using System.Text.RegularExpressions;

namespace PackingProof.Core.Tracking;

public sealed partial class TrackingCodeParser : ITrackingCodeParser
{
    public const int MinTrackingLength = 4;
    public const int MaxTrackingLength = 128;
    public const int MaxStructuredPayloadLength = 2048;

    private static readonly string[] TrackingJsonKeys =
    [
        "tracking_number",
        "trackingNumber",
        "waybill_no",
        "waybillNo"
    ];

    private static readonly string[] CarrierJsonKeys =
    [
        "carrier_code",
        "carrierCode",
        "shipping_provider",
        "shippingProvider"
    ];

    private static readonly string[] TikTokOrderJsonKeys =
    [
        "tiktok_order_id",
        "tiktokOrderId",
        "order_id",
        "orderId"
    ];

    private readonly IReadOnlyList<ITrackingPayloadRule> _customRules;

    public TrackingCodeParser(IEnumerable<ITrackingPayloadRule>? customRules = null)
    {
        _customRules = customRules?.ToList() ?? [];
    }

    public TrackingParseResult Parse(string? rawInput, BarcodeFormatHint formatHint = BarcodeFormatHint.Unknown)
    {
        if (rawInput is null)
        {
            return TrackingParseResult.Failure(
                "EMPTY_TRACKING_CODE",
                "Mã vận đơn không được để trống.");
        }

        // Only trim ASCII space ' ' first so control characters like \0, \r, \n, \t are caught deterministically.
        var spaceTrimmed = rawInput.Trim(' ');
        if (spaceTrimmed.Length == 0)
        {
            return TrackingParseResult.Failure(
                "EMPTY_TRACKING_CODE",
                "Mã vận đơn không được để trống.");
        }

        var looksLikeJsonObject = spaceTrimmed.StartsWith('{') && spaceTrimmed.EndsWith('}');
        var allowMultilineQr = looksLikeJsonObject || formatHint == BarcodeFormatHint.QrCode;

        // Reject non-whitespace control characters everywhere, and ALL control characters (0x00-0x1F, 0x7F) on plain barcode inputs.
        if (ContainsDisallowedControlChars(rawInput, allowJsonFormattingWhitespace: allowMultilineQr))
        {
            return TrackingParseResult.Failure(
                "TRACKING_CONTROL_CHAR",
                "Mã quét chứa ký tự điều khiển không hợp lệ. Vui lòng quét lại đúng mã vận đơn.");
        }

        // 1. Reject URLs and custom URI schemes immediately without ever guessing or making HTTP requests.
        if (LooksLikeUrlOrUriScheme(spaceTrimmed))
        {
            return UnrecognizedQrFailure();
        }

        // 2. Allow extensible custom rules before built-in JSON / 1D rules.
        foreach (var rule in _customRules)
        {
            var customResult = rule.TryParse(spaceTrimmed, formatHint);
            if (customResult is not null)
            {
                return customResult;
            }
        }

        // 3. Registered structured JSON QR payloads.
        if (looksLikeJsonObject || spaceTrimmed.StartsWith('{') || spaceTrimmed.StartsWith('['))
        {
            return ParseStructuredJsonPayload(spaceTrimmed);
        }

        // 3b. Unrecognized multi-field / composite QR payloads (e.g. key=value&key2=value2 or multiline QR text)
        if (!ContainsTraversalOrPathSeparator(spaceTrimmed) &&
            LooksLikeUnrecognizedCompositeQr(spaceTrimmed, formatHint))
        {
            return UnrecognizedQrFailure();
        }

        // 4. Plain 1D barcode / carrier tracking code string.
        return ValidatePlainTrackingCode(spaceTrimmed, matchedRule: "PlainCarrierCode");
    }

    private static TrackingParseResult ParseStructuredJsonPayload(string jsonPayload)
    {
        if (jsonPayload.Length > MaxStructuredPayloadLength ||
            !jsonPayload.StartsWith('{') ||
            !jsonPayload.EndsWith('}'))
        {
            return UnrecognizedQrFailure();
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(jsonPayload, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 4
            });
        }
        catch (JsonException)
        {
            return UnrecognizedQrFailure();
        }

        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                return UnrecognizedQrFailure();
            }

            if (!TryExtractExplicitStringProperty(doc.RootElement, TrackingJsonKeys, out var rawTracking, out var nonStringFound))
            {
                if (nonStringFound)
                {
                    return TrackingParseResult.Failure(
                        "UNRECOGNIZED_QR_PAYLOAD",
                        "Mã QR định dạng dữ liệu vận đơn dạng số thay vì chuỗi nên có nguy cơ mất số 0 ở đầu. Vui lòng quét trực tiếp mã vạch (1D) trên tem đơn hàng.");
                }

                return UnrecognizedQrFailure();
            }

            if (LooksLikeUrlOrUriScheme(rawTracking))
            {
                return UnrecognizedQrFailure();
            }

            var trackingValidation = ValidatePlainTrackingCode(rawTracking, matchedRule: "StructuredJsonQr");
            if (!trackingValidation.IsValid)
            {
                return trackingValidation;
            }

            string? carrierCode = null;
            if (TryExtractExplicitStringProperty(doc.RootElement, CarrierJsonKeys, out var rawCarrier, out _))
            {
                var trimmedCarrier = rawCarrier.Trim(' ');
                if (trimmedCarrier.Length > 0)
                {
                    if (!IsSafeAuxiliaryCode(trimmedCarrier, maxLen: 32))
                    {
                        return TrackingParseResult.Failure(
                            "INVALID_CARRIER_CODE",
                            "Thông tin đơn vị vận chuyển trong mã QR chứa ký tự không hợp lệ.");
                    }

                    carrierCode = trimmedCarrier;
                }
            }

            string? tikTokOrderId = null;
            if (TryExtractExplicitStringProperty(doc.RootElement, TikTokOrderJsonKeys, out var rawOrderId, out _))
            {
                var trimmedOrder = rawOrderId.Trim(' ');
                if (trimmedOrder.Length > 0)
                {
                    if (!IsSafeAuxiliaryCode(trimmedOrder, maxLen: 64))
                    {
                        return TrackingParseResult.Failure(
                            "INVALID_ORDER_ID",
                            "Thông tin mã đơn hàng trong mã QR chứa ký tự không hợp lệ.");
                    }

                    tikTokOrderId = trimmedOrder;
                }
            }

            return TrackingParseResult.Success(
                trackingNumber: trackingValidation.TrackingNumber!,
                matchedRule: "StructuredJsonQr",
                carrierCode: carrierCode,
                tikTokOrderId: tikTokOrderId);
        }
    }

    private static TrackingParseResult ValidatePlainTrackingCode(
        string candidate,
        string matchedRule)
    {
        if (ContainsDisallowedControlChars(candidate, allowJsonFormattingWhitespace: false))
        {
            return TrackingParseResult.Failure(
                "TRACKING_CONTROL_CHAR",
                "Mã vận đơn chứa ký tự điều khiển không hợp lệ.");
        }

        if (candidate.Length > MaxTrackingLength)
        {
            return TrackingParseResult.Failure(
                "TRACKING_TOO_LONG",
                $"Mã vận đơn vượt quá độ dài tối đa {MaxTrackingLength} ký tự.");
        }

        if (ContainsTraversalOrPathSeparator(candidate))
        {
            return TrackingParseResult.Failure(
                "TRACKING_PATH_TRAVERSAL",
                "Mã vận đơn chứa ký tự phân cách đường dẫn hoặc chuỗi điều hướng thư mục không được phép.");
        }

        if (ContainsShellMetacharacters(candidate))
        {
            return TrackingParseResult.Failure(
                "INVALID_TRACKING_CHARACTERS",
                "Mã vận đơn chứa ký tự đặc biệt không hợp lệ.");
        }

        if (candidate.Length < MinTrackingLength)
        {
            return TrackingParseResult.Failure(
                "TRACKING_TOO_SHORT",
                $"Mã vận đơn phải có ít nhất {MinTrackingLength} ký tự.");
        }

        if (!ValidPlainTrackingRegex().IsMatch(candidate))
        {
            return TrackingParseResult.Failure(
                "INVALID_TRACKING_CHARACTERS",
                "Mã vận đơn chỉ cho phép chữ cái không dấu, chữ số và các ký tự '.', '-', '_' (bắt đầu và kết thúc bằng chữ hoặc số).");
        }

        // Preserve exact original string including leading zeros ("00123456789") and casing!
        return TrackingParseResult.Success(
            trackingNumber: candidate,
            matchedRule: matchedRule);
    }

    private static bool TryExtractExplicitStringProperty(
        JsonElement obj,
        IReadOnlyList<string> candidateKeys,
        out string value,
        out bool nonStringFound)
    {
        value = string.Empty;
        nonStringFound = false;

        foreach (var key in candidateKeys)
        {
            if (obj.TryGetProperty(key, out var prop))
            {
                if (prop.ValueKind == JsonValueKind.Null)
                {
                    continue;
                }

                if (prop.ValueKind != JsonValueKind.String)
                {
                    nonStringFound = true;
                    continue;
                }

                value = prop.GetString() ?? string.Empty;
                return true;
            }
        }

        return false;
    }

    private static bool ContainsDisallowedControlChars(string input, bool allowJsonFormattingWhitespace)
    {
        foreach (var ch in input)
        {
            if (ch == '\u007F')
            {
                return true;
            }

            if (ch <= '\u001F')
            {
                if (allowJsonFormattingWhitespace && (ch == '\r' || ch == '\n' || ch == '\t'))
                {
                    continue;
                }

                return true;
            }
        }

        return false;
    }

    private static bool LooksLikeUrlOrUriScheme(string input)
    {
        if (UriSchemeRegex().IsMatch(input))
        {
            return true;
        }

        if (SpecialUriPrefixRegex().IsMatch(input))
        {
            return true;
        }

        if (input.StartsWith("www.", StringComparison.OrdinalIgnoreCase) &&
            (input.Contains('/') || input.Contains('?')))
        {
            return true;
        }

        return false;
    }

    private static bool LooksLikeUnrecognizedCompositeQr(string input, BarcodeFormatHint formatHint)
    {
        if (input.Contains('$') || input.Contains('`') || input.Contains('<') || input.Contains('>'))
        {
            return false;
        }

        if (CompositeKeyValueRegex().IsMatch(input))
        {
            return true;
        }

        if (formatHint == BarcodeFormatHint.QrCode &&
            (input.Contains('\n') || input.Contains('\r') || input.Contains('=') || input.Contains('|') || input.Contains(':')))
        {
            return true;
        }

        return false;
    }

    private static bool ContainsTraversalOrPathSeparator(string input)
    {
        if (input.Contains('/') ||
            input.Contains('\\') ||
            input.Contains("..", StringComparison.Ordinal) ||
            input.Contains("%2e%2e", StringComparison.OrdinalIgnoreCase) ||
            input.Contains("%2f", StringComparison.OrdinalIgnoreCase) ||
            input.Contains("%5c", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return false;
    }

    private static bool ContainsShellMetacharacters(string input)
    {
        foreach (var ch in input)
        {
            switch (ch)
            {
                case ';':
                case '&':
                case '|':
                case '$':
                case '`':
                case '>':
                case '<':
                case '!':
                case '*':
                case '?':
                case '"':
                case '\'':
                case '(':
                case ')':
                case '{':
                case '}':
                case '[':
                case ']':
                    return true;
            }
        }

        return false;
    }

    private static bool IsSafeAuxiliaryCode(string value, int maxLen) =>
        value.Length <= maxLen &&
        !ContainsDisallowedControlChars(value, allowJsonFormattingWhitespace: false) &&
        !ContainsTraversalOrPathSeparator(value) &&
        SafeAuxiliaryCodeRegex().IsMatch(value);

    private static TrackingParseResult UnrecognizedQrFailure() =>
        TrackingParseResult.Failure(
            "UNRECOGNIZED_QR_PAYLOAD",
            "Mã QR chứa liên kết web (URL) hoặc dữ liệu tổng hợp chưa được hỗ trợ. Hệ thống không tự truy cập URL hay suy đoán mã; vui lòng quét trực tiếp mã vạch (1D) hoặc mã vận đơn trên tem đơn hàng.");

    [GeneratedRegex(@"^[a-zA-Z][a-zA-Z0-9+.-]*://", RegexOptions.CultureInvariant)]
    private static partial Regex UriSchemeRegex();

    [GeneratedRegex(@"^(javascript|data|mailto|tel|blob|file|about):", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SpecialUriPrefixRegex();

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._-]{2,126}[A-Za-z0-9]$", RegexOptions.CultureInvariant)]
    private static partial Regex ValidPlainTrackingRegex();

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeAuxiliaryCodeRegex();

    [GeneratedRegex(@"^[A-Za-z0-9_.-]+[:=][A-Za-z0-9_.-]+([&;|][A-Za-z0-9_.-]+[:=][A-Za-z0-9_.-]+)+$", RegexOptions.CultureInvariant)]
    private static partial Regex CompositeKeyValueRegex();
}
