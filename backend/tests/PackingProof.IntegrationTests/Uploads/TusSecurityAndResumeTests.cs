using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PackingProof.Api.Common;
using PackingProof.Api.Features.Admin;
using PackingProof.Api.Features.Auth;
using PackingProof.Api.Features.Recordings;
using PackingProof.Api.Features.Shops;
using PackingProof.Api.Features.Uploads;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Storage;
using PackingProof.Infrastructure.Uploads;
using PackingProof.Infrastructure.Workers;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Uploads;

public sealed class TusSecurityAndResumeTests : IClassFixture<PostgresWebAppFixture>
{
    private readonly PostgresWebAppFixture _fixture;

    public TusSecurityAndResumeTests(PostgresWebAppFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task TusResumableUpload_EndToEndWithRealWebmAndMp4_ResumesViaHead_IgnoresFakeMetadata_ValidatesViaFfprobe_AndRemainsIdempotent()
    {
        var webmBytes = await MediaTestFixtureHelper.GetValidWebmBytesAsync();
        var webmSha256 = MediaTestFixtureHelper.ComputeSha256Hex(webmBytes);

        var mp4Bytes = await MediaTestFixtureHelper.GetValidMp4BytesAsync();
        var mp4Sha256 = MediaTestFixtureHelper.ComputeSha256Hex(mp4Bytes);

        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var (roles, shopA) = await GetRolesAndShopAAsync(superClient);
        var whA1 = shopA.Warehouses.Single();
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);

        await RegisterAndApproveAsync(
            superClient,
            "op.tus.e2e@packingproof.test",
            "OpPass123!",
            [new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopA.Id, whA1.Id)]);

        using var opClient = _fixture.CreateSessionClient();
        await opClient.LoginAsync("op.tus.e2e@packingproof.test", "OpPass123!");

        // 1. Create and finalize a WebM recording
        var recWebm = await CreateAndCaptureRecordingAsync(opClient, shopA.Id, whA1.Id, "003344556677", "video/webm;codecs=vp8");

        // Force StartedAtUtc to 2026-05-10 18:30:00 UTC -> which MUST map to 2026/05/11 in Asia/Ho_Chi_Minh (UTC+7)!
        var fixedStartedUtc = new DateTime(2026, 5, 10, 18, 30, 0, DateTimeKind.Utc);
        using (var prepScope = _fixture.Services.CreateScope())
        {
            var prepDb = prepScope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
            var entity = await prepDb.Recordings.FirstAsync(r => r.Id == recWebm.Id);
            entity.StartedAtUtc = fixedStartedUtc;
            await prepDb.SaveChangesAsync();
        }

        // 2. Idempotent POST /api/recordings/{id}/upload-session
        var sessionRes1 = await opClient.PostJsonAsync(
            $"/api/recordings/{recWebm.Id}/upload-session",
            new CreateUploadSessionRequest(webmBytes.Length, webmSha256));
        Assert.Equal(HttpStatusCode.OK, sessionRes1.StatusCode);
        var session1 = (await sessionRes1.Content.ReadFromJsonAsync<UploadSessionDto>(CookieSessionClient.JsonOptions))!;
        Assert.Null(session1.TusUploadUrl);
        Assert.Equal(webmBytes.Length, session1.ExpectedBytes);

        var sessionRes2 = await opClient.PostJsonAsync(
            $"/api/recordings/{recWebm.Id}/upload-session",
            new CreateUploadSessionRequest(webmBytes.Length, webmSha256));
        Assert.Equal(HttpStatusCode.OK, sessionRes2.StatusCode);
        var session2 = (await sessionRes2.Content.ReadFromJsonAsync<UploadSessionDto>(CookieSessionClient.JsonOptions))!;
        Assert.Equal(session1.UploadSessionId, session2.UploadSessionId);

