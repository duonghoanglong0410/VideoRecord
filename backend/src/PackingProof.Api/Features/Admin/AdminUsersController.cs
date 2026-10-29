using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Api.Features.Auth;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Api.Features.Admin;

[ApiController]
[Route("api/admin/users")]
[Authorize]
public sealed class AdminUsersController : ControllerBase
{
    private readonly PackingProofDbContext _db;
    private readonly UserManager<ApplicationUser> _userManager;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly IGrantCeilingValidator _grantValidator;
    private readonly IAuditLogger _auditLogger;

    public AdminUsersController(
        PackingProofDbContext db,
        UserManager<ApplicationUser> userManager,
        IScopeAuthorizationService scopeAuth,
        IGrantCeilingValidator grantValidator,
        IAuditLogger auditLogger)
    {
        _db = db;
        _userManager = userManager;
        _scopeAuth = scopeAuth;
        _grantValidator = grantValidator;
        _auditLogger = auditLogger;
    }

    [HttpGet]
    public async Task<IActionResult> ListUsers(
        [FromQuery] string? search = null,
        [FromQuery] string? q = null,
        [FromQuery] ApprovalStatus? status = null,
        [FromQuery] ApprovalStatus? approvalStatus = null,
        [FromQuery] Guid? shopId = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var actorAccess = await _scopeAuth.GetEffectiveAccessAsync(actorId, ct);

        if (!actorAccess.IsActive || !actorAccess.AllPermissions.Contains(PermissionCatalog.UserManage))
        {
            await AppendDeniedAuditAsync(actorId, "admin.users.list", null, "FORBIDDEN_USER_MANAGE", ct);
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền xem danh sách quản trị người dùng."));
        }

        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        IQueryable<ApplicationUser> query = _db.Users
            .AsNoTracking()
            .AsSplitQuery()
            .Include(u => u.ScopeGrants)
                .ThenInclude(g => g.Role)
            .Include(u => u.ScopeGrants)
                .ThenInclude(g => g.Shop)
            .Include(u => u.ScopeGrants)
                .ThenInclude(g => g.Warehouse)
                    .ThenInclude(w => w!.Shop);

        if (!actorAccess.IsSuperAdmin)
        {
            var managedShopIds = actorAccess.Grants
                .Where(g => g.ScopeType == ScopeType.Shop &&
                            g.ShopId.HasValue &&
                            g.Permissions.Contains(PermissionCatalog.UserManage, StringComparer.Ordinal))
                .Select(g => g.ShopId!.Value)
                .Distinct()
                .ToList();

            var managedWarehouseIds = actorAccess.Grants
                .Where(g => g.ScopeType == ScopeType.Warehouse &&
                            g.WarehouseId.HasValue &&
                            g.Permissions.Contains(PermissionCatalog.UserManage, StringComparer.Ordinal))
                .Select(g => g.WarehouseId!.Value)
                .Distinct()
                .ToList();

            if (managedShopIds.Count == 0 && managedWarehouseIds.Count == 0)
            {
                return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                    "FORBIDDEN",
                    "Phạm vi quản trị của bạn không hợp lệ."));
            }

