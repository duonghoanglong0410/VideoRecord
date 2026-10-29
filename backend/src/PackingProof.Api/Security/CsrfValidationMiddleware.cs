using Microsoft.AspNetCore.Antiforgery;
using PackingProof.Api.Common;

namespace PackingProof.Api.Security;

public sealed class CsrfValidationMiddleware
{
    private readonly RequestDelegate _next;

    public CsrfValidationMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, IAntiforgery antiforgery)
    {
        if (IsMutatingMethod(context.Request.Method) &&
            context.User.Identity?.IsAuthenticated == true)
        {
            // For /api/uploads (tus binary PATCH/POST/DELETE), require X-CSRF-Token explicitly
            // before calling ValidateRequestAsync so Request.Body is NEVER read or buffered.
            if (context.Request.Path.StartsWithSegments("/api/uploads", StringComparison.OrdinalIgnoreCase) &&
                string.IsNullOrWhiteSpace(context.Request.Headers["X-CSRF-Token"]))
            {
                await WriteCsrfForbiddenAsync(context);
                return;
            }

            try
            {
                await antiforgery.ValidateRequestAsync(context);
            }
            catch (AntiforgeryValidationException)
            {
                await WriteCsrfForbiddenAsync(context);
                return;
            }
        }

        await _next(context);
    }

    private static async Task WriteCsrfForbiddenAsync(HttpContext context)
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsJsonAsync(new ApiErrorResponse(
            "CSRF_TOKEN_INVALID",
            "Mã bảo vệ CSRF bị thiếu hoặc không hợp lệ. Vui lòng tải lại trang và thử lại."));
    }

    private static bool IsMutatingMethod(string method) =>
        HttpMethods.IsPost(method) ||
        HttpMethods.IsPut(method) ||
        HttpMethods.IsPatch(method) ||
        HttpMethods.IsDelete(method);
}

