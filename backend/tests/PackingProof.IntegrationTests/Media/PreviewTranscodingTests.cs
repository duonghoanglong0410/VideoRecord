using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PackingProof.Api.Features.Admin;
using PackingProof.Api.Features.Auth;
using PackingProof.Api.Features.Recordings;
using PackingProof.Api.Features.Uploads;
using PackingProof.Api.Features.Videos;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Core.Storage;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Storage;
using PackingProof.Infrastructure.Workers;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Media;

public sealed class PreviewTranscodingTests
{
    [Fact]
    public async Task WebmUpload_GeneratesIndependentH264Mp4Preview_PreservesOriginalWebmAndSha256_AndStreamsBothVariantsWithHttp206Range()
    {
        var silentWebmBytes = await MediaTestFixtureHelper.GetValidWebmBytesAsync();
        var silentWebmSha256 = MediaTestFixtureHelper.ComputeSha256Hex(silentWebmBytes);

        var audioWebmBytes = await GenerateWebmWithOpusAudioBytesAsync();
        var audioWebmSha256 = MediaTestFixtureHelper.ComputeSha256Hex(audioWebmBytes);

        var factory = new CustomStorageWebAppFactory(new Dictionary<string, string?>
        {
            ["ENABLE_BACKGROUND_WORKER"] = "false",
            ["PROCESSING_CONCURRENCY"] = "2"
        });

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
                "op.preview.transcode@packingproof.test");

            var processor = factory.Services.GetRequiredService<ProcessingJobProcessor>();
            var mediaInspector = factory.Services.GetRequiredService<IMediaInspector>();

            // --- Part A: Silent WebM (VP8, no audio) -> Original .webm + H.264 _preview.mp4 (-an)
            var silentRec = await CreateAndUploadViaTusAsync(
                opClient,
                shopA.Id,
                whA1.Id,
                "00912345001",
                silentWebmBytes);

            // Step 1: ValidateAndStoreOriginal commits Original .webm and enqueues GeneratePreview
            Assert.True(await processor.TryClaimAndProcessNextAsync("preview-test-worker"));

            var afterOriginalDto = (await (await opClient.GetAsync($"/api/recordings/{silentRec.Id}"))
                .Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
            Assert.Equal(StorageStatus.Stored, afterOriginalDto.StorageStatus);
            Assert.Equal(PreviewStatus.Pending, afterOriginalDto.PreviewStatus);

            // Before GeneratePreview runs, ?variant=preview returns 404 while ?variant=original already streams 206!
            var earlyPreviewRes = await opClient.GetAsync($"/api/videos/{silentRec.Id}/stream?variant=preview");
            Assert.Equal(HttpStatusCode.NotFound, earlyPreviewRes.StatusCode);

            // Step 2: GeneratePreview transcodes to real H.264 MP4 via FFmpeg
            Assert.True(await processor.TryClaimAndProcessNextAsync("preview-test-worker"));
            Assert.False(await processor.TryClaimAndProcessNextAsync("preview-test-worker"));

            var detailRes = await opClient.GetAsync($"/api/videos/{silentRec.Id}");
            Assert.Equal(HttpStatusCode.OK, detailRes.StatusCode);
            var detail = (await detailRes.Content.ReadFromJsonAsync<VideoDetailDto>(CookieSessionClient.JsonOptions))!;

            Assert.Equal(StorageStatus.Stored, detail.StorageStatus);
            Assert.Equal(PreviewStatus.Ready, detail.PreviewStatus);
            Assert.True(detail.HasOriginalAsset);
            Assert.True(detail.HasPreviewAsset);
            Assert.Equal(silentWebmSha256, detail.OriginalSha256);
            Assert.NotNull(detail.PreviewSizeBytes);
            Assert.True(detail.PreviewSizeBytes > 256);

            byte[] expectedPreviewBytesOnDisk;
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
                var assets = await db.VideoAssets
                    .AsNoTracking()
                    .Where(a => a.RecordingId == silentRec.Id)
                    .ToListAsync();

                Assert.Equal(2, assets.Count);
                var origAsset = assets.Single(a => a.Kind == AssetKind.Original);
                var prevAsset = assets.Single(a => a.Kind == AssetKind.Preview);

                Assert.EndsWith(".webm", origAsset.RelativePath, StringComparison.Ordinal);
                Assert.EndsWith($"_{silentRec.Id:D}_preview.mp4", prevAsset.RelativePath, StringComparison.Ordinal);
                Assert.Equal("video/webm", origAsset.MimeType);
                Assert.Equal("video/mp4", prevAsset.MimeType);
                Assert.Equal(silentWebmSha256, origAsset.Sha256);
                Assert.NotEqual(origAsset.Sha256, prevAsset.Sha256);

                var origFullPath = Path.Combine(
                    factory.NasRootPath,
                    origAsset.RelativePath.Replace('/', Path.DirectorySeparatorChar));
                var prevFullPath = Path.Combine(
                    factory.NasRootPath,
                    prevAsset.RelativePath.Replace('/', Path.DirectorySeparatorChar));

                Assert.True(File.Exists(origFullPath));
                Assert.True(File.Exists(prevFullPath));

                // Verify Original .webm on disk was NEVER modified
                var (_, diskOrigSha) = await FileSystemVideoStorage.ComputeFileSizeAndSha256Async(origFullPath);
                Assert.Equal(silentWebmSha256, diskOrigSha);

                // Verify Preview _preview.mp4 on disk matches stored SHA-256 AND passes real ffprobe as mp4 + h264!
                var (_, diskPrevSha) = await FileSystemVideoStorage.ComputeFileSizeAndSha256Async(prevFullPath);
                Assert.Equal(prevAsset.Sha256, diskPrevSha);
                expectedPreviewBytesOnDisk = await File.ReadAllBytesAsync(prevFullPath);

                var ffprobePreview = await mediaInspector.InspectAsync(prevFullPath);
                Assert.True(ffprobePreview.IsValid);
                Assert.Equal("mp4", ffprobePreview.NormalizedContainer);
                Assert.Equal("h264", ffprobePreview.VideoCodec);
                Assert.Null(ffprobePreview.AudioCodec);

                // Verify AuditEvent("video.preview_ready") was appended
                Assert.True(await db.AuditEvents.AnyAsync(a =>
                    a.Action == "video.preview_ready" &&
                    a.EntityId == silentRec.Id.ToString() &&
                    a.Outcome == AuditOutcome.Success));
            }

