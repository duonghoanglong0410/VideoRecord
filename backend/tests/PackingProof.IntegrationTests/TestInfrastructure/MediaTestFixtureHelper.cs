using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Mvc.Testing.Handlers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using PackingProof.Core.Entities;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.IntegrationTests.TestInfrastructure;

public static class MediaTestFixtureHelper
{
    private static readonly Lazy<Task<byte[]>> CachedWebmSample = new(() => GenerateSampleVideoBytesAsync(".webm", "libvpx"));
    private static readonly Lazy<Task<byte[]>> CachedMp4Sample = new(() => GenerateSampleVideoBytesAsync(".mp4", "libx264"));

    public static Task<byte[]> GetValidWebmBytesAsync() => CachedWebmSample.Value;

    public static Task<byte[]> GetValidMp4BytesAsync() => CachedMp4Sample.Value;

    public static string ComputeSha256Hex(byte[] bytes) =>
        Convert.ToHexStringLower(SHA256.HashData(bytes));

    public static string EncodeTusMetadata(IReadOnlyDictionary<string, string> metadata)
    {
        var pairs = new List<string>(metadata.Count);
        foreach (var (key, value) in metadata)
        {
            if (string.IsNullOrEmpty(value))
            {
                pairs.Add(key);
            }
            else
            {
                var base64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
                pairs.Add($"{key} {base64}");
            }
        }

        return string.Join(",", pairs);
    }

    public static async Task<HttpResponseMessage> TusCreateAsync(
        CookieSessionClient client,
        long uploadLength,
        IReadOnlyDictionary<string, string> metadata,
        bool includeCsrf = true)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/uploads")
        {
            Content = new ByteArrayContent([])
        };
        req.Content.Headers.ContentLength = 0;
        req.Headers.Add("Tus-Resumable", "1.0.0");
        req.Headers.Add("Upload-Length", uploadLength.ToString());

        if (metadata.Count > 0)
        {
            req.Headers.Add("Upload-Metadata", EncodeTusMetadata(metadata));
        }

        if (includeCsrf)
        {
            if (string.IsNullOrEmpty(client.CsrfToken))
            {
                await client.RefreshCsrfAsync();
            }
            req.Headers.Add("X-CSRF-Token", client.CsrfToken);
        }

