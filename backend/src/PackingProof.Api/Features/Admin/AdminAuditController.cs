using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Storage;

namespace PackingProof.Api.Features.Admin;

/// <summary>
/// Strictly append-only read endpoint for scoped audit logs.
/// Intentionally exposes NO POST, PUT, PATCH, or DELETE endpoints — even SuperAdmin cannot modify or delete audit events.
/// </summary>
[ApiController]
[Route("api/admin/audit")]
[Authorize]
public sealed class AdminAuditController : ControllerBase
{
    private readonly PackingProofDbContext _db;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly IAuditLogger _auditLogger;

    public AdminAuditController(
        PackingProofDbContext db,
        IScopeAuthorizationService scopeAuth,
        IAuditLogger auditLogger)
    {
        _db = db;
        _scopeAuth = scopeAuth;
        _auditLogger = auditLogger;
    }

    [HttpGet]
    public async Task<ActionResult<PaginatedResponse<AuditEventDto>>> ListAuditEvents(
        [FromQuery] string? action = null,
        [FromQuery] string? actorEmail = null,
        [FromQuery] string? entityType = null,
        [FromQuery] AuditOutcome? outcome = null,
        [FromQuery] Guid? shopId = null,
        [FromQuery] Guid? warehouseId = null,
        [FromQuery] string? fromDate = null,
        [FromQuery] string? toDate = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 25,
        CancellationToken ct = default)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var access = await _scopeAuth.GetEffectiveAccessAsync(actorId, ct);

