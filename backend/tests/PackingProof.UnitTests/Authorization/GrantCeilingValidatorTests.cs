using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using Xunit;

namespace PackingProof.UnitTests.Authorization;

public sealed class GrantCeilingValidatorTests
{
    [Fact]
    public async Task ShopAdmin_CannotGrant_SuperAdminRole()
    {
        await using var db = InMemoryAuthTestHarness.CreateDbContext();
        var world = await InMemoryAuthTestHarness.SeedStandardWorldAsync(db);
        var (_, validator) = InMemoryAuthTestHarness.CreateServices(db);

        var adminShopA = InMemoryAuthTestHarness.CreateUser(db, "admin-a@example.local");
        var staff = InMemoryAuthTestHarness.CreateUser(db, "staff@example.local");

        db.UserScopeGrants.Add(new UserScopeGrant
        {
            UserId = adminShopA.Id,
            RoleId = world.Roles[SystemRoles.Admin].Id,
            ScopeType = ScopeType.Shop,
            ShopId = world.ShopA.Id
        });
        await db.SaveChangesAsync();

        var result = await validator.ValidateRoleAssignmentAsync(
            adminShopA.Id,
            staff.Id,
            world.Roles[SystemRoles.SuperAdmin].Id,
            ScopeType.All,
            shopId: null,
            warehouseId: null);

        Assert.False(result.IsAllowed);
        Assert.Equal("CANNOT_GRANT_SUPERADMIN", result.ErrorCode);
    }

    [Fact]
    public async Task ShopAdmin_CannotGrant_OtherShop_Or_AllScope()
    {
        await using var db = InMemoryAuthTestHarness.CreateDbContext();
        var world = await InMemoryAuthTestHarness.SeedStandardWorldAsync(db);
        var (_, validator) = InMemoryAuthTestHarness.CreateServices(db);

        var adminShopA = InMemoryAuthTestHarness.CreateUser(db, "admin-a@example.local");
        var staff = InMemoryAuthTestHarness.CreateUser(db, "staff@example.local");

        db.UserScopeGrants.Add(new UserScopeGrant
        {
            UserId = adminShopA.Id,
            RoleId = world.Roles[SystemRoles.Admin].Id,
            ScopeType = ScopeType.Shop,
            ShopId = world.ShopA.Id
        });
        await db.SaveChangesAsync();

        var shopBResult = await validator.ValidateRoleAssignmentAsync(
            adminShopA.Id,
            staff.Id,
            world.Roles[SystemRoles.Operator].Id,
            ScopeType.Shop,
            shopId: world.ShopB.Id,
            warehouseId: null);

        Assert.False(shopBResult.IsAllowed);
        Assert.Equal("OUT_OF_SCOPE_GRANT", shopBResult.ErrorCode);

        var allScopeResult = await validator.ValidateRoleAssignmentAsync(
            adminShopA.Id,
            staff.Id,
            world.Roles[SystemRoles.Operator].Id,
            ScopeType.All,
            shopId: null,
            warehouseId: null);

        Assert.False(allScopeResult.IsAllowed);
        Assert.Equal("ALL_SCOPE_RESERVED_FOR_SUPERADMIN", allScopeResult.ErrorCode);
    }

    [Fact]
    public async Task ShopAdmin_CannotGrant_RoleContainingPermissionsOutsideOwnCeiling()
    {
        await using var db = InMemoryAuthTestHarness.CreateDbContext();
        var world = await InMemoryAuthTestHarness.SeedStandardWorldAsync(db);
        var (_, validator) = InMemoryAuthTestHarness.CreateServices(db);

        var adminShopA = InMemoryAuthTestHarness.CreateUser(db, "admin-a@example.local");
        var staff = InMemoryAuthTestHarness.CreateUser(db, "staff@example.local");

        db.UserScopeGrants.Add(new UserScopeGrant
        {
            UserId = adminShopA.Id,
            RoleId = world.Roles[SystemRoles.Admin].Id,
            ScopeType = ScopeType.Shop,
            ShopId = world.ShopA.Id
        });

        // Custom role containing storage.manage (which Shop Admin does NOT possess)
        var storageRole = new ApplicationRole
        {
            Id = Guid.NewGuid(),
            Name = "StorageCoordinator",
            NormalizedName = "STORAGECOORDINATOR",
            Description = "Has storage.manage",
            IsSystemRole = false
        };
        db.Roles.Add(storageRole);
        db.RolePermissions.Add(new RolePermission
        {
            RoleId = storageRole.Id,
            PermissionCode = PermissionCatalog.StorageManage
        });
        await db.SaveChangesAsync();

        var grantResult = await validator.ValidateRoleAssignmentAsync(
            adminShopA.Id,
            staff.Id,
            storageRole.Id,
            ScopeType.Shop,
            shopId: world.ShopA.Id,
            warehouseId: null);

        Assert.False(grantResult.IsAllowed);
        Assert.Equal("GRANT_CEILING_EXCEEDED", grantResult.ErrorCode);

        var createRoleResult = await validator.ValidateCustomRoleAsync(
            adminShopA.Id,
            existingRoleId: null,
            [PermissionCatalog.VideoView, PermissionCatalog.StorageManage]);

        Assert.False(createRoleResult.IsAllowed);
        Assert.Equal("GRANT_CEILING_EXCEEDED", createRoleResult.ErrorCode);
    }

