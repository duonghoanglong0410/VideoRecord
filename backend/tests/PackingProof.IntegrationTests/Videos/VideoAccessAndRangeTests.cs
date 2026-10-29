using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PackingProof.Api.Common;
using PackingProof.Api.Features.Admin;
using PackingProof.Api.Features.Auth;
using PackingProof.Api.Features.Recordings;
using PackingProof.Api.Features.Shops;
using PackingProof.Api.Features.Uploads;
using PackingProof.Api.Features.Videos;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Core.Storage;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Storage;
using PackingProof.Infrastructure.Workers;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Videos;

public sealed class VideoAccessAndRangeTests
{
    [Fact]
    public async Task Stream_WithHttpRangeHeader_Returns206PartialContent_ExactBytes_AndPreservesLeadingZeroSearch()
    {
        var mp4Bytes = await MediaTestFixtureHelper.GetValidMp4BytesAsync();
        Assert.True(mp4Bytes.Length > 1500, "Sample MP4 fixture must be larger than 1500 bytes for range slice test.");

        var factory = new CustomStorageWebAppFactory(new Dictionary<string, string?>
        {
            ["ENABLE_BACKGROUND_WORKER"] = "false"
        });

        try
        {
            var (shopA, whA1) = await factory.EnsureShopAExistsAsync();

            using var superClient = factory.CreateSessionClient();
            await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

            using var opClient = await CreateApprovedUserClientAsync(
                factory,
                superClient,
                "op.range@packingproof.test",
                SystemRoles.Operator,
                ScopeType.Own,
                shopA.Id,
                whA1.Id);

            const string leadingZeroTracking = "0088991122";
            var rec = await CreateUploadAndStoreAsync(
                factory,
                opClient,
                shopA.Id,
                whA1.Id,
                leadingZeroTracking,
                mp4Bytes);

            // 1. Search with exact=true and exact=false preserves leading zeros and never leaks physical paths
            var exactListRes = await opClient.GetAsync($"/api/videos?trackingNumber={leadingZeroTracking}&exact=true");
            Assert.Equal(HttpStatusCode.OK, exactListRes.StatusCode);
            var exactListRaw = await exactListRes.Content.ReadAsStringAsync();
            Assert.DoesNotContain(factory.NasRootPath, exactListRaw, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("shop-a/", exactListRaw, StringComparison.OrdinalIgnoreCase);

            var exactList = (await exactListRes.Content.ReadFromJsonAsync<PagedVideosResponse>(CookieSessionClient.JsonOptions))!;
            Assert.Single(exactList.Items);
            Assert.Equal(leadingZeroTracking, exactList.Items[0].TrackingNumber);

            var strippedZeroRes = await opClient.GetAsync("/api/videos?trackingNumber=88991122&exact=true");
            var strippedZeroList = (await strippedZeroRes.Content.ReadFromJsonAsync<PagedVideosResponse>(CookieSessionClient.JsonOptions))!;
            Assert.Empty(strippedZeroList.Items);

            var partialZeroRes = await opClient.GetAsync("/api/videos?q=008899&exact=false");
            var partialZeroList = (await partialZeroRes.Content.ReadFromJsonAsync<PagedVideosResponse>(CookieSessionClient.JsonOptions))!;
            Assert.Single(partialZeroList.Items);
            Assert.Equal(leadingZeroTracking, partialZeroList.Items[0].TrackingNumber);

            // 2. HEAD /api/videos/{id}/stream advertises Accept-Ranges: bytes and full Content-Length
            using (var headReq = new HttpRequestMessage(HttpMethod.Head, $"/api/videos/{rec.Id}/stream"))
            {
                var headRes = await opClient.Http.SendAsync(headReq);
                Assert.Equal(HttpStatusCode.OK, headRes.StatusCode);
                Assert.Contains("bytes", headRes.Headers.AcceptRanges);
                Assert.Equal(mp4Bytes.Length, headRes.Content.Headers.ContentLength);
            }

            // 3. GET /api/videos/{id}/stream with Range: bytes=0-1023 -> 206 Partial Content + exact byte slice
            using var rangeReq = new HttpRequestMessage(HttpMethod.Get, $"/api/videos/{rec.Id}/stream");
            rangeReq.Headers.Range = new RangeHeaderValue(0, 1023);

            var rangeRes = await opClient.Http.SendAsync(rangeReq);
            Assert.Equal(HttpStatusCode.PartialContent, rangeRes.StatusCode);
            Assert.Contains("bytes", rangeRes.Headers.AcceptRanges);
            Assert.NotNull(rangeRes.Content.Headers.ContentRange);
            Assert.Equal(0, rangeRes.Content.Headers.ContentRange!.From);
            Assert.Equal(1023, rangeRes.Content.Headers.ContentRange.To);
            Assert.Equal(mp4Bytes.Length, rangeRes.Content.Headers.ContentRange.Length);
            Assert.Equal(true, rangeRes.Headers.CacheControl?.Private);
            Assert.Equal(true, rangeRes.Headers.CacheControl?.NoStore);

            var slice = await rangeRes.Content.ReadAsByteArrayAsync();
            Assert.Equal(1024, slice.Length);
            Assert.Equal(mp4Bytes[..1024], slice);
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    [Fact]
    public async Task CrossUserOwnScope_AndCrossWarehouseManager_AreDeniedOnDetailStreamRangeAndDownload()
    {
        var webmBytes = await MediaTestFixtureHelper.GetValidWebmBytesAsync();
        var factory = new CustomStorageWebAppFactory(new Dictionary<string, string?>
        {
            ["ENABLE_BACKGROUND_WORKER"] = "false"
        });

        try
        {
            var (shopA, whA1) = await factory.EnsureShopAExistsAsync();
            Warehouse whA2;
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
                whA2 = new Warehouse
                {
                    ShopId = shopA.Id,
                    Code = "WH-HCM-02",
                    Name = "Kho TP.HCM 02",
                    IsActive = true
                };
                db.Warehouses.Add(whA2);
                await db.SaveChangesAsync();
            }

            using var superClient = factory.CreateSessionClient();
            await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

            using var userAClient = await CreateApprovedUserClientAsync(
                factory,
                superClient,
                "user.a@packingproof.test",
                SystemRoles.Operator,
                ScopeType.Own,
                shopA.Id,
                whA1.Id);

            using var userBClient = await CreateApprovedUserClientAsync(
                factory,
                superClient,
                "user.b@packingproof.test",
                SystemRoles.Operator,
                ScopeType.Own,
                shopA.Id,
                whA2.Id);

            using var managerWh1Client = await CreateApprovedUserClientAsync(
                factory,
                superClient,
                "manager.wh1@packingproof.test",
                SystemRoles.Manager,
                ScopeType.Warehouse,
                shopA.Id,
                whA1.Id);

            var userBRecording = await CreateUploadAndStoreAsync(
                factory,
                userBClient,
                shopA.Id,
                whA2.Id,
                "0099110022",
                webmBytes);

            foreach (var unauthorizedClient in new[] { userAClient, managerWh1Client })
            {
                var listRes = await unauthorizedClient.GetAsync("/api/videos");
                Assert.Equal(HttpStatusCode.OK, listRes.StatusCode);
                var listPayload = (await listRes.Content.ReadFromJsonAsync<PagedVideosResponse>(CookieSessionClient.JsonOptions))!;
                Assert.DoesNotContain(listPayload.Items, v => v.Id == userBRecording.Id);

                var detailRes = await unauthorizedClient.GetAsync($"/api/videos/{userBRecording.Id}");
                Assert.Equal(HttpStatusCode.Forbidden, detailRes.StatusCode);

                using var rangeReq = new HttpRequestMessage(HttpMethod.Get, $"/api/videos/{userBRecording.Id}/stream");
                rangeReq.Headers.Range = new RangeHeaderValue(0, 255);
                var streamRes = await unauthorizedClient.Http.SendAsync(rangeReq);
                Assert.Equal(HttpStatusCode.Forbidden, streamRes.StatusCode);

                var downloadRes = await unauthorizedClient.GetAsync($"/api/videos/{userBRecording.Id}/download");
                Assert.Equal(HttpStatusCode.Forbidden, downloadRes.StatusCode);
            }
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    [Fact]
    public async Task Viewer_CanListAndStreamRange_ButGets403AndAuditOnDownloadNotesHoldAndDeletionRequests()
    {
        var mp4Bytes = await MediaTestFixtureHelper.GetValidMp4BytesAsync();
        var mp4Sha = MediaTestFixtureHelper.ComputeSha256Hex(mp4Bytes);

        var factory = new CustomStorageWebAppFactory(new Dictionary<string, string?>
        {
            ["ENABLE_BACKGROUND_WORKER"] = "false"
        });

        try
        {
            var (shopA, whA1) = await factory.EnsureShopAExistsAsync();

            using var superClient = factory.CreateSessionClient();
            await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

            using var opClient = await CreateApprovedUserClientAsync(
                factory,
                superClient,
                "op.viewer.test@packingproof.test",
                SystemRoles.Operator,
                ScopeType.Own,
                shopA.Id,
                whA1.Id);

            using var viewerClient = await CreateApprovedUserClientAsync(
                factory,
                superClient,
                "viewer.shopa@packingproof.test",
                SystemRoles.Viewer,
                ScopeType.Shop,
                shopA.Id,
                null);

            using var shopAdminClient = await CreateApprovedUserClientAsync(
                factory,
                superClient,
                "admin.download.shopa@packingproof.test",
                SystemRoles.Admin,
                ScopeType.Shop,
                shopA.Id,
                null);

            var rec = await CreateUploadAndStoreAsync(
                factory,
                opClient,
                shopA.Id,
                whA1.Id,
                "0033445566",
                mp4Bytes);

            // Viewer can list & view detail (effective flags report false for mutating/download actions)
            var detailRes = await viewerClient.GetAsync($"/api/videos/{rec.Id}");
            Assert.Equal(HttpStatusCode.OK, detailRes.StatusCode);
            var detail = (await detailRes.Content.ReadFromJsonAsync<VideoDetailDto>(CookieSessionClient.JsonOptions))!;
            Assert.False(detail.CanDownload);
            Assert.False(detail.CanNote);
            Assert.False(detail.CanHold);
            Assert.False(detail.CanRequestDelete);
            Assert.False(detail.CanApproveDelete);
            Assert.Equal(mp4Sha, detail.OriginalSha256);

            // Viewer can stream via HTTP Range
            using (var rangeReq = new HttpRequestMessage(HttpMethod.Get, $"/api/videos/{rec.Id}/stream"))
            {
                rangeReq.Headers.Range = new RangeHeaderValue(0, 511);
                var rangeRes = await viewerClient.Http.SendAsync(rangeReq);
                Assert.Equal(HttpStatusCode.PartialContent, rangeRes.StatusCode);
            }

            // Viewer calling /download, /notes, /hold, /deletion-requests directly MUST get 403 Forbidden
            var viewerDownloadRes = await viewerClient.GetAsync($"/api/videos/{rec.Id}/download");
            Assert.Equal(HttpStatusCode.Forbidden, viewerDownloadRes.StatusCode);

            var viewerNoteRes = await viewerClient.PostJsonAsync(
                $"/api/videos/{rec.Id}/notes",
                new CreateVideoNoteRequest("Thử ghi chú trái phép"));
            Assert.Equal(HttpStatusCode.Forbidden, viewerNoteRes.StatusCode);

            var viewerHoldRes = await viewerClient.PutJsonAsync(
                $"/api/videos/{rec.Id}/hold",
                new UpdateVideoHoldRequest(true, "Thử hold trái phép"));
            Assert.Equal(HttpStatusCode.Forbidden, viewerHoldRes.StatusCode);

            var viewerDeleteReqRes = await viewerClient.PostJsonAsync(
                $"/api/videos/{rec.Id}/deletion-requests",
                new CreateDeletionRequestPayload("Thử xóa trái phép"));
            Assert.Equal(HttpStatusCode.Forbidden, viewerDeleteReqRes.StatusCode);

            // Shop Admin (holds video.download) succeeds and gets original attachment
            var adminDownloadRes = await shopAdminClient.GetAsync($"/api/videos/{rec.Id}/download");
            Assert.Equal(HttpStatusCode.OK, adminDownloadRes.StatusCode);
            Assert.Equal("attachment", adminDownloadRes.Content.Headers.ContentDisposition?.DispositionType);
            var downloadedBytes = await adminDownloadRes.Content.ReadAsByteArrayAsync();
            Assert.Equal(mp4Sha, MediaTestFixtureHelper.ComputeSha256Hex(downloadedBytes));

            // Verify both Denied and Success video.download AuditEvents exist
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
            var entityId = rec.Id.ToString();

            Assert.True(await db.AuditEvents.AnyAsync(a =>
                a.Action == "video.download" &&
                a.EntityId == entityId &&
                a.Outcome == AuditOutcome.Denied));

            Assert.True(await db.AuditEvents.AnyAsync(a =>
                a.Action == "video.download" &&
                a.EntityId == entityId &&
                a.Outcome == AuditOutcome.Success));
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    [Fact]
    public async Task WhenSynologyMarkerBecomesUnavailableAfterStored_StreamAndDownloadReturn503_WithoutStagingFallback()
    {
        var webmBytes = await MediaTestFixtureHelper.GetValidWebmBytesAsync();
        var tempRoot = Path.Combine(Path.GetTempPath(), $"packingproof_stream503_it_{Guid.NewGuid():N}");
        var synologyShare = Path.Combine(tempRoot, "synology-share");
        const string storageId = "synology-share-marker-42";

        Directory.CreateDirectory(synologyShare);
        var markerPath = Path.Combine(synologyShare, FileSystemVideoStorage.StorageMarkerFileName);
        await File.WriteAllTextAsync(markerPath, storageId, Encoding.UTF8);

        var factory = new CustomStorageWebAppFactory(
            new Dictionary<string, string?>
            {
                ["STORAGE_MODE"] = "SynologyMounted",
                ["NAS_ROOT_PATH"] = synologyShare,
                ["STORAGE_ID"] = storageId,
                ["ENABLE_BACKGROUND_WORKER"] = "false"
            },
            existingTempRootPath: tempRoot);

        try
        {
            var (shopA, whA1) = await factory.EnsureShopAExistsAsync();

            using var superClient = factory.CreateSessionClient();
            await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

            using var adminClient = await CreateApprovedUserClientAsync(
                factory,
                superClient,
                "admin.nas503@packingproof.test",
                SystemRoles.Admin,
                ScopeType.Shop,
                shopA.Id,
                null);

            var rec = await CreateUploadAndStoreAsync(
                factory,
                adminClient,
                shopA.Id,
                whA1.Id,
                "0011223344",
                webmBytes);

            // Plant an unverified decoy file in staging to prove stream/download NEVER fall back to staging
            Directory.CreateDirectory(factory.StagingRootPath);
            await File.WriteAllBytesAsync(
                Path.Combine(factory.StagingRootPath, $"{rec.Id:N}.webm"),
                webmBytes);

            // Simulate NAS share unmounting / marker disappearing after Stored
            File.Delete(markerPath);

            var streamRes = await adminClient.GetAsync($"/api/videos/{rec.Id}/stream");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, streamRes.StatusCode);
            var streamErr = (await streamRes.Content.ReadFromJsonAsync<ApiErrorResponse>(CookieSessionClient.JsonOptions))!;
            Assert.Equal("STORAGE_FILE_UNAVAILABLE", streamErr.ErrorCode);

            var downloadRes = await adminClient.GetAsync($"/api/videos/{rec.Id}/download");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, downloadRes.StatusCode);
            var downloadErr = (await downloadRes.Content.ReadFromJsonAsync<ApiErrorResponse>(CookieSessionClient.JsonOptions))!;
            Assert.Equal("STORAGE_FILE_UNAVAILABLE", downloadErr.ErrorCode);
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    [Fact]
    public async Task HoldProtection_BlocksDeleteRequestAndApproveWith409_AndProtectsHeldVideoDuringRetentionSweep()
    {
        var webmBytes = await MediaTestFixtureHelper.GetValidWebmBytesAsync();
        var factory = new CustomStorageWebAppFactory(new Dictionary<string, string?>
        {
            ["ENABLE_BACKGROUND_WORKER"] = "false"
        });

        try
        {
            var (shopA, whA1) = await factory.EnsureShopAExistsAsync();

            using var superClient = factory.CreateSessionClient();
            await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

            using var adminClient = await CreateApprovedUserClientAsync(
                factory,
                superClient,
                "admin.hold@packingproof.test",
                SystemRoles.Admin,
                ScopeType.Shop,
                shopA.Id,
                null);

            var heldRec = await CreateUploadAndStoreAsync(
                factory,
                adminClient,
                shopA.Id,
                whA1.Id,
                "0066778899",
                webmBytes);

            var normalExpiredRec = await CreateUploadAndStoreAsync(
                factory,
                adminClient,
                shopA.Id,
                whA1.Id,
                "0066778800",
                webmBytes);

            // 1. Place heldRec on Hold -> POST /deletion-requests MUST fail with 409 VIDEO_ON_HOLD
            var setHoldRes = await adminClient.PutJsonAsync(
                $"/api/videos/{heldRec.Id}/hold",
                new UpdateVideoHoldRequest(true, "Đơn hàng đang tranh chấp thiếu phụ kiện"));
            Assert.Equal(HttpStatusCode.OK, setHoldRes.StatusCode);

            var blockedReqRes = await adminClient.PostJsonAsync(
                $"/api/videos/{heldRec.Id}/deletion-requests",
                new CreateDeletionRequestPayload("Muốn xóa nhầm video đang tranh chấp"));
            Assert.Equal(HttpStatusCode.Conflict, blockedReqRes.StatusCode);
            var blockedErr = (await blockedReqRes.Content.ReadFromJsonAsync<ApiErrorResponse>(CookieSessionClient.JsonOptions))!;
            Assert.Equal("VIDEO_ON_HOLD", blockedErr.ErrorCode);

            // 2. Unhold temporarily, create pending deletion request, then re-enable Hold -> approve MUST fail with 409 VIDEO_ON_HOLD
            var unholdRes = await adminClient.PutJsonAsync(
                $"/api/videos/{heldRec.Id}/hold",
                new UpdateVideoHoldRequest(false));
            Assert.Equal(HttpStatusCode.OK, unholdRes.StatusCode);

            var createDelReqRes = await adminClient.PostJsonAsync(
                $"/api/videos/{heldRec.Id}/deletion-requests",
                new CreateDeletionRequestPayload("Đề xuất dọn video test"));
            Assert.Equal(HttpStatusCode.Created, createDelReqRes.StatusCode);
            var pendingReq = (await createDelReqRes.Content.ReadFromJsonAsync<VideoDeletionRequestSummaryDto>(CookieSessionClient.JsonOptions))!;

            var reHoldRes = await adminClient.PutJsonAsync(
                $"/api/videos/{heldRec.Id}/hold",
                new UpdateVideoHoldRequest(true, "Khách mở lại khiếu nại trên sàn"));
            Assert.Equal(HttpStatusCode.OK, reHoldRes.StatusCode);

            var blockedApproveRes = await adminClient.PostJsonAsync(
                $"/api/deletion-requests/{pendingReq.Id}/approve",
                new ReviewDeletionRequestPayload("Thử duyệt xóa khi đang Hold"));
            Assert.Equal(HttpStatusCode.Conflict, blockedApproveRes.StatusCode);
            var approveErr = (await blockedApproveRes.Content.ReadFromJsonAsync<ApiErrorResponse>(CookieSessionClient.JsonOptions))!;
            Assert.Equal("VIDEO_ON_HOLD", approveErr.ErrorCode);

            // 3. Backdate both videos past 90-day retention window
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
                var oldTimestamp = DateTime.UtcNow.AddDays(-120);

                var dbHeld = await db.Recordings.SingleAsync(r => r.Id == heldRec.Id);
                dbHeld.CreatedAtUtc = oldTimestamp;
                dbHeld.StoredAtUtc = oldTimestamp;

                var dbNormal = await db.Recordings.SingleAsync(r => r.Id == normalExpiredRec.Id);
                dbNormal.CreatedAtUtc = oldTimestamp;
                dbNormal.StoredAtUtc = oldTimestamp;

                await db.SaveChangesAsync();
            }

            var retentionProcessor = factory.Services.GetRequiredService<RetentionCleanupProcessor>();

            // When RetentionEnabled == false (default), sweep does nothing
            var disabledSweep = await retentionProcessor.RunSweepOnceAsync();
            Assert.False(disabledSweep.RetentionEnabled);
            Assert.Equal(0, disabledSweep.EvaluatedCount);

            // Turn on retention with explicit confirmation via SuperAdmin
            var enableRetentionRes = await superClient.PutJsonAsync(
                "/api/admin/storage",
                new UpdateAdminStorageRequest(
                    MaxRecordingSeconds: 600,
                    MaxUploadBytes: 536_870_912,
                    MaxLocalPendingRecordings: 3,
                    EnableAudioRecording: false,
                    RetentionEnabled: true,
                    RetentionDays: 90,
                    ConfirmRetentionEnable: true));
            Assert.Equal(HttpStatusCode.OK, enableRetentionRes.StatusCode);

            var activeSweep = await retentionProcessor.RunSweepOnceAsync();
            Assert.True(activeSweep.RetentionEnabled);
            Assert.Equal(1, activeSweep.SkippedHoldCount);
            Assert.Equal(1, activeSweep.DeletedCount);

            using (var verifyScope = factory.Services.CreateScope())
            {
                var db = verifyScope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
                var storage = verifyScope.ServiceProvider.GetRequiredService<IVideoStorage>();

                var dbHeldAfter = await db.Recordings
                    .Include(r => r.VideoAssets)
                    .SingleAsync(r => r.Id == heldRec.Id);
                Assert.False(dbHeldAfter.IsSoftDeleted);
                Assert.Null(dbHeldAfter.PhysicalDeletedAtUtc);

                // Held physical file is still intact and readable
                await using (var s = await storage.OpenReadAsync(dbHeldAfter.VideoAssets.Single().RelativePath))
                {
                    Assert.True(s.Length > 0);
                }

                var dbNormalAfter = await db.Recordings
                    .Include(r => r.VideoAssets)
                    .SingleAsync(r => r.Id == normalExpiredRec.Id);
                Assert.True(dbNormalAfter.IsSoftDeleted);
                Assert.NotNull(dbNormalAfter.PhysicalDeletedAtUtc);

                // Normal expired physical file was deleted
                await Assert.ThrowsAsync<StorageUnavailableException>(() =>
                    storage.OpenReadAsync(dbNormalAfter.VideoAssets.Single().RelativePath));

                var heldIdStr = heldRec.Id.ToString();
                var normalIdStr = normalExpiredRec.Id.ToString();

                Assert.True(await db.AuditEvents.AnyAsync(a =>
                    a.Action == "video.delete_request_blocked_hold" &&
                    a.EntityId == heldIdStr &&
                    a.Outcome == AuditOutcome.Denied));

                Assert.True(await db.AuditEvents.AnyAsync(a =>
                    a.Action == "retention.skipped_hold" &&
                    a.EntityId == heldIdStr &&
                    a.Outcome == AuditOutcome.Success));

                Assert.True(await db.AuditEvents.AnyAsync(a =>
                    a.Action == "retention.deleted" &&
                    a.EntityId == normalIdStr &&
                    a.Outcome == AuditOutcome.Success));
            }
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    [Fact]
    public async Task VideoImport_IsDenied403WithoutPermission_AndTagsSourceImportedThroughTusPipelineWhenGranted()
    {
        var mp4Bytes = await MediaTestFixtureHelper.GetValidMp4BytesAsync();
        var factory = new CustomStorageWebAppFactory(new Dictionary<string, string?>
        {
            ["ENABLE_BACKGROUND_WORKER"] = "false"
        });

        try
        {
            var (shopA, whA1) = await factory.EnsureShopAExistsAsync();

            using var superClient = factory.CreateSessionClient();
            await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

            // 1. Default Operator (video.import OFF by default) -> 403 Forbidden
            using var defaultOpClient = await CreateApprovedUserClientAsync(
                factory,
                superClient,
                "op.noimport@packingproof.test",
                SystemRoles.Operator,
                ScopeType.Own,
                shopA.Id,
                whA1.Id);

            var deniedImportRes = await defaultOpClient.PostJsonAsync(
                "/api/videos/import",
                new CreateVideoImportRequest(
                    ShopId: shopA.Id,
                    WarehouseId: whA1.Id,
                    RawCode: "0044556677",
                    ExpectedBytes: mp4Bytes.Length));
            Assert.Equal(HttpStatusCode.Forbidden, deniedImportRes.StatusCode);

            // 2. Custom role explicitly granting video.import + video.view (even WITHOUT video.upload!)
            var createRoleRes = await superClient.PostJsonAsync(
                "/api/admin/roles",
                new UpsertCustomRoleRequest(
                    Name: "ImportSpecialist",
                    Description: "Cho phép nhập tệp video có sẵn sau khi quét mã",
                    Permissions: [PermissionCatalog.VideoImport, PermissionCatalog.VideoView]));
            Assert.Equal(HttpStatusCode.Created, createRoleRes.StatusCode);
            var importRole = (await createRoleRes.Content.ReadFromJsonAsync<RoleDto>(CookieSessionClient.JsonOptions))!;

            using var importClient = await CreateApprovedUserWithRoleIdClientAsync(
                factory,
                superClient,
                "importer@packingproof.test",
                importRole.Id,
                ScopeType.Warehouse,
                shopA.Id,
                whA1.Id);

            var importCreateRes = await importClient.PostJsonAsync(
                "/api/videos/import",
                new CreateVideoImportRequest(
                    ShopId: shopA.Id,
                    WarehouseId: whA1.Id,
                    RawCode: "0044556677",
                    ClientMimeType: "video/mp4",
                    ExpectedBytes: mp4Bytes.Length));
            Assert.Equal(HttpStatusCode.Created, importCreateRes.StatusCode);

            var importCreated = (await importCreateRes.Content.ReadFromJsonAsync<CreateVideoImportResponse>(CookieSessionClient.JsonOptions))!;
            Assert.Equal(RecordingSource.Imported, importCreated.Recording.Source);
            Assert.Equal(CaptureStatus.Captured, importCreated.Recording.CaptureStatus);
            Assert.Equal(StorageStatus.AwaitingUpload, importCreated.Recording.StorageStatus);
            Assert.NotNull(importCreated.UploadSession);

            // Complete upload through tus + ffprobe + IVideoStorage worker
            var tusCreateRes = await MediaTestFixtureHelper.TusCreateAsync(
                importClient,
                mp4Bytes.Length,
                new Dictionary<string, string>
                {
                    ["recordingId"] = importCreated.Recording.Id.ToString(),
                    ["uploadSessionId"] = importCreated.UploadSession!.UploadSessionId.ToString()
                });
            Assert.Equal(HttpStatusCode.Created, tusCreateRes.StatusCode);
            var tusUrl = tusCreateRes.Headers.Location!.ToString();

            var patchRes = await MediaTestFixtureHelper.TusPatchAsync(importClient, tusUrl, 0, mp4Bytes);
            Assert.Equal(HttpStatusCode.NoContent, patchRes.StatusCode);

            var processor = factory.Services.GetRequiredService<ProcessingJobProcessor>();
            Assert.True(await processor.TryClaimAndProcessNextAsync("import-worker"));

            var detailRes = await importClient.GetAsync($"/api/videos/{importCreated.Recording.Id}");
            Assert.Equal(HttpStatusCode.OK, detailRes.StatusCode);
            var detail = (await detailRes.Content.ReadFromJsonAsync<VideoDetailDto>(CookieSessionClient.JsonOptions))!;
            Assert.Equal(RecordingSource.Imported, detail.Source);
            Assert.Equal(StorageStatus.Stored, detail.StorageStatus);
            Assert.Equal("0044556677", detail.TrackingNumber);
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    private static async Task<CookieSessionClient> CreateApprovedUserClientAsync(
        CustomStorageWebAppFactory factory,
        CookieSessionClient superClient,
        string email,
        string roleName,
        ScopeType scopeType,
        Guid shopId,
        Guid? warehouseId)
    {
        var rolesRes = await superClient.GetAsync("/api/admin/roles");
        rolesRes.EnsureSuccessStatusCode();
        var roles = (await rolesRes.Content.ReadFromJsonAsync<List<RoleDto>>(CookieSessionClient.JsonOptions))!;
        var role = roles.Single(r => r.Name == roleName);

        return await CreateApprovedUserWithRoleIdClientAsync(
            factory,
            superClient,
            email,
            role.Id,
            scopeType,
            shopId,
            warehouseId);
    }

    private static async Task<CookieSessionClient> CreateApprovedUserWithRoleIdClientAsync(
        CustomStorageWebAppFactory factory,
        CookieSessionClient superClient,
        string email,
        Guid roleId,
        ScopeType scopeType,
        Guid shopId,
        Guid? warehouseId)
    {
        const string password = "TestUserPass123!";
        using (var regClient = factory.CreateSessionClient())
        {
            var regRes = await regClient.PostJsonAsync("/api/auth/register", new
            {
                name = email,
                email,
                password,
                confirmPassword = password
            });
            regRes.EnsureSuccessStatusCode();
            var me = (await regRes.Content.ReadFromJsonAsync<AuthMeResponse>(CookieSessionClient.JsonOptions))!;

            var approveRes = await superClient.PostJsonAsync(
                $"/api/admin/users/{me.Id}/approve",
                new ApproveUserRequest(
                    Grants: [new GrantProposalDto(roleId, scopeType, shopId, warehouseId)],
                    DefaultShopId: shopId,
                    DefaultWarehouseId: warehouseId));
            approveRes.EnsureSuccessStatusCode();
        }

        var client = factory.CreateSessionClient();
        await client.LoginAsync(email, password);
        return client;
    }

    private static async Task<RecordingDto> CreateUploadAndStoreAsync(
        CustomStorageWebAppFactory factory,
        CookieSessionClient client,
        Guid shopId,
        Guid warehouseId,
        string trackingNumber,
        byte[] mediaBytes)
    {
        var createRes = await client.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopId, warehouseId, trackingNumber));
        createRes.EnsureSuccessStatusCode();
        var created = (await createRes.Content.ReadFromJsonAsync<CreateRecordingResponse>(CookieSessionClient.JsonOptions))!;
        var recordingId = created.Recording.Id;

        var startRes = await client.PostJsonAsync(
            $"/api/recordings/{recordingId}/events",
            new RecordingEventRequest("started"));
        startRes.EnsureSuccessStatusCode();

        var capturedRes = await client.PostJsonAsync(
            $"/api/recordings/{recordingId}/events",
            new RecordingEventRequest("captured", DurationSeconds: 1.2));
        capturedRes.EnsureSuccessStatusCode();

        var sessionRes = await client.PostJsonAsync(
            $"/api/recordings/{recordingId}/upload-session",
            new CreateUploadSessionRequest(
                ExpectedBytes: mediaBytes.Length,
                ClientSha256: MediaTestFixtureHelper.ComputeSha256Hex(mediaBytes)));
        sessionRes.EnsureSuccessStatusCode();
        var uploadSession = (await sessionRes.Content.ReadFromJsonAsync<UploadSessionDto>(CookieSessionClient.JsonOptions))!;

        var tusCreateRes = await MediaTestFixtureHelper.TusCreateAsync(
            client,
            mediaBytes.Length,
            new Dictionary<string, string>
            {
                ["recordingId"] = recordingId.ToString(),
                ["uploadSessionId"] = uploadSession.UploadSessionId.ToString()
            });
        Assert.Equal(HttpStatusCode.Created, tusCreateRes.StatusCode);
        var tusUrl = tusCreateRes.Headers.Location!.ToString();

        var patchRes = await MediaTestFixtureHelper.TusPatchAsync(client, tusUrl, 0, mediaBytes);
        Assert.Equal(HttpStatusCode.NoContent, patchRes.StatusCode);

        var processor = factory.Services.GetRequiredService<ProcessingJobProcessor>();
        var processed = await processor.TryClaimAndProcessNextAsync("test-worker");
        Assert.True(processed);

        var finalRes = await client.GetAsync($"/api/recordings/{recordingId}");
        finalRes.EnsureSuccessStatusCode();
        var finalDto = (await finalRes.Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
        Assert.Equal(StorageStatus.Stored, finalDto.StorageStatus);

        return finalDto;
    }
}