        if (!access.IsActive || !access.AllPermissions.Contains(PermissionCatalog.AuditView))
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "admin.audit.view",
                EntityType: "AuditEvent",
                Outcome: AuditOutcome.Denied,
                ActorUserId: actorId,
                ActorEmail: HttpContext.GetUserEmail(),
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "FORBIDDEN_AUDIT_VIEW" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền truy cập nhật ký kiểm toán (audit.view)."));
        }

        if (!StoragePathBuilder.TryParseHoChiMinhFromDateUtc(fromDate, out var fromUtc) ||
            !StoragePathBuilder.TryParseHoChiMinhToDateExclusiveUtc(toDate, out var toExclusiveUtc))
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_DATE_RANGE",
                "Định dạng ngày lọc không hợp lệ. Vui lòng sử dụng định dạng yyyy-MM-dd (theo múi giờ Asia/Ho_Chi_Minh)."));
        }

        IQueryable<AuditEvent> query = _db.AuditEvents.AsNoTracking();

        var hasGlobalAuditScope = access.IsSuperAdmin &&
            access.Grants.Any(g =>
                g.ScopeType == ScopeType.All &&
                string.Equals(g.RoleName, SystemRoles.SuperAdmin, StringComparison.Ordinal) &&
                g.Permissions.Contains(PermissionCatalog.AuditView, StringComparer.Ordinal));

        if (!hasGlobalAuditScope)
        {
            var allowedShopIds = access.Grants
                .Where(g =>
                    g.ScopeType == ScopeType.Shop &&
                    g.ShopId.HasValue &&
                    g.Permissions.Contains(PermissionCatalog.AuditView, StringComparer.Ordinal))
                .Select(g => g.ShopId!.Value)
                .Distinct()
                .ToList();

            var allowedWarehouseIds = access.Grants
                .Where(g =>
                    g.ScopeType == ScopeType.Warehouse &&
                    g.WarehouseId.HasValue &&
                    g.Permissions.Contains(PermissionCatalog.AuditView, StringComparer.Ordinal))
                .Select(g => g.WarehouseId!.Value)
                .Distinct()
                .ToList();

            if (allowedShopIds.Count == 0 && allowedWarehouseIds.Count == 0)
            {
                return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                    "FORBIDDEN",
                    "Phạm vi quyền xem nhật ký kiểm toán của bạn không hợp lệ."));
            }

            if (shopId.HasValue && !allowedShopIds.Contains(shopId.Value))
            {
                var hasWarehouseInRequestedShop = allowedWarehouseIds.Count > 0 &&
                    await _db.Warehouses
                        .AsNoTracking()
                        .AnyAsync(w =>
                            allowedWarehouseIds.Contains(w.Id) &&
                            w.ShopId == shopId.Value, ct);

                if (!hasWarehouseInRequestedShop)
                {
                    return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                        "OUT_OF_SCOPE_AUDIT",
                        "Bạn không có quyền xem nhật ký kiểm toán của Shop nằm ngoài phạm vi được giao."));
                }
            }

            query = query.Where(a =>
                (a.ShopId.HasValue && allowedShopIds.Contains(a.ShopId.Value)) ||
                (a.WarehouseId.HasValue && allowedWarehouseIds.Contains(a.WarehouseId.Value)));
        }

        if (!string.IsNullOrWhiteSpace(action))
        {
            var pattern = $"%{ScopeQueryExtensions.EscapeLikePattern(action.Trim())}%";
            query = query.Where(a => EF.Functions.ILike(a.Action, pattern, "\\"));
        }

        if (!string.IsNullOrWhiteSpace(actorEmail))
        {
            var pattern = $"%{ScopeQueryExtensions.EscapeLikePattern(actorEmail.Trim())}%";
            query = query.Where(a => a.ActorEmail != null && EF.Functions.ILike(a.ActorEmail, pattern, "\\"));
        }

        if (!string.IsNullOrWhiteSpace(entityType))
        {
            var trimmedType = entityType.Trim();
            query = query.Where(a => a.EntityType.ToLower() == trimmedType.ToLower());
        }

        if (outcome.HasValue)
        {
            query = query.Where(a => a.Outcome == outcome.Value);
        }

        if (shopId.HasValue)
        {
            query = query.Where(a => a.ShopId == shopId.Value);
        }

        if (warehouseId.HasValue)
        {
            query = query.Where(a => a.WarehouseId == warehouseId.Value);
        }

        if (fromUtc.HasValue)
        {
            var start = fromUtc.Value;
            query = query.Where(a => a.OccurredAtUtc >= start);
        }

        if (toExclusiveUtc.HasValue)
        {
            var end = toExclusiveUtc.Value;
            query = query.Where(a => a.OccurredAtUtc < end);
        }

        var normalizedPage = Math.Max(1, page);
        var normalizedPageSize = Math.Clamp(pageSize, 1, 100);

        var totalCount = await query.CountAsync(ct);

        var rawEvents = await query
            .OrderByDescending(a => a.OccurredAtUtc)
            .ThenByDescending(a => a.Id)
            .Skip((normalizedPage - 1) * normalizedPageSize)
            .Take(normalizedPageSize)
            .ToListAsync(ct);

        var referencedShopIds = rawEvents
            .Where(a => a.ShopId.HasValue)
            .Select(a => a.ShopId!.Value)
            .Distinct()
            .ToList();

        var referencedWarehouseIds = rawEvents
            .Where(a => a.WarehouseId.HasValue)
            .Select(a => a.WarehouseId!.Value)
            .Distinct()
            .ToList();

        var shopNames = referencedShopIds.Count == 0
            ? new Dictionary<Guid, string>()
            : await _db.Shops
                .AsNoTracking()
                .Where(s => referencedShopIds.Contains(s.Id))
                .ToDictionaryAsync(s => s.Id, s => s.Name, ct);

        var warehouseNames = referencedWarehouseIds.Count == 0
            ? new Dictionary<Guid, string>()
            : await _db.Warehouses
                .AsNoTracking()
                .Where(w => referencedWarehouseIds.Contains(w.Id))
                .ToDictionaryAsync(w => w.Id, w => w.Name, ct);

        var items = rawEvents
            .Select(a => new AuditEventDto(
                Id: a.Id,
                OccurredAtUtc: a.OccurredAtUtc,
                ActorUserId: a.ActorUserId,
                ActorEmail: a.ActorEmail,
                Action: a.Action,
                EntityType: a.EntityType,
                EntityId: a.EntityId,
                ShopId: a.ShopId,
                ShopName: a.ShopId.HasValue && shopNames.TryGetValue(a.ShopId.Value, out var sn) ? sn : null,
                WarehouseId: a.WarehouseId,
                WarehouseName: a.WarehouseId.HasValue && warehouseNames.TryGetValue(a.WarehouseId.Value, out var wn) ? wn : null,
                Outcome: a.Outcome,
                IpAddress: a.IpAddress,
                UserAgent: a.UserAgent,
                MetadataJson: a.MetadataJson))
            .ToList();

        return Ok(new PaginatedResponse<AuditEventDto>(
            Items: items,
            TotalCount: totalCount,
            Page: normalizedPage,
            PageSize: normalizedPageSize));
    }
}
