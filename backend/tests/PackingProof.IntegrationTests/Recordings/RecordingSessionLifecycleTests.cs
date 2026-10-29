using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PackingProof.Api.Common;
using PackingProof.Api.Features.Admin;
using PackingProof.Api.Features.Auth;
using PackingProof.Api.Features.Recordings;
using PackingProof.Api.Features.Shops;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Core.Tracking;
using PackingProof.Infrastructure.Persistence;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Recordings;

public sealed class RecordingSessionLifecycleTests : IClassFixture<PostgresWebAppFixture>
{
    private readonly PostgresWebAppFixture _fixture;

    public RecordingSessionLifecycleTests(PostgresWebAppFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task CreateRecording_RejectsInvalidTrackingCode_AndRejectsOutOfScopeShopWarehouse()
    {
        var (shopB, whB1) = await _fixture.EnsureShopBExistsAsync();

        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var (roles, shopA) = await GetRolesAndShopAAsync(superClient);
        var whA1 = shopA.Warehouses.Single();
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);

        await RegisterAndApproveAsync(
            superClient,
            "op.scope.test@packingproof.test",
            "OpPass123!",
            [new GrantProposalDto(operatorRole.Id, ScopeType.Warehouse, shopA.Id, whA1.Id)]);

        using var opClient = _fixture.CreateSessionClient();
        await opClient.LoginAsync("op.scope.test@packingproof.test", "OpPass123!");

        // 1. Invalid tracking code (QR URL) -> 400 BadRequest
        var urlCodeRes = await opClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(
                ShopId: shopA.Id,
                WarehouseId: whA1.Id,
                RawCode: "https://www.tiktok.com/track/00998877",
                FormatHint: BarcodeFormatHint.QrCode));
        Assert.Equal(HttpStatusCode.BadRequest, urlCodeRes.StatusCode);
        var urlErr = await urlCodeRes.Content.ReadFromJsonAsync<ApiErrorResponse>(CookieSessionClient.JsonOptions);
        Assert.Equal("UNRECOGNIZED_QR_PAYLOAD", urlErr?.ErrorCode);

