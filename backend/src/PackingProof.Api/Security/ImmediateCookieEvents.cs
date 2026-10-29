using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using PackingProof.Api.Common;
using PackingProof.Core.Enums;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Api.Security;

public sealed class ImmediateCookieEvents : CookieAuthenticationEvents
{
    public const string ApprovalStatusItemKey = "PackingProof.UserApprovalStatus";

    public override async Task ValidatePrincipal(CookieValidatePrincipalContext context)
    {
        if (context.Principal?.Identity?.IsAuthenticated != true)
        {
            context.RejectPrincipal();
            return;
        }

        var userIdRaw = context.Principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (!Guid.TryParse(userIdRaw, out var userId))
        {
            await RejectAndSignOutAsync(context);
            return;
        }

        var identityOptions = context.HttpContext.RequestServices
            .GetRequiredService<IOptions<IdentityOptions>>().Value;

        var stampClaimType = identityOptions.ClaimsIdentity.SecurityStampClaimType;
        var cookieSecurityStamp = context.Principal.FindFirst(stampClaimType)?.Value;

        if (string.IsNullOrEmpty(cookieSecurityStamp))
        {
            await RejectAndSignOutAsync(context);
            return;
        }

        var db = context.HttpContext.RequestServices.GetRequiredService<PackingProofDbContext>();
        var dbUser = await db.Users
            .AsNoTracking()
            .Select(u => new
            {
                u.Id,
                u.ApprovalStatus,
                u.LockoutEnd,
                u.SecurityStamp
            })
            .FirstOrDefaultAsync(u => u.Id == userId, context.HttpContext.RequestAborted);

        if (dbUser is null)
        {
            await RejectAndSignOutAsync(context);
            return;
        }

        if (dbUser.ApprovalStatus == ApprovalStatus.Locked)
        {
            await RejectAndSignOutAsync(context);
            return;
        }

        if (dbUser.LockoutEnd.HasValue && dbUser.LockoutEnd.Value > DateTimeOffset.UtcNow)
        {
            await RejectAndSignOutAsync(context);
            return;
        }

        if (!string.Equals(cookieSecurityStamp, dbUser.SecurityStamp, StringComparison.Ordinal))
        {
            await RejectAndSignOutAsync(context);
            return;
        }

        context.HttpContext.Items[ApprovalStatusItemKey] = dbUser.ApprovalStatus;
    }

    public override async Task RedirectToLogin(RedirectContext<CookieAuthenticationOptions> context)
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsJsonAsync(new ApiErrorResponse(
            "UNAUTHORIZED",
            "Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại."));
    }

    public override async Task RedirectToAccessDenied(RedirectContext<CookieAuthenticationOptions> context)
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsJsonAsync(new ApiErrorResponse(
            "FORBIDDEN",
            "Bạn không có quyền thực hiện thao tác này."));
    }

    private static async Task RejectAndSignOutAsync(CookieValidatePrincipalContext context)
    {
        context.RejectPrincipal();
        await context.HttpContext.SignOutAsync(IdentityConstants.ApplicationScheme);
    }
}

