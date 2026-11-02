using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using PackingProof.Api.Features.Health;
using PackingProof.Api.Features.Uploads;
using PackingProof.Api.Security;
using PackingProof.Infrastructure;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Identity;
using PackingProof.Infrastructure.Persistence;
using tusdotnet;

var builder = WebApplication.CreateBuilder(args);

if (!builder.Environment.IsEnvironment("Testing"))
{
    var dotEnvValues = DotEnvLoader.ReadDotEnvIfPresent(builder.Environment.ContentRootPath);
    if (dotEnvValues.Count > 0)
    {
        var nonExistingOnly = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var (key, value) in dotEnvValues)
        {
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
            {
                nonExistingOnly[key] = value;
            }
        }

        if (nonExistingOnly.Count > 0)
        {
            builder.Configuration.AddInMemoryCollection(nonExistingOnly);
        }
    }
}

builder.Configuration.AddEnvironmentVariables();

builder.Services.AddDataProtection()
    .SetApplicationName("PackingProof.Web");

builder.Services.AddPackingProofInfrastructure();

builder.Services.AddScoped<ImmediateCookieEvents>();

builder.Services.AddOptions<CookieAuthenticationOptions>(IdentityConstants.ApplicationScheme)
    .Configure<PackingProofOptions, IHostEnvironment>((cookie, packingOptions, env) =>
    {
        cookie.Cookie.Name = packingOptions.AuthCookieName;
        cookie.Cookie.HttpOnly = true;
        cookie.Cookie.SameSite = SameSiteMode.Lax;
        cookie.Cookie.SecurePolicy = env.IsProduction()
            ? CookieSecurePolicy.Always
            : CookieSecurePolicy.SameAsRequest;
        cookie.ExpireTimeSpan = TimeSpan.FromHours(12);
        cookie.SlidingExpiration = true;
        cookie.EventsType = typeof(ImmediateCookieEvents);
    });

builder.Services.AddAntiforgery();
builder.Services.AddOptions<AntiforgeryOptions>()
    .Configure<PackingProofOptions, IHostEnvironment>((antiforgery, packingOptions, env) =>
    {
        antiforgery.HeaderName = "X-CSRF-Token";
        antiforgery.Cookie.Name = $"{packingOptions.AuthCookieName}.Antiforgery";
        antiforgery.Cookie.HttpOnly = true;
        antiforgery.Cookie.SameSite = SameSiteMode.Lax;
        antiforgery.Cookie.SecurePolicy = env.IsProduction()
            ? CookieSecurePolicy.Always
            : CookieSecurePolicy.SameAsRequest;
    });

builder.Services
    .AddControllers()
    .AddJsonOptions(json =>
    {
        json.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter());
    });

builder.Services.ConfigureHttpJsonOptions(json =>
{
    json.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

builder.Services.AddOpenApi();

var app = builder.Build();

app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedFor
});

var autoMigrateSetting = app.Configuration["AUTO_MIGRATE_ON_STARTUP"];
var shouldAutoMigrate = string.IsNullOrWhiteSpace(autoMigrateSetting) ||
                        (bool.TryParse(autoMigrateSetting, out var parsedAuto) && parsedAuto);

if (shouldAutoMigrate)
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
    await db.Database.MigrateAsync();

    var seeder = scope.ServiceProvider.GetRequiredService<SystemSeeder>();
    await seeder.SeedAsync();
}

// Same-origin static hosting support (for IIS, single-origin production, and Playwright E2E)
var packingOpts = app.Services.GetRequiredService<PackingProofOptions>();
string? resolvedFrontendRoot = null;

if (!string.IsNullOrWhiteSpace(packingOpts.FrontendDistPath))
{
    var candidate = Path.IsPathRooted(packingOpts.FrontendDistPath)
        ? Path.GetFullPath(packingOpts.FrontendDistPath)
        : Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, packingOpts.FrontendDistPath));

    if (File.Exists(Path.Combine(candidate, "index.html")))
    {
        resolvedFrontendRoot = candidate;
    }
}
else if (!string.IsNullOrWhiteSpace(app.Environment.WebRootPath) &&
         File.Exists(Path.Combine(app.Environment.WebRootPath, "index.html")))
{
    resolvedFrontendRoot = Path.GetFullPath(app.Environment.WebRootPath);
}

PhysicalFileProvider? frontendFileProvider = null;
if (resolvedFrontendRoot is not null)
{
    frontendFileProvider = new PhysicalFileProvider(resolvedFrontendRoot);
    var contentTypeProvider = new FileExtensionContentTypeProvider();
    contentTypeProvider.Mappings[".webmanifest"] = "application/manifest+json";

    app.UseDefaultFiles(new DefaultFilesOptions
    {
        FileProvider = frontendFileProvider
    });

    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = frontendFileProvider,
        ContentTypeProvider = contentTypeProvider,
        OnPrepareResponse = ctx =>
        {
            var fileName = ctx.File.Name;
            if (fileName.Equals("index.html", StringComparison.OrdinalIgnoreCase) ||
                fileName.Equals("sw.js", StringComparison.OrdinalIgnoreCase) ||
                fileName.Equals("manifest.webmanifest", StringComparison.OrdinalIgnoreCase))
            {
                ctx.Context.Response.Headers.CacheControl = "no-cache";
            }
        }
    });
}

app.MapOpenApi("/openapi/v1.json");

app.UseAuthentication();
app.UseMiddleware<CsrfValidationMiddleware>();
app.UseMiddleware<ActiveAccountEnforcementMiddleware>();
app.UseAuthorization();

app.UseTus(TusConfigurationFactory.CreateAsync);

app.MapPackingProofHealthEndpoints();
app.MapControllers();

if (resolvedFrontendRoot is not null)
{
    var indexHtmlPath = Path.Combine(resolvedFrontendRoot, "index.html");
    app.Use(async (context, next) =>
    {
        await next();

        if (context.Response.HasStarted || context.Response.StatusCode != StatusCodes.Status404NotFound)
        {
            return;
        }

        if (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method))
        {
            return;
        }

        var reqPath = context.Request.Path;
        if (reqPath.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase) ||
            reqPath.StartsWithSegments("/health", StringComparison.OrdinalIgnoreCase) ||
            reqPath.StartsWithSegments("/openapi", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        // Do not serve SPA HTML for missing static assets with explicit file extensions (e.g. /assets/missing.js)
        var lastSegment = reqPath.Value?.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
        if (!string.IsNullOrEmpty(lastSegment) && Path.HasExtension(lastSegment))
        {
            return;
        }

        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.ContentType = "text/html; charset=utf-8";
        context.Response.Headers.CacheControl = "no-cache";

        if (HttpMethods.IsGet(context.Request.Method))
        {
            await context.Response.SendFileAsync(indexHtmlPath, context.RequestAborted);
        }
    });
}

await app.RunAsync();

public partial class Program;
