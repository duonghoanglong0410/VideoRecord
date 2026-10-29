using System.Net;
using System.Net.Http.Json;
using PackingProof.Api.Features.Admin;
using PackingProof.Api.Features.Auth;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Auth;

public sealed class ImmediateRevocationTests : IClassFixture<PostgresWebAppFixture>
{
    private readonly PostgresWebAppFixture _fixture;

    public ImmediateRevocationTests(PostgresWebAppFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task LockingUser_ImmediatelyBlocksVeryNextRequestWithExistingCookie()
    {
        using var adminClient = _fixture.CreateSessionClient();
        await adminClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var userId = await RegisterAndApproveAsViewerAsync(adminClient, "locktarget@packingproof.test", "LockPass123!");

        using var userClient = _fixture.CreateSessionClient();
        await userClient.LoginAsync("locktarget@packingproof.test", "LockPass123!");

        // Sanity check: authenticated request succeeds before lock
        var beforeLock = await userClient.GetAsync("/api/shops");
        Assert.Equal(HttpStatusCode.OK, beforeLock.StatusCode);

        // SuperAdmin locks user
        var lockRes = await adminClient.PostJsonAsync($"/api/admin/users/{userId}/lock", new { });
        Assert.Equal(HttpStatusCode.OK, lockRes.StatusCode);

        // Very next request using existing auth cookie is rejected immediately (401)
        var afterLock = await userClient.GetAsync("/api/shops");
        Assert.Equal(HttpStatusCode.Unauthorized, afterLock.StatusCode);

        var meAfterLock = await userClient.GetAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, meAfterLock.StatusCode);
    }

    [Fact]
    public async Task RevokingSession_ImmediatelyBlocksVeryNextRequestWithExistingCookie()
    {
        using var adminClient = _fixture.CreateSessionClient();
        await adminClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var userId = await RegisterAndApproveAsViewerAsync(adminClient, "revoketarget@packingproof.test", "RevokePass123!");

        using var userClient = _fixture.CreateSessionClient();
        await userClient.LoginAsync("revoketarget@packingproof.test", "RevokePass123!");

        Assert.Equal(HttpStatusCode.OK, (await userClient.GetAsync("/api/auth/me")).StatusCode);

        // SuperAdmin revokes user's active sessions
        var revokeRes = await adminClient.PostJsonAsync($"/api/admin/users/{userId}/revoke-sessions", new { });
        Assert.Equal(HttpStatusCode.OK, revokeRes.StatusCode);

        // Very next HTTP request with old cookie is rejected immediately
        var afterRevoke = await userClient.GetAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, afterRevoke.StatusCode);
    }

    [Fact]
    public async Task RemovingPermissionOrScope_ImmediatelyInvalidatesExistingCookieAndDeniesRemovedCapability()
    {
        using var adminClient = _fixture.CreateSessionClient();
        await adminClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var rolesRes = await adminClient.GetAsync("/api/admin/roles");
        var roles = (await rolesRes.Content.ReadFromJsonAsync<List<RoleDto>>(CookieSessionClient.JsonOptions))!;
        var shopAdminRole = roles.Single(r => r.Name == SystemRoles.Admin);
        var viewerRole = roles.Single(r => r.Name == SystemRoles.Viewer);

        var shopsRes = await adminClient.GetAsync("/api/shops");
        var shopsPayload = (await shopsRes.Content.ReadFromJsonAsync<PackingProof.Api.Features.Shops.AccessibleShopsResponse>(
            CookieSessionClient.JsonOptions))!;
        var shopA = shopsPayload.Shops.Single(s => s.Code == "ShopA");

        // Register & approve user as ShopA Admin
        using var targetClient = _fixture.CreateSessionClient();
        var regRes = await targetClient.PostJsonAsync("/api/auth/register", new
        {
            name = "Scoped Admin",
            email = "demotetarget@packingproof.test",
            password = "DemotePass123!",
            confirmPassword = "DemotePass123!"
        });
        var regUser = (await regRes.Content.ReadFromJsonAsync<AuthMeResponse>(CookieSessionClient.JsonOptions))!;

        var approveRes = await adminClient.PostJsonAsync(
            $"/api/admin/users/{regUser.Id}/approve",
            new ApproveUserRequest(
                Grants: [new GrantProposalDto(shopAdminRole.Id, ScopeType.Shop, shopA.Id, null)],
                DefaultShopId: shopA.Id));
        Assert.Equal(HttpStatusCode.OK, approveRes.StatusCode);

        // Login with ShopA Admin privileges
        await targetClient.LoginAsync("demotetarget@packingproof.test", "DemotePass123!");
        Assert.Equal(HttpStatusCode.OK, (await targetClient.GetAsync("/api/admin/users")).StatusCode);

        // SuperAdmin downgrades user from Admin to Viewer
        var updateGrantsRes = await adminClient.PutJsonAsync(
            $"/api/admin/users/{regUser.Id}/grants",
            new UpdateUserGrantsRequest(
                Grants: [new GrantProposalDto(viewerRole.Id, ScopeType.Shop, shopA.Id, null)]));
        Assert.Equal(HttpStatusCode.OK, updateGrantsRes.StatusCode);

        // Very next request using the old cookie is immediately blocked because SecurityStamp rotated!
        var nextWithOldCookie = await targetClient.GetAsync("/api/admin/users");
        Assert.Equal(HttpStatusCode.Unauthorized, nextWithOldCookie.StatusCode);

        // Even after re-logging in cleanly, user only has Viewer role so /api/admin/users returns 403!
        await targetClient.LoginAsync("demotetarget@packingproof.test", "DemotePass123!");
        var afterReLogin = await targetClient.GetAsync("/api/admin/users");
        Assert.Equal(HttpStatusCode.Forbidden, afterReLogin.StatusCode);
    }

    private async Task<Guid> RegisterAndApproveAsViewerAsync(
        CookieSessionClient superAdminClient,
        string email,
        string password)
    {
        var rolesRes = await superAdminClient.GetAsync("/api/admin/roles");
        var roles = (await rolesRes.Content.ReadFromJsonAsync<List<RoleDto>>(CookieSessionClient.JsonOptions))!;
        var viewerRole = roles.Single(r => r.Name == SystemRoles.Viewer);

        var shopsRes = await superAdminClient.GetAsync("/api/shops");
        var shopsPayload = (await shopsRes.Content.ReadFromJsonAsync<PackingProof.Api.Features.Shops.AccessibleShopsResponse>(
            CookieSessionClient.JsonOptions))!;
        var shopA = shopsPayload.Shops.First();

        using var regClient = _fixture.CreateSessionClient();
        var regRes = await regClient.PostJsonAsync("/api/auth/register", new
        {
            name = email,
            email,
            password,
            confirmPassword = password
        });
        regRes.EnsureSuccessStatusCode();
        var user = (await regRes.Content.ReadFromJsonAsync<AuthMeResponse>(CookieSessionClient.JsonOptions))!;

        var approveRes = await superAdminClient.PostJsonAsync(
            $"/api/admin/users/{user.Id}/approve",
            new ApproveUserRequest(
                Grants: [new GrantProposalDto(viewerRole.Id, ScopeType.Shop, shopA.Id, null)],
                DefaultShopId: shopA.Id));
        approveRes.EnsureSuccessStatusCode();

        return user.Id;
    }
}