        return await client.Http.SendAsync(req);
    }

    public static async Task<HttpResponseMessage> TusHeadAsync(
        CookieSessionClient client,
        string tusUploadUrl)
    {
        using var req = new HttpRequestMessage(HttpMethod.Head, tusUploadUrl);
        req.Headers.Add("Tus-Resumable", "1.0.0");
        return await client.Http.SendAsync(req);
    }

    public static async Task<HttpResponseMessage> TusPatchAsync(
        CookieSessionClient client,
        string tusUploadUrl,
        long uploadOffset,
        byte[] chunkBytes,
        bool includeCsrf = true)
    {
        var content = new ByteArrayContent(chunkBytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/offset+octet-stream");

        using var req = new HttpRequestMessage(HttpMethod.Patch, tusUploadUrl)
        {
            Content = content
        };
        req.Headers.Add("Tus-Resumable", "1.0.0");
        req.Headers.Add("Upload-Offset", uploadOffset.ToString());

        if (includeCsrf)
        {
            if (string.IsNullOrEmpty(client.CsrfToken))
            {
                await client.RefreshCsrfAsync();
            }
            req.Headers.Add("X-CSRF-Token", client.CsrfToken);
        }

        return await client.Http.SendAsync(req);
    }

    public static async Task<HttpResponseMessage> TusDeleteAsync(
        CookieSessionClient client,
        string tusUploadUrl,
        bool includeCsrf = true)
    {
        using var req = new HttpRequestMessage(HttpMethod.Delete, tusUploadUrl);
        req.Headers.Add("Tus-Resumable", "1.0.0");

        if (includeCsrf)
        {
            if (string.IsNullOrEmpty(client.CsrfToken))
            {
                await client.RefreshCsrfAsync();
            }
            req.Headers.Add("X-CSRF-Token", client.CsrfToken);
        }

        return await client.Http.SendAsync(req);
    }

    public static long GetUploadOffsetHeader(HttpResponseMessage response)
    {
        if (!response.Headers.TryGetValues("Upload-Offset", out var values))
        {
            throw new InvalidOperationException("Response did not include an Upload-Offset header.");
        }

        return long.Parse(values.Single());
    }

    private static async Task<byte[]> GenerateSampleVideoBytesAsync(string extension, string videoCodec)
    {
        var tempFile = Path.Combine(Path.GetTempPath(), $"packingproof_sample_{Guid.NewGuid():N}{extension}");
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            startInfo.ArgumentList.Add("-y");
            startInfo.ArgumentList.Add("-hide_banner");
            startInfo.ArgumentList.Add("-loglevel");
            startInfo.ArgumentList.Add("error");
            startInfo.ArgumentList.Add("-f");
            startInfo.ArgumentList.Add("lavfi");
            startInfo.ArgumentList.Add("-i");
            startInfo.ArgumentList.Add("testsrc=duration=1.2:size=320x240:rate=15");
            startInfo.ArgumentList.Add("-c:v");
            startInfo.ArgumentList.Add(videoCodec);

            if (string.Equals(videoCodec, "libx264", StringComparison.OrdinalIgnoreCase))
            {
                startInfo.ArgumentList.Add("-pix_fmt");
                startInfo.ArgumentList.Add("yuv420p");
                startInfo.ArgumentList.Add("-movflags");
                startInfo.ArgumentList.Add("+faststart");
            }
            else
            {
                startInfo.ArgumentList.Add("-b:v");
                startInfo.ArgumentList.Add("200k");
            }

            startInfo.ArgumentList.Add(tempFile);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Unable to start ffmpeg process to generate test fixture.");

            var stderrTask = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            var stderr = await stderrTask;

            if (process.ExitCode != 0 || !File.Exists(tempFile))
            {
                throw new InvalidOperationException(
                    $"ffmpeg failed with exit code {process.ExitCode} while generating '{extension}' sample: {stderr}");
            }

            var bytes = await File.ReadAllBytesAsync(tempFile);
            if (bytes.Length < 256)
            {
                throw new InvalidOperationException($"Generated '{extension}' fixture is unexpectedly small ({bytes.Length} bytes).");
            }

            return bytes;
        }
        finally
        {
            try
            {
                if (File.Exists(tempFile))
                {
                    File.Delete(tempFile);
                }
            }
            catch
            {
                // Ignore temp file deletion errors
            }
        }
    }
}

public sealed class CustomStorageWebAppFactory : WebApplicationFactory<Program>
{
    private readonly IReadOnlyDictionary<string, string?> _extraOverrides;

    public string DatabaseName { get; }
    public string TempRootPath { get; }
    public string NasRootPath { get; }
    public string StagingRootPath { get; }

    public string ConnectionString =>
        $"Host=localhost;Port=5432;Database={DatabaseName};Username=postgres;Pooling=false";

