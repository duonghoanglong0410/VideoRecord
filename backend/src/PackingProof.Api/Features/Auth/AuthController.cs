using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using PackingProof.Api.Common;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Notifications;

namespace PackingProof.Api.Features.Auth;

[ApiController]
[Route("api/auth")]
public sealed class AuthController : ControllerBase
{
    private readonly UserManager<ApplicationUser> _userManager;
    private readonly SignInManager<ApplicationUser> _signInManager;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly IAuditLogger _auditLogger;
    private readonly IAntiforgery _antiforgery;
    private readonly IPasswordResetEmailSender _emailSender;
    private readonly PackingProofOptions _options;

    public AuthController(
        UserManager<ApplicationUser> userManager,
        SignInManager<ApplicationUser> signInManager,
        IScopeAuthorizationService scopeAuth,
        IAuditLogger auditLogger,
        IAntiforgery antiforgery,
        IPasswordResetEmailSender emailSender,
        PackingProofOptions options)
    {
        _userManager = userManager;
        _signInManager = signInManager;
        _scopeAuth = scopeAuth;
        _auditLogger = auditLogger;
        _antiforgery = antiforgery;
        _emailSender = emailSender;
        _options = options;
    }

    [HttpGet("csrf")]
    [AllowAnonymous]
    public ActionResult<CsrfTokenResponse> GetCsrfToken()
    {
        var tokens = _antiforgery.GetAndStoreTokens(HttpContext);
        return Ok(new CsrfTokenResponse(tokens.RequestToken ?? string.Empty));
    }

