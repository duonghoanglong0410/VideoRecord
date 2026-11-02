using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Mvc.Testing.Handlers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using PackingProof.Core.Entities;
using PackingProof.Infrastructure.Persistence;
using Xunit;

namespace PackingProof.IntegrationTests.TestInfrastructure;

public sealed class PostgresWebAppFixture : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const string SuperAdminEmail = "superadmin@packingproof.test";
    public const string SuperAdminPassword = "SuperAdminPass123!";

    public string DatabaseName { get; } = $"packingproof_it_{Guid.NewGuid():N}";
    public string TempRootPath { get; } = Path.Combine(Path.GetTempPath(), $"packingproof_it_{Guid.NewGuid():N}");

    public string ConnectionString =>
        $"Host=localhost;Port=5432;Database={DatabaseName};Username=postgres;Pooling=false";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureAppConfiguration((_, configBuilder) =>
        {
            var overrides = new Dictionary<string, string?>
            {
                ["APP_PUBLIC_ORIGIN"] = "http://localhost",
                ["DATABASE_CONNECTION"] = ConnectionString,
                ["AUTH_COOKIE_NAME"] = "PackingProof.TestAuth",
                ["STORAGE_MODE"] = "LocalDevelopment",
                ["NAS_ROOT_PATH"] = Path.Combine(TempRootPath, "storage"),
                ["STORAGE_ID"] = "packingproof-it-storage-01",
                ["STAGING_ROOT_PATH"] = Path.Combine(TempRootPath, "staging"),
                ["NAS_WRITE_ONCE_MODE"] = "false",
                ["NAS_SMB_USERNAME"] = "",
                ["NAS_SMB_PASSWORD"] = "",
                ["DATA_PROTECTION_KEYS_PATH"] = Path.Combine(TempRootPath, "dp-keys"),
                ["INITIAL_ADMIN_EMAIL"] = SuperAdminEmail,
                ["INITIAL_ADMIN_PASSWORD"] = SuperAdminPassword,
                ["AUTO_MIGRATE_ON_STARTUP"] = "true"
            };

            configBuilder.AddInMemoryCollection(overrides);
        });
    }

    public Task InitializeAsync()
    {
        Directory.CreateDirectory(TempRootPath);
        // Trigger host startup, EF MigrateAsync(), and SystemSeeder.SeedAsync()
        _ = Services;
        return Task.CompletedTask;
    }

    public CookieSessionClient CreateSessionClient()
    {
        var cookieHandler = new CookieContainerHandler();
        var client = CreateDefaultClient(cookieHandler);
        return new CookieSessionClient(client);
    }

    public async Task<(Shop ShopB, Warehouse WarehouseB1)> EnsureShopBExistsAsync()
    {
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

        var shopB = db.Shops.FirstOrDefault(s => s.Code == "ShopB");
        if (shopB is null)
        {
            shopB = new Shop
            {
                Code = "ShopB",
                Slug = "shop-b",
                Name = "Shop B",
                AllowedStorageSubdir = "shop-b",
                IsActive = true
            };
            db.Shops.Add(shopB);
            await db.SaveChangesAsync();
        }

        var whB1 = db.Warehouses.FirstOrDefault(w => w.ShopId == shopB.Id && w.Code == "WH-HN-01");
        if (whB1 is null)
        {
            whB1 = new Warehouse
            {
                ShopId = shopB.Id,
                Code = "WH-HN-01",
                Name = "Kho Hà Nội 01",
                IsActive = true
            };
            db.Warehouses.Add(whB1);
            await db.SaveChangesAsync();
        }

        return (shopB, whB1);
    }

    async Task IAsyncLifetime.DisposeAsync()
    {
        await base.DisposeAsync();
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
            // Ignore cleanup errors if DB was never created
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

