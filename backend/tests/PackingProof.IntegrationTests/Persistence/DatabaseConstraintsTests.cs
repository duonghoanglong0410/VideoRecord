using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Infrastructure.Persistence;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Persistence;

public sealed class DatabaseConstraintsTests : IClassFixture<PostgresWebAppFixture>
{
    private readonly PostgresWebAppFixture _fixture;

    public DatabaseConstraintsTests(PostgresWebAppFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task Recordings_AllowDuplicateTrackingNumbers_AndPreserveLeadingZeros_AndEnforceXminConcurrency()
    {
        using var scope = _fixture.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

        var user = await db.Users.FirstAsync();
        var shop = await db.Shops.FirstAsync();
        var warehouse = await db.Warehouses.FirstAsync(w => w.ShopId == shop.Id);

        const string trackingWithLeadingZeros = "000849201938";

        var rec1 = new Recording
        {
            OwnerUserId = user.Id,
            ShopId = shop.Id,
            WarehouseId = warehouse.Id,
            TrackingNumber = trackingWithLeadingZeros,
            SafeTrackingSegment = trackingWithLeadingZeros,
            Source = RecordingSource.RecordedInBrowser,
            CaptureStatus = CaptureStatus.Captured,
            StorageStatus = StorageStatus.AwaitingUpload,
            PreviewStatus = PreviewStatus.NotRequired
        };

        var rec2 = new Recording
        {
            OwnerUserId = user.Id,
            ShopId = shop.Id,
            WarehouseId = warehouse.Id,
            TrackingNumber = trackingWithLeadingZeros,
            SafeTrackingSegment = trackingWithLeadingZeros,
            Source = RecordingSource.RecordedInBrowser,
            CaptureStatus = CaptureStatus.Captured,
            StorageStatus = StorageStatus.AwaitingUpload,
            PreviewStatus = PreviewStatus.NotRequired
        };

        db.Recordings.AddRange(rec1, rec2);
        await db.SaveChangesAsync();

        var saved = await db.Recordings
            .AsNoTracking()
            .Where(r => r.TrackingNumber == trackingWithLeadingZeros)
            .ToListAsync();

        Assert.Equal(2, saved.Count);
        Assert.All(saved, r => Assert.Equal("000849201938", r.TrackingNumber));
        Assert.All(saved, r => Assert.True(r.Version > 0));

        // Verify PostgreSQL xmin optimistic concurrency token detects concurrent update
        using var scopeA = _fixture.Services.CreateScope();
        using var scopeB = _fixture.Services.CreateScope();
        var dbA = scopeA.ServiceProvider.GetRequiredService<PackingProofDbContext>();
        var dbB = scopeB.ServiceProvider.GetRequiredService<PackingProofDbContext>();

        var concurrentA = await dbA.Recordings.FirstAsync(r => r.Id == rec1.Id);
        var concurrentB = await dbB.Recordings.FirstAsync(r => r.Id == rec1.Id);

        concurrentA.Hold = true;
        await dbA.SaveChangesAsync();

        concurrentB.HoldReason = "Stale write";
        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(() => dbB.SaveChangesAsync());
    }

    [Fact]
    public async Task VideoAssets_RejectDuplicate_RecordingId_And_Kind_AtDatabaseLevel()
    {
        using var scope = _fixture.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

        var user = await db.Users.FirstAsync();
        var shop = await db.Shops.FirstAsync();
        var warehouse = await db.Warehouses.FirstAsync(w => w.ShopId == shop.Id);
        var storageProfile = await db.StorageProfiles.FirstAsync();

        var recording = new Recording
        {
            OwnerUserId = user.Id,
            ShopId = shop.Id,
            WarehouseId = warehouse.Id,
            TrackingNumber = "VN26999111222",
            SafeTrackingSegment = "VN26999111222",
            Source = RecordingSource.RecordedInBrowser,
            CaptureStatus = CaptureStatus.Captured,
            StorageStatus = StorageStatus.Stored,
            PreviewStatus = PreviewStatus.NotRequired
        };

        db.Recordings.Add(recording);
        await db.SaveChangesAsync();

        var firstOriginal = new VideoAsset
        {
            RecordingId = recording.Id,
            Kind = AssetKind.Original,
            StorageProfileId = storageProfile.Id,
            RelativePath = $"shop-a/2026/10/29/VN26999111222/VN26999111222_{recording.Id}.webm",
            MimeType = "video/webm",
            SizeBytes = 1_048_576,
            Sha256 = new string('a', 64),
            VerifiedAtUtc = DateTime.UtcNow
        };

        db.VideoAssets.Add(firstOriginal);
        await db.SaveChangesAsync();

        // Preview asset for the same RecordingId IS allowed
        var previewAsset = new VideoAsset
        {
            RecordingId = recording.Id,
            Kind = AssetKind.Preview,
            StorageProfileId = storageProfile.Id,
            RelativePath = $"shop-a/2026/10/29/VN26999111222/VN26999111222_{recording.Id}_preview.mp4",
            MimeType = "video/mp4",
            SizeBytes = 524_288,
            Sha256 = new string('b', 64),
            VerifiedAtUtc = DateTime.UtcNow
        };

        db.VideoAssets.Add(previewAsset);
        await db.SaveChangesAsync();

        // Second Original asset for the same RecordingId MUST be rejected by unique index UX_VideoAssets_RecordingId_Kind
        var duplicateOriginal = new VideoAsset
        {
            RecordingId = recording.Id,
            Kind = AssetKind.Original,
            StorageProfileId = storageProfile.Id,
            RelativePath = $"shop-a/2026/10/29/VN26999111222/VN26999111222_{recording.Id}_dup.webm",
            MimeType = "video/webm",
            SizeBytes = 1_048_576,
            Sha256 = new string('c', 64),
            VerifiedAtUtc = DateTime.UtcNow
        };

        db.VideoAssets.Add(duplicateOriginal);

        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        var pgEx = Assert.IsType<PostgresException>(ex.InnerException);
        Assert.Equal(PostgresErrorCodes.UniqueViolation, pgEx.SqlState);
    }
}