    [HttpPost("register")]
    [AllowAnonymous]
    public async Task<IActionResult> Register([FromBody] RegisterRequest request, CancellationToken ct)
    {
        var fullName = request.ResolvedName;
        var email = request.Email?.Trim() ?? string.Empty;

        if (string.IsNullOrWhiteSpace(fullName) || fullName.Length > 200)
        {
            return BadRequest(new ApiErrorResponse(
                "VALIDATION_ERROR",
                "Vui lòng nhập họ và tên hợp lệ (tối đa 200 ký tự)."));
        }

        if (string.IsNullOrWhiteSpace(email) || !new EmailAddressAttribute().IsValid(email))
        {
            return BadRequest(new ApiErrorResponse(
                "VALIDATION_ERROR",
                "Vui lòng nhập địa chỉ email hợp lệ."));
        }

        if (string.IsNullOrEmpty(request.Password) || request.Password != request.ConfirmPassword)
        {
            return BadRequest(new ApiErrorResponse(
                "PASSWORD_CONFIRM_MISMATCH",
                "Mật khẩu xác nhận không khớp."));
        }

        var user = new ApplicationUser
        {
            UserName = email,
            Email = email,
            FullName = fullName,
            ApprovalStatus = ApprovalStatus.PendingApproval,
            CreatedAtUtc = DateTime.UtcNow
        };

        var createResult = await _userManager.CreateAsync(user, request.Password);
        if (!createResult.Succeeded)
        {
            var vnDetails = IdentityErrorTranslator.ToVietnamese(createResult.Errors);
            return BadRequest(new ApiErrorResponse(
                "REGISTRATION_FAILED",
                vnDetails.FirstOrDefault() ?? "Không thể đăng ký tài khoản.",
                vnDetails));
        }

        await _signInManager.SignInAsync(user, isPersistent: false);
        HttpContext.User = await _signInManager.CreateUserPrincipalAsync(user);
        var csrfToken = _antiforgery.GetAndStoreTokens(HttpContext).RequestToken;

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "auth.register",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: user.Id,
            ActorEmail: user.Email,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { email = user.Email, fullName = user.FullName, approvalStatus = "PendingApproval" }), ct);

        var me = await BuildAuthMeResponseAsync(user, csrfToken, ct);
        return StatusCode(StatusCodes.Status201Created, me);
    }

    [HttpPost("login")]
    [AllowAnonymous]
    public async Task<IActionResult> Login([FromBody] LoginRequest request, CancellationToken ct)
    {
        var email = request.Email?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrEmpty(request.Password))
        {
            return BadRequest(new ApiErrorResponse(
                "VALIDATION_ERROR",
                "Vui lòng nhập đầy đủ email và mật khẩu."));
        }

        var user = await _userManager.FindByEmailAsync(email);
        if (user is null)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.login",
                EntityType: "User",
                Outcome: AuditOutcome.Failed,
                ActorEmail: email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { email, reason = "USER_NOT_FOUND" }), ct);

            return Unauthorized(new ApiErrorResponse(
                "INVALID_CREDENTIALS",
                "Email hoặc mật khẩu không chính xác."));
        }

        if (user.ApprovalStatus == ApprovalStatus.Locked)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.login",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "ACCOUNT_LOCKED" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "ACCOUNT_LOCKED",
                "Tài khoản đã bị khóa bởi quản trị viên."));
        }

        if (await _userManager.IsLockedOutAsync(user))
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.login",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "LOCKOUT_ACTIVE" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "ACCOUNT_LOCKED_OUT",
                "Tài khoản tạm thời bị khóa do đăng nhập sai quá số lần quy định. Vui lòng thử lại sau."));
        }

        var signInResult = await _signInManager.PasswordSignInAsync(
            user,
            request.Password,
            request.RememberMe,
            lockoutOnFailure: true);

        if (signInResult.IsLockedOut)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.login",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "LOCKOUT_TRIGGERED" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "ACCOUNT_LOCKED_OUT",
                "Tài khoản đã bị tạm khóa 15 phút do nhập sai mật khẩu liên tiếp."));
        }

        if (signInResult.RequiresTwoFactor)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.login.2fa_required",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Success,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent()), ct);

            return Ok(new LoginResponse(RequiresTwoFactor: true, User: null));
        }

        if (!signInResult.Succeeded)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.login",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Failed,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "INVALID_PASSWORD" }), ct);

            return Unauthorized(new ApiErrorResponse(
                "INVALID_CREDENTIALS",
                "Email hoặc mật khẩu không chính xác."));
        }

        HttpContext.User = await _signInManager.CreateUserPrincipalAsync(user);
        var csrfToken = _antiforgery.GetAndStoreTokens(HttpContext).RequestToken;

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "auth.login",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: user.Id,
            ActorEmail: user.Email,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent()), ct);

        var me = await BuildAuthMeResponseAsync(user, csrfToken, ct);
        return Ok(new LoginResponse(RequiresTwoFactor: false, User: me, CsrfToken: csrfToken));
    }

    [HttpPost("login-2fa")]
    [AllowAnonymous]
    public async Task<IActionResult> LoginTwoFactor([FromBody] Login2FaRequest request, CancellationToken ct)
    {
        var user = await _signInManager.GetTwoFactorAuthenticationUserAsync();
        if (user is null)
        {
            return Unauthorized(new ApiErrorResponse(
                "TWO_FACTOR_SESSION_EXPIRED",
                "Phiên xác thực hai lớp không tồn tại hoặc đã hết hạn. Vui lòng đăng nhập lại."));
        }

        if (user.ApprovalStatus == ApprovalStatus.Locked || await _userManager.IsLockedOutAsync(user))
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "ACCOUNT_LOCKED",
                "Tài khoản đang bị khóa."));
        }

        var normalizedCode = (request.Code ?? string.Empty)
            .Replace(" ", string.Empty)
            .Replace("-", string.Empty)
            .Trim();

        if (string.IsNullOrEmpty(normalizedCode))
        {
            return BadRequest(new ApiErrorResponse(
                "VALIDATION_ERROR",
                "Vui lòng nhập mã xác thực hai lớp."));
        }

        Microsoft.AspNetCore.Identity.SignInResult result;
        if (request.UseRecoveryCode)
        {
            // Identity recovery codes may contain a hyphen in original format or cleaned format
            var rawTrimmed = (request.Code ?? string.Empty).Trim();
            result = await _signInManager.TwoFactorRecoveryCodeSignInAsync(rawTrimmed);
            if (!result.Succeeded && rawTrimmed != normalizedCode)
            {
                result = await _signInManager.TwoFactorRecoveryCodeSignInAsync(normalizedCode);
            }
        }
        else
        {
            result = await _signInManager.TwoFactorAuthenticatorSignInAsync(
                normalizedCode,
                request.RememberMe,
                rememberClient: false);
        }

        if (result.IsLockedOut)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.login_2fa",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "LOCKOUT_TRIGGERED", useRecoveryCode = request.UseRecoveryCode }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "ACCOUNT_LOCKED_OUT",
                "Tài khoản đã bị tạm khóa do nhập sai mã xác thực nhiều lần."));
        }

        if (!result.Succeeded)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.login_2fa",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Failed,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { useRecoveryCode = request.UseRecoveryCode }), ct);

            return Unauthorized(new ApiErrorResponse(
                "INVALID_2FA_CODE",
                "Mã xác thực hai lớp không hợp lệ."));
        }

        HttpContext.User = await _signInManager.CreateUserPrincipalAsync(user);
        var csrfToken = _antiforgery.GetAndStoreTokens(HttpContext).RequestToken;

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "auth.login_2fa",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: user.Id,
            ActorEmail: user.Email,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { useRecoveryCode = request.UseRecoveryCode }), ct);

        var me = await BuildAuthMeResponseAsync(user, csrfToken, ct);
        return Ok(new LoginResponse(RequiresTwoFactor: false, User: me, CsrfToken: csrfToken));
    }

    [HttpPost("logout")]
    [Authorize]
    public async Task<IActionResult> Logout(CancellationToken ct)
    {
        var userId = HttpContext.TryGetUserId();
        var email = HttpContext.GetUserEmail();

        await _signInManager.SignOutAsync();
        HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity());
        var csrfToken = _antiforgery.GetAndStoreTokens(HttpContext).RequestToken;

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "auth.logout",
            EntityType: "User",
            EntityId: userId?.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: userId,
            ActorEmail: email,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent()), ct);

        return Ok(new { message = "Đã đăng xuất thành công.", csrfToken });
    }

    [HttpGet("me")]
    [Authorize]
    public async Task<ActionResult<AuthMeResponse>> GetMe(CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var user = await _userManager.FindByIdAsync(userId.ToString());
        if (user is null)
        {
            return Unauthorized(new ApiErrorResponse(
                "UNAUTHORIZED",
                "Không tìm thấy thông tin người dùng."));
        }

        var csrfToken = _antiforgery.GetAndStoreTokens(HttpContext).RequestToken;
        var response = await BuildAuthMeResponseAsync(user, csrfToken, ct);
        return Ok(response);
    }

    [HttpPost("forgot-password")]
    [AllowAnonymous]
    public async Task<IActionResult> ForgotPassword([FromBody] ForgotPasswordRequest request, CancellationToken ct)
    {
        var email = request.Email?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(email))
        {
            return BadRequest(new ApiErrorResponse(
                "VALIDATION_ERROR",
                "Vui lòng nhập địa chỉ email."));
        }

        if (!_emailSender.IsConfigured)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.forgot_password",
                EntityType: "User",
                Outcome: AuditOutcome.Denied,
                ActorEmail: email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { email, reason = "SMTP_NOT_CONFIGURED" }), ct);

            return StatusCode(StatusCodes.Status503ServiceUnavailable, new ApiErrorResponse(
                "SMTP_NOT_CONFIGURED",
                "Hệ thống chưa cấu hình máy chủ email (SMTP). Vui lòng liên hệ Quản trị viên để được cấp mã đặt lại mật khẩu một lần."));
        }

        var user = await _userManager.FindByEmailAsync(email);
        if (user is not null && user.ApprovalStatus != ApprovalStatus.Locked)
        {
            var resetToken = await _userManager.GeneratePasswordResetTokenAsync(user);
            await _emailSender.SendPasswordResetEmailAsync(user.Email!, user.FullName, resetToken, ct);

            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.forgot_password",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Success,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { delivery = "smtp" }), ct);
        }

        return Ok(new
        {
            message = "Nếu địa chỉ email tồn tại trong hệ thống, hướng dẫn đặt lại mật khẩu đã được gửi."
        });
    }

    [HttpPost("reset-password")]
    [AllowAnonymous]
    public async Task<IActionResult> ResetPassword([FromBody] ResetPasswordRequest request, CancellationToken ct)
    {
        var email = request.Email?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(request.Token))
        {
            return BadRequest(new ApiErrorResponse(
                "VALIDATION_ERROR",
                "Vui lòng cung cấp đầy đủ email và mã đặt lại mật khẩu."));
        }

        if (string.IsNullOrEmpty(request.NewPassword) || request.NewPassword != request.ConfirmPassword)
        {
            return BadRequest(new ApiErrorResponse(
                "PASSWORD_CONFIRM_MISMATCH",
                "Mật khẩu xác nhận không khớp."));
        }

        var user = await _userManager.FindByEmailAsync(email);
        if (user is null || user.ApprovalStatus == ApprovalStatus.Locked)
        {
            return BadRequest(new ApiErrorResponse(
                "RESET_PASSWORD_FAILED",
                "Mã đặt lại mật khẩu không hợp lệ hoặc tài khoản không khả dụng."));
        }

        var resetResult = await _userManager.ResetPasswordAsync(user, request.Token.Trim(), request.NewPassword);
        if (!resetResult.Succeeded)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "auth.reset_password",
                EntityType: "User",
                EntityId: user.Id.ToString(),
                Outcome: AuditOutcome.Failed,
                ActorUserId: user.Id,
                ActorEmail: user.Email,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent()), ct);

            var details = IdentityErrorTranslator.ToVietnamese(resetResult.Errors);
            return BadRequest(new ApiErrorResponse(
                "RESET_PASSWORD_FAILED",
                details.FirstOrDefault() ?? "Không thể đặt lại mật khẩu.",
                details));
        }

        user.ForcePasswordReset = false;
        await _userManager.UpdateAsync(user);
        await _userManager.UpdateSecurityStampAsync(user);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "auth.reset_password",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: user.Id,
            ActorEmail: user.Email,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent()), ct);

        return Ok(new { message = "Đặt lại mật khẩu thành công. Vui lòng đăng nhập bằng mật khẩu mới." });
    }

    private async Task<AuthMeResponse> BuildAuthMeResponseAsync(
        ApplicationUser user,
        string? csrfToken,
        CancellationToken ct)
    {
        var effective = await _scopeAuth.GetEffectiveAccessAsync(user.Id, ct);

        var grantDtos = effective.Grants
            .Select(g => new UserGrantDto(
                g.GrantId,
                g.RoleId,
                g.RoleName,
                g.ScopeType,
                g.ShopId,
                g.ShopName,
                g.WarehouseId,
                g.WarehouseName))
            .ToList();

        var permissions = effective.AllPermissions
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToList();

        var runtimeConfig = new RuntimeConfigDto(
            StorageMode: _options.StorageMode,
            MaxRecordingSeconds: _options.MaxRecordingSeconds,
            MaxUploadBytes: _options.MaxUploadBytes,
            MaxLocalPendingRecordings: _options.MaxLocalPendingRecordings,
            UploadChunkBytes: _options.UploadChunkBytes,
            EnableAudioRecording: _options.EnableAudioRecording,
            SmtpConfigured: _options.IsSmtpConfigured);

        return new AuthMeResponse(
            Id: user.Id,
            Email: user.Email ?? string.Empty,
            FullName: user.FullName,
            ApprovalStatus: user.ApprovalStatus,
            TwoFactorEnabled: user.TwoFactorEnabled,
            ForcePasswordReset: user.ForcePasswordReset,
            IsSuperAdmin: effective.IsSuperAdmin,
            DefaultShopId: user.DefaultShopId,
            DefaultWarehouseId: user.DefaultWarehouseId,
            Permissions: permissions,
            Grants: grantDtos,
            RuntimeConfig: runtimeConfig,
            CsrfToken: csrfToken);
    }
}

