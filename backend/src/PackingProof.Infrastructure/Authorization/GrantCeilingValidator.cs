using Microsoft.EntityFrameworkCore;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Infrastructure.Authorization;

public sealed class GrantCeilingValidator : IGrantCeilingValidator
{
    private readonly PackingProofDbContext _db;
    private readonly IScopeAuthorizationService _scopeAuth;

    public GrantCeilingValidator(
        PackingProofDbContext db,
        IScopeAuthorizationService scopeAuth)
    {
        _db = db;
        _scopeAuth = scopeAuth;
    }

    public async Task<GrantValidationResult> ValidateRoleAssignmentAsync(
        Guid actorUserId,
        Guid targetUserId,
        Guid roleId,
        ScopeType scopeType,
        Guid? shopId,
        Guid? warehouseId,
        CancellationToken ct = default)
    {
        var actorAccess = await _scopeAuth.GetEffectiveAccessAsync(actorUserId, ct);
        if (!actorAccess.IsActive || !actorAccess.AllPermissions.Contains(PermissionCatalog.UserManage))
        {
            return GrantValidationResult.Denied(
                "FORBIDDEN_USER_MANAGE",
                "Bạn không có quyền quản lý người dùng.");
        }

        var targetUser = await _db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == targetUserId, ct);

        if (targetUser is null)
        {
            return GrantValidationResult.Denied(
                "TARGET_USER_NOT_FOUND",
                "Không tìm thấy người dùng mục tiêu.");
        }

        var targetIsSuperAdmin = await UserHasSuperAdminGrantAsync(targetUserId, ct);
        if (targetIsSuperAdmin && !actorAccess.IsSuperAdmin)
        {
            return GrantValidationResult.Denied(
                "CANNOT_MANAGE_SUPERADMIN",
                "Bạn không có quyền thay đổi phân quyền của tài khoản SuperAdmin.");
        }

        var proposedRole = await _db.Roles
            .AsNoTracking()
            .Include(r => r.RolePermissions)
            .FirstOrDefaultAsync(r => r.Id == roleId, ct);

        if (proposedRole is null)
        {
            return GrantValidationResult.Denied(
                "ROLE_NOT_FOUND",
                "Vai trò được chọn không tồn tại.");
        }

        if (targetIsSuperAdmin &&
            !string.Equals(proposedRole.Name, SystemRoles.SuperAdmin, StringComparison.Ordinal))
        {
            var otherActiveSuperAdmins = await CountOtherActiveSuperAdminsAsync(targetUserId, ct);
            if (otherActiveSuperAdmins == 0)
            {
                return GrantValidationResult.Denied(
                    "LAST_SUPERADMIN_PROTECTED",
                    "Không thể hạ quyền của SuperAdmin hoạt động cuối cùng trong hệ thống.");
            }
        }

        if (actorUserId == targetUserId)
        {
            return GrantValidationResult.Denied(
                "SELF_ESCALATION_FORBIDDEN",
                "Không được phép tự cấp hoặc tự thay đổi quyền của chính mình.");
        }