    public CustomStorageWebAppFactory(
        IReadOnlyDictionary<string, string?>? extraOverrides = null,
        string? existingDatabaseName = null,
        string? existingTempRootPath = null)
    {
        _extraOverrides = extraOverrides ?? new Dictionary<string, string?>();
        DatabaseName = existingDatabaseName ?? $"packingproof_it_{Guid.NewGuid():N}";
        TempRootPath = existingTempRootPath ?? Path.Combine(Path.GetTempPath(), $"packingproof_it_{Guid.NewGuid():N}");
        NasRootPath = _extraOverrides.TryGetValue("NAS_ROOT_PATH", out var customNas) && !string.IsNullOrWhiteSpace(customNas)
            ? customNas!
            : Path.Combine(TempRootPath, "nas-share");
        StagingRootPath = _extraOverrides.TryGetValue("STAGING_ROOT_PATH", out var customStaging) && !string.IsNullOrWhiteSpace(customStaging)
            ? customStaging!
            : Path.Combine(TempRootPath, "staging");

        Directory.CreateDirectory(TempRootPath);
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureAppConfiguration((_, configBuilder) =>
        {
            var settings = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                ["APP_PUBLIC_ORIGIN"] = "http://localhost",
                ["DATABASE_CONNECTION"] = ConnectionString,
                ["AUTH_COOKIE_NAME"] = "PackingProof.TestAuth",
                ["STORAGE_MODE"] = "LocalDevelopment",
                ["NAS_ROOT_PATH"] = NasRootPath,
                ["STORAGE_ID"] = "packingproof-synology-prod-01",
                ["STAGING_ROOT_PATH"] = StagingRootPath,
                ["DATA_PROTECTION_KEYS_PATH"] = Path.Combine(TempRootPath, "dp-keys"),
                ["INITIAL_ADMIN_EMAIL"] = PostgresWebAppFixture.SuperAdminEmail,
                ["INITIAL_ADMIN_PASSWORD"] = PostgresWebAppFixture.SuperAdminPassword,
                ["AUTO_MIGRATE_ON_STARTUP"] = "true",
                ["WORKER_POLL_INTERVAL_MS"] = "150",
                ["WORKER_RETRY_BASE_DELAY_SECONDS"] = "1",
                ["WORKER_MAX_ATTEMPTS"] = "3"
            };

            foreach (var (key, value) in _extraOverrides)
            {
                settings[key] = value;
            }

            configBuilder.AddInMemoryCollection(settings);
        });
    }

    public CookieSessionClient CreateSessionClient()
    {
        var cookieHandler = new CookieContainerHandler();
        var client = CreateDefaultClient(cookieHandler);
        return new CookieSessionClient(client);
    }

    public async Task<(Shop ShopA, Warehouse WarehouseA1)> EnsureShopAExistsAsync()
    {
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

        var shopA = db.Shops.FirstOrDefault(s => s.Code == "ShopA");
        if (shopA is null)
        {
            shopA = new Shop
            {
                Code = "ShopA",
                Slug = "shop-a",
                Name = "Shop A",
                AllowedStorageSubdir = "shop-a",
                IsActive = true
            };
            db.Shops.Add(shopA);
            await db.SaveChangesAsync();
        }

        var whA1 = db.Warehouses.FirstOrDefault(w => w.ShopId == shopA.Id && w.Code == "WH-HCM-01");
        if (whA1 is null)
        {
            whA1 = new Warehouse
            {
                ShopId = shopA.Id,
                Code = "WH-HCM-01",
                Name = "Kho TP.HCM 01",
                IsActive = true
            };
            db.Warehouses.Add(whA1);
            await db.SaveChangesAsync();
        }

        return (shopA, whA1);
    }

    public async Task CleanupDatabaseAndTempRootAsync()
    {
        await DisposeAsync();
        NpgsqlConnection.ClearAllPools();

        try
        {
            await using var adminConn = new NpgsqlConnection(
                "Host=localhost;Port=5432;Database=postgres;Username=postgres;Pooling=false");
            await adminConn.OpenAsync();

            await using (var terminateCmd = adminConn.CreateCommand())
            {
                terminateCmd.CommandText =
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = @db AND pid <> pg_backend_pid();";
                terminateCmd.Parameters.AddWithValue("db", DatabaseName);
                await terminateCmd.ExecuteNonQueryAsync();
            }

            await using (var dropCmd = adminConn.CreateCommand())
            {
                dropCmd.CommandText = $"DROP DATABASE IF EXISTS \"{DatabaseName}\";";
                await dropCmd.ExecuteNonQueryAsync();
            }
        }
        catch
        {
            // Ignore cleanup errors
        }

        try
        {
            if (Directory.Exists(TempRootPath))
            {
                Directory.Delete(TempRootPath, recursive: true);
            }
        }
        catch
        {
            // Ignore temp folder deletion errors
        }
    }
}

