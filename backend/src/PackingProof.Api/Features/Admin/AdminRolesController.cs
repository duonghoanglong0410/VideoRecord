using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Api.Features.Admin;

[ApiController]
[Route("api/admin")]
[Authorize]
public sealed class AdminRolesController : ControllerBase
{
    private readonly PackingProofDbContext _db;
    private readonly RoleManager<ApplicationRole> _roleManager;
    private readonly UserManager<ApplicationUser> _userManager;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly IGrantCeilingValidator _grantValidator;
    private readonly IAuditLogger _auditLogger;

    public AdminRolesController(
        PackingProofDbContext db,
        RoleManager<ApplicationRole> roleManager,
        UserManager<ApplicationUser> userManager,
        IScopeAuthorizationService scopeAuth,
        IGrantCeilingValidator grantValidator,
        IAuditLogger auditLogger)
    {
        _db = db;
        _roleManager = roleManager;
        _userManager = userManager;
        _scopeAuth = scopeAuth;
        _grantValidator = grantValidator;
        _auditLogger = auditLogger;
    }

    [HttpGet("roles")]
    public async Task<IActionResult> ListRoles(CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var access = await _scopeAuth.GetEffectiveAccessAsync(actorId, ct);

        if (!access.IsActive ||
            (!access.AllPermissions.Contains(PermissionCatalog.RoleManage) &&
             !access.AllPermissions.Contains(PermissionCatalog.UserManage)))
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền xem danh sách vai trò."));
        }

        var roles = await _db.Roles
            .AsNoTracking()
            .Include(r => r.RolePermissions)
            .OrderByDescending(r => r.IsSystemRole)
            .ThenBy(r => r.Name)
            .ToListAsync(ct);

        var dtos = roles
            .Select(r => new RoleDto(
                r.Id,
                r.Name ?? string.Empty,
                r.Description,
                r.IsSystemRole,
                r.CreatedAtUtc,
                r.RolePermissions
                    .Select(rp => rp.PermissionCode)
                    .OrderBy(c => c, StringComparer.Ordinal)
                    .ToList()))
            .ToList();

