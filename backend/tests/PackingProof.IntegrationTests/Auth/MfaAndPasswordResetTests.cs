using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using OtpNet;
using PackingProof.Api.Features.Admin;
using PackingProof.Api.Features.Auth;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Persistence;
using PackingProof.IntegrationTests.TestInfrastructure;
using Xunit;

namespace PackingProof.IntegrationTests.Auth;

public sealed class MfaAndPasswordResetTests : IClassFixture<PostgresWebAppFixture>
{
    private readonly PostgresWebAppFixture _fixture;

    public MfaAndPasswordResetTests(PostgresWebAppFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task TotpMfa_Setup_Enable_LoginWithTotp_AndLoginWithRecoveryCode_WorkEndToEnd()
    {
        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        var rolesRes = await superClient.GetAsync("/api/admin/roles");
        var roles = (await rolesRes.Content.ReadFromJsonAsync<List<RoleDto>>(CookieSessionClient.JsonOptions))!;
        var adminRole = roles.Single(r => r.Name == SystemRoles.Admin);

        var shopsRes = await superClient.GetAsync("/api/shops");
        var shops = (await shopsRes.Content.ReadFromJsonAsync<PackingProof.Api.Features.Shops.AccessibleShopsResponse>(
            CookieSessionClient.JsonOptions))!;
        var shopA = shops.Shops.First();

        // Register & approve user
        using var mfaUserClient = _fixture.CreateSessionClient();
        var regRes = await mfaUserClient.PostJsonAsync("/api/auth/register", new
        {
            name = "MFA Admin",
            email = "mfa.admin@packingproof.test",
            password = "MfaPassword123!",
            confirmPassword = "MfaPassword123!"
        });
        var registered = (await regRes.Content.ReadFromJsonAsync<AuthMeResponse>(CookieSessionClient.JsonOptions))!;

        var approveRes = await superClient.PostJsonAsync(
            $"/api/admin/users/{registered.Id}/approve",
            new ApproveUserRequest([new GrantProposalDto(adminRole.Id, ScopeType.Shop, shopA.Id, null)]));
        approveRes.EnsureSuccessStatusCode();

        // Login freshly after approval
        await mfaUserClient.LoginAsync("mfa.admin@packingproof.test", "MfaPassword123!");

        // 1. Setup MFA
        var setupRes = await mfaUserClient.PostJsonAsync("/api/auth/mfa/setup", new { });
        Assert.Equal(HttpStatusCode.OK, setupRes.StatusCode);
        var setupPayload = (await setupRes.Content.ReadFromJsonAsync<MfaSetupResponse>(
            CookieSessionClient.JsonOptions))!;

        Assert.False(string.IsNullOrWhiteSpace(setupPayload.SharedKey));
        Assert.StartsWith("otpauth://totp/", setupPayload.AuthenticatorUri);

        // Compute real RFC 6238 TOTP code from Base32 secret
        var cleanBase32Key = setupPayload.SharedKey.Replace(" ", string.Empty).ToUpperInvariant();
        var totp = new Totp(Base32Encoding.ToBytes(cleanBase32Key));
        var validTotpCode = totp.ComputeTotp();

        // 2. Enable MFA
        var enableRes = await mfaUserClient.PostJsonAsync(
            "/api/auth/mfa/enable",
            new MfaEnableRequest(validTotpCode));
        Assert.Equal(HttpStatusCode.OK, enableRes.StatusCode);
        var enablePayload = (await enableRes.Content.ReadFromJsonAsync<MfaEnableResponse>(
            CookieSessionClient.JsonOptions))!;

        Assert.True(enablePayload.Enabled);
        Assert.Equal(10, enablePayload.RecoveryCodes.Count);

        // 3. Logout and login again -> requiresTwoFactor = true
        await mfaUserClient.PostJsonAsync("/api/auth/logout", new { });

        var challengeLogin = await mfaUserClient.LoginAsync("mfa.admin@packingproof.test", "MfaPassword123!");
        Assert.True(challengeLogin.RequiresTwoFactor);
        Assert.Null(challengeLogin.User);

        // 4. Complete login-2fa with TOTP code
        var step2Res = await mfaUserClient.PostJsonAsync(
            "/api/auth/login-2fa",
            new Login2FaRequest(totp.ComputeTotp(), UseRecoveryCode: false));
        Assert.Equal(HttpStatusCode.OK, step2Res.StatusCode);
        var step2Login = (await step2Res.Content.ReadFromJsonAsync<LoginResponse>(
            CookieSessionClient.JsonOptions))!;
        Assert.False(step2Login.RequiresTwoFactor);
        Assert.True(step2Login.User!.TwoFactorEnabled);

        await mfaUserClient.RefreshCsrfAsync();
        await mfaUserClient.PostJsonAsync("/api/auth/logout", new { });

        // 5. Login with one-time recovery code
        var challenge2 = await mfaUserClient.LoginAsync("mfa.admin@packingproof.test", "MfaPassword123!");
        Assert.True(challenge2.RequiresTwoFactor);

        var recoveryRes = await mfaUserClient.PostJsonAsync(
            "/api/auth/login-2fa",
            new Login2FaRequest(enablePayload.RecoveryCodes[0], UseRecoveryCode: true));
        Assert.Equal(HttpStatusCode.OK, recoveryRes.StatusCode);
    }

    [Fact]
    public async Task AdminInitiatedControlledPasswordReset_Works_RevokesOldSession_AndNeverStoresRawTokenInAuditEvents()
    {
        using var superClient = _fixture.CreateSessionClient();
        await superClient.LoginAsync(PostgresWebAppFixture.SuperAdminEmail, PostgresWebAppFixture.SuperAdminPassword);

        using var staffClient = _fixture.CreateSessionClient();
        var regRes = await staffClient.PostJsonAsync("/api/auth/register", new
        {
            name = "Reset Staff",
            email = "reset.staff@packingproof.test",
            password = "OldPassword123!",
            confirmPassword = "OldPassword123!"
        });
        var staff = (await regRes.Content.ReadFromJsonAsync<AuthMeResponse>(CookieSessionClient.JsonOptions))!;

        await superClient.PostJsonAsync($"/api/admin/users/{staff.Id}/approve", new ApproveUserRequest());
        await staffClient.LoginAsync("reset.staff@packingproof.test", "OldPassword123!");

        // Public forgot-password without SMTP configured returns controlled 503 guidance
        var forgotRes = await staffClient.PostJsonAsync(
            "/api/auth/forgot-password",
            new ForgotPasswordRequest("reset.staff@packingproof.test"));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, forgotRes.StatusCode);

        // Authorized Admin initiates controlled one-time password reset
        var initRes = await superClient.PostJsonAsync(
            $"/api/admin/users/{staff.Id}/initiate-password-reset",
            new { });
        Assert.Equal(HttpStatusCode.OK, initRes.StatusCode);
        var initPayload = (await initRes.Content.ReadFromJsonAsync<AdminPasswordResetInitiatedResponse>(
            CookieSessionClient.JsonOptions))!;

        Assert.False(string.IsNullOrWhiteSpace(initPayload.ResetToken));

        // Existing staff session is immediately revoked
        var oldSessionCheck = await staffClient.GetAsync("/api/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, oldSessionCheck.StatusCode);

        // Staff resets password with one-time token
        using var resetClient = _fixture.CreateSessionClient();
        await resetClient.RefreshCsrfAsync();
        const string newPassword = "BrandNewPassword456!";
        var resetRes = await resetClient.PostJsonAsync(
            "/api/auth/reset-password",
            new ResetPasswordRequest(
                "reset.staff@packingproof.test",
                initPayload.ResetToken,
                newPassword,
                newPassword));
        Assert.Equal(HttpStatusCode.OK, resetRes.StatusCode);

        // Staff logs in with new password
        var newLogin = await resetClient.LoginAsync("reset.staff@packingproof.test", newPassword);
        Assert.False(newLogin.RequiresTwoFactor);
        Assert.False(newLogin.User!.ForcePasswordReset);

        // Verify AuditEvents exist for initiate_password_reset & reset_password and NEVER contain raw resetToken or password
        using var scope = _fixture.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PackingProofDbContext>();
        var allAudits = await db.AuditEvents.AsNoTracking().ToListAsync();

        Assert.Contains(allAudits, a =>
            a.Action == "admin.user.initiate_password_reset" &&
            a.EntityId == staff.Id.ToString() &&
            a.Outcome == AuditOutcome.Success);

        Assert.Contains(allAudits, a =>
            a.Action == "auth.reset_password" &&
            a.EntityId == staff.Id.ToString() &&
            a.Outcome == AuditOutcome.Success);

        foreach (var audit in allAudits)
        {
            Assert.DoesNotContain(initPayload.ResetToken, audit.MetadataJson);
            Assert.DoesNotContain(newPassword, audit.MetadataJson);
        }
    }
}