            // Verify staging folder has zero leftover temp preview files
            Assert.Empty(Directory.GetFiles(factory.StagingRootPath));

            // Step 3: Verify HTTP 206 Partial Content Range requests on ?variant=preview, ?variant=original, and ?variant=auto
            const int sliceLen = 256;
            Assert.True(silentWebmBytes.Length > sliceLen);
            Assert.True(expectedPreviewBytesOnDisk.Length > sliceLen);

            using (var prevRangeReq = new HttpRequestMessage(HttpMethod.Get, $"/api/videos/{silentRec.Id}/stream?variant=preview"))
            {
                prevRangeReq.Headers.Range = new RangeHeaderValue(0, sliceLen - 1);
                var prevRangeRes = await opClient.Http.SendAsync(prevRangeReq);
                Assert.Equal(HttpStatusCode.PartialContent, prevRangeRes.StatusCode);
                Assert.Equal("video/mp4", prevRangeRes.Content.Headers.ContentType?.MediaType);
                Assert.Equal(expectedPreviewBytesOnDisk.Length, prevRangeRes.Content.Headers.ContentRange?.Length);
                var prevSlice = await prevRangeRes.Content.ReadAsByteArrayAsync();
                Assert.Equal(expectedPreviewBytesOnDisk[..sliceLen], prevSlice);
            }

            using (var origRangeReq = new HttpRequestMessage(HttpMethod.Get, $"/api/videos/{silentRec.Id}/stream?variant=original"))
            {
                origRangeReq.Headers.Range = new RangeHeaderValue(0, sliceLen - 1);
                var origRangeRes = await opClient.Http.SendAsync(origRangeReq);
                Assert.Equal(HttpStatusCode.PartialContent, origRangeRes.StatusCode);
                Assert.Equal("video/webm", origRangeRes.Content.Headers.ContentType?.MediaType);
                Assert.Equal(silentWebmBytes.Length, origRangeRes.Content.Headers.ContentRange?.Length);
                var origSlice = await origRangeRes.Content.ReadAsByteArrayAsync();
                Assert.Equal(silentWebmBytes[..sliceLen], origSlice);
            }

            using (var autoRangeReq = new HttpRequestMessage(HttpMethod.Get, $"/api/videos/{silentRec.Id}/stream?variant=auto"))
            {
                autoRangeReq.Headers.Range = new RangeHeaderValue(0, sliceLen - 1);
                var autoRangeRes = await opClient.Http.SendAsync(autoRangeReq);
                Assert.Equal(HttpStatusCode.PartialContent, autoRangeRes.StatusCode);
                Assert.Equal("video/mp4", autoRangeRes.Content.Headers.ContentType?.MediaType);
                var autoSlice = await autoRangeRes.Content.ReadAsByteArrayAsync();
                Assert.Equal(expectedPreviewBytesOnDisk[..sliceLen], autoSlice);
            }

