using System.Security.Cryptography;
using System.Text;

namespace PackingProof.Core.Tracking;

public static class PathSegmentSanitizer
{
    public const int MaxSegmentLength = 96;
    private const int HashSuffixHexLength = 12;

    private static readonly HashSet<string> WindowsReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    };

    /// <summary>
    /// Converts an arbitrary input string into a strictly safe single filesystem path segment
    /// matching ^[A-Za-z0-9_-]{1,96}$, never '.' or '..', and never a reserved device name.
    /// Appends a deterministic SHA-256 suffix whenever characters are substituted or truncated.
    /// </summary>
    public static string ToSafeSegment(string? input)
    {
        var raw = input ?? string.Empty;
        var hashSuffix = ComputeShortHashHex(raw);

        if (raw.Length == 0)
        {
            return $"trk_{hashSuffix}";
        }

        var sb = new StringBuilder(Math.Min(raw.Length, MaxSegmentLength + 16));
        var hadUnsafeChar = false;
        var prevWasUnderscore = false;

        foreach (var ch in raw)
        {
            if (IsSafeAsciiChar(ch))
            {
                sb.Append(ch);
                prevWasUnderscore = ch == '_';
            }
            else
            {
                hadUnsafeChar = true;
                if (!prevWasUnderscore && sb.Length > 0)
                {
                    sb.Append('_');
                    prevWasUnderscore = true;
                }
            }
        }

        var cleaned = sb.ToString().Trim('_', '-');
        if (cleaned.Length == 0)
        {
            return $"trk_{hashSuffix}";
        }

        var isReserved = WindowsReservedNames.Contains(cleaned);
        var exceedsMax = cleaned.Length > MaxSegmentLength;

        if (!hadUnsafeChar && !isReserved && !exceedsMax)
        {
            return cleaned;
        }

        var maxPrefixLength = MaxSegmentLength - 1 - HashSuffixHexLength;
        var prefix = cleaned.Length > maxPrefixLength
            ? cleaned[..maxPrefixLength].TrimEnd('_', '-')
            : cleaned;

        if (prefix.Length == 0)
        {
            return $"trk_{hashSuffix}";
        }

        return $"{prefix}_{hashSuffix}";
    }

    /// <summary>
    /// Verifies that combining <paramref name="rootDirectory"/> and <paramref name="relativePath"/>
    /// stays strictly underneath <paramref name="rootDirectory"/>.
    /// </summary>
    public static string CombineWithinRoot(string rootDirectory, params string[] segments)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootDirectory);

        var normalizedRoot = Path.GetFullPath(rootDirectory)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var rootWithSep = normalizedRoot + Path.DirectorySeparatorChar;

        var allParts = new string[segments.Length + 1];
        allParts[0] = normalizedRoot;
        Array.Copy(segments, 0, allParts, 1, segments.Length);

        var combined = Path.GetFullPath(Path.Combine(allParts));
        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;

        if (!combined.StartsWith(rootWithSep, comparison))
        {
            throw new InvalidOperationException("Resolved path escaped the configured storage root.");
        }

        return combined;
    }

    private static bool IsSafeAsciiChar(char ch) =>
        (ch >= 'A' && ch <= 'Z') ||
        (ch >= 'a' && ch <= 'z') ||
        (ch >= '0' && ch <= '9') ||
        ch == '_' ||
        ch == '-';

    private static string ComputeShortHashHex(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return Convert.ToHexStringLower(hash[..(HashSuffixHexLength / 2)]);
    }
}