        return await ValidateSingleProposalAsync(
            actorAccess,
            new GrantProposal(roleId, scopeType, shopId, warehouseId),
            ct);
    }

    public async Task<GrantValidationResult> ValidateGrantsAssignmentAsync(
        Guid actorUserId,
        Guid targetUserId,
        IReadOnlyList<GrantProposal> proposedGrants,
        CancellationToken ct = default)
    {
        var actorAccess = await _scopeAuth.GetEffectiveAccessAsync(actorUserId, ct);
        if (!actorAccess.IsActive || !actorAccess.AllPermissions.Contains(PermissionCatalog.UserManage))
        {
            return GrantValidationResult.Denied(
                "FORBIDDEN_USER_MANAGE",
                "Bạn không có quyền quản lý người dùng.");
        }

        var targetUser = await _db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == targetUserId, ct);

        if (targetUser is null)
        {
            return GrantValidationResult.Denied(
                "TARGET_USER_NOT_FOUND",
                "Không tìm thấy người dùng mục tiêu.");
        }

        var existingGrants = await _db.UserScopeGrants
            .AsNoTracking()
            .Include(g => g.Role)
                .ThenInclude(r => r.RolePermissions)
            .Include(g => g.Warehouse)
            .Where(g => g.UserId == targetUserId)
            .ToListAsync(ct);

        var targetIsSuperAdmin = existingGrants.Any(g =>
            g.ScopeType == ScopeType.All &&
            string.Equals(g.Role.Name, SystemRoles.SuperAdmin, StringComparison.Ordinal));

        if (targetIsSuperAdmin && !actorAccess.IsSuperAdmin)
        {
            return GrantValidationResult.Denied(
                "CANNOT_MANAGE_SUPERADMIN",
                "Bạn không có quyền thay đổi phân quyền của tài khoản SuperAdmin.");
        }

        if (targetIsSuperAdmin)
        {
            var superAdminRoleId = existingGrants
                .First(g => string.Equals(g.Role.Name, SystemRoles.SuperAdmin, StringComparison.Ordinal))
                .RoleId;

            var retainsSuperAdmin = proposedGrants.Any(p =>
                p.RoleId == superAdminRoleId && p.ScopeType == ScopeType.All);

            if (!retainsSuperAdmin)
            {
                var otherActiveSuperAdmins = await CountOtherActiveSuperAdminsAsync(targetUserId, ct);
                if (otherActiveSuperAdmins == 0)
                {
                    return GrantValidationResult.Denied(
                        "LAST_SUPERADMIN_PROTECTED",
                        "Không thể gỡ vai trò hoặc hạ quyền SuperAdmin hoạt động cuối cùng trong hệ thống.");
                }
            }
        }

        if (actorUserId == targetUserId)
        {
            return GrantValidationResult.Denied(
                "SELF_ESCALATION_FORBIDDEN",
                "Không được phép tự cấp hoặc tự thay đổi quyền của chính mình.");
        }

        // Verify actor can manage any existing grants that are being removed
        foreach (var existing in existingGrants)
        {
            var existingShopId = existing.ShopId ?? existing.Warehouse?.ShopId;
            var stillPresent = proposedGrants.Any(p =>
                p.RoleId == existing.RoleId &&
                p.ScopeType == existing.ScopeType &&
                (p.ShopId ?? existingShopId) == existingShopId &&
                p.WarehouseId == existing.WarehouseId);

            if (!stillPresent)
            {
                var removalCheck = await ValidateSingleProposalAsync(
                    actorAccess,
                    new GrantProposal(existing.RoleId, existing.ScopeType, existingShopId, existing.WarehouseId),
                    ct);

                if (!removalCheck.IsAllowed)
                {
                    return GrantValidationResult.Denied(
                        "OUT_OF_SCOPE_GRANT_REMOVAL",
                        "Bạn không có quyền gỡ phân quyền nằm ngoài phạm vi hoặc vượt trần quyền của mình.");
                }
            }
        }

        // Verify every proposed grant
        foreach (var proposal in proposedGrants)
        {
            var check = await ValidateSingleProposalAsync(actorAccess, proposal, ct);
            if (!check.IsAllowed)
            {
                return check;
            }
        }

        return GrantValidationResult.Allowed();
    }

    public async Task<GrantValidationResult> ValidateUserManagementActionAsync(
        Guid actorUserId,
        Guid targetUserId,
        string actionType,
        CancellationToken ct = default)
    {
        var actorAccess = await _scopeAuth.GetEffectiveAccessAsync(actorUserId, ct);
        if (!actorAccess.IsActive || !actorAccess.AllPermissions.Contains(PermissionCatalog.UserManage))
        {
            return GrantValidationResult.Denied(
                "FORBIDDEN_USER_MANAGE",
                "Bạn không có quyền quản lý tài khoản người dùng.");
        }

        var targetUser = await _db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == targetUserId, ct);

        if (targetUser is null)
        {
            return GrantValidationResult.Denied(
                "TARGET_USER_NOT_FOUND",
                "Không tìm thấy người dùng mục tiêu.");
        }

        var targetIsSuperAdmin = await UserHasSuperAdminGrantAsync(targetUserId, ct);
        if (targetIsSuperAdmin && !actorAccess.IsSuperAdmin)
        {
            return GrantValidationResult.Denied(
                "CANNOT_MANAGE_SUPERADMIN",
                "Bạn không có quyền thao tác trên tài khoản SuperAdmin.");
        }

        var normalizedAction = actionType.Trim().ToLowerInvariant();
        if (normalizedAction is "lock" or "delete" or "demote")
        {
            if (targetIsSuperAdmin)
            {
                var otherActiveSuperAdmins = await CountOtherActiveSuperAdminsAsync(targetUserId, ct);
                if (otherActiveSuperAdmins == 0)
                {
                    return GrantValidationResult.Denied(
                        "LAST_SUPERADMIN_PROTECTED",
                        "Không thể khóa, xóa hoặc hạ quyền SuperAdmin hoạt động cuối cùng trong hệ thống.");
                }
            }

            if (actorUserId == targetUserId)
            {
                return GrantValidationResult.Denied(
                    "SELF_ACTION_FORBIDDEN",
                    "Không thể tự khóa hoặc xóa tài khoản đang đăng nhập của chính mình.");
            }
        }

        if (normalizedAction == "approve" && actorUserId == targetUserId)
        {
            return GrantValidationResult.Denied(
                "SELF_APPROVAL_FORBIDDEN",
                "Không thể tự phê duyệt tài khoản của chính mình.");
        }

        if (actorAccess.IsSuperAdmin)
        {
            return GrantValidationResult.Allowed();
        }

        // Actor must have user.manage on at least one non-Own scope
        var actorManageGrants = actorAccess.Grants
            .Where(g => g.ScopeType != ScopeType.Own &&
                        g.Permissions.Contains(PermissionCatalog.UserManage, StringComparer.Ordinal))
            .ToList();

        if (actorManageGrants.Count == 0)
        {
            return GrantValidationResult.Denied(
                "FORBIDDEN_USER_MANAGE_SCOPE",
                "Phạm vi quyền của bạn không cho phép quản lý người dùng khác.");
        }

        var targetGrants = await _db.UserScopeGrants
            .AsNoTracking()
            .Include(g => g.Warehouse)
            .Where(g => g.UserId == targetUserId)
            .ToListAsync(ct);

        if (targetGrants.Count == 0)
        {
            // PendingApproval or unassigned user: check DefaultShopId if set
            if (targetUser.DefaultShopId.HasValue)
            {
                var coversDefaultShop = actorManageGrants.Any(ag =>
                    (ag.ScopeType == ScopeType.Shop && ag.ShopId == targetUser.DefaultShopId) ||
                    (ag.ScopeType == ScopeType.Warehouse && ag.ShopId == targetUser.DefaultShopId));

                if (!coversDefaultShop)
                {
                    return GrantValidationResult.Denied(
                        "OUT_OF_SCOPE_USER",
                        "Người dùng thuộc shop ngoài phạm vi quản lý của bạn.");
                }
            }

            return GrantValidationResult.Allowed();
        }

        // For users with existing grants, every grant of target user must fall within actor's user.manage scopes,
        // or at minimum target must belong to actor's managed shop/warehouse and not exclusively outside it.
        var allTargetScopesCovered = targetGrants.All(tg =>
        {
            var tgShopId = tg.ShopId ?? tg.Warehouse?.ShopId;
            return actorManageGrants.Any(ag => ActorGrantCoversTargetScope(ag, tg.ScopeType, tgShopId, tg.WarehouseId));
        });

        if (!allTargetScopesCovered)
        {
            return GrantValidationResult.Denied(
                "OUT_OF_SCOPE_USER",
                "Người dùng này có phân quyền ngoài phạm vi quản lý của bạn.");
        }

        return GrantValidationResult.Allowed();
    }

    public async Task<GrantValidationResult> ValidateCustomRoleAsync(
        Guid actorUserId,
        Guid? existingRoleId,
        IReadOnlyCollection<string> permissionCodes,
        CancellationToken ct = default)
    {
        var actorAccess = await _scopeAuth.GetEffectiveAccessAsync(actorUserId, ct);
        if (!actorAccess.IsActive || !actorAccess.AllPermissions.Contains(PermissionCatalog.RoleManage))
        {
            return GrantValidationResult.Denied(
                "FORBIDDEN_ROLE_MANAGE",
                "Bạn không có quyền quản lý vai trò.");
        }

        var roleManageGrants = actorAccess.Grants
            .Where(g => g.ScopeType != ScopeType.Own &&
                        g.Permissions.Contains(PermissionCatalog.RoleManage, StringComparer.Ordinal))
            .ToList();

        if (roleManageGrants.Count == 0)
        {
            return GrantValidationResult.Denied(
                "FORBIDDEN_ROLE_MANAGE_SCOPE",
                "Phạm vi của bạn không cho phép tạo hoặc chỉnh sửa vai trò.");
        }

        if (permissionCodes.Count == 0)
        {
            return GrantValidationResult.Denied(
                "EMPTY_ROLE_PERMISSIONS",
                "Vai trò phải có ít nhất một quyền hợp lệ.");
        }

        var invalidCodes = permissionCodes.Where(c => !PermissionCatalog.IsValid(c)).ToList();
        if (invalidCodes.Count > 0)
        {
            return GrantValidationResult.Denied(
                "INVALID_PERMISSION_CODE",
                $"Danh sách quyền chứa mã không hợp lệ: {string.Join(", ", invalidCodes)}.");
        }

        var actorCeiling = new HashSet<string>(
            roleManageGrants.SelectMany(g => g.Permissions),
            StringComparer.Ordinal);

        if (existingRoleId.HasValue)
        {
            var existingRole = await _db.Roles
                .AsNoTracking()
                .Include(r => r.RolePermissions)
                .FirstOrDefaultAsync(r => r.Id == existingRoleId.Value, ct);

            if (existingRole is null)
            {
                return GrantValidationResult.Denied(
                    "ROLE_NOT_FOUND",
                    "Không tìm thấy vai trò cần cập nhật.");
            }

            if (existingRole.IsSystemRole)
            {
                return GrantValidationResult.Denied(
                    "SYSTEM_ROLE_IMMUTABLE",
                    "Không được phép chỉnh sửa các vai trò mặc định của hệ thống.");
            }

            var existingPermsOutsideCeiling = existingRole.RolePermissions
                .Select(rp => rp.PermissionCode)
                .Where(code => !actorCeiling.Contains(code))
                .ToList();

            if (existingPermsOutsideCeiling.Count > 0)
            {
                return GrantValidationResult.Denied(
                    "GRANT_CEILING_EXCEEDED",
                    "Vai trò hiện tại chứa các quyền vượt quá trần quyền hạn của bạn.");
            }
        }

        var exceeded = permissionCodes
            .Where(code => !actorCeiling.Contains(code))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        if (exceeded.Count > 0)
        {
            return GrantValidationResult.Denied(
                "GRANT_CEILING_EXCEEDED",
                $"Không thể gán các quyền vượt quá giới hạn quyền của bạn: {string.Join(", ", exceeded)}.");
        }

        return GrantValidationResult.Allowed();
    }

    private async Task<GrantValidationResult> ValidateSingleProposalAsync(
        UserEffectiveAccess actorAccess,
        GrantProposal proposal,
        CancellationToken ct)
    {
        var role = await _db.Roles
            .AsNoTracking()
            .Include(r => r.RolePermissions)
            .FirstOrDefaultAsync(r => r.Id == proposal.RoleId, ct);

        if (role is null)
        {
            return GrantValidationResult.Denied(
                "ROLE_NOT_FOUND",
                "Vai trò được chọn không tồn tại.");
        }

        var roleName = role.Name ?? string.Empty;
        var isProposedSuperAdmin = string.Equals(roleName, SystemRoles.SuperAdmin, StringComparison.Ordinal);

        if (isProposedSuperAdmin && !actorAccess.IsSuperAdmin)
        {
            return GrantValidationResult.Denied(
                "CANNOT_GRANT_SUPERADMIN",
                "Chỉ SuperAdmin mới được phép cấp vai trò SuperAdmin.");
        }

        if (proposal.ScopeType == ScopeType.All && !isProposedSuperAdmin)
        {
            return GrantValidationResult.Denied(
                "ALL_SCOPE_RESERVED_FOR_SUPERADMIN",
                "Phạm vi toàn hệ thống (All) chỉ dành riêng cho vai trò SuperAdmin.");
        }

        if (isProposedSuperAdmin && proposal.ScopeType != ScopeType.All)
        {
            return GrantValidationResult.Denied(
                "SUPERADMIN_REQUIRES_ALL_SCOPE",
                "Vai trò SuperAdmin bắt buộc phải gắn với phạm vi toàn hệ thống (All).");
        }

        Guid? resolvedShopId = proposal.ShopId;
        Guid? resolvedWarehouseId = proposal.WarehouseId;

        switch (proposal.ScopeType)
        {
            case ScopeType.All:
                if (proposal.ShopId.HasValue || proposal.WarehouseId.HasValue)
                {
                    return GrantValidationResult.Denied(
                        "INVALID_ALL_SCOPE_TARGETS",
                        "Phạm vi All không được đính kèm Shop hoặc Kho cụ thể.");
                }
                break;

            case ScopeType.Shop:
                if (!proposal.ShopId.HasValue)
                {
                    return GrantValidationResult.Denied(
                        "SHOP_REQUIRED",
                        "Phạm vi theo Shop bắt buộc phải chọn Shop.");
                }

                if (proposal.WarehouseId.HasValue)
                {
                    return GrantValidationResult.Denied(
                        "INVALID_SHOP_SCOPE_WAREHOUSE",
                        "Phạm vi theo Shop không đi kèm Kho cụ thể.");
                }

                var shopExists = await _db.Shops
                    .AsNoTracking()
                    .AnyAsync(s => s.Id == proposal.ShopId.Value && s.IsActive, ct);

                if (!shopExists)
                {
                    return GrantValidationResult.Denied(
                        "SHOP_NOT_FOUND",
                        "Shop được chọn không tồn tại hoặc đã ngừng hoạt động.");
                }
                break;

            case ScopeType.Warehouse:
                if (!proposal.WarehouseId.HasValue)
                {
                    return GrantValidationResult.Denied(
                        "WAREHOUSE_REQUIRED",
                        "Phạm vi theo Kho bắt buộc phải chọn Kho.");
                }

                var warehouse = await _db.Warehouses
                    .AsNoTracking()
                    .FirstOrDefaultAsync(w => w.Id == proposal.WarehouseId.Value && w.IsActive, ct);

                if (warehouse is null)
                {
                    return GrantValidationResult.Denied(
                        "WAREHOUSE_NOT_FOUND",
                        "Kho được chọn không tồn tại hoặc đã ngừng hoạt động.");
                }

                if (proposal.ShopId.HasValue && proposal.ShopId.Value != warehouse.ShopId)
                {
                    return GrantValidationResult.Denied(
                        "WAREHOUSE_SHOP_MISMATCH",
                        "Kho được chọn không thuộc Shop tương ứng.");
                }

                resolvedShopId = warehouse.ShopId;
                break;

            case ScopeType.Own:
                if (proposal.WarehouseId.HasValue)
                {
                    var ownWh = await _db.Warehouses
                        .AsNoTracking()
                        .FirstOrDefaultAsync(w => w.Id == proposal.WarehouseId.Value && w.IsActive, ct);

                    if (ownWh is null)
                    {
                        return GrantValidationResult.Denied(
                            "WAREHOUSE_NOT_FOUND",
                            "Kho được chọn không tồn tại hoặc đã ngừng hoạt động.");
                    }

                    if (proposal.ShopId.HasValue && proposal.ShopId.Value != ownWh.ShopId)
                    {
                        return GrantValidationResult.Denied(
                            "WAREHOUSE_SHOP_MISMATCH",
                            "Kho được chọn không thuộc Shop tương ứng.");
                    }

                    resolvedShopId = ownWh.ShopId;
                }
                else if (proposal.ShopId.HasValue)
                {
                    var ownShopExists = await _db.Shops
                        .AsNoTracking()
                        .AnyAsync(s => s.Id == proposal.ShopId.Value && s.IsActive, ct);

                    if (!ownShopExists)
                    {
                        return GrantValidationResult.Denied(
                            "SHOP_NOT_FOUND",
                            "Shop được chọn không tồn tại hoặc đã ngừng hoạt động.");
                    }
                }
                else if (!actorAccess.IsSuperAdmin)
                {
                    return GrantValidationResult.Denied(
                        "OWN_SCOPE_REQUIRES_BOUNDARY",
                        "Quản trị viên theo phạm vi bắt buộc phải chọn Shop hoặc Kho cho quyền Own.");
                }
                break;
        }

        // Gather all permissions actor holds from grants that cover the target scope
        var coveringActorGrants = actorAccess.Grants
            .Where(ag => ActorGrantCoversTargetScope(ag, proposal.ScopeType, resolvedShopId, resolvedWarehouseId))
            .ToList();

        var actorPermissionsAtTargetScope = new HashSet<string>(
            coveringActorGrants.SelectMany(g => g.Permissions),
            StringComparer.Ordinal);

        if (!actorPermissionsAtTargetScope.Contains(PermissionCatalog.UserManage))
        {
            return GrantValidationResult.Denied(
                "OUT_OF_SCOPE_GRANT",
                "Bạn không có quyền cấp phân quyền trong phạm vi đã chọn.");
        }

        var rolePermissions = role.RolePermissions
            .Select(rp => rp.PermissionCode)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        var exceededPermissions = rolePermissions
            .Where(p => !actorPermissionsAtTargetScope.Contains(p))
            .ToList();

        if (exceededPermissions.Count > 0)
        {
            return GrantValidationResult.Denied(
                "GRANT_CEILING_EXCEEDED",
                $"Vai trò chứa quyền vượt quá trần quyền hạn của bạn tại phạm vi này: {string.Join(", ", exceededPermissions)}.");
        }

        return GrantValidationResult.Allowed();
    }

    private static bool ActorGrantCoversTargetScope(
        EffectiveGrantInfo actorGrant,
        ScopeType targetScopeType,
        Guid? targetShopId,
        Guid? targetWarehouseId)
    {
        switch (actorGrant.ScopeType)
        {
            case ScopeType.All:
                return string.Equals(actorGrant.RoleName, SystemRoles.SuperAdmin, StringComparison.Ordinal);

            case ScopeType.Shop:
                if (!actorGrant.ShopId.HasValue || targetScopeType == ScopeType.All)
                {
                    return false;
                }

                return targetShopId.HasValue && actorGrant.ShopId.Value == targetShopId.Value;

            case ScopeType.Warehouse:
                if (!actorGrant.WarehouseId.HasValue ||
                    targetScopeType is ScopeType.All or ScopeType.Shop)
                {
                    return false;
                }

                return targetWarehouseId.HasValue && actorGrant.WarehouseId.Value == targetWarehouseId.Value;

            case ScopeType.Own:
            default:
                return false;
        }
    }

    private Task<bool> UserHasSuperAdminGrantAsync(Guid userId, CancellationToken ct) =>
        _db.UserScopeGrants
            .AsNoTracking()
            .AnyAsync(g =>
                g.UserId == userId &&
                g.ScopeType == ScopeType.All &&
                g.Role.Name == SystemRoles.SuperAdmin, ct);

    private Task<int> CountOtherActiveSuperAdminsAsync(Guid excludedUserId, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        return _db.UserScopeGrants
            .AsNoTracking()
            .Where(g =>
                g.UserId != excludedUserId &&
                g.ScopeType == ScopeType.All &&
                g.Role.Name == SystemRoles.SuperAdmin &&
                g.User.ApprovalStatus == ApprovalStatus.Active &&
                (!g.User.LockoutEnd.HasValue || g.User.LockoutEnd <= now))
            .Select(g => g.UserId)
            .Distinct()
            .CountAsync(ct);
    }
}