        // 3. Tus POST /api/uploads with untrusted/spoofed owner, shop, path, and fake .mp4 filename metadata
        var tusCreateRes = await MediaTestFixtureHelper.TusCreateAsync(
            opClient,
            webmBytes.Length,
            new Dictionary<string, string>
            {
                ["recordingId"] = recWebm.Id.ToString(),
                ["uploadSessionId"] = session1.UploadSessionId.ToString(),
                ["ownerUserId"] = Guid.NewGuid().ToString(),
                ["shopId"] = Guid.NewGuid().ToString(),
                ["relativePath"] = "../../pwned-folder/evil.mp4",
                ["filename"] = "spoofed_client_extension.mp4"
            });
        Assert.Equal(HttpStatusCode.Created, tusCreateRes.StatusCode);
        var tusLocation = tusCreateRes.Headers.Location?.ToString();
        Assert.False(string.IsNullOrWhiteSpace(tusLocation));
        var tusPath = tusLocation!.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? new Uri(tusLocation).PathAndQuery
            : tusLocation;

        // 4. Upload first 40% chunk via PATCH, then simulate network drop & resume via HEAD
        var splitIndex = Math.Max(1, (int)(webmBytes.Length * 0.4));
        var firstPart = webmBytes[..splitIndex];
        var secondPart = webmBytes[splitIndex..];

        var patch1Res = await MediaTestFixtureHelper.TusPatchAsync(opClient, tusPath, 0, firstPart);
        Assert.Equal(HttpStatusCode.NoContent, patch1Res.StatusCode);
        Assert.Equal(firstPart.Length, MediaTestFixtureHelper.GetUploadOffsetHeader(patch1Res));

        // Verify upload-session endpoint also reflects the partial tus URL & live offset
        var midSessionRes = await opClient.PostJsonAsync(
            $"/api/recordings/{recWebm.Id}/upload-session",
            new CreateUploadSessionRequest(webmBytes.Length));
        var midSession = (await midSessionRes.Content.ReadFromJsonAsync<UploadSessionDto>(CookieSessionClient.JsonOptions))!;
        Assert.Equal(tusPath, midSession.TusUploadUrl);
        Assert.Equal(firstPart.Length, midSession.ReceivedBytes);

        // Tus HEAD returns exact server offset
        var headRes = await MediaTestFixtureHelper.TusHeadAsync(opClient, tusPath);
        Assert.Equal(HttpStatusCode.OK, headRes.StatusCode);
        var resumedOffset = MediaTestFixtureHelper.GetUploadOffsetHeader(headRes);
        Assert.Equal(firstPart.Length, resumedOffset);

        // 5. Resume remaining 60% via PATCH from server offset
        var patch2Res = await MediaTestFixtureHelper.TusPatchAsync(opClient, tusPath, resumedOffset, secondPart);
        Assert.Equal(HttpStatusCode.NoContent, patch2Res.StatusCode);
        Assert.Equal(webmBytes.Length, MediaTestFixtureHelper.GetUploadOffsetHeader(patch2Res));

        // Wait for background ProcessingJobWorker to validate via real ffprobe and commit to storage
        var storedWebmDto = await WaitForRecordingTerminalStorageAsync(opClient, recWebm.Id);
        Assert.Equal(StorageStatus.Stored, storedWebmDto.StorageStatus);
        Assert.Contains(
            storedWebmDto.PreviewStatus,
            new[] { PreviewStatus.Pending, PreviewStatus.Processing, PreviewStatus.Ready });
        Assert.Equal("webm", storedWebmDto.ActualContainer);
        Assert.Equal(StorageMode.LocalDevelopment, storedWebmDto.StorageMode);
        Assert.NotNull(storedWebmDto.StoredAtUtc);
        Assert.NotNull(storedWebmDto.ServerReceivedAtUtc);

