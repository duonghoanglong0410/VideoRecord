using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PackingProof.Api.Features.Admin;
using PackingProof.Api.Features.Auth;
using PackingProof.Api.Features.Recordings;
using PackingProof.Api.Features.Uploads;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Core.Storage;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Storage;
using PackingProof.Infrastructure.Workers;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Storage;

public sealed class SynologyStorageAndWorkerTests
{
    [Fact]
    public async Task SynologyMounted_MissingMountOrMismatchedMarker_NeverAutoCreatesFolder_PreservesStaging_AndRecoversWhenMarkerRestored()
    {
        var webmBytes = await MediaTestFixtureHelper.GetValidWebmBytesAsync();
        var webmSha256 = MediaTestFixtureHelper.ComputeSha256Hex(webmBytes);

        var tempRoot = Path.Combine(Path.GetTempPath(), $"packingproof_synology_it_{Guid.NewGuid():N}");
        var unmountedNasPath = Path.Combine(tempRoot, "synology-unmounted-share");
        const string expectedStorageId = "synology-nas-cluster-99";

        var factory = new CustomStorageWebAppFactory(
            new Dictionary<string, string?>
            {
                ["STORAGE_MODE"] = "SynologyMounted",
                ["NAS_ROOT_PATH"] = unmountedNasPath,
                ["STORAGE_ID"] = expectedStorageId,
                ["ENABLE_BACKGROUND_WORKER"] = "false",
                ["WORKER_MAX_ATTEMPTS"] = "2",
                ["WORKER_RETRY_BASE_DELAY_SECONDS"] = "1"
            },
            existingTempRootPath: tempRoot);

        try
        {
            var (shopA, whA1) = await factory.EnsureShopAExistsAsync();

            // Verify startup in SynologyMounted mode did NOT auto-create NAS_ROOT_PATH!
            Assert.False(Directory.Exists(unmountedNasPath));

            using var superClient = factory.CreateSessionClient();
            await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

            // /health/ready reports 503 Unhealthy when Synology mount/marker is missing
            using (var anonClient = factory.CreateSessionClient())
            {
                var publicReady = await anonClient.GetAsync("/health/ready");
                Assert.Equal(HttpStatusCode.ServiceUnavailable, publicReady.StatusCode);
                var publicJson = await publicReady.Content.ReadFromJsonAsync<JsonElement>();
                Assert.Equal("Unhealthy", publicJson.GetProperty("status").GetString());
                Assert.False(publicJson.TryGetProperty("diagnostics", out _));
            }

            var adminReadyUnhealthy = await superClient.GetAsync("/health/ready");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, adminReadyUnhealthy.StatusCode);
            var adminUnhealthyJson = await adminReadyUnhealthy.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(adminUnhealthyJson.GetProperty("diagnostics").GetProperty("storageMarkerValid").GetBoolean());

            using var operatorClient = await CreateApprovedOperatorClientAsync(factory, superClient, shopA.Id, whA1.Id, "op.synology@packingproof.test");

            // Upload real .webm via tus into staging
            var rec = await UploadBytesViaTusAsync(operatorClient, shopA.Id, whA1.Id, "007711223344", webmBytes);

            // Immediately after tus 100%, StorageStatus MUST be Validating (NOT Stored!)
            var preWorkerDto = (await (await operatorClient.GetAsync($"/api/recordings/{rec.Id}"))
                .Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
            Assert.Equal(StorageStatus.Validating, preWorkerDto.StorageStatus);

            var processor = factory.Services.GetRequiredService<ProcessingJobProcessor>();

            // Attempt 1: NAS_ROOT_PATH does not exist at all
            var claimed1 = await processor.TryClaimAndProcessNextAsync("test-worker-1");
            Assert.True(claimed1);

            // CRITICAL INVARIANT: NAS_ROOT_PATH MUST STILL NOT EXIST! Zero local fallback directories created!
            Assert.False(Directory.Exists(unmountedNasPath));

            var afterAttempt1 = (await (await operatorClient.GetAsync($"/api/recordings/{rec.Id}"))
                .Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
            Assert.Equal(StorageStatus.WaitingForStorage, afterAttempt1.StorageStatus);
            Assert.True(afterAttempt1.IsRetryable);
            Assert.Equal("NAS_STORAGE_MARKER_INVALID", afterAttempt1.LastErrorCode);

            // Verify staging file is still 100% preserved
            Assert.NotEmpty(Directory.GetFiles(factory.StagingRootPath));

            // Simulate mount appearing with WRONG marker ID on Attempt 2 (exhausting MaxAttempts = 2)
            Directory.CreateDirectory(unmountedNasPath);
            var markerPath = Path.Combine(unmountedNasPath, FileSystemVideoStorage.StorageMarkerFileName);
            await File.WriteAllTextAsync(markerPath, "wrong-nas-volume-id", Encoding.UTF8);

            await MakeJobImmediatelyDueAsync(factory, rec.Id);
            var claimed2 = await processor.TryClaimAndProcessNextAsync("test-worker-1");
            Assert.True(claimed2);

            var afterAttempt2 = (await (await operatorClient.GetAsync($"/api/recordings/{rec.Id}"))
                .Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
            Assert.Equal(StorageStatus.Failed, afterAttempt2.StorageStatus);
            Assert.True(afterAttempt2.IsRetryable);
            Assert.Equal("NAS_STORAGE_MARKER_INVALID", afterAttempt2.LastErrorCode);
            Assert.Empty(Directory.GetDirectories(unmountedNasPath));
            Assert.NotEmpty(Directory.GetFiles(factory.StagingRootPath));

            // Restore the genuine Synology marker file
            await File.WriteAllTextAsync(markerPath, expectedStorageId, Encoding.UTF8);

            // /health/ready now turns 200 Healthy
            var adminReadyHealthy = await superClient.GetAsync("/health/ready");
            Assert.Equal(HttpStatusCode.OK, adminReadyHealthy.StatusCode);

            // Trigger POST /api/recordings/{id}/retry-storage and run worker
            var retryRes = await operatorClient.PostJsonAsync($"/api/recordings/{rec.Id}/retry-storage", new { });
            Assert.Equal(HttpStatusCode.OK, retryRes.StatusCode);

            var claimed3 = await processor.TryClaimAndProcessNextAsync("test-worker-1");
            Assert.True(claimed3);

            var finalDto = (await (await operatorClient.GetAsync($"/api/recordings/{rec.Id}"))
                .Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
            Assert.Equal(StorageStatus.Stored, finalDto.StorageStatus);
            Assert.False(finalDto.IsRetryable);
            Assert.Equal(StorageMode.SynologyMounted, finalDto.StorageMode);
            Assert.Equal("webm", finalDto.ActualContainer);

            // Verify file is stored on Synology share with exact SHA-256 and staging is now empty
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
                var videoStorage = scope.ServiceProvider.GetRequiredService<IVideoStorage>();
                var asset = await db.VideoAssets.SingleAsync(v => v.RecordingId == rec.Id && v.Kind == AssetKind.Original);
                Assert.Equal(webmSha256, asset.Sha256);

                await using (var readStream = await videoStorage.OpenReadAsync(asset.RelativePath))
                {
                    using var ms = new MemoryStream();
                    await readStream.CopyToAsync(ms);
                    Assert.Equal(webmSha256, MediaTestFixtureHelper.ComputeSha256Hex(ms.ToArray()));
                }

                // If Synology marker disappears while reading, OpenReadAsync MUST throw StorageUnavailableException (never silent fallback)
                File.Delete(markerPath);
                await Assert.ThrowsAsync<StorageUnavailableException>(() =>
                    videoStorage.OpenReadAsync(asset.RelativePath));
            }

            Assert.Empty(Directory.GetFiles(factory.StagingRootPath));
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    [Fact]
    public async Task CrashReconciliation_HashConflictProtection_FakeVideoRejection_AndExpiredLeaseRecovery_WorkDeterministically()
    {
        var webmBytes = await MediaTestFixtureHelper.GetValidWebmBytesAsync();
        var webmSha256 = MediaTestFixtureHelper.ComputeSha256Hex(webmBytes);

        var tempRoot = Path.Combine(Path.GetTempPath(), $"packingproof_reconcile_it_{Guid.NewGuid():N}");
        var nasPath = Path.Combine(tempRoot, "synology-share");
        Directory.CreateDirectory(nasPath);
        await File.WriteAllTextAsync(
            Path.Combine(nasPath, FileSystemVideoStorage.StorageMarkerFileName),
            "synology-reconcile-01",
            Encoding.UTF8);

        var factory = new CustomStorageWebAppFactory(
            new Dictionary<string, string?>
            {
                ["STORAGE_MODE"] = "SynologyMounted",
                ["NAS_ROOT_PATH"] = nasPath,
                ["STORAGE_ID"] = "synology-reconcile-01",
                ["ENABLE_BACKGROUND_WORKER"] = "false"
            },
            existingTempRootPath: tempRoot);

        try
        {
            var (shopA, whA1) = await factory.EnsureShopAExistsAsync();

            using var superClient = factory.CreateSessionClient();
            await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

            using var opClient = await CreateApprovedOperatorClientAsync(
                factory,
                superClient,
                shopA.Id,
                whA1.Id,
                "op.reconcile@packingproof.test");

            var processor = factory.Services.GetRequiredService<ProcessingJobProcessor>();

            // --- CASE A: Crash recovery after NAS commit (target file already exists with IDENTICAL SHA-256)
            // AND expired Running lease recovery from crashed worker!
            var recReconcile = await UploadBytesViaTusAsync(opClient, shopA.Id, whA1.Id, "008811112222", webmBytes);
            string preExistingFullPath;
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
                var recEntity = await db.Recordings.Include(r => r.Shop).FirstAsync(r => r.Id == recReconcile.Id);
                var expectedRel = StoragePathBuilder.BuildOriginalRelativePath(
                    recEntity.Shop.Slug,
                    recEntity.StartedAtUtc ?? recEntity.CreatedAtUtc,
                    recEntity.SafeTrackingSegment,
                    recEntity.Id,
                    "webm");

                preExistingFullPath = Path.Combine(nasPath, expectedRel.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(preExistingFullPath)!);
                await File.WriteAllBytesAsync(preExistingFullPath, webmBytes);

                // Simulate a crashed worker holding an EXPIRED Running lease
                var job = await db.ProcessingJobs.SingleAsync(j => j.RecordingId == recReconcile.Id);
                job.Status = ProcessingJobStatus.Running;
                job.LeaseOwner = "crashed-worker-instance";
                job.LeaseExpiresAtUtc = DateTime.UtcNow.AddSeconds(-30);
                job.AttemptCount = 1;
                await db.SaveChangesAsync();
            }

            Assert.True(await processor.TryClaimAndProcessNextAsync("recovery-worker-instance"));

            var reconciledDto = (await (await opClient.GetAsync($"/api/recordings/{recReconcile.Id}"))
                .Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
            Assert.Equal(StorageStatus.Stored, reconciledDto.StorageStatus);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
                var audit = await db.AuditEvents
                    .AsNoTracking()
                    .SingleAsync(a => a.Action == "video.stored" && a.EntityId == recReconcile.Id.ToString());
                Assert.Contains("\"reconciledExisting\":true", audit.MetadataJson);
            }

            // --- CASE B: Pre-existing target file on NAS has DIFFERENT SHA-256 -> MUST NOT overwrite, fails permanently!
            var recConflict = await UploadBytesViaTusAsync(opClient, shopA.Id, whA1.Id, "008833334444", webmBytes);
            var protectedExistingBytes = Encoding.UTF8.GetBytes("EXISTING-PROTECTED-EVIDENCE-DO-NOT-OVERWRITE");
            string conflictTargetFullPath;
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
                var recEntity = await db.Recordings.Include(r => r.Shop).FirstAsync(r => r.Id == recConflict.Id);
                var expectedRel = StoragePathBuilder.BuildOriginalRelativePath(
                    recEntity.Shop.Slug,
                    recEntity.StartedAtUtc ?? recEntity.CreatedAtUtc,
                    recEntity.SafeTrackingSegment,
                    recEntity.Id,
                    "webm");

                conflictTargetFullPath = Path.Combine(nasPath, expectedRel.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(conflictTargetFullPath)!);
                await File.WriteAllBytesAsync(conflictTargetFullPath, protectedExistingBytes);
            }

            Assert.True(await processor.TryClaimAndProcessNextAsync("recovery-worker-instance"));

            var conflictDto = (await (await opClient.GetAsync($"/api/recordings/{recConflict.Id}"))
                .Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
            Assert.Equal(StorageStatus.Failed, conflictDto.StorageStatus);
            Assert.False(conflictDto.IsRetryable);
            Assert.Equal("STORAGE_HASH_CONFLICT", conflictDto.LastErrorCode);

            // Prove existing file on NAS was NOT touched/overwritten!
            var actualRemainingBytes = await File.ReadAllBytesAsync(conflictTargetFullPath);
            Assert.Equal(protectedExistingBytes, actualRemainingBytes);

            // --- CASE C: Fake/corrupt text bytes uploaded with .mp4 metadata -> rejected by ffprobe, never copied to NAS!
            var fakeVideoBytes = Encoding.UTF8.GetBytes("THIS IS PLAIN TEXT PRETENDING TO BE AN MP4 VIDEO FILE!");
            var recFake = await UploadBytesViaTusAsync(
                opClient,
                shopA.Id,
                whA1.Id,
                "008855556666",
                fakeVideoBytes,
                clientMimeType: "video/mp4");

            Assert.True(await processor.TryClaimAndProcessNextAsync("recovery-worker-instance"));

            var fakeDto = (await (await opClient.GetAsync($"/api/recordings/{recFake.Id}"))
                .Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
            Assert.Equal(StorageStatus.Failed, fakeDto.StorageStatus);
            Assert.False(fakeDto.IsRetryable);
            Assert.Equal("INVALID_MEDIA_CONTAINER", fakeDto.LastErrorCode);

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
                var hasAnyAsset = await db.VideoAssets.AnyAsync(v => v.RecordingId == recFake.Id);
                Assert.False(hasAnyAsset);

                var fakeJob = await db.ProcessingJobs.SingleAsync(j => j.RecordingId == recFake.Id);
                Assert.Equal(ProcessingJobStatus.DeadLetter, fakeJob.Status);
            }

            // Ensure no directory/file for 008855556666 was ever created on NAS
            var allNasFiles = Directory.GetFiles(nasPath, "*008855556666*", SearchOption.AllDirectories);
            Assert.Empty(allNasFiles);
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    private static async Task<RecordingDto> UploadBytesViaTusAsync(
        CookieSessionClient opClient,
        Guid shopId,
        Guid warehouseId,
        string trackingCode,
        byte[] payloadBytes,
        string clientMimeType = "video/webm")
    {
        var createRes = await opClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopId, warehouseId, trackingCode, ClientMimeType: clientMimeType));
        createRes.EnsureSuccessStatusCode();
        var rec = (await createRes.Content.ReadFromJsonAsync<CreateRecordingResponse>(CookieSessionClient.JsonOptions))!.Recording;

        (await opClient.PostJsonAsync(
            $"/api/recordings/{rec.Id}/events",
            new RecordingEventRequest("started", ClientMimeType: clientMimeType))).EnsureSuccessStatusCode();

        var capturedRes = await opClient.PostJsonAsync(
            $"/api/recordings/{rec.Id}/events",
            new RecordingEventRequest("captured", DurationSeconds: 1.5));
        capturedRes.EnsureSuccessStatusCode();
        var captured = (await capturedRes.Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;

        var sessionRes = await opClient.PostJsonAsync(
            $"/api/recordings/{rec.Id}/upload-session",
            new CreateUploadSessionRequest(payloadBytes.Length));
        sessionRes.EnsureSuccessStatusCode();
        var session = (await sessionRes.Content.ReadFromJsonAsync<UploadSessionDto>(CookieSessionClient.JsonOptions))!;

        var tusCreate = await MediaTestFixtureHelper.TusCreateAsync(
            opClient,
            payloadBytes.Length,
            new Dictionary<string, string>
            {
                ["recordingId"] = rec.Id.ToString(),
                ["uploadSessionId"] = session.UploadSessionId.ToString(),
                ["filename"] = "fake.mp4"
            });
        Assert.Equal(HttpStatusCode.Created, tusCreate.StatusCode);

        var tusUrl = tusCreate.Headers.Location!.ToString();
        var tusPath = tusUrl.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? new Uri(tusUrl).PathAndQuery
            : tusUrl;

        var tusPatch = await MediaTestFixtureHelper.TusPatchAsync(opClient, tusPath, 0, payloadBytes);
        Assert.Equal(HttpStatusCode.NoContent, tusPatch.StatusCode);

        return captured;
    }

    private static async Task MakeJobImmediatelyDueAsync(CustomStorageWebAppFactory factory, Guid recordingId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
        var job = await db.ProcessingJobs.SingleAsync(j =>
            j.RecordingId == recordingId &&
            j.JobType == ProcessingJobType.ValidateAndStoreOriginal);
        job.NextAttemptAtUtc = DateTime.UtcNow.AddSeconds(-1);
        await db.SaveChangesAsync();
    }

    private static async Task<CookieSessionClient> CreateApprovedOperatorClientAsync(
        CustomStorageWebAppFactory factory,
        CookieSessionClient superClient,
        Guid shopId,
        Guid warehouseId,
        string email)
    {
        const string password = "OpPassword123!";
        var rolesRes = await superClient.GetAsync("/api/admin/roles");
        rolesRes.EnsureSuccessStatusCode();
        var roles = (await rolesRes.Content.ReadFromJsonAsync<List<RoleDto>>(CookieSessionClient.JsonOptions))!;
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);

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
                new ApproveUserRequest([new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopId, warehouseId)]));
            approveRes.EnsureSuccessStatusCode();
        }

        var opClient = factory.CreateSessionClient();
        await opClient.LoginAsync(email, password);
        return opClient;
    }
}
