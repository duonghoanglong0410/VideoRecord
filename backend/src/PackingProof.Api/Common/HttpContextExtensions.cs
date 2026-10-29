using System.Security.Claims;

namespace PackingProof.Api.Common;

public static class HttpContextExtensions
{
    public static Guid GetRequiredUserId(this HttpContext context)
    {
        var raw = context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(raw, out var id)
            ? id
            : throw new UnauthorizedAccessException("Missing authenticated user identifier.");
    }

    public static Guid? TryGetUserId(this HttpContext context)
    {
        var raw = context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(raw, out var id) ? id : null;
    }

    public static string? GetUserEmail(this HttpContext context) =>
        context.User.FindFirst(ClaimTypes.Email)?.Value ?? context.User.Identity?.Name;

    public static string? GetClientIp(this HttpContext context) =>
        context.Connection.RemoteIpAddress?.ToString();

    public static string? GetUserAgent(this HttpContext context) =>
        context.Request.Headers.UserAgent.ToString();
}

