using PackingProof.Core.Enums;

namespace PackingProof.Api.Features.Auth;

public sealed record CsrfTokenResponse(string Token);

public sealed record RegisterRequest(
    string? Name,
    string? FullName,
    string Email,
    string Password,
    string ConfirmPassword)
{
    public string ResolvedName =>
        !string.IsNullOrWhiteSpace(Name)
            ? Name.Trim()
            : FullName?.Trim() ?? string.Empty;
}

public sealed record LoginRequest(
    string Email,
    string Password,
    bool RememberMe = false);

public sealed record Login2FaRequest(
    string Code,
    bool UseRecoveryCode = false,
    bool RememberMe = false);

public sealed record LoginResponse(
    bool RequiresTwoFactor,
    AuthMeResponse? User,
    string? CsrfToken = null);

public sealed record ForgotPasswordRequest(string Email);

public sealed record ResetPasswordRequest(
    string Email,
    string Token,
    string NewPassword,
    string ConfirmPassword);

public sealed record MfaSetupResponse(
    string SharedKey,
    string AuthenticatorUri);

public sealed record MfaEnableRequest(string Code);

public sealed record MfaEnableResponse(
    bool Enabled,
    IReadOnlyList<string> RecoveryCodes);

public sealed record MfaDisableRequest(string CurrentPassword);

public sealed record MfaRecoveryCodesRequest(string CurrentPassword);

public sealed record MfaRecoveryCodesResponse(IReadOnlyList<string> RecoveryCodes);

public sealed record UserGrantDto(
    Guid Id,
    Guid RoleId,
    string RoleName,
    ScopeType ScopeType,
    Guid? ShopId,
    string? ShopName,
    Guid? WarehouseId,
    string? WarehouseName);

public sealed record RuntimeConfigDto(
    StorageMode StorageMode,
    int MaxRecordingSeconds,
    long MaxUploadBytes,
    int MaxLocalPendingRecordings,
    int UploadChunkBytes,
    bool EnableAudioRecording,
    bool SmtpConfigured);

public sealed record AuthMeResponse(
    Guid Id,
    string Email,
    string FullName,
    ApprovalStatus ApprovalStatus,
    bool TwoFactorEnabled,
    bool ForcePasswordReset,
    bool IsSuperAdmin,
    Guid? DefaultShopId,
    Guid? DefaultWarehouseId,
    IReadOnlyList<string> Permissions,
    IReadOnlyList<UserGrantDto> Grants,
    RuntimeConfigDto RuntimeConfig,
    string? CsrfToken = null);

