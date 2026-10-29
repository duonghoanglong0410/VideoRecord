using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Core.Enums;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Api.Security;

public sealed class ActiveAccountEnforcementMiddleware
{
    private readonly RequestDelegate _next;

    public ActiveAccountEnforcementMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, PackingProofDbContext db)
    {
        if (context.User.Identity?.IsAuthenticated == true)
        {
            ApprovalStatus? status = null;
            if (context.Items.TryGetValue(ImmediateCookieEvents.ApprovalStatusItemKey, out var item) &&
                item is ApprovalStatus cachedStatus)
            {
                status = cachedStatus;
            }
            else if (context.TryGetUserId() is { } userId)
            {
                status = await db.Users
                    .AsNoTracking()
                    .Where(u => u.Id == userId)
                    .Select(u => (ApprovalStatus?)u.ApprovalStatus)
                    .FirstOrDefaultAsync(context.RequestAborted);
            }

            if (status != ApprovalStatus.Active && !IsAllowedForPendingApproval(context.Request))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                context.Response.ContentType = "application/json; charset=utf-8";
                await context.Response.WriteAsJsonAsync(new ApiErrorResponse(
                    "ACCOUNT_PENDING_APPROVAL",
                    "Tài khoản đang chờ phê duyệt. Bạn chưa được phép truy cập dữ liệu hoặc chức năng nghiệp vụ."));
                return;
            }
        }

        await _next(context);
    }

    private static bool IsAllowedForPendingApproval(HttpRequest request)
    {
        var path = request.Path.Value ?? string.Empty;
        var method = request.Method;

        if (HttpMethods.IsGet(method) &&
            (path.Equals("/api/auth/me", StringComparison.OrdinalIgnoreCase) ||
             path.Equals("/api/auth/csrf", StringComparison.OrdinalIgnoreCase) ||
             path.Equals("/health/live", StringComparison.OrdinalIgnoreCase) ||
             path.Equals("/health/ready", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        if (HttpMethods.IsPost(method) &&
            path.Equals("/api/auth/logout", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        // Allow same-origin static assets and SPA HTML shell navigation (GET/HEAD outside /api and /openapi)
        // so React Router can load and render the PendingApproval screen cleanly.
        if ((HttpMethods.IsGet(method) || HttpMethods.IsHead(method)) &&
            !request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase) &&
            !request.Path.StartsWithSegments("/openapi", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return false;
    }
}

