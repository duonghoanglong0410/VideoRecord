using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PackingProof.Infrastructure.Auditing;

public static class AuditMetadataScrubber
{
    private static readonly string[] SensitiveKeyMarkers =
    [
        "password",
        "token",
        "cookie",
        "secret",
        "authorization",
        "qrraw",
        "rawqr",
        "recoverycode",
        "authenticatorkey",
        "otpauth",
        "sharedkey",
        "unformattedkey"
    ];

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false
    };

    public static string ScrubToJson(object? metadata)
    {
        if (metadata is null)
        {
            return "{}";
        }

        JsonNode? rootNode;
        if (metadata is string rawString)
        {
            var trimmed = rawString.Trim();
            if ((trimmed.StartsWith('{') && trimmed.EndsWith('}')) ||
                (trimmed.StartsWith('[') && trimmed.EndsWith(']')))
            {
                try
                {
                    rootNode = JsonNode.Parse(trimmed);
                }
                catch (JsonException)
                {
                    rootNode = new JsonObject { ["note"] = ScrubStringValue(rawString) };
                }
            }
            else
            {
                rootNode = new JsonObject { ["note"] = ScrubStringValue(rawString) };
            }
        }
        else
        {
            rootNode = JsonSerializer.SerializeToNode(metadata, SerializerOptions);
        }

        if (rootNode is null)
        {
            return "{}";
        }

        ScrubNodeInPlace(rootNode);
        return rootNode.ToJsonString(SerializerOptions);
    }

    public static bool IsSensitiveKey(string key)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return false;
        }

        Span<char> buffer = stackalloc char[key.Length];
        var len = 0;
        foreach (var ch in key)
        {
            if (ch is '_' or '-' or ' ' or '.')
            {
                continue;
            }

            buffer[len++] = char.ToLowerInvariant(ch);
        }

        var normalized = new string(buffer[..len]);
        foreach (var marker in SensitiveKeyMarkers)
        {
            if (normalized.Contains(marker, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static void ScrubNodeInPlace(JsonNode node)
    {
        switch (node)
        {
            case JsonObject obj:
            {
                var keysToRemove = new List<string>();
                var keysToUpdate = new List<(string Key, string Value)>();

                foreach (var kvp in obj)
                {
                    if (IsSensitiveKey(kvp.Key))
                    {
                        keysToRemove.Add(kvp.Key);
                        continue;
                    }

                    if (kvp.Value is JsonValue val && val.TryGetValue<string>(out var strVal))
                    {
                        var scrubbed = ScrubStringValue(strVal);
                        if (!ReferenceEquals(scrubbed, strVal))
                        {
                            keysToUpdate.Add((kvp.Key, scrubbed));
                        }
                    }
                    else if (kvp.Value is not null)
                    {
                        ScrubNodeInPlace(kvp.Value);
                    }
                }

                foreach (var key in keysToRemove)
                {
                    obj.Remove(key);
                }

                foreach (var (key, scrubbedVal) in keysToUpdate)
                {
                    obj[key] = scrubbedVal;
                }

                break;
            }

            case JsonArray arr:
            {
                for (var i = 0; i < arr.Count; i++)
                {
                    var item = arr[i];
                    if (item is JsonValue val && val.TryGetValue<string>(out var strVal))
                    {
                        var scrubbed = ScrubStringValue(strVal);
                        if (!ReferenceEquals(scrubbed, strVal))
                        {
                            arr[i] = scrubbed;
                        }
                    }
                    else if (item is not null)
                    {
                        ScrubNodeInPlace(item);
                    }
                }

                break;
            }
        }
    }

    private static string ScrubStringValue(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return value;
        }

        if (value.StartsWith("otpauth://", StringComparison.OrdinalIgnoreCase) ||
            value.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return "[REDACTED]";
        }

        return value;
    }
}

