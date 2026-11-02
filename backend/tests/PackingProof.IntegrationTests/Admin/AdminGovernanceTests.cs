using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PackingProof.Api.Common;
using PackingProof.Api.Features.Admin;
using PackingProof.Api.Features.Auth;
using PackingProof.Api.Features.Recordings;
using PackingProof.Api.Features.Shops;
using PackingProof.Api.Features.Videos;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Persistence;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Admin;

public sealed class AdminGovernanceTests : IClassFixture<PostgresWebAppFixture>
{
    private readonly PostgresWebAppFixture _fixture;

    public AdminGovernanceTests(PostgresWebAppFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task ShopAAdmin_CannotViewOrManageShopBVideosUsersOrAuditEvents()
    {
        var (shopB, whB1) = await _fixture.EnsureShopBExistsAsync();

        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var roles = (await (await superClient.GetAsync("/api/admin/roles"))
            .Content.ReadFromJsonAsync<List<RoleDto>>(CookieSessionClient.JsonOptions))!;
        var shops = (await (await superClient.GetAsync("/api/shops"))
            .Content.ReadFromJsonAsync<AccessibleShopsResponse>(CookieSessionClient.JsonOptions))!;

        var shopA = shops.Shops.Single(s => s.Code == "ShopA");
        var whA1 = shopA.Warehouses.First();

        var adminRole = roles.Single(r => r.Name == SystemRoles.Admin);
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);

        var shopAAdminId = await RegisterAndApproveAsync(
            superClient,
            "gov.admin.shopa@packingproof.test",
            [new GrantProposalDto(adminRole.Id, ScopeType.Shop, shopA.Id, null)],
            shopA.Id,
            whA1.Id);

        var shopBOperatorId = await RegisterAndApproveAsync(
            superClient,
            "gov.op.shopb@packingproof.test",
            [new GrantProposalDto(operatorRole.Id, ScopeType.Shop, shopB.Id, null)],
            shopB.Id,
            whB1.Id);

        // ShopB operator creates a recording in ShopB (creates ShopB video + ShopB audit events)
        using var shopBOpClient = _fixture.CreateSessionClient();
        await shopBOpClient.LoginAsync("gov.op.shopb@packingproof.test", "GovPass123!");

        var shopBCreateRes = await shopBOpClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopB.Id, whB1.Id, "0055998877"));
        shopBCreateRes.EnsureSuccessStatusCode();
        var shopBRec = (await shopBCreateRes.Content.ReadFromJsonAsync<CreateRecordingResponse>(CookieSessionClient.JsonOptions))!.Recording;

        // ShopA Admin creates a recording in ShopA so ShopA has its own video & audit events
        using var shopAAdminClient = _fixture.CreateSessionClient();
        await shopAAdminClient.LoginAsync("gov.admin.shopa@packingproof.test", "GovPass123!");

        var shopACreateRes = await shopAAdminClient.PostJsonAsync(
            "/api/recordings",
            new CreateRecordingRequest(shopA.Id, whA1.Id, "0011998877"));
        shopACreateRes.EnsureSuccessStatusCode();

        // 1. Videos isolation: ShopA Admin cannot list or view ShopB videos
        var videosList = (await (await shopAAdminClient.GetAsync("/api/videos"))
            .Content.ReadFromJsonAsync<PagedVideosResponse>(CookieSessionClient.JsonOptions))!;
        Assert.DoesNotContain(videosList.Items, v => v.ShopId == shopB.Id || v.Id == shopBRec.Id);

        var videosFilteredShopB = (await (await shopAAdminClient.GetAsync($"/api/videos?shopId={shopB.Id}"))
            .Content.ReadFromJsonAsync<PagedVideosResponse>(CookieSessionClient.JsonOptions))!;
        Assert.Empty(videosFilteredShopB.Items);

        var shopBDetailRes = await shopAAdminClient.GetAsync($"/api/videos/{shopBRec.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, shopBDetailRes.StatusCode);

        // 2. Users isolation: ShopA Admin cannot see or manage ShopB users
        var usersList = (await (await shopAAdminClient.GetAsync("/api/admin/users?pageSize=100"))
            .Content.ReadFromJsonAsync<PaginatedResponse<AdminUserSummaryDto>>(CookieSessionClient.JsonOptions))!;
        Assert.Contains(usersList.Items, u => u.Id == shopAAdminId);
        Assert.DoesNotContain(usersList.Items, u => u.Id == shopBOperatorId);

        var usersFilteredShopB = (await (await shopAAdminClient.GetAsync($"/api/admin/users?shopId={shopB.Id}"))
            .Content.ReadFromJsonAsync<PaginatedResponse<AdminUserSummaryDto>>(CookieSessionClient.JsonOptions))!;
        Assert.Empty(usersFilteredShopB.Items);

        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await shopAAdminClient.PostJsonAsync($"/api/admin/users/{shopBOperatorId}/lock", new { })).StatusCode);

        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await shopAAdminClient.PutJsonAsync(
                $"/api/admin/users/{shopBOperatorId}/grants",
                new UpdateUserGrantsRequest([new GrantProposalDto(operatorRole.Id, ScopeType.Shop, shopA.Id, null)]))).StatusCode);

        // 3. Audit isolation: ShopA Admin sees ShopA events, ZERO ShopB events, and gets 403 when querying ShopB explicitly
        var auditRes = await shopAAdminClient.GetAsync("/api/admin/audit?pageSize=100");
        Assert.Equal(HttpStatusCode.OK, auditRes.StatusCode);
        var auditPage = (await auditRes.Content.ReadFromJsonAsync<PaginatedResponse<AuditEventDto>>(CookieSessionClient.JsonOptions))!;
        Assert.NotEmpty(auditPage.Items);
        Assert.All(auditPage.Items, e => Assert.Equal(shopA.Id, e.ShopId));
        Assert.DoesNotContain(auditPage.Items, e => e.ShopId == shopB.Id);

        var auditShopBRes = await shopAAdminClient.GetAsync($"/api/admin/audit?shopId={shopB.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, auditShopBRes.StatusCode);

        // 4. Storage management is strictly system-level (ShopA Admin gets 403)
        Assert.Equal(HttpStatusCode.Forbidden, (await shopAAdminClient.GetAsync("/api/admin/storage")).StatusCode);
    }

    [Fact]
    public async Task TurningOnRetention_RequiresConfirmRetentionEnable_ValidatesSubdirectories_AndAudits()
    {
        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        // Ensure retention starts disabled
        var resetRes = await superClient.PutJsonAsync(
            "/api/admin/storage",
            new UpdateAdminStorageRequest(
                MaxRecordingSeconds: 600,
                MaxUploadBytes: 536_870_912,
                MaxLocalPendingRecordings: 3,
                EnableAudioRecording: false,
                RetentionEnabled: false,
                RetentionDays: 90,
                ConfirmRetentionEnable: false));
        resetRes.EnsureSuccessStatusCode();

        // 1. Turning on RetentionEnabled without confirmRetentionEnable == true MUST fail with 400 BadRequest
        var unconfirmedRes = await superClient.PutJsonAsync(
            "/api/admin/storage",
            new UpdateAdminStorageRequest(
                MaxRecordingSeconds: 600,
                MaxUploadBytes: 536_870_912,
                MaxLocalPendingRecordings: 3,
                EnableAudioRecording: false,
                RetentionEnabled: true,
                RetentionDays: 45,
                ConfirmRetentionEnable: false));
        Assert.Equal(HttpStatusCode.BadRequest, unconfirmedRes.StatusCode);
        var unconfirmedErr = (await unconfirmedRes.Content.ReadFromJsonAsync<ApiErrorResponse>(CookieSessionClient.JsonOptions))!;
        Assert.Equal("RETENTION_CONFIRMATION_REQUIRED", unconfirmedErr.ErrorCode);

        // 2. Attempting path traversal in shop allowedStorageSubdir MUST fail with 400 BadRequest
        var overview = (await (await superClient.GetAsync("/api/admin/storage"))
            .Content.ReadFromJsonAsync<AdminStorageOverviewDto>(CookieSessionClient.JsonOptions))!;
        var shopA = overview.Shops.First(s => s.Code == "ShopA");

        var unsafeSubdirRes = await superClient.PutJsonAsync(
            "/api/admin/storage",
            new UpdateAdminStorageRequest(
                MaxRecordingSeconds: 600,
                MaxUploadBytes: 536_870_912,
                MaxLocalPendingRecordings: 3,
                EnableAudioRecording: false,
                RetentionEnabled: false,
                RetentionDays: 90,
                ConfirmRetentionEnable: false,
                ShopSubdirectories: [new ShopStorageSubdirUpdateDto(shopA.Id, "../outside-nas")]));
        Assert.Equal(HttpStatusCode.BadRequest, unsafeSubdirRes.StatusCode);

        // 3. Turning on RetentionEnabled WITH confirmRetentionEnable == true succeeds and writes AuditEvent
        var confirmedRes = await superClient.PutJsonAsync(
            "/api/admin/storage",
            new UpdateAdminStorageRequest(
                MaxRecordingSeconds: 600,
                MaxUploadBytes: 536_870_912,
                MaxLocalPendingRecordings: 3,
                EnableAudioRecording: false,
                RetentionEnabled: true,
                RetentionDays: 45,
                ConfirmRetentionEnable: true));
        Assert.Equal(HttpStatusCode.OK, confirmedRes.StatusCode);
        var updatedOverview = (await confirmedRes.Content.ReadFromJsonAsync<AdminStorageOverviewDto>(CookieSessionClient.JsonOptions))!;
        Assert.True(updatedOverview.RetentionEnabled);
        Assert.Equal(45, updatedOverview.RetentionDays);

        // Restore RetentionEnabled = false so shared fixture stays clean
        await superClient.PutJsonAsync(
            "/api/admin/storage",
            new UpdateAdminStorageRequest(
                MaxRecordingSeconds: 600,
                MaxUploadBytes: 536_870_912,
                MaxLocalPendingRecordings: 3,
                EnableAudioRecording: false,
                RetentionEnabled: false,
                RetentionDays: 90,
                ConfirmRetentionEnable: false));

        // 4. Health check succeeds and never exposes physical filesystem paths
        var healthRes = await superClient.PostJsonAsync("/api/admin/storage/health-check", new { });
        Assert.Equal(HttpStatusCode.OK, healthRes.StatusCode);
        var healthJson = await healthRes.Content.ReadAsStringAsync();
        Assert.DoesNotContain(_fixture.TempRootPath, healthJson, StringComparison.OrdinalIgnoreCase);

        using var scope = _fixture.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
        Assert.True(await db.AuditEvents.AnyAsync(a =>
            a.Action == "admin.storage.update" &&
            a.Outcome == AuditOutcome.Denied));
        Assert.True(await db.AuditEvents.AnyAsync(a =>
            a.Action == "admin.storage.update" &&
            a.Outcome == AuditOutcome.Success));
    }

    [Fact]
    public async Task AuditEndpoint_IsStrictlyReadOnly_RejectsPutAndDeleteEvenForSuperAdmin()
    {
        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var getRes = await superClient.GetAsync("/api/admin/audit");
        Assert.Equal(HttpStatusCode.OK, getRes.StatusCode);

        var putRootRes = await superClient.PutJsonAsync("/api/admin/audit", new { action = "tamper" });
        Assert.Contains(putRootRes.StatusCode, new[] { HttpStatusCode.NotFound, HttpStatusCode.MethodNotAllowed });

        var putIdRes = await superClient.PutJsonAsync("/api/admin/audit/1", new { action = "tamper" });
        Assert.Contains(putIdRes.StatusCode, new[] { HttpStatusCode.NotFound, HttpStatusCode.MethodNotAllowed });

        using (var delRootReq = new HttpRequestMessage(HttpMethod.Delete, "/api/admin/audit"))
        {
            delRootReq.Headers.Add("X-CSRF-Token", superClient.CsrfToken);
            var delRootRes = await superClient.Http.SendAsync(delRootReq);
            Assert.Contains(delRootRes.StatusCode, new[] { HttpStatusCode.NotFound, HttpStatusCode.MethodNotAllowed });
        }

        using (var delIdReq = new HttpRequestMessage(HttpMethod.Delete, "/api/admin/audit/1"))
        {
            delIdReq.Headers.Add("X-CSRF-Token", superClient.CsrfToken);
            var delIdRes = await superClient.Http.SendAsync(delIdReq);
            Assert.Contains(delIdRes.StatusCode, new[] { HttpStatusCode.NotFound, HttpStatusCode.MethodNotAllowed });
        }
    }

    [Fact]
    public async Task WarehousesAndAccountManagement_EnforcesShopScope_SupportsDirectAccountCreation_AndSelfServiceProfile()
    {
        var (shopB, _) = await _fixture.EnsureShopBExistsAsync();

        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var roles = (await (await superClient.GetAsync("/api/admin/roles"))
            .Content.ReadFromJsonAsync<List<RoleDto>>(CookieSessionClient.JsonOptions))!;
        var shops = (await (await superClient.GetAsync("/api/shops"))
            .Content.ReadFromJsonAsync<AccessibleShopsResponse>(CookieSessionClient.JsonOptions))!;

        var shopA = shops.Shops.Single(s => s.Code == "ShopA");
        var whA1 = shopA.Warehouses.First();
        var adminRole = roles.Single(r => r.Name == SystemRoles.Admin);
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);

        await RegisterAndApproveAsync(
            superClient,
            "wh.admin.shopa@packingproof.test",
            [new GrantProposalDto(adminRole.Id, ScopeType.Shop, shopA.Id, null)],
            shopA.Id,
            whA1.Id);

        using var shopAAdminClient = _fixture.CreateSessionClient();
        await shopAAdminClient.LoginAsync("wh.admin.shopa@packingproof.test", "GovPass123!");

        // 1. ShopA Admin sees only ShopA in /api/admin/warehouses/overview and cannot manage ShopB
        var overviewRes = await shopAAdminClient.GetAsync("/api/admin/warehouses/overview");
        Assert.Equal(HttpStatusCode.OK, overviewRes.StatusCode);
        var overview = (await overviewRes.Content.ReadFromJsonAsync<AdminWarehousesOverviewDto>(CookieSessionClient.JsonOptions))!;
        Assert.False(overview.CanManageShops);
        Assert.Single(overview.Shops);
        Assert.Equal(shopA.Id, overview.Shops[0].Id);

        var forbiddenWhRes = await shopAAdminClient.PostJsonAsync(
            $"/api/admin/warehouses/shops/{shopB.Id}",
            new CreateAdminWarehouseRequest("WHB-BLOCKED", "Kho Bị Chặn", true));
        Assert.Equal(HttpStatusCode.Forbidden, forbiddenWhRes.StatusCode);

        // 2. ShopA Admin creates a new warehouse & packing station in ShopA, then pauses the extra station
        var createWhRes = await shopAAdminClient.PostJsonAsync(
            $"/api/admin/warehouses/shops/{shopA.Id}",
            new CreateAdminWarehouseRequest("WHA-TB02", "Kho Tân Bình 02", true));
        Assert.Equal(HttpStatusCode.Created, createWhRes.StatusCode);
        var createdWh = (await createWhRes.Content.ReadFromJsonAsync<AdminWarehouseDetailDto>(CookieSessionClient.JsonOptions))!;
        Assert.Equal("WHA-TB02", createdWh.Code);
        Assert.Single(createdWh.PackingStations);

        var createStRes = await shopAAdminClient.PostJsonAsync(
            $"/api/admin/warehouses/{createdWh.Id}/stations",
            new CreateAdminPackingStationRequest("ST-02", "Bàn đóng gói 02"));
        Assert.Equal(HttpStatusCode.Created, createStRes.StatusCode);
        var createdSt = (await createStRes.Content.ReadFromJsonAsync<AdminPackingStationDto>(CookieSessionClient.JsonOptions))!;

        var pauseStRes = await shopAAdminClient.PutJsonAsync(
            $"/api/admin/warehouses/stations/{createdSt.Id}",
            new UpdateAdminPackingStationRequest("ST-02", "Bàn đóng gói 02 (Bảo trì)", false));
        Assert.Equal(HttpStatusCode.OK, pauseStRes.StatusCode);

        // Active /api/shops hides paused ST-02 while keeping ST-01 active
        var activeShops = (await (await shopAAdminClient.GetAsync("/api/shops"))
            .Content.ReadFromJsonAsync<AccessibleShopsResponse>(CookieSessionClient.JsonOptions))!;
        var activeNewWh = activeShops.Shops.Single(s => s.Id == shopA.Id).Warehouses.Single(w => w.Id == createdWh.Id);
        Assert.Single(activeNewWh.PackingStations);
        Assert.Equal("ST-01", activeNewWh.PackingStations[0].Code);

        // 3. ShopA Admin directly creates an Active staff account in ShopA without /register
        var directUserRes = await shopAAdminClient.PostJsonAsync(
            "/api/admin/users",
            new CreateAdminUserRequest(
                FullName: "Nhân Viên Kho Mới",
                Email: "direct.staff.shopa@packingproof.test",
                Password: "DirectPass#2026!",
                Grants: [new GrantProposalDto(operatorRole.Id, ScopeType.Warehouse, shopA.Id, createdWh.Id)],
                DefaultShopId: shopA.Id,
                DefaultWarehouseId: createdWh.Id,
                ForcePasswordReset: false));
        Assert.Equal(HttpStatusCode.Created, directUserRes.StatusCode);
        var directUser = (await directUserRes.Content.ReadFromJsonAsync<AdminUserSummaryDto>(CookieSessionClient.JsonOptions))!;
        Assert.Equal(ApprovalStatus.Active, directUser.ApprovalStatus);

        // 4. Direct staff logs in immediately, updates own profile, and changes own password
        using var staffClient = _fixture.CreateSessionClient();
        await staffClient.LoginAsync("direct.staff.shopa@packingproof.test", "DirectPass#2026!");

        var updateOwnProfileRes = await staffClient.PutJsonAsync(
            "/api/auth/profile",
            new UpdateOwnProfileRequest("Nhân Viên Kho Đã Cập Nhật", shopA.Id, createdWh.Id));
        Assert.Equal(HttpStatusCode.OK, updateOwnProfileRes.StatusCode);
        var updatedMe = (await updateOwnProfileRes.Content.ReadFromJsonAsync<AuthMeResponse>(CookieSessionClient.JsonOptions))!;
        Assert.Equal("Nhân Viên Kho Đã Cập Nhật", updatedMe.FullName);

        var changePwRes = await staffClient.PostJsonAsync(
            "/api/auth/change-password",
            new ChangeOwnPasswordRequest("DirectPass#2026!", "NewSelfPass#2026!", "NewSelfPass#2026!"));
        Assert.Equal(HttpStatusCode.OK, changePwRes.StatusCode);

        // Verify login works with the newly changed password
        using var staffReLoginClient = _fixture.CreateSessionClient();
        await staffReLoginClient.LoginAsync("direct.staff.shopa@packingproof.test", "NewSelfPass#2026!");
    }

    private async Task<Guid> RegisterAndApproveAsync(
        CookieSessionClient superClient,
        string email,
        IReadOnlyList<GrantProposalDto> grants,
        Guid defaultShopId,
        Guid defaultWarehouseId)
    {
        const string password = "GovPass123!";
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
            new ApproveUserRequest(grants, defaultShopId, defaultWarehouseId));
        approveRes.EnsureSuccessStatusCode();

        return me.Id;
    }
}
