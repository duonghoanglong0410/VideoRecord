using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PackingProof.Api.Features.Admin;
using PackingProof.Api.Features.Auth;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Persistence;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Auth;

public sealed class PrivilegeEscalationTests : IClassFixture<PostgresWebAppFixture>
{
    private readonly PostgresWebAppFixture _fixture;

    public PrivilegeEscalationTests(PostgresWebAppFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task Viewer_CallingAdminAndMutatingEndpoints_Gets403Forbidden()
    {
        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var (roles, shopAId) = await GetRolesAndShopAAsync(superClient);
        var viewerRole = roles.Single(r => r.Name == SystemRoles.Viewer);

        var viewerUserId = await RegisterAndApproveAsync(
            superClient,
            "viewer.only@packingproof.test",
            "ViewerPass123!",
            [new GrantProposalDto(viewerRole.Id, ScopeType.Shop, shopAId, null)]);

        using var viewerClient = _fixture.CreateSessionClient();
        await viewerClient.LoginAsync("viewer.only@packingproof.test", "ViewerPass123!");

        Assert.Equal(HttpStatusCode.Forbidden, (await viewerClient.GetAsync("/api/admin/users")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await viewerClient.GetAsync("/api/admin/roles")).StatusCode);

        var createRoleRes = await viewerClient.PostJsonAsync(
            "/api/admin/roles",
            new UpsertCustomRoleRequest("HackedRole", "Desc", [PermissionCatalog.VideoView]));
        Assert.Equal(HttpStatusCode.Forbidden, createRoleRes.StatusCode);

        var selfGrantRes = await viewerClient.PutJsonAsync(
            $"/api/admin/users/{viewerUserId}/grants",
            new UpdateUserGrantsRequest([
                new GrantProposalDto(roles.Single(r => r.Name == SystemRoles.SuperAdmin).Id, ScopeType.All)
            ]));
        Assert.Equal(HttpStatusCode.Forbidden, selfGrantRes.StatusCode);
    }

    [Fact]
    public async Task ShopAdmin_AttemptingToGrantSuperAdmin_OrOutOfScopeShopB_Gets403_AndWritesDeniedAuditEvent()
    {
        var (shopB, _) = await _fixture.EnsureShopBExistsAsync();

        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var (roles, shopAId) = await GetRolesAndShopAAsync(superClient);
        var adminRole = roles.Single(r => r.Name == SystemRoles.Admin);
        var superAdminRole = roles.Single(r => r.Name == SystemRoles.SuperAdmin);
        var operatorRole = roles.Single(r => r.Name == SystemRoles.Operator);

        var shopAAdminId = await RegisterAndApproveAsync(
            superClient,
            "admin.shopa@packingproof.test",
            "AdminShopAPass123!",
            [new GrantProposalDto(adminRole.Id, ScopeType.Shop, shopAId, null)]);

        var targetUserId = await RegisterAndApproveAsync(
            superClient,
            "target.staff@packingproof.test",
            "TargetPass123!",
            []);

        using var shopAAdminClient = _fixture.CreateSessionClient();
        await shopAAdminClient.LoginAsync("admin.shopa@packingproof.test", "AdminShopAPass123!");

        // 1. Attempt to grant SuperAdmin -> 403 + AuditEvent(Denied)
        var grantSuperRes = await shopAAdminClient.PutJsonAsync(
            $"/api/admin/users/{targetUserId}/grants",
            new UpdateUserGrantsRequest([
                new GrantProposalDto(superAdminRole.Id, ScopeType.All)
            ]));
        Assert.Equal(HttpStatusCode.Forbidden, grantSuperRes.StatusCode);

        // 2. Attempt to grant Operator in out-of-scope ShopB -> 403 + AuditEvent(Denied)
        var grantShopBRes = await shopAAdminClient.PutJsonAsync(
            $"/api/admin/users/{targetUserId}/grants",
            new UpdateUserGrantsRequest([
                new GrantProposalDto(operatorRole.Id, ScopeType.Shop, shopB.Id, null)
            ]));
        Assert.Equal(HttpStatusCode.Forbidden, grantShopBRes.StatusCode);

        // Verify AuditEvents recorded Outcome = Denied for both privilege escalation attempts
        using var scope = _fixture.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();

        var deniedEvents = await db.AuditEvents
            .AsNoTracking()
            .Where(a =>
                a.ActorUserId == shopAAdminId &&
                a.Action == "admin.user.update_grants" &&
                a.Outcome == AuditOutcome.Denied)
            .ToListAsync();

        Assert.Equal(2, deniedEvents.Count);
        Assert.Contains(deniedEvents, e => e.MetadataJson.Contains("CANNOT_GRANT_SUPERADMIN"));
        Assert.Contains(deniedEvents, e => e.MetadataJson.Contains("OUT_OF_SCOPE_GRANT"));
    }

    [Fact]
    public async Task Csrf_IsEnforcedOnCookieAuthenticatedMutations_AndHealthReadyHidesPublicDiagnostics()
    {
        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        // Mutating request WITHOUT X-CSRF-Token must be rejected with 403
        var noCsrfLogout = await superClient.PostJsonAsync("/api/auth/logout", new { }, includeCsrf: false);
        Assert.Equal(HttpStatusCode.Forbidden, noCsrfLogout.StatusCode);

        // SuperAdmin (has storage.manage) sees diagnostics on /health/ready
        var adminReadyRes = await superClient.GetAsync("/health/ready");
        Assert.Equal(HttpStatusCode.OK, adminReadyRes.StatusCode);
        using var adminReadyDoc = JsonDocument.Parse(await adminReadyRes.Content.ReadAsStringAsync());
        Assert.Equal("Healthy", adminReadyDoc.RootElement.GetProperty("status").GetString());
        Assert.True(adminReadyDoc.RootElement.TryGetProperty("diagnostics", out _));

        // Anonymous caller sees ONLY { status: "Healthy" } without internal diagnostics
        using var anonClient = _fixture.CreateSessionClient();
        var publicReadyRes = await anonClient.GetAsync("/health/ready");
        Assert.Equal(HttpStatusCode.OK, publicReadyRes.StatusCode);
        using var publicReadyDoc = JsonDocument.Parse(await publicReadyRes.Content.ReadAsStringAsync());
        Assert.Equal("Healthy", publicReadyDoc.RootElement.GetProperty("status").GetString());
        Assert.False(publicReadyDoc.RootElement.TryGetProperty("diagnostics", out _));
    }

    private static async Task<(List<RoleDto> Roles, Guid ShopAId)> GetRolesAndShopAAsync(
        CookieSessionClient superClient)
    {
        var rolesRes = await superClient.GetAsync("/api/admin/roles");
        var roles = (await rolesRes.Content.ReadFromJsonAsync<List<RoleDto>>(CookieSessionClient.JsonOptions))!;

        var shopsRes = await superClient.GetAsync("/api/shops");
        var shops = (await shopsRes.Content.ReadFromJsonAsync<PackingProof.Api.Features.Shops.AccessibleShopsResponse>(
            CookieSessionClient.JsonOptions))!;
        var shopA = shops.Shops.Single(s => s.Code == "ShopA");

        return (roles, shopA.Id);
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
