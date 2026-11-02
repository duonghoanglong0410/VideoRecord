using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
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
[Route("api/admin/warehouses")]
[Authorize]
public sealed partial class AdminWarehousesController : ControllerBase
{
    private readonly PackingProofDbContext _db;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly IAuditLogger _auditLogger;

    public AdminWarehousesController(
        PackingProofDbContext db,
        IScopeAuthorizationService scopeAuth,
        IAuditLogger auditLogger)
    {
        _db = db;
        _scopeAuth = scopeAuth;
        _auditLogger = auditLogger;
    }

    [HttpGet("overview")]
    public async Task<ActionResult<AdminWarehousesOverviewDto>> GetOverview(CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var access = await ResolveWarehouseAdminAccessAsync(actorId, ct);

        if (!access.HasAnyAccess)
        {
            await AppendDeniedAuditAsync(actorId, "admin.warehouses.overview", "Warehouse", null, null, null, ct);
            return ForbiddenWarehouseManage();
        }

        IQueryable<Shop> shopsQuery = _db.Shops
            .AsNoTracking()
            .AsSplitQuery()
            .Include(s => s.Warehouses)
                .ThenInclude(w => w.PackingStations);

        if (!access.CanManageAllShops)
        {
            var allowedIds = access.ManagedShopIds.ToList();
            shopsQuery = shopsQuery.Where(s => allowedIds.Contains(s.Id));
        }

        var shops = await shopsQuery
            .OrderByDescending(s => s.IsActive)
            .ThenBy(s => s.Name)
            .ToListAsync(ct);

        var shopIds = shops.Select(s => s.Id).ToList();

        var recordingCounts = await _db.Recordings
            .AsNoTracking()
            .Where(r => !r.IsSoftDeleted && shopIds.Contains(r.ShopId))
            .GroupBy(r => new { r.ShopId, r.WarehouseId })
            .Select(g => new
            {
                g.Key.ShopId,
                g.Key.WarehouseId,
                Count = g.Count()
            })
            .ToListAsync(ct);

        var recCountByWarehouse = recordingCounts
            .ToDictionary(x => x.WarehouseId, x => x.Count);
        var recCountByShop = recordingCounts
            .GroupBy(x => x.ShopId)
            .ToDictionary(g => g.Key, g => g.Sum(x => x.Count));

        var activeGrants = await _db.UserScopeGrants
            .AsNoTracking()
            .Where(g =>
                g.User.ApprovalStatus == ApprovalStatus.Active &&
                ((g.ShopId.HasValue && shopIds.Contains(g.ShopId.Value)) ||
                 (g.Warehouse != null && shopIds.Contains(g.Warehouse.ShopId))))
            .Select(g => new
            {
                g.UserId,
                ResolvedShopId = g.ShopId ?? g.Warehouse!.ShopId,
                g.WarehouseId
            })
            .ToListAsync(ct);

        var userCountByShop = activeGrants
            .GroupBy(g => g.ResolvedShopId)
            .ToDictionary(g => g.Key, g => g.Select(x => x.UserId).Distinct().Count());

        var userCountByWarehouse = activeGrants
            .Where(g => g.WarehouseId.HasValue)
            .GroupBy(g => g.WarehouseId!.Value)
            .ToDictionary(g => g.Key, g => g.Select(x => x.UserId).Distinct().Count());

        var shopDtos = shops
            .Select(s => new AdminShopWarehouseTreeDto(
                Id: s.Id,
                Code: s.Code,
                Slug: s.Slug,
                Name: s.Name,
                AllowedStorageSubdir: s.AllowedStorageSubdir,
                IsActive: s.IsActive,
                AssignedUserCount: userCountByShop.GetValueOrDefault(s.Id, 0),
                RecordingCount: recCountByShop.GetValueOrDefault(s.Id, 0),
                CreatedAtUtc: s.CreatedAtUtc,
                Warehouses: s.Warehouses
                    .OrderByDescending(w => w.IsActive)
                    .ThenBy(w => w.Name)
                    .Select(w => new AdminWarehouseDetailDto(
                        Id: w.Id,
                        ShopId: w.ShopId,
                        Code: w.Code,
                        Name: w.Name,
                        IsActive: w.IsActive,
                        AssignedUserCount: userCountByWarehouse.GetValueOrDefault(w.Id, 0),
                        RecordingCount: recCountByWarehouse.GetValueOrDefault(w.Id, 0),
                        CreatedAtUtc: w.CreatedAtUtc,
                        PackingStations: w.PackingStations
                            .OrderByDescending(p => p.IsActive)
                            .ThenBy(p => p.Code)
                            .Select(p => new AdminPackingStationDto(
                                Id: p.Id,
                                WarehouseId: p.WarehouseId,
                                Code: p.Code,
                                Name: p.Name,
                                IsActive: p.IsActive,
                                CreatedAtUtc: p.CreatedAtUtc))
                            .ToList()))
                    .ToList()))
            .ToList();

        return Ok(new AdminWarehousesOverviewDto(
            CanManageShops: access.CanManageAllShops,
            Shops: shopDtos));
    }