            // --- Part B: WebM with Opus audio -> H.264 + AAC MP4 preview
            var audioRec = await CreateAndUploadViaTusAsync(
                opClient,
                shopA.Id,
                whA1.Id,
                "00912345002",
                audioWebmBytes);

            await processor.DrainAvailableJobsAsync("preview-audio-worker");

            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
                var recEntity = await db.Recordings.AsNoTracking().SingleAsync(r => r.Id == audioRec.Id);
                Assert.Equal(StorageStatus.Stored, recEntity.StorageStatus);
                Assert.Equal(PreviewStatus.Ready, recEntity.PreviewStatus);

                var origAudioAsset = await db.VideoAssets.AsNoTracking()
                    .SingleAsync(a => a.RecordingId == audioRec.Id && a.Kind == AssetKind.Original);
                var prevAudioAsset = await db.VideoAssets.AsNoTracking()
                    .SingleAsync(a => a.RecordingId == audioRec.Id && a.Kind == AssetKind.Preview);

                Assert.Equal(audioWebmSha256, origAudioAsset.Sha256);

                var prevAudioFullPath = Path.Combine(
                    factory.NasRootPath,
                    prevAudioAsset.RelativePath.Replace('/', Path.DirectorySeparatorChar));
                var inspectedAudioMp4 = await mediaInspector.InspectAsync(prevAudioFullPath);
                Assert.True(inspectedAudioMp4.IsValid);
                Assert.Equal("mp4", inspectedAudioMp4.NormalizedContainer);
                Assert.Equal("h264", inspectedAudioMp4.VideoCodec);
                Assert.Equal("aac", inspectedAudioMp4.AudioCodec);
            }
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    [Fact]
    public async Task WhenPreviewTranscodingFails_PreviewStatusBecomesFailed_WhileOriginalRemainsStoredAndAccessible()
    {
        var webmBytes = await MediaTestFixtureHelper.GetValidWebmBytesAsync();
        var webmSha256 = MediaTestFixtureHelper.ComputeSha256Hex(webmBytes);

        var factory = new CustomStorageWebAppFactory(new Dictionary<string, string?>
        {
            ["ENABLE_BACKGROUND_WORKER"] = "false",
            ["FFMPEG_PATH"] = "__non_existent_ffmpeg_binary_for_failure_test__",
            ["WORKER_MAX_ATTEMPTS"] = "1"
        });

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
                "op.preview.fail@packingproof.test");

            var rec = await CreateAndUploadViaTusAsync(
                opClient,
                shopA.Id,
                whA1.Id,
                "00912345999",
                webmBytes);

            var processor = factory.Services.GetRequiredService<ProcessingJobProcessor>();
            await processor.DrainAvailableJobsAsync("preview-failure-worker");

            var detailRes = await opClient.GetAsync($"/api/videos/{rec.Id}");
            Assert.Equal(HttpStatusCode.OK, detailRes.StatusCode);
            var detail = (await detailRes.Content.ReadFromJsonAsync<VideoDetailDto>(CookieSessionClient.JsonOptions))!;

            // Original MUST remain Stored with untouched SHA-256 even though PreviewStatus is Failed!
            Assert.Equal(StorageStatus.Stored, detail.StorageStatus);
            Assert.Equal(PreviewStatus.Failed, detail.PreviewStatus);
            Assert.True(detail.HasOriginalAsset);
            Assert.False(detail.HasPreviewAsset);
            Assert.Equal(webmSha256, detail.OriginalSha256);

            // Auto & original stream variants still serve Original .webm with HTTP 206 Partial Content!
            using var rangeReq = new HttpRequestMessage(HttpMethod.Get, $"/api/videos/{rec.Id}/stream?variant=auto");
            rangeReq.Headers.Range = new RangeHeaderValue(0, 127);
            var rangeRes = await opClient.Http.SendAsync(rangeReq);
            Assert.Equal(HttpStatusCode.PartialContent, rangeRes.StatusCode);
            Assert.Equal("video/webm", rangeRes.Content.Headers.ContentType?.MediaType);
            var slice = await rangeRes.Content.ReadAsByteArrayAsync();
            Assert.Equal(webmBytes[..128], slice);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
            var previewJob = await db.ProcessingJobs.AsNoTracking()
                .SingleAsync(j => j.RecordingId == rec.Id && j.JobType == ProcessingJobType.GeneratePreview);
            Assert.Equal(ProcessingJobStatus.Failed, previewJob.Status);
            Assert.Equal("FFMPEG_TOOL_UNAVAILABLE", previewJob.LastErrorCode);

            Assert.True(await db.AuditEvents.AnyAsync(a =>
                a.Action == "video.preview_failed" &&
                a.EntityId == rec.Id.ToString() &&
                a.Outcome == AuditOutcome.Failed));
        }
        finally
        {
            await factory.CleanupDatabaseAndTempRootAsync();
        }
    }

    private static async Task<RecordingDto> CreateAndUploadViaTusAsync(
        CookieSessionClient opClient,
        Guid shopId,
        Guid warehouseId,
        string trackingCode,
        byte[] payloadBytes)
    {
        var createRes = await opClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopId, warehouseId, trackingCode, ClientMimeType: "video/webm"));
        createRes.EnsureSuccessStatusCode();
        var rec = (await createRes.Content.ReadFromJsonAsync<CreateRecordingResponse>(CookieSessionClient.JsonOptions))!.Recording;

        (await opClient.PostJsonAsync(
            $"/api/recordings/{rec.Id}/events",
            new RecordingEventRequest("started", ClientMimeType: "video/webm"))).EnsureSuccessStatusCode();

        var capturedRes = await opClient.PostJsonAsync(
            $"/api/recordings/{rec.Id}/events",
            new RecordingEventRequest("captured", DurationSeconds: 1.2));
        capturedRes.EnsureSuccessStatusCode();
        var captured = (await capturedRes.Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;

        var sessionRes = await opClient.PostJsonAsync(
            $"/api/recordings/{rec.Id}/upload-session",
            new CreateUploadSessionRequest(payloadBytes.Length, MediaTestFixtureHelper.ComputeSha256Hex(payloadBytes)));
        sessionRes.EnsureSuccessStatusCode();
        var session = (await sessionRes.Content.ReadFromJsonAsync<UploadSessionDto>(CookieSessionClient.JsonOptions))!;

        var tusCreate = await MediaTestFixtureHelper.TusCreateAsync(
            opClient,
            payloadBytes.Length,
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

        var tusPatch = await MediaTestFixtureHelper.TusPatchAsync(opClient, tusPath, 0, payloadBytes);
        Assert.Equal(HttpStatusCode.NoContent, tusPatch.StatusCode);

        return captured;
    }

    private static async Task<CookieSessionClient> CreateApprovedOperatorClientAsync(
        CustomStorageWebAppFactory factory,
        CookieSessionClient superClient,
        Guid shopId,
        Guid warehouseId,
        string email)
    {
        const string password = "OpPreviewPass123!";
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
                new ApproveUserRequest(
                    Grants: [new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopId, warehouseId)],
                    DefaultShopId: shopId,
                    DefaultWarehouseId: warehouseId));
            approveRes.EnsureSuccessStatusCode();
        }

        var opClient = factory.CreateSessionClient();
        await opClient.LoginAsync(email, password);
        return opClient;
    }

    private static async Task<byte[]> GenerateWebmWithOpusAudioBytesAsync()
    {
        var tempFile = Path.Combine(Path.GetTempPath(), $"packingproof_audio_webm_{Guid.NewGuid():N}.webm");
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            psi.ArgumentList.Add("-y");
            psi.ArgumentList.Add("-hide_banner");
            psi.ArgumentList.Add("-loglevel");
            psi.ArgumentList.Add("error");
            psi.ArgumentList.Add("-f");
            psi.ArgumentList.Add("lavfi");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add("testsrc=duration=1.0:size=320x240:rate=15");
            psi.ArgumentList.Add("-f");
            psi.ArgumentList.Add("lavfi");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add("sine=frequency=440:duration=1.0");
            psi.ArgumentList.Add("-c:v");
            psi.ArgumentList.Add("libvpx");
            psi.ArgumentList.Add("-b:v");
            psi.ArgumentList.Add("200k");
            psi.ArgumentList.Add("-c:a");
            psi.ArgumentList.Add("libopus");
            psi.ArgumentList.Add("-b:a");
            psi.ArgumentList.Add("64k");
            psi.ArgumentList.Add(tempFile);

            using var process = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start ffmpeg for audio WebM fixture.");
            var stderrTask = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            var stderr = await stderrTask;

            if (process.ExitCode != 0 || !File.Exists(tempFile))
            {
                throw new InvalidOperationException($"ffmpeg audio WebM generation failed ({process.ExitCode}): {stderr}");
            }

            return await File.ReadAllBytesAsync(tempFile);
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
                // Ignore cleanup failure
            }
        }
    }
}
