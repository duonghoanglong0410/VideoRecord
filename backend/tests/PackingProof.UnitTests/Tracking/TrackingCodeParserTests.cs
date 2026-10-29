using System.Text.RegularExpressions;
using PackingProof.Core.Tracking;
using Xunit;

namespace PackingProof.UnitTests.Tracking;

public sealed class TrackingCodeParserTests
{
    private readonly TrackingCodeParser _parser = new();

    [Theory]
    [InlineData("00123456")]
    [InlineData("00009876543210")]
    [InlineData("SPXVN048291023aBc")]
    [InlineData("JT-009812_vn")]
    [InlineData("S123.456.789")]
    public void Parse_ValidPlainCarrierCode_PreservesExactLeadingZerosAndOriginalCasing(string code)
    {
        var result = _parser.Parse(code, BarcodeFormatHint.OneDimensional);

        Assert.True(result.IsValid);
        Assert.Equal(code, result.TrackingNumber);
        Assert.Null(result.TikTokOrderId);
        Assert.Equal("PlainCarrierCode", result.MatchedRule);
    }

    [Theory]
    [InlineData("https://www.tiktok.com/@shop/order/0012345678")]
    [InlineData("http://192.168.1.10:8080/track?waybill=SPXVN001234")]
    [InlineData("tiktok://order/detail?tracking_number=00123456")]
    [InlineData("javascript:alert('00123456')")]
    [InlineData("file:///etc/passwd")]
    [InlineData("www.spx.vn/track/SPXVN00123456")]
    public void Parse_QrContainingUrlOrCustomUriScheme_RejectsWithUnrecognizedQrPayload_WithoutGuessing(string rawUrl)
    {
        var result = _parser.Parse(rawUrl, BarcodeFormatHint.QrCode);

        Assert.False(result.IsValid);
        Assert.Null(result.TrackingNumber);
        Assert.Equal("UNRECOGNIZED_QR_PAYLOAD", result.ErrorCode);
        Assert.NotNull(result.UserSafeErrorMessage);
    }

    [Fact]
    public void Parse_StructuredJsonQr_ExtractsTrackingNumberSeparatelyFromTikTokOrderId_AndPreservesLeadingZeros()
    {
        const string jsonQr = """
            {
              "tracking_number": "0039481200aB",
              "carrier_code": "SPX-VN",
              "tiktok_order_id": "577009988776655"
            }
            """;

        var result = _parser.Parse(jsonQr, BarcodeFormatHint.QrCode);

        Assert.True(result.IsValid);
        Assert.Equal("0039481200aB", result.TrackingNumber);
        Assert.Equal("SPX-VN", result.CarrierCode);
        Assert.Equal("577009988776655", result.TikTokOrderId);
        Assert.NotEqual(result.TrackingNumber, result.TikTokOrderId);
        Assert.Equal("StructuredJsonQr", result.MatchedRule);
    }

    [Fact]
    public void Parse_StructuredJsonQr_WithNumericTrackingOrOnlyOrderId_IsRejected()
    {
        const string numericJson = """{"tracking_number": 12345678, "tiktok_order_id": "577111"}""";
        var numericResult = _parser.Parse(numericJson, BarcodeFormatHint.QrCode);
        Assert.False(numericResult.IsValid);
        Assert.Equal("UNRECOGNIZED_QR_PAYLOAD", numericResult.ErrorCode);

        const string onlyOrderJson = """{"tiktok_order_id": "577009988776655", "carrier_code": "JT"}""";
        var onlyOrderResult = _parser.Parse(onlyOrderJson, BarcodeFormatHint.QrCode);
        Assert.False(onlyOrderResult.IsValid);
        Assert.Null(onlyOrderResult.TrackingNumber);
        Assert.Equal("UNRECOGNIZED_QR_PAYLOAD", onlyOrderResult.ErrorCode);
    }

    [Theory]
    [InlineData("../etc/passwd")]
    [InlineData("..\\Windows\\System32")]
    [InlineData("SPX..001234")]
    [InlineData("SPX%2e%2e001234")]
    [InlineData("ShopA/00123456")]
    [InlineData("ShopA\\00123456")]
    [InlineData("{\"tracking_number\":\"../../secret\"}")]
    public void Parse_PathTraversalOrSeparators_IsRejected(string dangerousInput)
    {
        var result = _parser.Parse(dangerousInput);

        Assert.False(result.IsValid);
        Assert.Null(result.TrackingNumber);
        Assert.Equal("TRACKING_PATH_TRAVERSAL", result.ErrorCode);
    }