            query = query.Where(u =>
                !u.ScopeGrants.Any(g => g.Role.Name == SystemRoles.SuperAdmin) &&
                (
                    (!u.ScopeGrants.Any() &&
                     u.ApprovalStatus == ApprovalStatus.PendingApproval &&
                     (!u.DefaultShopId.HasValue || managedShopIds.Contains(u.DefaultShopId.Value))) ||
                    u.ScopeGrants.Any(g =>
                        (g.ShopId.HasValue && managedShopIds.Contains(g.ShopId.Value)) ||
                        (g.Warehouse != null && managedShopIds.Contains(g.Warehouse.ShopId)) ||
                        (g.WarehouseId.HasValue && managedWarehouseIds.Contains(g.WarehouseId.Value)))
                ));
        }

        var effectiveStatus = approvalStatus ?? status;
        if (effectiveStatus.HasValue)
        {
            query = query.Where(u => u.ApprovalStatus == effectiveStatus.Value);
        }

        if (shopId.HasValue)
        {
            var targetShopId = shopId.Value;
            query = query.Where(u =>
                u.DefaultShopId == targetShopId ||
                u.ScopeGrants.Any(g =>
                    g.ShopId == targetShopId ||
                    (g.Warehouse != null && g.Warehouse.ShopId == targetShopId)));
        }

        var effectiveSearch = !string.IsNullOrWhiteSpace(q) ? q : search;
        if (!string.IsNullOrWhiteSpace(effectiveSearch))
        {
            var escaped = ScopeQueryExtensions.EscapeLikePattern(effectiveSearch.Trim());
            var pattern = $"%{escaped}%";
            query = query.Where(u =>
                EF.Functions.ILike(u.Email!, pattern, "\\") ||
                EF.Functions.ILike(u.FullName, pattern, "\\"));
        }

        var totalCount = await query.CountAsync(ct);
        var users = await query
            .OrderByDescending(u => u.CreatedAtUtc)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(ct);

        var items = users.Select(MapToAdminUserSummary).ToList();
        return Ok(new PaginatedResponse<AdminUserSummaryDto>(items, totalCount, page, pageSize));
    }

    [HttpPost("{id:guid}/approve")]
    public async Task<IActionResult> ApproveUser(
        Guid id,
        [FromBody] ApproveUserRequest? request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var actionValidation = await _grantValidator.ValidateUserManagementActionAsync(actorId, id, "approve", ct);
        if (!actionValidation.IsAllowed)
        {
            await AppendDeniedAuditAsync(actorId, "admin.user.approve", id.ToString(), actionValidation.ErrorCode, ct);
            return ToValidationActionResult(actionValidation);
        }

        var proposals = request?.Grants?
            .Select(g => new GrantProposal(g.RoleId, g.ScopeType, g.ShopId, g.WarehouseId))
            .ToList() ?? [];

        if (proposals.Count > 0)
        {
            var grantValidation = await _grantValidator.ValidateGrantsAssignmentAsync(actorId, id, proposals, ct);
            if (!grantValidation.IsAllowed)
            {
                await AppendDeniedAuditAsync(actorId, "admin.user.approve", id.ToString(), grantValidation.ErrorCode, ct);
                return ToValidationActionResult(grantValidation);
            }
        }

        var user = await _userManager.FindByIdAsync(id.ToString());
        if (user is null)
        {
            return NotFound(new ApiErrorResponse("TARGET_USER_NOT_FOUND", "Không tìm thấy người dùng."));
        }

        if (request?.DefaultShopId.HasValue == true || request?.DefaultWarehouseId.HasValue == true)
        {
            var defaultScopeCheck = await ValidateDefaultShopWarehouseForActorAsync(
                actorId,
                request.DefaultShopId,
                request.DefaultWarehouseId,
                ct);
            if (defaultScopeCheck is not null)
            {
                await AppendDeniedAuditAsync(actorId, "admin.user.approve", id.ToString(), "OUT_OF_SCOPE_DEFAULT_SHOP", ct);
                return defaultScopeCheck;
            }
        }

        user.ApprovalStatus = ApprovalStatus.Active;
        user.ApprovedAtUtc = DateTime.UtcNow;
        user.ApprovedByUserId = actorId;
        user.LockedAtUtc = null;
        user.LockedByUserId = null;
        user.LockoutEnd = null;
        user.AccessFailedCount = 0;

        if (request?.DefaultShopId.HasValue == true)
        {
            user.DefaultShopId = request.DefaultShopId;
        }

        if (request?.DefaultWarehouseId.HasValue == true)
        {
            user.DefaultWarehouseId = request.DefaultWarehouseId;
        }

        if (proposals.Count > 0)
        {
            await ReplaceUserGrantsInternalAsync(user, actorId, proposals, ct);
            await SyncInferredDefaultScopeIfUnsetAsync(user, ct);
        }

        await _userManager.UpdateAsync(user);
        await _userManager.UpdateSecurityStampAsync(user);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.user.approve",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: user.DefaultShopId,
            WarehouseId: user.DefaultWarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { targetEmail = user.Email, grantCount = proposals.Count }), ct);

        var reloaded = await LoadUserWithGrantsAsync(user.Id, ct);
        return Ok(MapToAdminUserSummary(reloaded!));
    }

    [HttpPost("{id:guid}/lock")]
    public async Task<IActionResult> LockUser(Guid id, CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var validation = await _grantValidator.ValidateUserManagementActionAsync(actorId, id, "lock", ct);
        if (!validation.IsAllowed)
        {
            await AppendDeniedAuditAsync(actorId, "admin.user.lock", id.ToString(), validation.ErrorCode, ct);
            return ToValidationActionResult(validation);
        }

        var user = await _userManager.FindByIdAsync(id.ToString());
        if (user is null)
        {
            return NotFound(new ApiErrorResponse("TARGET_USER_NOT_FOUND", "Không tìm thấy người dùng."));
        }

        user.ApprovalStatus = ApprovalStatus.Locked;
        user.LockedAtUtc = DateTime.UtcNow;
        user.LockedByUserId = actorId;
        user.LockoutEnd = DateTimeOffset.MaxValue;

        await _userManager.UpdateAsync(user);
        await _userManager.UpdateSecurityStampAsync(user);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.user.lock",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: user.DefaultShopId,
            WarehouseId: user.DefaultWarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { targetEmail = user.Email }), ct);

        return Ok(new { message = "Đã khóa tài khoản và thu hồi toàn bộ phiên đăng nhập." });
    }

    [HttpPost("{id:guid}/unlock")]
    public async Task<IActionResult> UnlockUser(Guid id, CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var validation = await _grantValidator.ValidateUserManagementActionAsync(actorId, id, "unlock", ct);
        if (!validation.IsAllowed)
        {
            await AppendDeniedAuditAsync(actorId, "admin.user.unlock", id.ToString(), validation.ErrorCode, ct);
            return ToValidationActionResult(validation);
        }

        var user = await _userManager.FindByIdAsync(id.ToString());
        if (user is null)
        {
            return NotFound(new ApiErrorResponse("TARGET_USER_NOT_FOUND", "Không tìm thấy người dùng."));
        }

        user.ApprovalStatus = ApprovalStatus.Active;
        user.LockedAtUtc = null;
        user.LockedByUserId = null;
        user.LockoutEnd = null;
        user.AccessFailedCount = 0;

        await _userManager.UpdateAsync(user);
        await _userManager.UpdateSecurityStampAsync(user);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.user.unlock",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: user.DefaultShopId,
            WarehouseId: user.DefaultWarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { targetEmail = user.Email }), ct);

        return Ok(new { message = "Đã mở khóa tài khoản thành công." });
    }

    [HttpPost("{id:guid}/revoke-sessions")]
    public async Task<IActionResult> RevokeSessions(Guid id, CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var validation = await _grantValidator.ValidateUserManagementActionAsync(actorId, id, "revoke-sessions", ct);
        if (!validation.IsAllowed)
        {
            await AppendDeniedAuditAsync(actorId, "admin.user.revoke_sessions", id.ToString(), validation.ErrorCode, ct);
            return ToValidationActionResult(validation);
        }

        var user = await _userManager.FindByIdAsync(id.ToString());
        if (user is null)
        {
            return NotFound(new ApiErrorResponse("TARGET_USER_NOT_FOUND", "Không tìm thấy người dùng."));
        }

        await _userManager.UpdateSecurityStampAsync(user);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.user.revoke_sessions",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: user.DefaultShopId,
            WarehouseId: user.DefaultWarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { targetEmail = user.Email }), ct);

        return Ok(new { message = "Đã thu hồi tất cả phiên đăng nhập hiện hành của người dùng." });
    }

    [HttpPut("{id:guid}/grants")]
    public async Task<IActionResult> UpdateUserGrants(
        Guid id,
        [FromBody] UpdateUserGrantsRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var proposals = (request.Grants ?? [])
            .Select(g => new GrantProposal(g.RoleId, g.ScopeType, g.ShopId, g.WarehouseId))
            .ToList();

        var validation = await _grantValidator.ValidateGrantsAssignmentAsync(actorId, id, proposals, ct);
        if (!validation.IsAllowed)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "admin.user.update_grants",
                EntityType: "User",
                EntityId: id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: actorId,
                ActorEmail: HttpContext.GetUserEmail(),
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new
                {
                    errorCode = validation.ErrorCode,
                    proposedGrants = proposals.Select(p => new
                    {
                        p.RoleId,
                        scopeType = p.ScopeType.ToString(),
                        p.ShopId,
                        p.WarehouseId
                    })
                }), ct);

            return ToValidationActionResult(validation);
        }

        var user = await _userManager.FindByIdAsync(id.ToString());
        if (user is null)
        {
            return NotFound(new ApiErrorResponse("TARGET_USER_NOT_FOUND", "Không tìm thấy người dùng."));
        }

        if (request.DefaultShopId.HasValue || request.DefaultWarehouseId.HasValue)
        {
            var defaultScopeCheck = await ValidateDefaultShopWarehouseForActorAsync(
                actorId,
                request.DefaultShopId,
                request.DefaultWarehouseId,
                ct);
            if (defaultScopeCheck is not null)
            {
                await AppendDeniedAuditAsync(actorId, "admin.user.update_grants", id.ToString(), "OUT_OF_SCOPE_DEFAULT_SHOP", ct);
                return defaultScopeCheck;
            }
        }

        await ReplaceUserGrantsInternalAsync(user, actorId, proposals, ct);

        if (request.DefaultShopId.HasValue)
        {
            user.DefaultShopId = request.DefaultShopId;
        }

        if (request.DefaultWarehouseId.HasValue)
        {
            user.DefaultWarehouseId = request.DefaultWarehouseId;
        }

        await SyncInferredDefaultScopeIfUnsetAsync(user, ct);

        await _userManager.UpdateAsync(user);
        await _userManager.UpdateSecurityStampAsync(user);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.user.update_grants",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: user.DefaultShopId,
            WarehouseId: user.DefaultWarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                targetEmail = user.Email,
                grantCount = proposals.Count,
                grants = proposals.Select(p => new
                {
                    p.RoleId,
                    scopeType = p.ScopeType.ToString(),
                    p.ShopId,
                    p.WarehouseId
                })
            }), ct);

        var reloaded = await LoadUserWithGrantsAsync(user.Id, ct);
        return Ok(MapToAdminUserSummary(reloaded!));
    }

    [HttpPost("{id:guid}/initiate-password-reset")]
    public async Task<IActionResult> InitiateControlledPasswordReset(Guid id, CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var validation = await _grantValidator.ValidateUserManagementActionAsync(
            actorId,
            id,
            "initiate-password-reset",
            ct);

        if (!validation.IsAllowed)
        {
            await AppendDeniedAuditAsync(
                actorId,
                "admin.user.initiate_password_reset",
                id.ToString(),
                validation.ErrorCode,
                ct);
            return ToValidationActionResult(validation);
        }

        var user = await _userManager.FindByIdAsync(id.ToString());
        if (user is null)
        {
            return NotFound(new ApiErrorResponse("TARGET_USER_NOT_FOUND", "Không tìm thấy người dùng."));
        }

        user.ForcePasswordReset = true;
        await _userManager.UpdateAsync(user);
        await _userManager.UpdateSecurityStampAsync(user);

        var oneTimeResetToken = await _userManager.GeneratePasswordResetTokenAsync(user);

        // Audit strictly WITHOUT passing or logging the raw token
        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.user.initiate_password_reset",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: user.DefaultShopId,
            WarehouseId: user.DefaultWarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                targetEmail = user.Email,
                deliveryMethod = "admin_controlled_direct_https",
                sessionsRevoked = true
            }), ct);

        return Ok(new AdminPasswordResetInitiatedResponse(
            UserId: user.Id,
            Email: user.Email ?? string.Empty,
            ResetToken: oneTimeResetToken,
            Message: "Đã tạo mã đặt lại mật khẩu một lần và thu hồi các phiên đăng nhập cũ. Vui lòng chuyển mã này trực tiếp cho nhân viên qua kênh nội bộ an toàn."));
    }

    private async Task ReplaceUserGrantsInternalAsync(
        ApplicationUser targetUser,
        Guid actorId,
        IReadOnlyList<GrantProposal> proposals,
        CancellationToken ct)
    {
        var existing = await _db.UserScopeGrants
            .Where(g => g.UserId == targetUser.Id)
            .ToListAsync(ct);

        _db.UserScopeGrants.RemoveRange(existing);

        foreach (var p in proposals)
        {
            Guid? shopId = p.ShopId;
            if (!shopId.HasValue && p.WarehouseId.HasValue)
            {
                shopId = await _db.Warehouses
                    .AsNoTracking()
                    .Where(w => w.Id == p.WarehouseId.Value)
                    .Select(w => (Guid?)w.ShopId)
                    .FirstOrDefaultAsync(ct);
            }

            _db.UserScopeGrants.Add(new UserScopeGrant
            {
                UserId = targetUser.Id,
                RoleId = p.RoleId,
                ScopeType = p.ScopeType,
                ShopId = shopId,
                WarehouseId = p.WarehouseId,
                GrantedByUserId = actorId,
                CreatedAtUtc = DateTime.UtcNow
            });
        }

        await _db.SaveChangesAsync(ct);
    }

    private Task<ApplicationUser?> LoadUserWithGrantsAsync(Guid userId, CancellationToken ct) =>
        _db.Users
            .AsNoTracking()
            .Include(u => u.ScopeGrants)
                .ThenInclude(g => g.Role)
            .Include(u => u.ScopeGrants)
                .ThenInclude(g => g.Shop)
            .Include(u => u.ScopeGrants)
                .ThenInclude(g => g.Warehouse)
                    .ThenInclude(w => w!.Shop)
            .FirstOrDefaultAsync(u => u.Id == userId, ct);

    private static AdminUserSummaryDto MapToAdminUserSummary(ApplicationUser u)
    {
        var now = DateTimeOffset.UtcNow;
        var grants = u.ScopeGrants
            .Select(g => new UserGrantDto(
                g.Id,
                g.RoleId,
                g.Role.Name ?? string.Empty,
                g.ScopeType,
                g.ShopId ?? g.Warehouse?.ShopId,
                g.Shop?.Name ?? g.Warehouse?.Shop?.Name,
                g.WarehouseId,
                g.Warehouse?.Name))
            .ToList();

        return new AdminUserSummaryDto(
            Id: u.Id,
            Email: u.Email ?? string.Empty,
            FullName: u.FullName,
            ApprovalStatus: u.ApprovalStatus,
            TwoFactorEnabled: u.TwoFactorEnabled,
            IsLockedOut: u.LockoutEnd.HasValue && u.LockoutEnd.Value > now,
            ForcePasswordReset: u.ForcePasswordReset,
            DefaultShopId: u.DefaultShopId,
            DefaultWarehouseId: u.DefaultWarehouseId,
            CreatedAtUtc: u.CreatedAtUtc,
            ApprovedAtUtc: u.ApprovedAtUtc,
            Grants: grants);
    }

    private async Task AppendDeniedAuditAsync(
        Guid actorId,
        string action,
        string? entityId,
        string? errorCode,
        CancellationToken ct)
    {
        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: action,
            EntityType: "User",
            EntityId: entityId,
            Outcome: AuditOutcome.Denied,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { errorCode }), ct);
    }

    private async Task<IActionResult?> ValidateDefaultShopWarehouseForActorAsync(
        Guid actorId,
        Guid? defaultShopId,
        Guid? defaultWarehouseId,
        CancellationToken ct)
    {
        Guid? resolvedShopId = defaultShopId;
        if (defaultWarehouseId.HasValue)
        {
            var warehouse = await _db.Warehouses
                .AsNoTracking()
                .FirstOrDefaultAsync(w => w.Id == defaultWarehouseId.Value && w.IsActive, ct);
            if (warehouse is null)
            {
                return BadRequest(new ApiErrorResponse(
                    "WAREHOUSE_NOT_FOUND",
                    "Kho mặc định được chọn không tồn tại hoặc đã ngưng hoạt động."));
            }

            if (defaultShopId.HasValue && defaultShopId.Value != warehouse.ShopId)
            {
                return BadRequest(new ApiErrorResponse(
                    "WAREHOUSE_SHOP_MISMATCH",
                    "Kho mặc định không thuộc Shop mặc định đã chọn."));
            }

            resolvedShopId = warehouse.ShopId;
        }
        else if (defaultShopId.HasValue)
        {
            var shopExists = await _db.Shops
                .AsNoTracking()
                .AnyAsync(s => s.Id == defaultShopId.Value && s.IsActive, ct);
            if (!shopExists)
            {
                return BadRequest(new ApiErrorResponse(
                    "SHOP_NOT_FOUND",
                    "Shop mặc định được chọn không tồn tại hoặc đã ngưng hoạt động."));
            }
        }

        var canManageScope = await _scopeAuth.HasPermissionAsync(
            actorId,
            PermissionCatalog.UserManage,
            new ResourceScopeContext(
                OwnerUserId: null,
                ShopId: resolvedShopId,
                WarehouseId: defaultWarehouseId),
            ct);

        if (!canManageScope)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "OUT_OF_SCOPE_DEFAULT_SHOP",
                "Bạn không có quyền gán Shop/Kho mặc định nằm ngoài phạm vi quản trị của mình."));
        }

        return null;
    }

    private async Task SyncInferredDefaultScopeIfUnsetAsync(ApplicationUser user, CancellationToken ct)
    {
        if (user.DefaultShopId.HasValue)
        {
            return;
        }

        var firstScopedGrant = await _db.UserScopeGrants
            .AsNoTracking()
            .Where(g => g.UserId == user.Id && (g.ShopId.HasValue || g.WarehouseId.HasValue))
            .OrderBy(g => g.CreatedAtUtc)
            .FirstOrDefaultAsync(ct);

        if (firstScopedGrant is not null)
        {
            user.DefaultShopId = firstScopedGrant.ShopId;
            user.DefaultWarehouseId ??= firstScopedGrant.WarehouseId;
        }
    }

    private IActionResult ToValidationActionResult(GrantValidationResult validation)
    {
        if (validation.ErrorCode == "TARGET_USER_NOT_FOUND")
        {
            return NotFound(new ApiErrorResponse(
                validation.ErrorCode,
                validation.UserMessage ?? "Không tìm thấy người dùng."));
        }

        return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
            validation.ErrorCode ?? "FORBIDDEN",
            validation.UserMessage ?? "Thao tác phân quyền không được phép."));
    }
}
