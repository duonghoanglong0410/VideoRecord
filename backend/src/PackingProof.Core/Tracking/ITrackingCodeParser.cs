namespace PackingProof.Core.Tracking;

public interface ITrackingPayloadRule
{
    string RuleName { get; }

    /// <summary>
    /// Attempts to evaluate a raw scanned payload. Returns null if this rule does not apply.
    /// </summary>
    TrackingParseResult? TryParse(string trimmedPayload, BarcodeFormatHint formatHint);
}

public interface ITrackingCodeParser
{
    TrackingParseResult Parse(string? rawInput, BarcodeFormatHint formatHint = BarcodeFormatHint.Unknown);
}

