using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;

namespace PackingProof.Api.Common;

public static class ScopeQueryExtensions
{
    public static bool TryApplyRecordingPermissionScope(
        IQueryable<Recording> source,
        UserEffectiveAccess access,
        string permissionCode,
        out IQueryable<Recording> scopedQuery)
    {
        scopedQuery = source;

        if (!access.IsActive || !access.AllPermissions.Contains(permissionCode))
        {
            return false;
        }

        if (access.IsSuperAdmin &&
            access.Grants.Any(g =>
                g.ScopeType == ScopeType.All &&
                string.Equals(g.RoleName, SystemRoles.SuperAdmin, StringComparison.Ordinal) &&
                g.Permissions.Contains(permissionCode, StringComparer.Ordinal)))
        {
            return true;
        }

        var shopIds = new HashSet<Guid>();
        var warehouseIds = new HashSet<Guid>();
        var ownShopIds = new HashSet<Guid>();
        var ownWarehouseIds = new HashSet<Guid>();
        var hasUnrestrictedOwn = false;

        foreach (var grant in access.Grants)
        {
            if (!grant.Permissions.Contains(permissionCode, StringComparer.Ordinal))
            {
                continue;
            }

            switch (grant.ScopeType)
            {
                case ScopeType.Shop when grant.ShopId.HasValue:
                    shopIds.Add(grant.ShopId.Value);
                    break;

                case ScopeType.Warehouse when grant.WarehouseId.HasValue:
                    warehouseIds.Add(grant.WarehouseId.Value);
                    break;

                case ScopeType.Own:
                    if (grant.WarehouseId.HasValue)
                    {
                        ownWarehouseIds.Add(grant.WarehouseId.Value);
                    }
                    else if (grant.ShopId.HasValue)
                    {
                        ownShopIds.Add(grant.ShopId.Value);
                    }
                    else
                    {
                        hasUnrestrictedOwn = true;
                    }
                    break;
            }
        }

        if (shopIds.Count == 0 &&
            warehouseIds.Count == 0 &&
            ownShopIds.Count == 0 &&
            ownWarehouseIds.Count == 0 &&
            !hasUnrestrictedOwn)
        {
            return false;
        }

        var userId = access.UserId;
        var shopList = shopIds.ToList();
        var whList = warehouseIds.ToList();
        var ownShopList = ownShopIds.ToList();
        var ownWhList = ownWarehouseIds.ToList();

        scopedQuery = source.Where(r =>
            shopList.Contains(r.ShopId) ||
            whList.Contains(r.WarehouseId) ||
            (hasUnrestrictedOwn && r.OwnerUserId == userId) ||
            (r.OwnerUserId == userId && ownShopList.Contains(r.ShopId)) ||
            (r.OwnerUserId == userId && ownWhList.Contains(r.WarehouseId)));

        return true;
    }

    public static bool HasEffectivePermissionInMemory(
        UserEffectiveAccess access,
        string permissionCode,
        ResourceScopeContext resource)
    {
        if (!access.IsActive || !access.AllPermissions.Contains(permissionCode))
        {
            return false;
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
                        resource.ShopId.HasValue &&
                        grant.ShopId.Value == resource.ShopId.Value)
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
                    if (!resource.OwnerUserId.HasValue || resource.OwnerUserId.Value != access.UserId)
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
                        resource.ShopId.HasValue &&
                        grant.ShopId.Value != resource.ShopId.Value)
                    {
                        break;
                    }

                    return true;
            }
        }

        return false;
    }

    public static string EscapeLikePattern(string input) =>
        input
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("%", "\\%", StringComparison.Ordinal)
            .Replace("_", "\\_", StringComparison.Ordinal);
}