        // 6. Verify Asia/Ho_Chi_Minh folder structure, ffprobe-verified .webm extension (NOT spoofed .mp4!), SHA-256, and staging cleanup
        using (var verifyScope = _fixture.Services.CreateScope())
        {
            var db = verifyScope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
            var options = verifyScope.ServiceProvider.GetRequiredService<PackingProofOptions>();
            var coordinator = verifyScope.ServiceProvider.GetRequiredService<RecordingUploadCoordinator>();
            var processor = verifyScope.ServiceProvider.GetRequiredService<ProcessingJobProcessor>();

            var expectedRelativePath =
                $"shop-a/2026/05/11/003344556677/003344556677_{recWebm.Id:D}.webm";

            var asset = await db.VideoAssets
                .AsNoTracking()
                .SingleAsync(v => v.RecordingId == recWebm.Id && v.Kind == AssetKind.Original);

            Assert.Equal(expectedRelativePath, asset.RelativePath);
            Assert.Equal(webmBytes.Length, asset.SizeBytes);
            Assert.Equal(webmSha256, asset.Sha256);
            Assert.Equal("video/webm", asset.MimeType);

            var physicalStoredPath = Path.Combine(
                Path.GetFullPath(options.NasRootPath),
                expectedRelativePath.Replace('/', Path.DirectorySeparatorChar));
            Assert.True(File.Exists(physicalStoredPath));
            var (_, diskSha256) = await FileSystemVideoStorage.ComputeFileSizeAndSha256Async(physicalStoredPath);
            Assert.Equal(webmSha256, diskSha256);

            // Verify staging tus file & metadata sidecars were cleaned up after Stored
            var tusFileId = tusPath.Split('/').Last();
            var stagingRoot = Path.GetFullPath(options.StagingRootPath);
            Assert.Empty(Directory.GetFiles(stagingRoot, $"{tusFileId}*"));

            // Verify duplicate OnFileComplete callback + worker drain remain 100% idempotent
            await coordinator.HandleTusFileCompletedAsync(tusFileId, webmBytes.Length);
            await processor.DrainAvailableJobsAsync("test-idempotent-worker");

            var jobsCount = await db.ProcessingJobs.CountAsync(j =>
                j.RecordingId == recWebm.Id &&
                j.JobType == ProcessingJobType.ValidateAndStoreOriginal);
            var assetsCount = await db.VideoAssets.CountAsync(v =>
                v.RecordingId == recWebm.Id &&
                v.Kind == AssetKind.Original);

            Assert.Equal(1, jobsCount);
            Assert.Equal(1, assetsCount);

            var storedAudit = await db.AuditEvents
                .AsNoTracking()
                .FirstOrDefaultAsync(a =>
                    a.Action == "video.stored" &&
                    a.EntityId == recWebm.Id.ToString() &&
                    a.Outcome == AuditOutcome.Success);
            Assert.NotNull(storedAudit);
        }

        // 7. Also verify H.264 MP4 upload sets PreviewStatus = NotRequired
        var recMp4 = await CreateAndCaptureRecordingAsync(opClient, shopA.Id, whA1.Id, "008899001122", "video/mp4");
        var mp4Session = (await (await opClient.PostJsonAsync(
            $"/api/recordings/{recMp4.Id}/upload-session",
            new CreateUploadSessionRequest(mp4Bytes.Length, mp4Sha256)))
            .Content.ReadFromJsonAsync<UploadSessionDto>(CookieSessionClient.JsonOptions))!;

        var mp4Create = await MediaTestFixtureHelper.TusCreateAsync(
            opClient,
            mp4Bytes.Length,
            new Dictionary<string, string>
            {
                ["recordingId"] = recMp4.Id.ToString(),
                ["uploadSessionId"] = mp4Session.UploadSessionId.ToString()
            });
        Assert.Equal(HttpStatusCode.Created, mp4Create.StatusCode);
        var mp4TusUrl = mp4Create.Headers.Location!.ToString();
        var mp4TusPath = mp4TusUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? new Uri(mp4TusUrl).PathAndQuery
            : mp4TusUrl;

        var mp4Patch = await MediaTestFixtureHelper.TusPatchAsync(opClient, mp4TusPath, 0, mp4Bytes);
        Assert.Equal(HttpStatusCode.NoContent, mp4Patch.StatusCode);

