namespace PackingProof.Infrastructure.Configuration;

public static class DotEnvLoader
{
    public static Dictionary<string, string?> ReadDotEnvIfPresent(string startDirectory)
    {
        var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var dir = new DirectoryInfo(startDirectory);

        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, ".env");
            if (File.Exists(candidate))
            {
                foreach (var rawLine in File.ReadAllLines(candidate))
                {
                    var line = rawLine.Trim();
                    if (string.IsNullOrEmpty(line) || line.StartsWith('#'))
                    {
                        continue;
                    }

                    var eqIdx = line.IndexOf('=');
                    if (eqIdx <= 0)
                    {
                        continue;
                    }

                    var key = line[..eqIdx].Trim();
                    var value = line[(eqIdx + 1)..].Trim();

                    if (value.Length >= 2 &&
                        ((value.StartsWith('"') && value.EndsWith('"')) ||
                         (value.StartsWith('\'') && value.EndsWith('\''))))
                    {
                        value = value[1..^1];
                    }

                    values[key] = value;
                }

                break;
            }

            dir = dir.Parent;
        }

        return values;
    }
}