    [HttpPut("shops/{shopId:guid}")]
    public async Task<IActionResult> UpdateShop(
        Guid shopId,
        [FromBody] UpdateAdminShopRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var access = await ResolveWarehouseAdminAccessAsync(actorId, ct);

        if (!access.CanManageAllShops)
        {
            await AppendDeniedAuditAsync(actorId, "admin.shop.update", "Shop", shopId.ToString(), shopId, null, ct);
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Chỉ Quản trị cao nhất mới được phép chỉnh sửa thông tin hoặc trạng thái của Shop."));
        }

        var shop = await _db.Shops.FirstOrDefaultAsync(s => s.Id == shopId, ct);
        if (shop is null)
        {
            return NotFound(new ApiErrorResponse("SHOP_NOT_FOUND", "Không tìm thấy Shop cần cập nhật."));
        }

        var name = request.Name?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(name) || name.Length > 128)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_SHOP_NAME",
                "Tên hiển thị của Shop bắt buộc và không vượt quá 128 ký tự."));
        }

        var prevActive = shop.IsActive;
        var prevName = shop.Name;
        var prevCode = shop.Code;
        var prevSubdir = shop.AllowedStorageSubdir;

        if (!string.IsNullOrWhiteSpace(request.Code))
        {
            var nextCode = request.Code.Trim();
            if (nextCode.Length > 32 || !SafeOrgCodeRegex().IsMatch(nextCode))
            {
                return BadRequest(new ApiErrorResponse(
                    "INVALID_SHOP_CODE",
                    "Mã Shop bắt buộc (tối đa 32 ký tự, chỉ gồm chữ không dấu, số, '-' hoặc '_')."));
            }

            var dupCode = await _db.Shops
                .AsNoTracking()
                .AnyAsync(s => s.Id != shop.Id && s.Code.ToLower() == nextCode.ToLower(), ct);
            if (dupCode)
            {
                return Conflict(new ApiErrorResponse(
                    "DUPLICATE_SHOP_CODE",
                    "Mã Shop này đã được sử dụng bởi một Shop khác."));
            }

            shop.Code = nextCode;
        }

        if (!string.IsNullOrWhiteSpace(request.AllowedStorageSubdir))
        {
            var nextSubdir = request.AllowedStorageSubdir.Trim();
            if (nextSubdir.Length > 64 || !SafeSingleSubdirRegex().IsMatch(nextSubdir))
            {
                return BadRequest(new ApiErrorResponse(
                    "INVALID_STORAGE_SUBDIR",
                    "Thư mục con lưu trữ chỉ cho phép chữ cái không dấu, số, '-' hoặc '_' (tối đa 64 ký tự)."));
            }

            var dupSubdir = await _db.Shops
                .AsNoTracking()
                .AnyAsync(s => s.Id != shop.Id && s.AllowedStorageSubdir.ToLower() == nextSubdir.ToLower(), ct);
            if (dupSubdir)
            {
                return Conflict(new ApiErrorResponse(
                    "DUPLICATE_STORAGE_SUBDIR",
                    "Thư mục lưu trữ này đã được gán cho một Shop khác."));
            }

            shop.AllowedStorageSubdir = nextSubdir;
        }

        shop.Name = name;
        shop.IsActive = request.IsActive;

        await _db.SaveChangesAsync(ct);

        if (prevActive != shop.IsActive || !string.Equals(prevSubdir, shop.AllowedStorageSubdir, StringComparison.OrdinalIgnoreCase))
        {
            await SyncStorageProfileAllowedSubdirsAsync(actorId, ct);
        }

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.shop.update",
            EntityType: "Shop",
            EntityId: shop.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: shop.Id,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                previousCode = prevCode,
                shop.Code,
                previousName = prevName,
                shop.Name,
                previousSubdir = prevSubdir,
                shop.AllowedStorageSubdir,
                previousActive = prevActive,
                shop.IsActive
            }), ct);

        return Ok(new
        {
            message = "Đã cập nhật thông tin Shop thành công.",
            shop.Id,
            shop.Code,
            shop.Name,
            shop.AllowedStorageSubdir,
            shop.IsActive
        });
    }

    [HttpDelete("shops/{shopId:guid}")]
    [HttpPost("shops/{shopId:guid}/delete")]
    public async Task<IActionResult> DeleteShop(
        Guid shopId,
        [FromQuery] bool force = false,
        CancellationToken ct = default)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var access = await ResolveWarehouseAdminAccessAsync(actorId, ct);

        if (!access.CanManageAllShops)
        {
            await AppendDeniedAuditAsync(actorId, "admin.shop.delete", "Shop", shopId.ToString(), shopId, null, ct);
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Chỉ Quản trị cao nhất mới được phép xóa Shop."));
        }

        var shop = await _db.Shops
            .Include(s => s.Warehouses)
                .ThenInclude(w => w.PackingStations)
            .FirstOrDefaultAsync(s => s.Id == shopId, ct);

        if (shop is null)
        {
            return NotFound(new ApiErrorResponse("SHOP_NOT_FOUND", "Không tìm thấy Shop cần xóa."));
        }

        var hasHoldRecordings = await _db.Recordings
            .AsNoTracking()
            .AnyAsync(r => r.ShopId == shopId && !r.IsSoftDeleted && r.Hold, ct);

        if (hasHoldRecordings)
        {
            return Conflict(new ApiErrorResponse(
                "SHOP_HAS_HOLD_RECORDINGS",
                "Shop này đang có video đơn hàng bị khóa bảo vệ đối soát (Hold) nên không thể xóa vĩnh viễn. Vui lòng gỡ khóa bảo vệ trước hoặc dùng nút 'Tạm ngưng Shop'."));
        }

        var activeRecordingCount = await _db.Recordings
            .AsNoTracking()
            .CountAsync(r => r.ShopId == shopId && !r.IsSoftDeleted, ct);

        if (activeRecordingCount > 0 && !force)
        {
            return Conflict(new ApiErrorResponse(
                "SHOP_HAS_RECORDINGS",
                $"Shop này đang lưu {activeRecordingCount} video đơn hàng. Vui lòng tích chọn xác nhận xóa kèm dữ liệu video hoặc dùng tính năng 'Tạm ngưng Shop'."));
        }

        await PurgeRecordingsByFilterAsync(r => r.ShopId == shopId, ct);

        var warehouseIds = shop.Warehouses.Select(w => w.Id).ToList();

        var affectedUsers = await _db.Users
            .Where(u => u.DefaultShopId == shopId || (u.DefaultWarehouseId.HasValue && warehouseIds.Contains(u.DefaultWarehouseId.Value)))
            .ToListAsync(ct);

        foreach (var user in affectedUsers)
        {
            if (user.DefaultShopId == shopId)
            {
                user.DefaultShopId = null;
            }
            if (user.DefaultWarehouseId.HasValue && warehouseIds.Contains(user.DefaultWarehouseId.Value))
            {
                user.DefaultWarehouseId = null;
            }
        }

        var grants = await _db.UserScopeGrants
            .Where(g => g.ShopId == shopId || (g.WarehouseId.HasValue && warehouseIds.Contains(g.WarehouseId.Value)))
            .ToListAsync(ct);
        if (grants.Count > 0)
        {
            _db.UserScopeGrants.RemoveRange(grants);
        }

        foreach (var wh in shop.Warehouses)
        {
            if (wh.PackingStations.Count > 0)
            {
                _db.PackingStations.RemoveRange(wh.PackingStations);
            }
        }

        if (shop.Warehouses.Count > 0)
        {
            _db.Warehouses.RemoveRange(shop.Warehouses);
        }

        var deletedCode = shop.Code;
        var deletedName = shop.Name;
        _db.Shops.Remove(shop);

        await _db.SaveChangesAsync(ct);
        await SyncStorageProfileAllowedSubdirsAsync(actorId, ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.shop.delete",
            EntityType: "Shop",
            EntityId: shopId.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { shopCode = deletedCode, shopName = deletedName, force, purgedRecordings = activeRecordingCount }), ct);

        return Ok(new { message = $"Đã xóa Shop \"{deletedName}\" ({deletedCode}) thành công." });
    }

    [HttpPost("shops/{shopId:guid}")]
    public async Task<ActionResult<AdminWarehouseDetailDto>> CreateWarehouse(
        Guid shopId,
        [FromBody] CreateAdminWarehouseRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var access = await ResolveWarehouseAdminAccessAsync(actorId, ct);

        if (!access.CanManageShop(shopId))
        {
            await AppendDeniedAuditAsync(actorId, "admin.warehouse.create", "Warehouse", null, shopId, null, ct);
            return ForbiddenWarehouseManage();
        }

        var shop = await _db.Shops
            .AsNoTracking()
            .FirstOrDefaultAsync(s => s.Id == shopId, ct);

        if (shop is null)
        {
            return NotFound(new ApiErrorResponse("SHOP_NOT_FOUND", "Không tìm thấy Shop cần thêm kho."));
        }

        var code = request.Code?.Trim() ?? string.Empty;
        var name = request.Name?.Trim() ?? string.Empty;

        if (string.IsNullOrWhiteSpace(code) || code.Length > 32 || !SafeOrgCodeRegex().IsMatch(code))
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_WAREHOUSE_CODE",
                "Mã Kho bắt buộc (tối đa 32 ký tự, chỉ gồm chữ không dấu, số, '-' hoặc '_')."));
        }

        if (string.IsNullOrWhiteSpace(name) || name.Length > 128)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_WAREHOUSE_NAME",
                "Tên Kho bắt buộc và không vượt quá 128 ký tự."));
        }

        var duplicateCode = await _db.Warehouses
            .AsNoTracking()
            .AnyAsync(w => w.ShopId == shopId && w.Code.ToLower() == code.ToLower(), ct);

        if (duplicateCode)
        {
            return Conflict(new ApiErrorResponse(
                "DUPLICATE_WAREHOUSE_CODE",
                "Mã Kho này đã tồn tại trong Shop đã chọn."));
        }

        var now = DateTime.UtcNow;
        var warehouse = new Warehouse
        {
            Id = Guid.NewGuid(),
            ShopId = shopId,
            Code = code,
            Name = name,
            IsActive = true,
            CreatedAtUtc = now
        };

        _db.Warehouses.Add(warehouse);

        var createdStations = new List<AdminPackingStationDto>();
        if (request.CreateDefaultStation)
        {
            var defaultStation = new PackingStation
            {
                Id = Guid.NewGuid(),
                WarehouseId = warehouse.Id,
                Code = "ST-01",
                Name = "Bàn đóng gói 01",
                IsActive = true,
                CreatedAtUtc = now
            };
            _db.PackingStations.Add(defaultStation);
            createdStations.Add(new AdminPackingStationDto(
                defaultStation.Id,
                defaultStation.WarehouseId,
                defaultStation.Code,
                defaultStation.Name,
                defaultStation.IsActive,
                defaultStation.CreatedAtUtc));
        }

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.warehouse.create",
            EntityType: "Warehouse",
            EntityId: warehouse.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: shopId,
            WarehouseId: warehouse.Id,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { shopCode = shop.Code, warehouse.Code, warehouse.Name }), ct);

        return StatusCode(StatusCodes.Status201Created, new AdminWarehouseDetailDto(
            Id: warehouse.Id,
            ShopId: warehouse.ShopId,
            Code: warehouse.Code,
            Name: warehouse.Name,
            IsActive: warehouse.IsActive,
            AssignedUserCount: 0,
            RecordingCount: 0,
            CreatedAtUtc: warehouse.CreatedAtUtc,
            PackingStations: createdStations));
    }

    [HttpPut("{warehouseId:guid}")]
    public async Task<ActionResult<AdminWarehouseDetailDto>> UpdateWarehouse(
        Guid warehouseId,
        [FromBody] UpdateAdminWarehouseRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var warehouse = await _db.Warehouses
            .Include(w => w.PackingStations)
            .FirstOrDefaultAsync(w => w.Id == warehouseId, ct);

        if (warehouse is null)
        {
            return NotFound(new ApiErrorResponse("WAREHOUSE_NOT_FOUND", "Không tìm thấy Kho đóng gói."));
        }

        var access = await ResolveWarehouseAdminAccessAsync(actorId, ct);
        if (!access.CanManageShop(warehouse.ShopId))
        {
            await AppendDeniedAuditAsync(
                actorId,
                "admin.warehouse.update",
                "Warehouse",
                warehouseId.ToString(),
                warehouse.ShopId,
                warehouse.Id,
                ct);
            return ForbiddenWarehouseManage();
        }

        var code = request.Code?.Trim() ?? string.Empty;
        var name = request.Name?.Trim() ?? string.Empty;

        if (string.IsNullOrWhiteSpace(code) || code.Length > 32 || !SafeOrgCodeRegex().IsMatch(code))
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_WAREHOUSE_CODE",
                "Mã Kho bắt buộc (tối đa 32 ký tự, chỉ gồm chữ không dấu, số, '-' hoặc '_')."));
        }

        if (string.IsNullOrWhiteSpace(name) || name.Length > 128)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_WAREHOUSE_NAME",
                "Tên Kho bắt buộc và không vượt quá 128 ký tự."));
        }

        var duplicateCode = await _db.Warehouses
            .AsNoTracking()
            .AnyAsync(w =>
                w.ShopId == warehouse.ShopId &&
                w.Id != warehouse.Id &&
                w.Code.ToLower() == code.ToLower(), ct);

        if (duplicateCode)
        {
            return Conflict(new ApiErrorResponse(
                "DUPLICATE_WAREHOUSE_CODE",
                "Mã Kho này đã tồn tại trong cùng một Shop."));
        }

        var prevCode = warehouse.Code;
        var prevName = warehouse.Name;
        var prevActive = warehouse.IsActive;

        warehouse.Code = code;
        warehouse.Name = name;
        warehouse.IsActive = request.IsActive;

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.warehouse.update",
            EntityType: "Warehouse",
            EntityId: warehouse.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: warehouse.ShopId,
            WarehouseId: warehouse.Id,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                previousCode = prevCode,
                warehouse.Code,
                previousName = prevName,
                warehouse.Name,
                previousActive = prevActive,
                warehouse.IsActive
            }), ct);

        var recCount = await _db.Recordings
            .AsNoTracking()
            .CountAsync(r => !r.IsSoftDeleted && r.WarehouseId == warehouse.Id, ct);

        var userCount = await _db.UserScopeGrants
            .AsNoTracking()
            .Where(g => g.User.ApprovalStatus == ApprovalStatus.Active && g.WarehouseId == warehouse.Id)
            .Select(g => g.UserId)
            .Distinct()
            .CountAsync(ct);

        return Ok(new AdminWarehouseDetailDto(
            Id: warehouse.Id,
            ShopId: warehouse.ShopId,
            Code: warehouse.Code,
            Name: warehouse.Name,
            IsActive: warehouse.IsActive,
            AssignedUserCount: userCount,
            RecordingCount: recCount,
            CreatedAtUtc: warehouse.CreatedAtUtc,
            PackingStations: warehouse.PackingStations
                .OrderByDescending(p => p.IsActive)
                .ThenBy(p => p.Code)
                .Select(p => new AdminPackingStationDto(
                    p.Id,
                    p.WarehouseId,
                    p.Code,
                    p.Name,
                    p.IsActive,
                    p.CreatedAtUtc))
                .ToList()));
    }

    [HttpPost("{warehouseId:guid}/stations")]
    public async Task<ActionResult<AdminPackingStationDto>> CreatePackingStation(
        Guid warehouseId,
        [FromBody] CreateAdminPackingStationRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var warehouse = await _db.Warehouses
            .AsNoTracking()
            .FirstOrDefaultAsync(w => w.Id == warehouseId, ct);

        if (warehouse is null)
        {
            return NotFound(new ApiErrorResponse("WAREHOUSE_NOT_FOUND", "Không tìm thấy Kho đóng gói."));
        }

        var access = await ResolveWarehouseAdminAccessAsync(actorId, ct);
        if (!access.CanManageShop(warehouse.ShopId))
        {
            await AppendDeniedAuditAsync(
                actorId,
                "admin.station.create",
                "PackingStation",
                null,
                warehouse.ShopId,
                warehouse.Id,
                ct);
            return ForbiddenWarehouseManage();
        }

        var code = request.Code?.Trim() ?? string.Empty;
        var name = request.Name?.Trim() ?? string.Empty;

        if (string.IsNullOrWhiteSpace(code) || code.Length > 32 || !SafeOrgCodeRegex().IsMatch(code))
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_STATION_CODE",
                "Mã bàn đóng gói bắt buộc (tối đa 32 ký tự, chỉ gồm chữ không dấu, số, '-' hoặc '_')."));
        }

        if (string.IsNullOrWhiteSpace(name) || name.Length > 128)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_STATION_NAME",
                "Tên bàn đóng gói bắt buộc và không vượt quá 128 ký tự."));
        }

        var duplicate = await _db.PackingStations
            .AsNoTracking()
            .AnyAsync(p => p.WarehouseId == warehouseId && p.Code.ToLower() == code.ToLower(), ct);

        if (duplicate)
        {
            return Conflict(new ApiErrorResponse(
                "DUPLICATE_STATION_CODE",
                "Mã bàn đóng gói này đã tồn tại trong Kho đã chọn."));
        }

        var station = new PackingStation
        {
            Id = Guid.NewGuid(),
            WarehouseId = warehouseId,
            Code = code,
            Name = name,
            IsActive = true,
            CreatedAtUtc = DateTime.UtcNow
        };

        _db.PackingStations.Add(station);
        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.station.create",
            EntityType: "PackingStation",
            EntityId: station.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: warehouse.ShopId,
            WarehouseId: warehouse.Id,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { warehouseCode = warehouse.Code, station.Code, station.Name }), ct);

        return StatusCode(StatusCodes.Status201Created, new AdminPackingStationDto(
            station.Id,
            station.WarehouseId,
            station.Code,
            station.Name,
            station.IsActive,
            station.CreatedAtUtc));
    }

    [HttpPut("stations/{stationId:guid}")]
    public async Task<ActionResult<AdminPackingStationDto>> UpdatePackingStation(
        Guid stationId,
        [FromBody] UpdateAdminPackingStationRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var station = await _db.PackingStations
            .Include(p => p.Warehouse)
            .FirstOrDefaultAsync(p => p.Id == stationId, ct);

        if (station is null)
        {
            return NotFound(new ApiErrorResponse("STATION_NOT_FOUND", "Không tìm thấy bàn đóng gói."));
        }

        var access = await ResolveWarehouseAdminAccessAsync(actorId, ct);
        if (!access.CanManageShop(station.Warehouse.ShopId))
        {
            await AppendDeniedAuditAsync(
                actorId,
                "admin.station.update",
                "PackingStation",
                stationId.ToString(),
                station.Warehouse.ShopId,
                station.WarehouseId,
                ct);
            return ForbiddenWarehouseManage();
        }

        var code = request.Code?.Trim() ?? string.Empty;
        var name = request.Name?.Trim() ?? string.Empty;

        if (string.IsNullOrWhiteSpace(code) || code.Length > 32 || !SafeOrgCodeRegex().IsMatch(code))
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_STATION_CODE",
                "Mã bàn đóng gói bắt buộc (tối đa 32 ký tự, chỉ gồm chữ không dấu, số, '-' hoặc '_')."));
        }

        if (string.IsNullOrWhiteSpace(name) || name.Length > 128)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_STATION_NAME",
                "Tên bàn đóng gói bắt buộc và không vượt quá 128 ký tự."));
        }

        var duplicate = await _db.PackingStations
            .AsNoTracking()
            .AnyAsync(p =>
                p.WarehouseId == station.WarehouseId &&
                p.Id != station.Id &&
                p.Code.ToLower() == code.ToLower(), ct);

        if (duplicate)
        {
            return Conflict(new ApiErrorResponse(
                "DUPLICATE_STATION_CODE",
                "Mã bàn đóng gói này đã tồn tại trong cùng Kho."));
        }

        station.Code = code;
        station.Name = name;
        station.IsActive = request.IsActive;

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.station.update",
            EntityType: "PackingStation",
            EntityId: station.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: station.Warehouse.ShopId,
            WarehouseId: station.WarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                warehouseCode = station.Warehouse.Code,
                station.Code,
                station.Name,
                station.IsActive
            }), ct);

        return Ok(new AdminPackingStationDto(
            station.Id,
            station.WarehouseId,
            station.Code,
            station.Name,
            station.IsActive,
            station.CreatedAtUtc));
    }

    [HttpDelete("{warehouseId:guid}")]
    [HttpPost("{warehouseId:guid}/delete")]
    public async Task<IActionResult> DeleteWarehouse(
        Guid warehouseId,
        [FromQuery] bool force = false,
        CancellationToken ct = default)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var warehouse = await _db.Warehouses
            .Include(w => w.PackingStations)
            .FirstOrDefaultAsync(w => w.Id == warehouseId, ct);

        if (warehouse is null)
        {
            return NotFound(new ApiErrorResponse("WAREHOUSE_NOT_FOUND", "Không tìm thấy Kho đóng gói cần xóa."));
        }

        var access = await ResolveWarehouseAdminAccessAsync(actorId, ct);
        if (!access.CanManageShop(warehouse.ShopId))
        {
            await AppendDeniedAuditAsync(
                actorId,
                "admin.warehouse.delete",
                "Warehouse",
                warehouseId.ToString(),
                warehouse.ShopId,
                warehouse.Id,
                ct);
            return ForbiddenWarehouseManage();
        }

        var hasHoldRecordings = await _db.Recordings
            .AsNoTracking()
            .AnyAsync(r => r.WarehouseId == warehouseId && !r.IsSoftDeleted && r.Hold, ct);

        if (hasHoldRecordings)
        {
            return Conflict(new ApiErrorResponse(
                "WAREHOUSE_HAS_HOLD_RECORDINGS",
                "Kho đóng gói này đang có video bị khóa bảo vệ đối soát (Hold) nên không thể xóa vĩnh viễn. Vui lòng gỡ khóa bảo vệ trước hoặc dùng nút 'Tạm ngưng'."));
        }

        var activeRecordingCount = await _db.Recordings
            .AsNoTracking()
            .CountAsync(r => r.WarehouseId == warehouseId && !r.IsSoftDeleted, ct);

        if (activeRecordingCount > 0 && !force)
        {
            return Conflict(new ApiErrorResponse(
                "WAREHOUSE_HAS_RECORDINGS",
                $"Kho đóng gói này đang lưu {activeRecordingCount} video đơn hàng. Vui lòng tích chọn xác nhận xóa kèm dữ liệu video hoặc dùng tính năng 'Tạm ngưng'."));
        }

        await PurgeRecordingsByFilterAsync(r => r.WarehouseId == warehouseId, ct);

        var affectedUsers = await _db.Users
            .Where(u => u.DefaultWarehouseId == warehouseId)
            .ToListAsync(ct);
        foreach (var user in affectedUsers)
        {
            user.DefaultWarehouseId = null;
        }

        var grants = await _db.UserScopeGrants
            .Where(g => g.WarehouseId == warehouseId)
            .ToListAsync(ct);
        if (grants.Count > 0)
        {
            _db.UserScopeGrants.RemoveRange(grants);
        }

        if (warehouse.PackingStations.Count > 0)
        {
            _db.PackingStations.RemoveRange(warehouse.PackingStations);
        }

        var deletedCode = warehouse.Code;
        var deletedName = warehouse.Name;
        var shopId = warehouse.ShopId;
        _db.Warehouses.Remove(warehouse);

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.warehouse.delete",
            EntityType: "Warehouse",
            EntityId: warehouseId.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: shopId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { warehouseCode = deletedCode, warehouseName = deletedName, force, purgedRecordings = activeRecordingCount }), ct);

        return Ok(new { message = $"Đã xóa Kho \"{deletedName}\" ({deletedCode}) thành công." });
    }

    [HttpDelete("stations/{stationId:guid}")]
    [HttpPost("stations/{stationId:guid}/delete")]
    public async Task<IActionResult> DeletePackingStation(Guid stationId, CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var station = await _db.PackingStations
            .Include(p => p.Warehouse)
            .FirstOrDefaultAsync(p => p.Id == stationId, ct);

        if (station is null)
        {
            return NotFound(new ApiErrorResponse("STATION_NOT_FOUND", "Không tìm thấy bàn đóng gói cần xóa."));
        }

        var access = await ResolveWarehouseAdminAccessAsync(actorId, ct);
        if (!access.CanManageShop(station.Warehouse.ShopId))
        {
            await AppendDeniedAuditAsync(
                actorId,
                "admin.station.delete",
                "PackingStation",
                stationId.ToString(),
                station.Warehouse.ShopId,
                station.WarehouseId,
                ct);
            return ForbiddenWarehouseManage();
        }

        var linkedRecordings = await _db.Recordings
            .Where(r => r.PackingStationId == stationId)
            .ToListAsync(ct);
        foreach (var rec in linkedRecordings)
        {
            rec.PackingStationId = null;
        }

        var deletedCode = station.Code;
        var deletedName = station.Name;
        var shopId = station.Warehouse.ShopId;
        var warehouseId = station.WarehouseId;
        _db.PackingStations.Remove(station);

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.station.delete",
            EntityType: "PackingStation",
            EntityId: stationId.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: shopId,
            WarehouseId: warehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { stationCode = deletedCode, stationName = deletedName }), ct);

        return Ok(new { message = $"Đã xóa bàn đóng gói \"{deletedName}\" ({deletedCode}) thành công." });
    }

    private async Task PurgeRecordingsByFilterAsync(
        System.Linq.Expressions.Expression<Func<Recording, bool>> filter,
        CancellationToken ct)
    {
        var recordings = await _db.Recordings
            .Where(filter)
            .ToListAsync(ct);

        if (recordings.Count == 0)
        {
            return;
        }

        var recIds = recordings.Select(r => r.Id).ToList();

        var externalLinks = await _db.Recordings
            .Where(r => r.LinkedFromRecordingId.HasValue && recIds.Contains(r.LinkedFromRecordingId.Value))
            .ToListAsync(ct);
        foreach (var linked in externalLinks)
        {
            linked.LinkedFromRecordingId = null;
        }

        var assets = await _db.VideoAssets
            .Where(a => recIds.Contains(a.RecordingId))
            .ToListAsync(ct);
        if (assets.Count > 0)
        {
            _db.VideoAssets.RemoveRange(assets);
        }

        var sessions = await _db.UploadSessions
            .Where(u => recIds.Contains(u.RecordingId))
            .ToListAsync(ct);
        if (sessions.Count > 0)
        {
            _db.UploadSessions.RemoveRange(sessions);
        }

        var jobs = await _db.ProcessingJobs
            .Where(j => recIds.Contains(j.RecordingId))
            .ToListAsync(ct);
        if (jobs.Count > 0)
        {
            _db.ProcessingJobs.RemoveRange(jobs);
        }

        var notes = await _db.VideoNotes
            .Where(n => recIds.Contains(n.RecordingId))
            .ToListAsync(ct);
        if (notes.Count > 0)
        {
            _db.VideoNotes.RemoveRange(notes);
        }

        var delReqs = await _db.DeletionRequests
            .Where(d => recIds.Contains(d.RecordingId))
            .ToListAsync(ct);
        if (delReqs.Count > 0)
        {
            _db.DeletionRequests.RemoveRange(delReqs);
        }

        _db.Recordings.RemoveRange(recordings);
    }

    private async Task SyncStorageProfileAllowedSubdirsAsync(Guid actorId, CancellationToken ct)
    {
        var profile = await _db.StorageProfiles.OrderBy(p => p.Name).FirstOrDefaultAsync(ct);
        if (profile is null)
        {
            return;
        }

        var activeSubdirs = await _db.Shops
            .AsNoTracking()
            .Where(s => s.IsActive && !string.IsNullOrWhiteSpace(s.AllowedStorageSubdir))
            .Select(s => s.AllowedStorageSubdir)
            .ToListAsync(ct);

        profile.AllowedSubdirectoriesJson = JsonSerializer.Serialize(
            activeSubdirs.Distinct(StringComparer.OrdinalIgnoreCase)
                         .OrderBy(s => s, StringComparer.OrdinalIgnoreCase)
                         .ToArray());
        profile.UpdatedAtUtc = DateTime.UtcNow;
        profile.UpdatedByUserId = actorId;
        await _db.SaveChangesAsync(ct);
    }

    private sealed record WarehouseAdminAccess(
        bool CanManageAllShops,
        HashSet<Guid> ManagedShopIds)
    {
        public bool HasAnyAccess => CanManageAllShops || ManagedShopIds.Count > 0;

        public bool CanManageShop(Guid shopId) =>
            CanManageAllShops || ManagedShopIds.Contains(shopId);
    }

    private async Task<WarehouseAdminAccess> ResolveWarehouseAdminAccessAsync(
        Guid actorId,
        CancellationToken ct)
    {
        var effective = await _scopeAuth.GetEffectiveAccessAsync(actorId, ct);
        if (!effective.IsActive)
        {
            return new WarehouseAdminAccess(false, []);
        }

        if (effective.IsSuperAdmin ||
            effective.AllPermissions.Contains(PermissionCatalog.StorageManage))
        {
            return new WarehouseAdminAccess(true, []);
        }

        var shopIds = effective.Grants
            .Where(g =>
                g.ScopeType == ScopeType.Shop &&
                g.ShopId.HasValue &&
                g.Permissions.Contains(PermissionCatalog.UserManage, StringComparer.Ordinal))
            .Select(g => g.ShopId!.Value)
            .ToHashSet();

        return new WarehouseAdminAccess(false, shopIds);
    }

    private async Task AppendDeniedAuditAsync(
        Guid actorId,
        string action,
        string entityType,
        string? entityId,
        Guid? shopId,
        Guid? warehouseId,
        CancellationToken ct)
    {
        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: action,
            EntityType: entityType,
            EntityId: entityId,
            Outcome: AuditOutcome.Denied,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            ShopId: shopId,
            WarehouseId: warehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { reason = "FORBIDDEN_WAREHOUSE_MANAGE" }), ct);
    }

    private ObjectResult ForbiddenWarehouseManage() =>
        StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
            "FORBIDDEN",
            "Bạn không có quyền quản lý cấu trúc Shop hoặc Kho đóng gói trong phạm vi này."));

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeSingleSubdirRegex();

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeOrgCodeRegex();
}