        // 2. Empty tracking code -> 400 BadRequest
        var emptyRes = await opClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopA.Id, whA1.Id, "   "));
        Assert.Equal(HttpStatusCode.BadRequest, emptyRes.StatusCode);

        // 3. Out-of-scope ShopB / WarehouseB1 -> 403 Forbidden
        var outOfScopeCreate = await opClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopB.Id, whB1.Id, "00123456789"));
        Assert.Equal(HttpStatusCode.Forbidden, outOfScopeCreate.StatusCode);

        var outOfScopeInspect = await opClient.PostJsonAsync(
            "/api/recordings/inspect-code",
            new InspectTrackingCodeRequest(shopB.Id, whB1.Id, "00123456789"));
        Assert.Equal(HttpStatusCode.Forbidden, outOfScopeInspect.StatusCode);

        // 4. Mismatched ShopId + WarehouseId -> 400 BadRequest
        var mismatchRes = await opClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopA.Id, whB1.Id, "00123456789"));
        Assert.Equal(HttpStatusCode.BadRequest, mismatchRes.StatusCode);
    }

    [Fact]
    public async Task ManualCodeEntry_IsDenied403ForDefaultOperator_AndAllowedWithReasonAndAuditWhenGranted()
    {
        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var (roles, shopA) = await GetRolesAndShopAAsync(superClient);
        var whA1 = shopA.Warehouses.Single();
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);
        var adminRole = roles.Single(r => r.Name == SystemRoles.Admin);

        var opUserId = await RegisterAndApproveAsync(
            superClient,
            "op.nomanual@packingproof.test",
            "OpPass123!",
            [new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopA.Id, whA1.Id)]);

        var adminUserId = await RegisterAndApproveAsync(
            superClient,
            "admin.manual@packingproof.test",
            "AdminPass123!",
            [new GrantProposalDto(adminRole.Id, ScopeType.Shop, shopA.Id, null)]);

        // 1. Default Operator lacks recording.manual_code -> 403 Forbidden + Denied AuditEvent
        using var opClient = _fixture.CreateSessionClient();
        await opClient.LoginAsync("op.nomanual@packingproof.test", "OpPass123!");

        var deniedManualRes = await opClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(
                ShopId: shopA.Id,
                WarehouseId: whA1.Id,
                RawCode: "0055443322",
                IsManualEntry: true,
                ManualEntryReason: "Tem bị rách góc phải"));
        Assert.Equal(HttpStatusCode.Forbidden, deniedManualRes.StatusCode);

        // 2. Admin has recording.manual_code, but missing reason -> 400 BadRequest
        using var adminClient = _fixture.CreateSessionClient();
        await adminClient.LoginAsync("admin.manual@packingproof.test", "AdminPass123!");

        var missingReasonRes = await adminClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(
                ShopId: shopA.Id,
                WarehouseId: whA1.Id,
                RawCode: "0055443322",
                IsManualEntry: true,
                ManualEntryReason: " "));
        Assert.Equal(HttpStatusCode.BadRequest, missingReasonRes.StatusCode);

        // 3. Admin with valid reason -> 201 Created + writes recording.manual_code AuditEvent
        var allowedManualRes = await adminClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(
                ShopId: shopA.Id,
                WarehouseId: whA1.Id,
                RawCode: "0055443322",
                IsManualEntry: true,
                ManualEntryReason: "Tem nhiệt bị mờ không quét được bằng camera"));
        Assert.Equal(HttpStatusCode.Created, allowedManualRes.StatusCode);

        var createdPayload = (await allowedManualRes.Content.ReadFromJsonAsync<CreateRecordingResponse>(
            CookieSessionClient.JsonOptions))!;
        Assert.Equal("0055443322", createdPayload.Recording.TrackingNumber);
        Assert.Equal("Tem nhiệt bị mờ không quét được bằng camera", createdPayload.Recording.ManualEntryReason);

        using var scope = _fixture.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

        var deniedAudit = await db.AuditEvents
            .AsNoTracking()
            .FirstOrDefaultAsync(a =>
                a.ActorUserId == opUserId &&
                a.Action == "recording.manual_code" &&
                a.Outcome == AuditOutcome.Denied);
        Assert.NotNull(deniedAudit);

        var successAudit = await db.AuditEvents
            .AsNoTracking()
            .FirstOrDefaultAsync(a =>
                a.ActorUserId == adminUserId &&
                a.Action == "recording.manual_code" &&
                a.EntityId == createdPayload.Recording.Id.ToString() &&
                a.Outcome == AuditOutcome.Success);
        Assert.NotNull(successAudit);
        Assert.Contains("0055443322", successAudit.MetadataJson);
    }

    [Fact]
    public async Task ConcurrentAndDuplicateTrackingCodeSessions_CreateDistinctRecordingIds_AndReportAccurateExistingCount()
    {
        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var (roles, shopA) = await GetRolesAndShopAAsync(superClient);
        var whA1 = shopA.Warehouses.Single();
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);

        await RegisterAndApproveAsync(
            superClient,
            "op1.concurrent@packingproof.test",
            "OpPass123!",
            [new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopA.Id, whA1.Id)]);

        await RegisterAndApproveAsync(
            superClient,
            "op2.concurrent@packingproof.test",
            "OpPass123!",
            [new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopA.Id, whA1.Id)]);

        using var op1Client = _fixture.CreateSessionClient();
        await op1Client.LoginAsync("op1.concurrent@packingproof.test", "OpPass123!");

        using var op2Client = _fixture.CreateSessionClient();
        await op2Client.LoginAsync("op2.concurrent@packingproof.test", "OpPass123!");

        const string trackingCode = "0077889911aB";

        // Before any recording exists: existingRecordingCount == 0
        var inspectInitial = await (await op1Client.PostJsonAsync(
            "/api/recordings/inspect-code",
            new InspectTrackingCodeRequest(shopA.Id, whA1.Id, trackingCode)))
            .Content.ReadFromJsonAsync<InspectTrackingCodeResponse>(CookieSessionClient.JsonOptions);
        Assert.NotNull(inspectInitial);
        Assert.True(inspectInitial.IsValid);
        Assert.Equal(trackingCode, inspectInitial.TrackingNumber);
        Assert.Equal(0, inspectInitial.ExistingRecordingCount);
        Assert.Null(inspectInitial.WarningMessage);

        // Two operators concurrently create sessions for the exact same tracking code
        var task1 = op1Client.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopA.Id, whA1.Id, trackingCode));
        var task2 = op2Client.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopA.Id, whA1.Id, trackingCode));

        var responses = await Task.WhenAll(task1, task2);
        Assert.Equal(HttpStatusCode.Created, responses[0].StatusCode);
        Assert.Equal(HttpStatusCode.Created, responses[1].StatusCode);

        var rec1 = (await responses[0].Content.ReadFromJsonAsync<CreateRecordingResponse>(CookieSessionClient.JsonOptions))!;
        var rec2 = (await responses[1].Content.ReadFromJsonAsync<CreateRecordingResponse>(CookieSessionClient.JsonOptions))!;

        Assert.NotEqual(rec1.Recording.Id, rec2.Recording.Id);
        Assert.Equal(trackingCode, rec1.Recording.TrackingNumber);
        Assert.Equal(trackingCode, rec2.Recording.TrackingNumber);

        // Inspecting again reports existingRecordingCount == 2 and a clear warning without blocking re-recording
        var inspectAfter = (await (await op1Client.PostJsonAsync(
            "/api/recordings/inspect-code",
            new InspectTrackingCodeRequest(shopA.Id, whA1.Id, trackingCode)))
            .Content.ReadFromJsonAsync<InspectTrackingCodeResponse>(CookieSessionClient.JsonOptions))!;
        Assert.True(inspectAfter.IsValid);
        Assert.Equal(2, inspectAfter.ExistingRecordingCount);
        Assert.NotNull(inspectAfter.WarningMessage);

        // ScopeType.Own isolation: op1 only sees op1's recording in GET /api/recordings and gets 403 on op2's recording
        var op1List = (await (await op1Client.GetAsync($"/api/recordings?trackingNumber={trackingCode}"))
            .Content.ReadFromJsonAsync<PagedRecordingsResponse>(CookieSessionClient.JsonOptions))!;
        Assert.Single(op1List.Items);
        Assert.Equal(rec1.Recording.Id, op1List.Items[0].Id);

        var crossReadRes = await op1Client.GetAsync($"/api/recordings/{rec2.Recording.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, crossReadRes.StatusCode);
    }

    [Fact]
    public async Task CaptureStatusLifecycle_EnforcesValidTransitions_KeepsTrackingImmutable_AndBlocksClientStored()
    {
        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var (roles, shopA) = await GetRolesAndShopAAsync(superClient);
        var whA1 = shopA.Warehouses.Single();
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);

        await RegisterAndApproveAsync(
            superClient,
            "op.lifecycle@packingproof.test",
            "OpPass123!",
            [new GrantProposalDto(operatorRole.Id, ScopeType.Own, shopA.Id, whA1.Id)]);

        using var opClient = _fixture.CreateSessionClient();
        await opClient.LoginAsync("op.lifecycle@packingproof.test", "OpPass123!");

        // Session 1: Valid Created -> Recording -> Captured
        var create1Res = await opClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopA.Id, whA1.Id, "0011223344"));
        create1Res.EnsureSuccessStatusCode();
        var rec1 = (await create1Res.Content.ReadFromJsonAsync<CreateRecordingResponse>(CookieSessionClient.JsonOptions))!.Recording;
        Assert.Equal(CaptureStatus.Created, rec1.CaptureStatus);
        Assert.Equal(StorageStatus.AwaitingUpload, rec1.StorageStatus);

        // Invalid jump Created -> Captured (skipping started) -> 409 Conflict
        var prematureCapture = await opClient.PostJsonAsync(
            $"/api/recordings/{rec1.Id}/events",
            new RecordingEventRequest("captured", DurationSeconds: 5.0));
        Assert.Equal(HttpStatusCode.Conflict, prematureCapture.StatusCode);

        // Valid Created -> Recording
        var startRes = await opClient.PostJsonAsync(
            $"/api/recordings/{rec1.Id}/events",
            new RecordingEventRequest("started", ClientMimeType: "video/webm;codecs=vp8"));
        Assert.Equal(HttpStatusCode.OK, startRes.StatusCode);
        var startedDto = (await startRes.Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
        Assert.Equal(CaptureStatus.Recording, startedDto.CaptureStatus);
        Assert.NotNull(startedDto.StartedAtUtc);

        // Attempt to mutate TrackingNumber during event -> 409 Conflict, tracking number stays immutable
        var tamperTrackingRes = await opClient.PostJsonAsync(
            $"/api/recordings/{rec1.Id}/events",
            new RecordingEventRequest("captured", DurationSeconds: 12.4, TrackingNumber: "9999999999"));
        Assert.Equal(HttpStatusCode.Conflict, tamperTrackingRes.StatusCode);

        // Attempt to force StorageStatus = Stored from client -> 403 Forbidden
        var tamperStoredPropRes = await opClient.PostJsonAsync(
            $"/api/recordings/{rec1.Id}/events",
            new RecordingEventRequest("captured", DurationSeconds: 12.4, StorageStatus: "Stored"));
        Assert.Equal(HttpStatusCode.Forbidden, tamperStoredPropRes.StatusCode);

        var tamperStoredEventRes = await opClient.PostJsonAsync(
            $"/api/recordings/{rec1.Id}/events",
            new RecordingEventRequest("stored"));
        Assert.Equal(HttpStatusCode.Forbidden, tamperStoredEventRes.StatusCode);

        // Valid Recording -> Captured
        var capturedRes = await opClient.PostJsonAsync(
            $"/api/recordings/{rec1.Id}/events",
            new RecordingEventRequest("captured", DurationSeconds: 18.5));
        Assert.Equal(HttpStatusCode.OK, capturedRes.StatusCode);
        var capturedDto = (await capturedRes.Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
        Assert.Equal(CaptureStatus.Captured, capturedDto.CaptureStatus);
        Assert.Equal(StorageStatus.AwaitingUpload, capturedDto.StorageStatus);
        Assert.Equal("0011223344", capturedDto.TrackingNumber);
        Assert.Equal(18.5, capturedDto.DurationSeconds);

        // Cannot cancel or interrupt after Captured -> 409 Conflict
        var cancelAfterCaptured = await opClient.PostJsonAsync(
            $"/api/recordings/{rec1.Id}/events",
            new RecordingEventRequest("cancelled"));
        Assert.Equal(HttpStatusCode.Conflict, cancelAfterCaptured.StatusCode);

        // Re-recording due to wrong tracking code links to rec1 without changing rec1's TrackingNumber
        var relinkedCreate = await opClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(
                ShopId: shopA.Id,
                WarehouseId: whA1.Id,
                RawCode: "0099887766",
                LinkedFromRecordingId: rec1.Id));
        Assert.Equal(HttpStatusCode.Created, relinkedCreate.StatusCode);
        var rec2 = (await relinkedCreate.Content.ReadFromJsonAsync<CreateRecordingResponse>(CookieSessionClient.JsonOptions))!.Recording;
        Assert.Equal(rec1.Id, rec2.LinkedFromRecordingId);
        Assert.Equal("0099887766", rec2.TrackingNumber);

        // Verify rec1's TrackingNumber is still "0011223344"
        var rec1Reloaded = (await (await opClient.GetAsync($"/api/recordings/{rec1.Id}"))
            .Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
        Assert.Equal("0011223344", rec1Reloaded.TrackingNumber);

        // Session 2: Valid Created -> Recording -> Interrupted
        await opClient.PostJsonAsync(
            $"/api/recordings/{rec2.Id}/events",
            new RecordingEventRequest("started", ClientMimeType: "video/webm"));

        var interruptRes = await opClient.PostJsonAsync(
            $"/api/recordings/{rec2.Id}/events",
            new RecordingEventRequest(
                "interrupted",
                DurationSeconds: 4.2,
                ErrorCode: "CAMERA_TRACK_ENDED",
                Reason: "Camera bị thu hồi do cuộc gọi đến"));
        Assert.Equal(HttpStatusCode.OK, interruptRes.StatusCode);
        var interruptedDto = (await interruptRes.Content.ReadFromJsonAsync<RecordingDto>(CookieSessionClient.JsonOptions))!;
        Assert.Equal(CaptureStatus.Interrupted, interruptedDto.CaptureStatus);
        Assert.Equal("CAMERA_TRACK_ENDED", interruptedDto.LastErrorCode);

        // Cannot mark Interrupted session as Captured afterwards -> 409 Conflict
        var captureAfterInterrupt = await opClient.PostJsonAsync(
            $"/api/recordings/{rec2.Id}/events",
            new RecordingEventRequest("captured", DurationSeconds: 5.0));
        Assert.Equal(HttpStatusCode.Conflict, captureAfterInterrupt.StatusCode);
    }

    private static async Task<(List<RoleDto> Roles, ShopDto ShopA)> GetRolesAndShopAAsync(
        CookieSessionClient superClient)
    {
        var rolesRes = await superClient.GetAsync("/api/admin/roles");
        var roles = (await rolesRes.Content.ReadFromJsonAsync<List<RoleDto>>(CookieSessionClient.JsonOptions))!;

        var shopsRes = await superClient.GetAsync("/api/shops");
        var shops = (await shopsRes.Content.ReadFromJsonAsync<AccessibleShopsResponse>(
            CookieSessionClient.JsonOptions))!;
        var shopA = shops.Shops.Single(s => s.Code == "ShopA");

        return (roles, shopA);
    }

    private async Task<Guid> RegisterAndApproveAsync(
        CookieSessionClient superClient,
        string email,
        string password,
        IReadOnlyList<GrantProposalDto> grants)
    {
        using var regClient = _fixture.CreateSessionClient();
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

