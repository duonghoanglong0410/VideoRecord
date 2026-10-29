using Microsoft.EntityFrameworkCore;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Authorization;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.UnitTests;

public static class InMemoryAuthTestHarness
{
    public static PackingProofDbContext CreateDbContext()
    {
        var options = new DbContextOptionsBuilder<PackingProofDbContext>()
            .UseInMemoryDatabase($"packingproof_unit_{Guid.NewGuid():N}")
            .Options;

        return new PackingProofDbContext(options);
    }

    public static async Task<SeededWorld> SeedStandardWorldAsync(PackingProofDbContext db)
    {
        foreach (var p in PermissionCatalog.All)
        {
            db.Permissions.Add(new Permission
            {
                Code = p.Code,
                Group = p.Group,
                Description = p.Description
            });
        }

        var roles = new Dictionary<string, ApplicationRole>(StringComparer.Ordinal);
        foreach (var r in SystemRoles.All)
        {
            var role = new ApplicationRole
            {
                Id = Guid.NewGuid(),
                Name = r.Name,
                NormalizedName = r.Name.ToUpperInvariant(),
                Description = r.Description,
                IsSystemRole = true
            };
            db.Roles.Add(role);
            roles[r.Name] = role;

            foreach (var code in r.DefaultPermissions)
            {
                db.RolePermissions.Add(new RolePermission
                {
                    RoleId = role.Id,
                    PermissionCode = code
                });
            }
        }

        var shopA = new Shop
        {
            Id = Guid.NewGuid(),
            Code = "ShopA",
            Slug = "shop-a",
            Name = "Shop A",
            AllowedStorageSubdir = "shop-a",
            IsActive = true
        };

        var shopB = new Shop
        {
            Id = Guid.NewGuid(),
            Code = "ShopB",
            Slug = "shop-b",
            Name = "Shop B",
            AllowedStorageSubdir = "shop-b",
            IsActive = true
        };

        db.Shops.AddRange(shopA, shopB);

        var warehouseA1 = new Warehouse
        {
            Id = Guid.NewGuid(),
            ShopId = shopA.Id,
            Code = "WH-A1",
            Name = "Kho A1",
            IsActive = true
        };

        var warehouseA2 = new Warehouse
        {
            Id = Guid.NewGuid(),
            ShopId = shopA.Id,
            Code = "WH-A2",
            Name = "Kho A2",
            IsActive = true
        };

        var warehouseB1 = new Warehouse
        {
            Id = Guid.NewGuid(),
            ShopId = shopB.Id,
            Code = "WH-B1",
            Name = "Kho B1",
            IsActive = true
        };

        db.Warehouses.AddRange(warehouseA1, warehouseA2, warehouseB1);
        await db.SaveChangesAsync();

        return new SeededWorld(roles, shopA, shopB, warehouseA1, warehouseA2, warehouseB1);
    }

    public static ApplicationUser CreateUser(
        PackingProofDbContext db,
        string email,
        ApprovalStatus status = ApprovalStatus.Active)
    {
        var user = new ApplicationUser
        {
            Id = Guid.NewGuid(),
            UserName = email,
            NormalizedUserName = email.ToUpperInvariant(),
            Email = email,
            NormalizedEmail = email.ToUpperInvariant(),
            FullName = email,
            ApprovalStatus = status,
            SecurityStamp = Guid.NewGuid().ToString("N")
        };

        db.Users.Add(user);
        return user;
    }

    public static (ScopeAuthorizationService ScopeAuth, GrantCeilingValidator Validator) CreateServices(
        PackingProofDbContext db)
    {
        var scopeAuth = new ScopeAuthorizationService(db);
        var validator = new GrantCeilingValidator(db, scopeAuth);
        return (scopeAuth, validator);
    }
}

public sealed record SeededWorld(
    Dictionary<string, ApplicationRole> Roles,
    Shop ShopA,
    Shop ShopB,
    Warehouse WarehouseA1,
    Warehouse WarehouseA2,
    Warehouse WarehouseB1);