    [Theory]
    [InlineData("0012\u00003456", "TRACKING_CONTROL_CHAR")]
    [InlineData("0012\n3456", "TRACKING_CONTROL_CHAR")]
    [InlineData("0012\r3456", "TRACKING_CONTROL_CHAR")]
    [InlineData("0012\t3456", "TRACKING_CONTROL_CHAR")]
    [InlineData("0012\u001B3456", "TRACKING_CONTROL_CHAR")]
    [InlineData("0012\u007F3456", "TRACKING_CONTROL_CHAR")]
    [InlineData("$(rm -rf /)", "TRACKING_PATH_TRAVERSAL")]
    [InlineData("$(whoami)", "INVALID_TRACKING_CHARACTERS")]
    [InlineData("`id`", "INVALID_TRACKING_CHARACTERS")]
    [InlineData("SPX123;whoami", "INVALID_TRACKING_CHARACTERS")]
    [InlineData("SPX123|cat", "INVALID_TRACKING_CHARACTERS")]
    [InlineData("AB1", "TRACKING_TOO_SHORT")]
    public void Parse_ControlCharsShellMetacharsAndTooShort_AreRejected(string rawInput, string expectedErrorCode)
    {
        var result = _parser.Parse(rawInput, BarcodeFormatHint.OneDimensional);

        Assert.False(result.IsValid);
        Assert.Null(result.TrackingNumber);
        Assert.Equal(expectedErrorCode, result.ErrorCode);
    }

    [Fact]
    public void Parse_MaxLengthBoundary_Allows128Chars_Rejects129Chars()
    {
        var exact128 = "0" + new string('A', 127);
        var valid = _parser.Parse(exact128);
        Assert.True(valid.IsValid);
        Assert.Equal(exact128, valid.TrackingNumber);

        var over129 = "0" + new string('A', 128);
        var invalid = _parser.Parse(over129);
        Assert.False(invalid.IsValid);
        Assert.Equal("TRACKING_TOO_LONG", invalid.ErrorCode);
    }

    [Theory]
    [InlineData("")]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("../../../etc/passwd")]
    [InlineData("..\\..\\Windows\\System32\\cmd.exe")]
    [InlineData("CON")]
    [InlineData("nul")]
    [InlineData("S123.456.789")]
    [InlineData("00123456789")]
    public void PathSegmentSanitizer_NeverProducesDotsSlashesOrRootEscape(string input)
    {
        var safeSegment = PathSegmentSanitizer.ToSafeSegment(input);

        Assert.NotEmpty(safeSegment);
        Assert.True(safeSegment.Length <= PathSegmentSanitizer.MaxSegmentLength);
        Assert.NotEqual(".", safeSegment);
        Assert.NotEqual("..", safeSegment);
        Assert.Matches(new Regex("^[A-Za-z0-9_-]{1,96}$"), safeSegment);

        var tempRoot = Path.Combine(Path.GetTempPath(), "packingproof_root_test");
        var resolved = PathSegmentSanitizer.CombineWithinRoot(tempRoot, "shop-a", "2026", "10", "29", safeSegment);
        Assert.StartsWith(Path.GetFullPath(tempRoot) + Path.DirectorySeparatorChar, resolved);
    }

    [Fact]
    public void PathSegmentSanitizer_LongInputAndDotCollisions_ProduceDistinctDeterministicSafeSegments()
    {
        var longA = new string('X', 120) + "1";
        var longB = new string('X', 120) + "2";

        var safeA = PathSegmentSanitizer.ToSafeSegment(longA);
        var safeB = PathSegmentSanitizer.ToSafeSegment(longB);

        Assert.True(safeA.Length <= PathSegmentSanitizer.MaxSegmentLength);
        Assert.True(safeB.Length <= PathSegmentSanitizer.MaxSegmentLength);
        Assert.NotEqual(safeA, safeB);
        Assert.Equal(safeA, PathSegmentSanitizer.ToSafeSegment(longA));

        var dotted = PathSegmentSanitizer.ToSafeSegment("GHTK.00123");
        var underscored = PathSegmentSanitizer.ToSafeSegment("GHTK_00123");
        Assert.NotEqual(dotted, underscored);
    }
}

