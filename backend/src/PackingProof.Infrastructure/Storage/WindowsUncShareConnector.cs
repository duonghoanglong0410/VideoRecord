using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace PackingProof.Infrastructure.Storage;

public static class WindowsUncShareConnector
{
    private const int ResourceTypeDisk = 0x00000001;
    private const int ErrorSuccess = 0;
    private const int ErrorAlreadyAssigned = 85;
    private const int ErrorSessionCredentialConflict = 1219;

    public static bool TryExtractUncServerAndShare(
        string? uncPath,
        out string serverName,
        out string shareRoot)
    {
        serverName = string.Empty;
        shareRoot = string.Empty;

        if (string.IsNullOrWhiteSpace(uncPath))
        {
            return false;
        }

        var trimmed = uncPath.Trim();
        if (!trimmed.StartsWith(@"\\", StringComparison.Ordinal) ||
            trimmed.Length <= 3 ||
            trimmed[2] is '\\' or '?' or '.')
        {
            return false;
        }

        var parts = trimmed[2..]
            .Split(['\\', '/'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (parts.Length < 2)
        {
            return false;
        }

        serverName = parts[0];
        var shareName = parts[1];
        shareRoot = $@"\\{serverName}\{shareName}";
        return true;
    }

    public static IReadOnlyList<string> BuildCandidateUsernames(string serverName, string rawUsername)
    {
        var trimmed = rawUsername.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return [];
        }

        if (trimmed.Contains('\\') || trimmed.Contains('@'))
        {
            return [trimmed];
        }

        return [$@"{serverName}\{trimmed}", trimmed];
    }

    public static void EnsureConnectedBestEffort(
        string? nasRootPath,
        string? username,
        string? password,
        ILogger logger)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
        {
            return;
        }

        if (!TryExtractUncServerAndShare(nasRootPath, out var serverName, out var shareRoot))
        {
            return;
        }

        ConnectWindowsUncShare(serverName, shareRoot, username, password, logger);
    }

    [SupportedOSPlatform("windows")]
    private static void ConnectWindowsUncShare(
        string serverName,
        string shareRoot,
        string rawUsername,
        string password,
        ILogger logger)
    {
        var candidates = BuildCandidateUsernames(serverName, rawUsername);
        var lastResult = ErrorSuccess;
        var lastUser = string.Empty;

        foreach (var candidateUser in candidates)
        {
            var netResource = new NetResource
            {
                dwScope = 0,
                dwType = ResourceTypeDisk,
                dwDisplayType = 0,
                dwUsage = 0,
                lpLocalName = null,
                lpRemoteName = shareRoot,
                lpComment = null,
                lpProvider = null
            };

            var result = WNetAddConnection2W(ref netResource, password, candidateUser, 0);
            if (result is ErrorSuccess or ErrorAlreadyAssigned or ErrorSessionCredentialConflict)
            {
                return;
            }

            lastResult = result;
            lastUser = candidateUser;
        }

        logger.LogWarning(
            "Unable to establish SMB session to UNC share '{ShareRoot}' as '{Username}' (Win32 error code {Win32Error}).",
            shareRoot,
            lastUser,
            lastResult);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NetResource
    {
        public int dwScope;
        public int dwType;
        public int dwDisplayType;
        public int dwUsage;
        public string? lpLocalName;
        public string? lpRemoteName;
        public string? lpComment;
        public string? lpProvider;
    }

    [SupportedOSPlatform("windows")]
    [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
    private static extern int WNetAddConnection2W(
        ref NetResource lpNetResource,
        string? lpPassword,
        string? lpUserName,
        int dwFlags);
}

