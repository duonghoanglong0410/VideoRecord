using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using PackingProof.Api.Common;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;

namespace PackingProof.Api.Features.Auth;

[ApiController]
[Route("api/auth/mfa")]
[Authorize]
public sealed class MfaController : ControllerBase
{
    private const string Issuer = "PackingProof";

    private readonly UserManager<ApplicationUser> _userManager;
    private readonly SignInManager<ApplicationUser> _signInManager;
    private readonly IAuditLogger _auditLogger;
    private readonly UrlEncoder _urlEncoder;

    public MfaController(
        UserManager<ApplicationUser> userManager,
        SignInManager<ApplicationUser> signInManager,
        IAuditLogger auditLogger,
        UrlEncoder urlEncoder)
    {
        _userManager = userManager;
        _signInManager = signInManager;
        _auditLogger = auditLogger;
        _urlEncoder = urlEncoder;
    }

    [HttpPost("setup")]
    public async Task<IActionResult> Setup(CancellationToken ct)
    {
        var user = await GetRequiredUserAsync();
        if (user is null)
        {
            return Unauthorized(new ApiErrorResponse("UNAUTHORIZED", "Phiên đăng nhập không hợp lệ."));
        }

        var unformattedKey = await _userManager.GetAuthenticatorKeyAsync(user);
        if (string.IsNullOrEmpty(unformattedKey))
        {
            await _userManager.ResetAuthenticatorKeyAsync(user);
            unformattedKey = await _userManager.GetAuthenticatorKeyAsync(user);
            await _signInManager.RefreshSignInAsync(user);
        }

        var formattedKey = FormatKey(unformattedKey!);
        var authenticatorUri = BuildQrCodeUri(user.Email ?? user.UserName ?? "user", unformattedKey!);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "auth.mfa.setup",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: user.Id,
            ActorEmail: user.Email,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent()), ct);

        return Ok(new MfaSetupResponse(formattedKey, authenticatorUri));
    }

    [HttpPost("enable")]
    public async Task<IActionResult> Enable([FromBody] MfaEnableRequest request, CancellationToken ct)
    {
        var user = await GetRequiredUserAsync();
        if (user is null)
        {
            return Unauthorized(new ApiErrorResponse("UNAUTHORIZED", "Phiên đăng nhập không hợp lệ."));
        }

        var verificationCode = (request.Code ?? string.Empty)
            .Replace(" ", string.Empty)
            .Replace("-", string.Empty)
            .Trim();

        if (string.IsNullOrEmpty(verificationCode))
        {
            return BadRequest(new ApiErrorResponse(
                "VALIDATION_ERROR",
                "Vui lòng nhập mã xác thực 6 chữ số từ ứng dụng Authenticator."));
        }

        var is2FaTokenValid = await _userManager.VerifyTwoFactorTokenAsync(
            user,
            _userManager.Options.Tokens.AuthenticatorTokenProvider,
            verificationCode);

        if (!is2FaTokenValid)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.mfa.enable",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Failed,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent()), ct);

            return BadRequest(new ApiErrorResponse(
                "INVALID_2FA_CODE",
                "Mã xác thực không chính xác. Vui lòng kiểm tra đồng bộ giờ trên điện thoại và thử lại."));
        }

        await _userManager.SetTwoFactorEnabledAsync(user, true);
        var recoveryCodes = (await _userManager.GenerateNewTwoFactorRecoveryCodesAsync(user, 10))?.ToList() ?? [];
        await _signInManager.RefreshSignInAsync(user);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "auth.mfa.enable",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: user.Id,
            ActorEmail: user.Email,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { recoveryCodeCount = recoveryCodes.Count }), ct);

        return Ok(new MfaEnableResponse(Enabled: true, RecoveryCodes: recoveryCodes));
    }

    [HttpPost("disable")]
    public async Task<IActionResult> Disable([FromBody] MfaDisableRequest request, CancellationToken ct)
    {
        var user = await GetRequiredUserAsync();
        if (user is null)
        {
            return Unauthorized(new ApiErrorResponse("UNAUTHORIZED", "Phiên đăng nhập không hợp lệ."));
        }

        if (string.IsNullOrEmpty(request.CurrentPassword) ||
            !await _userManager.CheckPasswordAsync(user, request.CurrentPassword))
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.mfa.disable",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Failed,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "INVALID_CURRENT_PASSWORD" }), ct);

            return BadRequest(new ApiErrorResponse(
                "INVALID_CURRENT_PASSWORD",
                "Mật khẩu hiện tại không chính xác."));
        }

        await _userManager.SetTwoFactorEnabledAsync(user, false);
        await _userManager.ResetAuthenticatorKeyAsync(user);
        await _userManager.UpdateSecurityStampAsync(user);
        await _signInManager.RefreshSignInAsync(user);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "auth.mfa.disable",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: user.Id,
            ActorEmail: user.Email,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent()), ct);

        return Ok(new { enabled = false, message = "Đã tắt xác thực hai lớp thành công." });
    }

    [HttpPost("recovery-codes")]
    public async Task<IActionResult> GenerateRecoveryCodes([FromBody] MfaRecoveryCodesRequest request, CancellationToken ct)
    {
        var user = await GetRequiredUserAsync();
        if (user is null)
        {
            return Unauthorized(new ApiErrorResponse("UNAUTHORIZED", "Phiên đăng nhập không hợp lệ."));
        }

        if (!user.TwoFactorEnabled)
        {
            return BadRequest(new ApiErrorResponse(
                "MFA_NOT_ENABLED",
                "Tài khoản chưa bật xác thực hai lớp."));
        }

        if (string.IsNullOrEmpty(request.CurrentPassword) ||
            !await _userManager.CheckPasswordAsync(user, request.CurrentPassword))
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_CURRENT_PASSWORD",
                "Mật khẩu hiện tại không chính xác."));
        }

        var recoveryCodes = (await _userManager.GenerateNewTwoFactorRecoveryCodesAsync(user, 10))?.ToList() ?? [];
        await _signInManager.RefreshSignInAsync(user);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "auth.mfa.regenerate_recovery_codes",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: user.Id,
            ActorEmail: user.Email,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { recoveryCodeCount = recoveryCodes.Count }), ct);

        return Ok(new MfaRecoveryCodesResponse(recoveryCodes));
    }

    private async Task<ApplicationUser?> GetRequiredUserAsync()
    {
        var userId = HttpContext.TryGetUserId();
        return userId.HasValue ? await _userManager.FindByIdAsync(userId.Value.ToString()) : null;
    }

    private static string FormatKey(string unformattedKey)
    {
        var result = new StringBuilder();
        var currentPosition = 0;
        while (currentPosition + 4 < unformattedKey.Length)
        {
            result.Append(unformattedKey.AsSpan(currentPosition, 4)).Append(' ');
            currentPosition += 4;
        }

        if (currentPosition < unformattedKey.Length)
        {
            result.Append(unformattedKey.AsSpan(currentPosition));
        }

        return result.ToString().ToLowerInvariant();
    }

    private string BuildQrCodeUri(string email, string unformattedKey) =>
        $"otpauth://totp/{_urlEncoder.Encode(Issuer)}:{_urlEncoder.Encode(email)}?secret={unformattedKey}&issuer={_urlEncoder.Encode(Issuer)}&digits=6";
}