    [Fact]
    public async Task CannotLockOrDemote_LastActiveSuperAdmin()
    {
        await using var db = InMemoryAuthTestHarness.CreateDbContext();
        var world = await InMemoryAuthTestHarness.SeedStandardWorldAsync(db);
        var (_, validator) = InMemoryAuthTestHarness.CreateServices(db);

        var soleSuperAdmin = InMemoryAuthTestHarness.CreateUser(db, "root@example.local");
        db.UserScopeGrants.Add(new UserScopeGrant
        {
            UserId = soleSuperAdmin.Id,
            RoleId = world.Roles[SystemRoles.SuperAdmin].Id,
            ScopeType = ScopeType.All
        });
        await db.SaveChangesAsync();

        var lockResult = await validator.ValidateUserManagementActionAsync(
            soleSuperAdmin.Id,
            soleSuperAdmin.Id,
            "lock");

        Assert.False(lockResult.IsAllowed);
        Assert.Equal("LAST_SUPERADMIN_PROTECTED", lockResult.ErrorCode);

        var demoteBatchResult = await validator.ValidateGrantsAssignmentAsync(
            soleSuperAdmin.Id,
            soleSuperAdmin.Id,
            [
                new GrantProposal(
                    world.Roles[SystemRoles.Admin].Id,
                    ScopeType.Shop,
                    world.ShopA.Id,
                    null)
            ]);

        Assert.False(demoteBatchResult.IsAllowed);
        Assert.Equal("LAST_SUPERADMIN_PROTECTED", demoteBatchResult.ErrorCode);
    }

    [Fact]
    public async Task Actor_CannotSelfEscalate_OwnGrants()
    {
        await using var db = InMemoryAuthTestHarness.CreateDbContext();
        var world = await InMemoryAuthTestHarness.SeedStandardWorldAsync(db);
        var (_, validator) = InMemoryAuthTestHarness.CreateServices(db);

        var warehouseLeadRole = new ApplicationRole
        {
            Id = Guid.NewGuid(),
            Name = "WarehouseUserManager",
            NormalizedName = "WAREHOUSEUSERMANAGER",
            Description = "Can manage users in warehouse",
            IsSystemRole = false
        };
        db.Roles.Add(warehouseLeadRole);
        db.RolePermissions.AddRange(
            new RolePermission { RoleId = warehouseLeadRole.Id, PermissionCode = PermissionCatalog.UserManage },
            new RolePermission { RoleId = warehouseLeadRole.Id, PermissionCode = PermissionCatalog.VideoView });

        var whLead = InMemoryAuthTestHarness.CreateUser(db, "whlead@example.local");
        db.UserScopeGrants.Add(new UserScopeGrant
        {
            UserId = whLead.Id,
            RoleId = warehouseLeadRole.Id,
            ScopeType = ScopeType.Warehouse,
            ShopId = world.ShopA.Id,
            WarehouseId = world.WarehouseA1.Id
        });
        await db.SaveChangesAsync();

        var selfGrantResult = await validator.ValidateRoleAssignmentAsync(
            whLead.Id,
            whLead.Id,
            world.Roles[SystemRoles.Viewer].Id,
            ScopeType.Warehouse,
            world.ShopA.Id,
            world.WarehouseA1.Id);

        Assert.False(selfGrantResult.IsAllowed);
        Assert.Equal("SELF_ESCALATION_FORBIDDEN", selfGrantResult.ErrorCode);
    }

    [Fact]
    public async Task ShopAdmin_CanGrant_OperatorWithinOwnShop_AndOperatorDefaultsDisableManualCodeAndImport()
    {
        await using var db = InMemoryAuthTestHarness.CreateDbContext();
        var world = await InMemoryAuthTestHarness.SeedStandardWorldAsync(db);
        var (_, validator) = InMemoryAuthTestHarness.CreateServices(db);

        var operatorDef = SystemRoles.All.Single(r => r.Name == SystemRoles.Operator);
        Assert.DoesNotContain(PermissionCatalog.RecordingManualCode, operatorDef.DefaultPermissions);
        Assert.DoesNotContain(PermissionCatalog.VideoImport, operatorDef.DefaultPermissions);

        var adminShopA = InMemoryAuthTestHarness.CreateUser(db, "admin-a@example.local");
        var operatorUser = InMemoryAuthTestHarness.CreateUser(db, "op@example.local");

        db.UserScopeGrants.Add(new UserScopeGrant
        {
            UserId = adminShopA.Id,
            RoleId = world.Roles[SystemRoles.Admin].Id,
            ScopeType = ScopeType.Shop,
            ShopId = world.ShopA.Id
        });
        await db.SaveChangesAsync();

        var validResult = await validator.ValidateRoleAssignmentAsync(
            adminShopA.Id,
            operatorUser.Id,
            world.Roles[SystemRoles.Operator].Id,
            ScopeType.Warehouse,
            shopId: world.ShopA.Id,
            warehouseId: world.WarehouseA1.Id);

        Assert.True(validResult.IsAllowed);
    }
}

