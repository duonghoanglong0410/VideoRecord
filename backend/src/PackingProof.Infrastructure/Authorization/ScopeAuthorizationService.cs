using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Infrastructure.Authorization;

public sealed class ScopeAuthorizationService : IScopeAuthorizationService
{
    private readonly PackingProofDbContext _db;

    public ScopeAuthorizationService(PackingProofDbContext db)
    {
        _db = db;
    }

    public async Task<bool> HasPermissionAsync(
        ClaimsPrincipal principal,
        string permissionCode,
        ResourceScopeContext resource,
        CancellationToken ct = default)
    {
        if (principal.Identity?.IsAuthenticated != true)
        {
            return false;
        }

        var idClaim = principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (!Guid.TryParse(idClaim, out var userId))
        {
            return false;
        }

        return await HasPermissionAsync(userId, permissionCode, resource, ct);
    }

    public async Task<bool> HasPermissionAsync(
        Guid userId,
        string permissionCode,
        ResourceScopeContext resource,
        CancellationToken ct = default)
    {
        if (userId == Guid.Empty || !PermissionCatalog.IsValid(permissionCode))
        {
            return false;
        }

        var access = await GetEffectiveAccessAsync(userId, ct);
        if (!access.IsActive || !access.AllPermissions.Contains(permissionCode))
        {
            return false;
        }

        var effectiveShopId = resource.ShopId;
        if (effectiveShopId is null && resource.WarehouseId.HasValue)
        {
            effectiveShopId = await _db.Warehouses
                .AsNoTracking()
                .Where(w => w.Id == resource.WarehouseId.Value)
                .Select(w => (Guid?)w.ShopId)
                .FirstOrDefaultAsync(ct);
        }

        foreach (var grant in access.Grants)
        {
            if (!grant.Permissions.Contains(permissionCode, StringComparer.Ordinal))
            {
                continue;
            }

            switch (grant.ScopeType)
            {
                case ScopeType.All:
                    if (string.Equals(grant.RoleName, SystemRoles.SuperAdmin, StringComparison.Ordinal))
                    {
                        return true;
                    }
                    break;

                case ScopeType.Shop:
                    if (grant.ShopId.HasValue &&
                        effectiveShopId.HasValue &&
                        grant.ShopId.Value == effectiveShopId.Value)
                    {
                        return true;
                    }
                    break;

                case ScopeType.Warehouse:
                    if (grant.WarehouseId.HasValue &&
                        resource.WarehouseId.HasValue &&
                        grant.WarehouseId.Value == resource.WarehouseId.Value)
                    {
                        return true;
                    }
                    break;

                case ScopeType.Own:
                    if (!resource.OwnerUserId.HasValue || resource.OwnerUserId.Value != userId)
                    {
                        break;
                    }

                    if (grant.WarehouseId.HasValue &&
                        resource.WarehouseId.HasValue &&
                        grant.WarehouseId.Value != resource.WarehouseId.Value)
                    {
                        break;
                    }

                    if (grant.ShopId.HasValue &&
                        effectiveShopId.HasValue &&
                        grant.ShopId.Value != effectiveShopId.Value)
                    {
                        break;
                    }

                    return true;
            }
        }

        return false;
    }

    public async Task<bool> HasAnyScopeForPermissionAsync(
        Guid userId,
        string permissionCode,
        CancellationToken ct = default)
    {
        if (userId == Guid.Empty || !PermissionCatalog.IsValid(permissionCode))
        {
            return false;
        }

        var access = await GetEffectiveAccessAsync(userId, ct);
        return access.IsActive && access.AllPermissions.Contains(permissionCode);
    }

    public async Task<UserEffectiveAccess> GetEffectiveAccessAsync(
        Guid userId,
        CancellationToken ct = default)
    {
        if (userId == Guid.Empty)
        {
            return EmptyAccess(userId);
        }

        var user = await _db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == userId, ct);

        if (user is null ||
            user.ApprovalStatus != ApprovalStatus.Active ||
            (user.LockoutEnd.HasValue && user.LockoutEnd.Value > DateTimeOffset.UtcNow))
        {
            return EmptyAccess(userId);
        }

        var rawGrants = await _db.UserScopeGrants
            .AsNoTracking()
            .Include(g => g.Role)
                .ThenInclude(r => r.RolePermissions)
            .Include(g => g.Shop)
            .Include(g => g.Warehouse)
                .ThenInclude(w => w!.Shop)
            .Where(g => g.UserId == userId)
            .ToListAsync(ct);

        var allPermissions = new HashSet<string>(StringComparer.Ordinal);
        var grants = new List<EffectiveGrantInfo>(rawGrants.Count);
        var isSuperAdmin = false;

        foreach (var g in rawGrants)
        {
            var roleName = g.Role.Name ?? string.Empty;

            // ScopeType.All is strictly valid only for SuperAdmin
            if (g.ScopeType == ScopeType.All &&
                !string.Equals(roleName, SystemRoles.SuperAdmin, StringComparison.Ordinal))
            {
                continue;
            }

            if (g.ScopeType == ScopeType.All &&
                string.Equals(roleName, SystemRoles.SuperAdmin, StringComparison.Ordinal))
            {
                isSuperAdmin = true;
            }

            var perms = g.Role.RolePermissions
                .Select(rp => rp.PermissionCode)
                .Where(PermissionCatalog.IsValid)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(p => p, StringComparer.Ordinal)
                .ToList();

            foreach (var p in perms)
            {
                allPermissions.Add(p);
            }

            var resolvedShopId = g.ShopId ?? g.Warehouse?.ShopId;
            var resolvedShopName = g.Shop?.Name ?? g.Warehouse?.Shop?.Name;

            grants.Add(new EffectiveGrantInfo(
                g.Id,
                g.RoleId,
                roleName,
                g.ScopeType,
                resolvedShopId,
                resolvedShopName,
                g.WarehouseId,
                g.Warehouse?.Name,
                perms));
        }

        return new UserEffectiveAccess(
            userId,
            IsActive: true,
            IsSuperAdmin: isSuperAdmin,
            AllPermissions: allPermissions,
            Grants: grants);
    }

    private static UserEffectiveAccess EmptyAccess(Guid userId) =>
        new(
            userId,
            IsActive: false,
            IsSuperAdmin: false,
            AllPermissions: new HashSet<string>(StringComparer.Ordinal),
            Grants: []);
}