        return Ok(dtos);
    }

    [HttpGet("permissions")]
    public async Task<IActionResult> ListPermissions(CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var access = await _scopeAuth.GetEffectiveAccessAsync(actorId, ct);

        if (!access.IsActive ||
            (!access.AllPermissions.Contains(PermissionCatalog.RoleManage) &&
             !access.AllPermissions.Contains(PermissionCatalog.UserManage)))
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền xem danh mục quyền hạn."));
        }

        var items = PermissionCatalog.All
            .Select(p => new PermissionDto(p.Code, p.Group, p.Description))
            .ToList();

        return Ok(items);
    }

    [HttpPost("roles")]
    public async Task<IActionResult> CreateRole(
        [FromBody] UpsertCustomRoleRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var name = request.Name?.Trim() ?? string.Empty;
        var description = request.Description?.Trim() ?? string.Empty;
        var permissions = (request.Permissions ?? [])
            .Select(p => p.Trim())
            .Where(p => !string.IsNullOrEmpty(p))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        var validation = await _grantValidator.ValidateCustomRoleAsync(actorId, null, permissions, ct);
        if (!validation.IsAllowed)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "admin.role.create",
                EntityType: "Role",
                Outcome: AuditOutcome.Denied,
                ActorUserId: actorId,
                ActorEmail: HttpContext.GetUserEmail(),
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { roleName = name, errorCode = validation.ErrorCode, permissions }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                validation.ErrorCode ?? "FORBIDDEN",
                validation.UserMessage ?? "Không thể tạo vai trò vượt quá giới hạn quyền."));
        }

        if (string.IsNullOrWhiteSpace(name) || name.Length > 64)
        {
            return BadRequest(new ApiErrorResponse(
                "VALIDATION_ERROR",
                "Tên vai trò bắt buộc và không vượt quá 64 ký tự."));
        }

        if (await _roleManager.FindByNameAsync(name) is not null)
        {
            return Conflict(new ApiErrorResponse(
                "DUPLICATE_ROLE_NAME",
                "Tên vai trò này đã tồn tại trong hệ thống."));
        }

        var role = new ApplicationRole
        {
            Name = name,
            Description = description,
            IsSystemRole = false,
            CreatedAtUtc = DateTime.UtcNow
        };

        var createResult = await _roleManager.CreateAsync(role);
        if (!createResult.Succeeded)
        {
            var details = IdentityErrorTranslator.ToVietnamese(createResult.Errors);
            return BadRequest(new ApiErrorResponse(
                "ROLE_CREATE_FAILED",
                details.FirstOrDefault() ?? "Không thể tạo vai trò.",
                details));
        }

        foreach (var perm in permissions)
        {
            _db.RolePermissions.Add(new RolePermission
            {
                RoleId = role.Id,
                PermissionCode = perm
            });
        }

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.role.create",
            EntityType: "Role",
            EntityId: role.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { roleName = role.Name, permissions }), ct);

        return StatusCode(StatusCodes.Status201Created, new RoleDto(
            role.Id,
            role.Name!,
            role.Description,
            role.IsSystemRole,
            role.CreatedAtUtc,
            permissions.OrderBy(p => p, StringComparer.Ordinal).ToList()));
    }

    [HttpPut("roles/{id:guid}")]
    public async Task<IActionResult> UpdateRole(
        Guid id,
        [FromBody] UpsertCustomRoleRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var name = request.Name?.Trim() ?? string.Empty;
        var description = request.Description?.Trim() ?? string.Empty;
        var permissions = (request.Permissions ?? [])
            .Select(p => p.Trim())
            .Where(p => !string.IsNullOrEmpty(p))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        var validation = await _grantValidator.ValidateCustomRoleAsync(actorId, id, permissions, ct);
        if (!validation.IsAllowed)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "admin.role.update",
                EntityType: "Role",
                EntityId: id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: actorId,
                ActorEmail: HttpContext.GetUserEmail(),
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { roleName = name, errorCode = validation.ErrorCode, permissions }), ct);

            if (validation.ErrorCode == "ROLE_NOT_FOUND")
            {
                return NotFound(new ApiErrorResponse(validation.ErrorCode, validation.UserMessage!));
            }

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                validation.ErrorCode ?? "FORBIDDEN",
                validation.UserMessage ?? "Không thể cập nhật vai trò."));
        }

        if (string.IsNullOrWhiteSpace(name) || name.Length > 64)
        {
            return BadRequest(new ApiErrorResponse(
                "VALIDATION_ERROR",
                "Tên vai trò bắt buộc và không vượt quá 64 ký tự."));
        }

        var role = await _roleManager.FindByIdAsync(id.ToString());
        if (role is null)
        {
            return NotFound(new ApiErrorResponse("ROLE_NOT_FOUND", "Không tìm thấy vai trò."));
        }

        var duplicate = await _roleManager.FindByNameAsync(name);
        if (duplicate is not null && duplicate.Id != role.Id)
        {
            return Conflict(new ApiErrorResponse(
                "DUPLICATE_ROLE_NAME",
                "Tên vai trò này đã tồn tại trong hệ thống."));
        }

        role.Name = name;
        role.Description = description;
        var updateResult = await _roleManager.UpdateAsync(role);
        if (!updateResult.Succeeded)
        {
            var details = IdentityErrorTranslator.ToVietnamese(updateResult.Errors);
            return BadRequest(new ApiErrorResponse(
                "ROLE_UPDATE_FAILED",
                details.FirstOrDefault() ?? "Không thể cập nhật vai trò.",
                details));
        }

        var existingPerms = await _db.RolePermissions
            .Where(rp => rp.RoleId == role.Id)
            .ToListAsync(ct);

        _db.RolePermissions.RemoveRange(existingPerms);

        foreach (var perm in permissions)
        {
            _db.RolePermissions.Add(new RolePermission
            {
                RoleId = role.Id,
                PermissionCode = perm
            });
        }

        await _db.SaveChangesAsync(ct);

        // Immediately bump SecurityStamp for all users holding this role
        var affectedUserIds = await _db.UserScopeGrants
            .AsNoTracking()
            .Where(g => g.RoleId == role.Id)
            .Select(g => g.UserId)
            .Distinct()
            .ToListAsync(ct);

        foreach (var affectedUserId in affectedUserIds)
        {
            var affectedUser = await _userManager.FindByIdAsync(affectedUserId.ToString());
            if (affectedUser is not null)
            {
                await _userManager.UpdateSecurityStampAsync(affectedUser);
            }
        }

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.role.update",
            EntityType: "Role",
            EntityId: role.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { roleName = role.Name, permissions, affectedUsers = affectedUserIds.Count }), ct);

        return Ok(new RoleDto(
            role.Id,
            role.Name!,
            role.Description,
            role.IsSystemRole,
            role.CreatedAtUtc,
            permissions.OrderBy(p => p, StringComparer.Ordinal).ToList()));
    }
}

