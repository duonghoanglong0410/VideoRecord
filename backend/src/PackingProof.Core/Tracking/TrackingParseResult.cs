namespace PackingProof.Core.Tracking;

public enum BarcodeFormatHint
{
    Unknown = 0,
    OneDimensional = 1,
    QrCode = 2,
    ManualEntry = 3
}

public sealed record TrackingParseResult(
    bool IsValid,
    string? TrackingNumber,
    string? CarrierCode,
    string? TikTokOrderId,
    string? MatchedRule,
    string? ErrorCode,
    string? UserSafeErrorMessage)
{
    public static TrackingParseResult Success(
        string trackingNumber,
        string matchedRule,
        string? carrierCode = null,
        string? tikTokOrderId = null) =>
        new(
            IsValid: true,
            TrackingNumber: trackingNumber,
            CarrierCode: carrierCode,
            TikTokOrderId: tikTokOrderId,
            MatchedRule: matchedRule,
            ErrorCode: null,
            UserSafeErrorMessage: null);

    public static TrackingParseResult Failure(string errorCode, string userSafeErrorMessage) =>
        new(
            IsValid: false,
            TrackingNumber: null,
            CarrierCode: null,
            TikTokOrderId: null,
            MatchedRule: null,
            ErrorCode: errorCode,
            UserSafeErrorMessage: userSafeErrorMessage);
}

