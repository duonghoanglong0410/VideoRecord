using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Enums;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Api.Features.Shops;

public sealed record PackingStationDto(Guid Id, string Code, string Name);

public sealed record WarehouseDto(
    Guid Id,
    string Code,
    string Name,
    IReadOnlyList<PackingStationDto> PackingStations);

public sealed record ShopDto(
    Guid Id,
    string Code,
    string Slug,
    string Name,
    IReadOnlyList<WarehouseDto> Warehouses);

public sealed record AccessibleShopsResponse(IReadOnlyList<ShopDto> Shops);

[ApiController]
[Route("api/shops")]
[Authorize]
public sealed class ShopsController : ControllerBase
{
    private readonly PackingProofDbContext _db;
    private readonly IScopeAuthorizationService _scopeAuth;

    public ShopsController(
        PackingProofDbContext db,
        IScopeAuthorizationService scopeAuth)
    {
        _db = db;
        _scopeAuth = scopeAuth;
    }

    [HttpGet]
    public async Task<ActionResult<AccessibleShopsResponse>> GetAccessibleShops(CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var access = await _scopeAuth.GetEffectiveAccessAsync(userId, ct);

        if (!access.IsActive || access.Grants.Count == 0)
        {
            return Ok(new AccessibleShopsResponse([]));
        }

        var allActiveShops = await _db.Shops
            .AsNoTracking()
            .AsSplitQuery()
            .Where(s => s.IsActive)
            .Include(s => s.Warehouses.Where(w => w.IsActive))
                .ThenInclude(w => w.PackingStations.Where(p => p.IsActive))
            .OrderBy(s => s.Name)
            .ToListAsync(ct);

        if (access.IsSuperAdmin)
        {
            var allDtos = allActiveShops
                .Select(s => MapShop(s, null))
                .ToList();
            return Ok(new AccessibleShopsResponse(allDtos));
        }

        var fullShopIds = access.Grants
            .Where(g =>
                (g.ScopeType == ScopeType.Shop && g.ShopId.HasValue) ||
                (g.ScopeType == ScopeType.Own && g.ShopId.HasValue && !g.WarehouseId.HasValue))
            .Select(g => g.ShopId!.Value)
            .ToHashSet();

        var specificWarehouseIds = access.Grants
            .Where(g => g.WarehouseId.HasValue)
            .Select(g => g.WarehouseId!.Value)
            .ToHashSet();

        var filteredShops = new List<ShopDto>();
        foreach (var shop in allActiveShops)
        {
            if (fullShopIds.Contains(shop.Id))
            {
                filteredShops.Add(MapShop(shop, null));
            }
            else
            {
                var matchingWh = shop.Warehouses
                    .Where(w => specificWarehouseIds.Contains(w.Id))
                    .Select(w => w.Id)
                    .ToHashSet();

                if (matchingWh.Count > 0)
                {
                    filteredShops.Add(MapShop(shop, matchingWh));
                }
            }
        }

        return Ok(new AccessibleShopsResponse(filteredShops));
    }

    private static ShopDto MapShop(Core.Entities.Shop shop, HashSet<Guid>? allowedWarehouseIds)
    {
        var warehouses = shop.Warehouses
            .Where(w => allowedWarehouseIds is null || allowedWarehouseIds.Contains(w.Id))
            .OrderBy(w => w.Name)
            .Select(w => new WarehouseDto(
                w.Id,
                w.Code,
                w.Name,
                w.PackingStations
                    .OrderBy(p => p.Name)
                    .Select(p => new PackingStationDto(p.Id, p.Code, p.Name))
                    .ToList()))
            .ToList();

        return new ShopDto(
            shop.Id,
            shop.Code,
            shop.Slug,
            shop.Name,
            warehouses);
    }
}
