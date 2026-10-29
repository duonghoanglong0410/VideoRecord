using System.Security.Claims;
using PackingProof.Core.Enums;

namespace PackingProof.Core.Abstractions;

public sealed record ResourceScopeContext(
    Guid? OwnerUserId = null,
    Guid? ShopId = null,
    Guid? WarehouseId = null);

public sealed record EffectiveGrantInfo(
    Guid GrantId,
    Guid RoleId,
    string RoleName,
    ScopeType ScopeType,
    Guid? ShopId,
    string? ShopName,
    Guid? WarehouseId,
    string? WarehouseName,
    IReadOnlyList<string> Permissions);

public sealed record UserEffectiveAccess(
    Guid UserId,
    bool IsActive,
    bool IsSuperAdmin,
    IReadOnlySet<string> AllPermissions,
    IReadOnlyList<EffectiveGrantInfo> Grants);

public interface IScopeAuthorizationService
{
    Task<bool> HasPermissionAsync(
        Guid userId,
        string permissionCode,
        ResourceScopeContext resource,
        CancellationToken ct = default);

    Task<bool> HasPermissionAsync(
        ClaimsPrincipal principal,
        string permissionCode,
        ResourceScopeContext resource,
        CancellationToken ct = default);

    Task<bool> HasAnyScopeForPermissionAsync(
        Guid userId,
        string permissionCode,
        CancellationToken ct = default);

    Task<UserEffectiveAccess> GetEffectiveAccessAsync(
        Guid userId,
        CancellationToken ct = default);
}

