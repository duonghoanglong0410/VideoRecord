using PackingProof.Api.Common;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Permissions;
using PackingProof.Core.Storage;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Api.Features.Health;

public static class HealthEndpoints
{
    public const string StorageMarkerFileName = ".packingproof-storage-id";

    public static IEndpointRouteBuilder MapPackingProofHealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/health/live", () =>
            Results.Ok(new { status = "Healthy" }))
            .AllowAnonymous();

        endpoints.MapGet("/health/ready", async (
            HttpContext httpContext,
            PackingProofDbContext db,
            PackingProofOptions options,
            IVideoStorage videoStorage,
            IScopeAuthorizationService scopeAuth,
            CancellationToken ct) =>
        {
            var dbHealthy = false;
            try
            {
                dbHealthy = await db.Database.CanConnectAsync(ct);
            }
            catch
            {
                dbHealthy = false;
            }

            var storageReport = await videoStorage.CheckHealthAsync(ct);
            var stagingHealthy = CheckStagingReadiness(options);
            var isHealthy = dbHealthy && storageReport.IsHealthy && stagingHealthy;
            var statusText = isHealthy ? "Healthy" : "Unhealthy";
            var statusCode = isHealthy ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable;

            var canViewDiagnostics = false;
            if (httpContext.User.Identity?.IsAuthenticated == true &&
                httpContext.TryGetUserId() is { } userId)
            {
                canViewDiagnostics = await scopeAuth.HasAnyScopeForPermissionAsync(
                    userId,
                    PermissionCatalog.StorageManage,
                    ct);
            }

            if (!canViewDiagnostics)
            {
                return Results.Json(new { status = statusText }, statusCode: statusCode);
            }

            return Results.Json(
                new
                {
                    status = statusText,
                    diagnostics = new
                    {
                        database = dbHealthy ? "Healthy" : "Unhealthy",
                        storageMode = storageReport.Mode.ToString(),
                        storage = storageReport.IsHealthy ? "Healthy" : "Unhealthy",
                        storageRootExists = storageReport.RootExists,
                        storageMarkerValid = storageReport.MarkerValid,
                        storageCanReadWrite = storageReport.CanReadWrite,
                        storageErrorCode = storageReport.ErrorCode,
                        staging = stagingHealthy ? "Healthy" : "Unhealthy",
                        checkedAtUtc = storageReport.CheckedAtUtc
                    }
                },
                statusCode: statusCode);
        }).AllowAnonymous();

        return endpoints;
    }

    private static bool CheckStagingReadiness(PackingProofOptions options)
    {
        try
        {
            var stagingFullPath = Path.GetFullPath(options.StagingRootPath);
            return Directory.Exists(stagingFullPath);
        }
        catch
        {
            return false;
        }
    }
}

