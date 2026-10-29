using System.Net;
using System.Net.Http.Json;
using PackingProof.Api.Features.Auth;
using PackingProof.Core.Enums;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Auth;

public sealed class RegistrationAndApprovalTests : IClassFixture<PostgresWebAppFixture>
{
    private readonly PostgresWebAppFixture _fixture;

    public RegistrationAndApprovalTests(PostgresWebAppFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task Register_CreatesPendingApprovalUser_IgnoresInjectedRolesAndScopes_AndBlocksBusinessAndAdminApis()
    {
        using var client = _fixture.CreateSessionClient();
        await client.RefreshCsrfAsync();

        // Attempt to inject role, grants, shopId, and approvalStatus during registration
        var maliciousRegistrationPayload = new
        {
            name = "Nhân viên Mới",
            email = "newstaff@packingproof.test",
            password = "NewStaffPass123!",
            confirmPassword = "NewStaffPass123!",
            approvalStatus = "Active",
            isSuperAdmin = true,
            roles = new[] { "SuperAdmin" },
            grants = new[]
            {
                new { roleName = "SuperAdmin", scopeType = "All" }
            }
        };

        var registerRes = await client.PostJsonAsync("/api/auth/register", maliciousRegistrationPayload);
        Assert.Equal(HttpStatusCode.Created, registerRes.StatusCode);

        var registeredMe = (await registerRes.Content.ReadFromJsonAsync<AuthMeResponse>(
            CookieSessionClient.JsonOptions))!;

        Assert.Equal(ApprovalStatus.PendingApproval, registeredMe.ApprovalStatus);
        Assert.False(registeredMe.IsSuperAdmin);
        Assert.Empty(registeredMe.Permissions);
        Assert.Empty(registeredMe.Grants);

        await client.RefreshCsrfAsync();

        // PendingApproval user CAN access GET /api/auth/me
        var meRes = await client.GetAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.OK, meRes.StatusCode);
        var meBody = (await meRes.Content.ReadFromJsonAsync<AuthMeResponse>(CookieSessionClient.JsonOptions))!;
        Assert.Equal(ApprovalStatus.PendingApproval, meBody.ApprovalStatus);

        // PendingApproval user gets 403 on business, MFA, and admin endpoints
        var shopsRes = await client.GetAsync("/api/shops");
        Assert.Equal(HttpStatusCode.Forbidden, shopsRes.StatusCode);

        var adminUsersRes = await client.GetAsync("/api/admin/users");
        Assert.Equal(HttpStatusCode.Forbidden, adminUsersRes.StatusCode);

        var mfaSetupRes = await client.PostJsonAsync("/api/auth/mfa/setup", new { });
        Assert.Equal(HttpStatusCode.Forbidden, mfaSetupRes.StatusCode);

        // PendingApproval user CAN log out
        var logoutRes = await client.PostJsonAsync("/api/auth/logout", new { });
        Assert.Equal(HttpStatusCode.OK, logoutRes.StatusCode);

        // Verify /health/live and /openapi/v1.json are available
        var liveRes = await client.GetAsync("/health/live");
        Assert.Equal(HttpStatusCode.OK, liveRes.StatusCode);

        var openApiRes = await client.GetAsync("/openapi/v1.json");
        Assert.Equal(HttpStatusCode.OK, openApiRes.StatusCode);
        var openApiJson = await openApiRes.Content.ReadAsStringAsync();
        Assert.Contains("\"/api/auth/login\"", openApiJson);
    }
}