        var storedMp4Dto = await WaitForRecordingTerminalStorageAsync(opClient, recMp4.Id);
        Assert.Equal(StorageStatus.Stored, storedMp4Dto.StorageStatus);
        Assert.Equal(PreviewStatus.NotRequired, storedMp4Dto.PreviewStatus);
        Assert.Equal("mp4", storedMp4Dto.ActualContainer);
        Assert.Equal("h264", storedMp4Dto.VideoCodec);
    }

    [Fact]
    public async Task TusEndpoints_EnforceCrossUserIsolation_ViewerRoleDenial_CsrfValidation_AndLifecycleChecks()
    {
        var webmBytes = await MediaTestFixtureHelper.GetValidWebmBytesAsync();

        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var (roles, shopA) = await GetRolesAndShopAAsync(superClient);
        var whA1 = shopA.Warehouses.Single();
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);
        var viewerRole = roles.Single(r => r.Name == SystemRoles.Viewer);

        await RegisterAndApproveAsync(
            superClient,
            "user.a.tus@packingproof.test",
            "UserAPass123!",
            [new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopA.Id, whA1.Id)]);

        await RegisterAndApproveAsync(
            superClient,
            "user.b.tus@packingproof.test",
            "UserBPass123!",
            [new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopA.Id, whA1.Id)]);

        await RegisterAndApproveAsync(
            superClient,
            "viewer.tus@packingproof.test",
            "ViewerPass123!",
            [new GrantProposalDto(viewerRole.Id, ScopeType.Shop, shopA.Id, null)]);

        using var userAClient = _fixture.CreateSessionClient();
        await userAClient.LoginAsync("user.a.tus@packingproof.test", "UserAPass123!");

        using var userBClient = _fixture.CreateSessionClient();
        await userBClient.LoginAsync("user.b.tus@packingproof.test", "UserBPass123!");

        using var viewerClient = _fixture.CreateSessionClient();
        await viewerClient.LoginAsync("viewer.tus@packingproof.test", "ViewerPass123!");

        // 1. Lifecycle checks: Created and Cancelled recordings MUST reject upload-session with 409 Conflict
        var createdOnlyRes = await userAClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopA.Id, whA1.Id, "004411223344"));
        var createdOnlyRec = (await createdOnlyRes.Content.ReadFromJsonAsync<CreateRecordingResponse>(CookieSessionClient.JsonOptions))!.Recording;

        var prematureUploadSession = await userAClient.PostJsonAsync(
            $"/api/recordings/{createdOnlyRec.Id}/upload-session",
            new CreateUploadSessionRequest(webmBytes.Length));
        Assert.Equal(HttpStatusCode.Conflict, prematureUploadSession.StatusCode);

        await userAClient.PostJsonAsync(
            $"/api/recordings/{createdOnlyRec.Id}/events",
            new RecordingEventRequest("cancelled", Reason: "Quét nhầm đơn"));

        var cancelledUploadSession = await userAClient.PostJsonAsync(
            $"/api/recordings/{createdOnlyRec.Id}/upload-session",
            new CreateUploadSessionRequest(webmBytes.Length));
        Assert.Equal(HttpStatusCode.Conflict, cancelledUploadSession.StatusCode);

        // 2. Valid Captured recording owned by User A
        var userARec = await CreateAndCaptureRecordingAsync(userAClient, shopA.Id, whA1.Id, "004455667788", "video/webm");

        // Viewer and User B cannot create an upload-session for User A's recording -> 403 Forbidden
        var viewerSessionAttempt = await viewerClient.PostJsonAsync(
            $"/api/recordings/{userARec.Id}/upload-session",
            new CreateUploadSessionRequest(webmBytes.Length));
        Assert.Equal(HttpStatusCode.Forbidden, viewerSessionAttempt.StatusCode);

        var userBSessionAttempt = await userBClient.PostJsonAsync(
            $"/api/recordings/{userARec.Id}/upload-session",
            new CreateUploadSessionRequest(webmBytes.Length));
        Assert.Equal(HttpStatusCode.Forbidden, userBSessionAttempt.StatusCode);

        // Viewer calling tus POST /api/uploads directly gets 403 Forbidden
        var viewerTusPost = await MediaTestFixtureHelper.TusCreateAsync(
            viewerClient,
            webmBytes.Length,
            new Dictionary<string, string>
            {
                ["recordingId"] = userARec.Id.ToString(),
                ["uploadSessionId"] = Guid.NewGuid().ToString()
            });
        Assert.Equal(HttpStatusCode.Forbidden, viewerTusPost.StatusCode);

        // 3. User A creates upload-session
        var sessionA = (await (await userAClient.PostJsonAsync(
            $"/api/recordings/{userARec.Id}/upload-session",
            new CreateUploadSessionRequest(webmBytes.Length)))
            .Content.ReadFromJsonAsync<UploadSessionDto>(CookieSessionClient.JsonOptions))!;

        // Missing X-CSRF-Token on POST /api/uploads -> 403 Forbidden
        var noCsrfCreate = await MediaTestFixtureHelper.TusCreateAsync(
            userAClient,
            webmBytes.Length,
            new Dictionary<string, string>
            {
                ["recordingId"] = userARec.Id.ToString(),
                ["uploadSessionId"] = sessionA.UploadSessionId.ToString()
            },
            includeCsrf: false);
        Assert.Equal(HttpStatusCode.Forbidden, noCsrfCreate.StatusCode);

        // User B trying to hijack User A's uploadSessionId on POST /api/uploads -> 403 Forbidden
        var userBHijackCreate = await MediaTestFixtureHelper.TusCreateAsync(
            userBClient,
            webmBytes.Length,
            new Dictionary<string, string>
            {
                ["recordingId"] = userARec.Id.ToString(),
                ["uploadSessionId"] = sessionA.UploadSessionId.ToString()
            });
        Assert.Equal(HttpStatusCode.Forbidden, userBHijackCreate.StatusCode);

        // User A creates tus file properly
        var createARes = await MediaTestFixtureHelper.TusCreateAsync(
            userAClient,
            webmBytes.Length,
            new Dictionary<string, string>
            {
                ["recordingId"] = userARec.Id.ToString(),
                ["uploadSessionId"] = sessionA.UploadSessionId.ToString()
            });
        Assert.Equal(HttpStatusCode.Created, createARes.StatusCode);
        var tusUrl = createARes.Headers.Location!.ToString();
        var tusPath = tusUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? new Uri(tusUrl).PathAndQuery
            : tusUrl;

        // Missing X-CSRF-Token on PATCH /api/uploads/<id> -> 403 Forbidden
        var noCsrfPatch = await MediaTestFixtureHelper.TusPatchAsync(
            userAClient,
            tusPath,
            0,
            webmBytes[..256],
            includeCsrf: false);
        Assert.Equal(HttpStatusCode.Forbidden, noCsrfPatch.StatusCode);

        // 4. Cross-user protection: User B calling HEAD, PATCH, DELETE on User A's tus resource MUST receive 403 Forbidden!
        var userBHead = await MediaTestFixtureHelper.TusHeadAsync(userBClient, tusPath);
        Assert.Equal(HttpStatusCode.Forbidden, userBHead.StatusCode);

        var userBPatch = await MediaTestFixtureHelper.TusPatchAsync(userBClient, tusPath, 0, webmBytes[..256]);
        Assert.Equal(HttpStatusCode.Forbidden, userBPatch.StatusCode);

        var userBDelete = await MediaTestFixtureHelper.TusDeleteAsync(userBClient, tusPath);
        Assert.Equal(HttpStatusCode.Forbidden, userBDelete.StatusCode);

        // User A can terminate their own incomplete upload cleanly
        var userADelete = await MediaTestFixtureHelper.TusDeleteAsync(userAClient, tusPath);
        Assert.Equal(HttpStatusCode.NoContent, userADelete.StatusCode);
    }

    [Fact]
    public async Task TusUpload_RevokingUserSessionMidUpload_RejectsNextPatchAndHeadImmediatelyWith401()
    {
        var webmBytes = await MediaTestFixtureHelper.GetValidWebmBytesAsync();

        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var (roles, shopA) = await GetRolesAndShopAAsync(superClient);
        var whA1 = shopA.Warehouses.Single();
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);

        var opUserId = await RegisterAndApproveAsync(
            superClient,
            "op.revoke.midupload@packingproof.test",
            "OpPass123!",
            [new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopA.Id, whA1.Id)]);

        using var opClient = _fixture.CreateSessionClient();
        await opClient.LoginAsync("op.revoke.midupload@packingproof.test", "OpPass123!");

        var rec = await CreateAndCaptureRecordingAsync(opClient, shopA.Id, whA1.Id, "005566778899", "video/webm");
        var session = (await (await opClient.PostJsonAsync(
            $"/api/recordings/{rec.Id}/upload-session",
            new CreateUploadSessionRequest(webmBytes.Length)))
            .Content.ReadFromJsonAsync<UploadSessionDto>(CookieSessionClient.JsonOptions))!;

        var tusCreate = await MediaTestFixtureHelper.TusCreateAsync(
            opClient,
            webmBytes.Length,
            new Dictionary<string, string>
            {
                ["recordingId"] = rec.Id.ToString(),
                ["uploadSessionId"] = session.UploadSessionId.ToString()
            });
        Assert.Equal(HttpStatusCode.Created, tusCreate.StatusCode);
        var tusUrl = tusCreate.Headers.Location!.ToString();
        var tusPath = tusUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? new Uri(tusUrl).PathAndQuery
            : tusUrl;

        var firstHalf = webmBytes[..(webmBytes.Length / 2)];
        var secondHalf = webmBytes[(webmBytes.Length / 2)..];

        var firstPatch = await MediaTestFixtureHelper.TusPatchAsync(opClient, tusPath, 0, firstHalf);
        Assert.Equal(HttpStatusCode.NoContent, firstPatch.StatusCode);

        // SuperAdmin revokes operator's active sessions mid-upload!
        var revokeRes = await superClient.PostJsonAsync($"/api/admin/users/{opUserId}/revoke-sessions", new { });
        revokeRes.EnsureSuccessStatusCode();

        // The very next PATCH and HEAD on the active tus resource MUST fail with 401 Unauthorized!
        var secondPatch = await MediaTestFixtureHelper.TusPatchAsync(opClient, tusPath, firstHalf.Length, secondHalf);
        Assert.Equal(HttpStatusCode.Unauthorized, secondPatch.StatusCode);

        var headAfterRevoke = await MediaTestFixtureHelper.TusHeadAsync(opClient, tusPath);
        Assert.Equal(HttpStatusCode.Unauthorized, headAfterRevoke.StatusCode);
    }

    [Fact]
    public async Task UploadSession_EnforcesMaxUploadBytes413_AndStagingMaxBytes507()
    {
        var factory = new CustomStorageWebAppFactory(new Dictionary<string, string?>
        {
            ["MAX_UPLOAD_BYTES"] = "20000",
            ["STAGING_MAX_BYTES"] = "25000",
            ["ENABLE_BACKGROUND_WORKER"] = "false"
        });

        try
        {
            using var superClient = factory.CreateSessionClient();
            await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

            var (roles, shopA) = await GetRolesAndShopAAsync(superClient);
            var whA1 = shopA.Warehouses.Single();
            var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);

            await RegisterAndApproveOnFactoryAsync(
                factory,
                superClient,
                "op.quota@packingproof.test",
                "OpPass123!",
                [new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopA.Id, whA1.Id)]);

            using var opClient = factory.CreateSessionClient();
            await opClient.LoginAsync("op.quota@packingproof.test", "OpPass123!");

            var rec1 = await CreateAndCaptureRecordingAsync(opClient, shopA.Id, whA1.Id, "006611111111", "video/webm");
            var rec2 = await CreateAndCaptureRecordingAsync(opClient, shopA.Id, whA1.Id, "006622222222", "video/webm");

            // 1. Exceeding MAX_UPLOAD_BYTES (20,000) -> 413 PayloadTooLarge
            var oversizeRes = await opClient.PostJsonAsync(
                $"/api/recordings/{rec1.Id}/upload-session",
                new CreateUploadSessionRequest(21_000));
            Assert.Equal(HttpStatusCode.RequestEntityTooLarge, oversizeRes.StatusCode);

            // 2. First upload reserves 15,000 bytes (fits within STAGING_MAX_BYTES = 25,000) -> 200 OK
            var okSessionRes = await opClient.PostJsonAsync(
                $"/api/recordings/{rec1.Id}/upload-session",
                new CreateUploadSessionRequest(15_000));
            Assert.Equal(HttpStatusCode.OK, okSessionRes.StatusCode);

            // 3. Second upload requests 15,000 bytes (15,000 + 15,000 = 30,000 > 25,000) -> 507 Insufficient Storage
            var stagingFullRes = await opClient.PostJsonAsync(
                $"/api/recordings/{rec2.Id}/upload-session",
                new CreateUploadSessionRequest(15_000));
            Assert.Equal(HttpStatusCode.InsufficientStorage, stagingFullRes.StatusCode);

            var err = await stagingFullRes.Content.ReadFromJsonAsync<ApiErrorResponse>(CookieSessionClient.JsonOptions);
            Assert.Equal("STAGING_CAPACITY_EXCEEDED", err?.ErrorCode);
            Assert.False(string.IsNullOrWhiteSpace(err?.Message));
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    private static async Task<RecordingDto> CreateAndCaptureRecordingAsync(
        CookieSessionClient client,
        Guid shopId,
        Guid warehouseId,
        string trackingCode,
        string clientMimeType)
    {
        var createRes = await client.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopId, warehouseId, trackingCode, ClientMimeType: clientMimeType));
        createRes.EnsureSuccessStatusCode();
        var created = (await createRes.Content.ReadFromJsonAsync<CreateRecordingResponse>(CookieSessionClient.JsonOptions))!.Recording;

        var startRes = await client.PostJsonAsync(
            $"/api/recordings/{created.Id}/events",
            new RecordingEventRequest("started", ClientMimeType: clientMimeType));
        startRes.EnsureSuccessStatusCode();

        var captureRes = await client.PostJsonAsync(
            $"/api/recordings/{created.Id}/events",
            new RecordingEventRequest("captured", DurationSeconds: 1.2));
        captureRes.EnsureSuccessStatusCode();

        return (await captureRes.Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
    }

    private static async Task<RecordingDto> WaitForRecordingTerminalStorageAsync(
        CookieSessionClient client,
        Guid recordingId,
        int timeoutMs = 15_000)
    {
        var sw = Stopwatch.StartNew();
        RecordingDto? last = null;

        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            var res = await client.GetAsync($"/api/recordings/{recordingId}");
            res.EnsureSuccessStatusCode();
            last = (await res.Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;

            if (last.StorageStatus is StorageStatus.Stored or StorageStatus.Failed)
            {
                return last;
            }

            await Task.Delay(120);
        }

        throw new TimeoutException(
            $"Recording '{recordingId}' did not reach terminal StorageStatus within {timeoutMs}ms (last={last?.StorageStatus}).");
    }

    private static async Task<(List<RoleDto> Roles, ShopDto ShopA)> GetRolesAndShopAAsync(
        CookieSessionClient superClient)
    {
        var rolesRes = await superClient.GetAsync("/api/admin/roles");
        rolesRes.EnsureSuccessStatusCode();
        var roles = (await rolesRes.Content.ReadFromJsonAsync<List<RoleDto>>(CookieSessionClient.JsonOptions))!;

        var shopsRes = await superClient.GetAsync("/api/shops");
        shopsRes.EnsureSuccessStatusCode();
        var shops = (await shopsRes.Content.ReadFromJsonAsync<AccessibleShopsResponse>(CookieSessionClient.JsonOptions))!;
        var shopA = shops.Shops.Single(s => s.Code == "ShopA");

        return (roles, shopA);
    }

    private Task<Guid> RegisterAndApproveAsync(
        CookieSessionClient superClient,
        string email,
        string password,
        IReadOnlyList<GrantProposalDto> grants) =>
        RegisterAndApproveCoreAsync(_fixture.CreateSessionClient, superClient, email, password, grants);

    private static Task<Guid> RegisterAndApproveOnFactoryAsync(
        CustomStorageWebAppFactory factory,
        CookieSessionClient superClient,
        string email,
        string password,
        IReadOnlyList<GrantProposalDto> grants) =>
        RegisterAndApproveCoreAsync(factory.CreateSessionClient, superClient, email, password, grants);

    private static async Task<Guid> RegisterAndApproveCoreAsync(
        Func<CookieSessionClient> clientFactory,
        CookieSessionClient superClient,
        string email,
        string password,
        IReadOnlyList<GrantProposalDto> grants)
    {
        using var regClient = clientFactory();
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
            new ApproveUserRequest(grants));
        approveRes.EnsureSuccessStatusCode();

        return me.Id;
    }
}

