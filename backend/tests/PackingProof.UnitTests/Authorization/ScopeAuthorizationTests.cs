using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using Xunit;

namespace PackingProof.UnitTests.Authorization;

public sealed class ScopeAuthorizationTests
{
    [Fact]
    public async Task DefaultDeny_AppliesToUnassigned_PendingApproval_AndLockedUsers()
    {
        await using var db = InMemoryAuthTestHarness.CreateDbContext();
        var world = await InMemoryAuthTestHarness.SeedStandardWorldAsync(db);
        var (scopeAuth, _) = InMemoryAuthTestHarness.CreateServices(db);

        var unassigned = InMemoryAuthTestHarness.CreateUser(db, "unassigned@example.local");
        var pending = InMemoryAuthTestHarness.CreateUser(db, "pending@example.local", ApprovalStatus.PendingApproval);
        var locked = InMemoryAuthTestHarness.CreateUser(db, "locked@example.local", ApprovalStatus.Locked);

        db.UserScopeGrants.AddRange(
            new UserScopeGrant
            {
                UserId = pending.Id,
                RoleId = world.Roles[SystemRoles.SuperAdmin].Id,
                ScopeType = ScopeType.All
            },
            new UserScopeGrant
            {
                UserId = locked.Id,
                RoleId = world.Roles[SystemRoles.SuperAdmin].Id,
                ScopeType = ScopeType.All
            });
        await db.SaveChangesAsync();

        var resource = new ResourceScopeContext(unassigned.Id, world.ShopA.Id, world.WarehouseA1.Id);

        Assert.False(await scopeAuth.HasPermissionAsync(unassigned.Id, PermissionCatalog.VideoView, resource));
        Assert.False(await scopeAuth.HasPermissionAsync(pending.Id, PermissionCatalog.VideoView, resource));
        Assert.False(await scopeAuth.HasPermissionAsync(locked.Id, PermissionCatalog.VideoView, resource));
        Assert.False(await scopeAuth.HasPermissionAsync(unassigned.Id, "unknown.permission", resource));
    }

    [Fact]
    public async Task OwnScope_AllowsOnlyOwnResourcesWithinAssignedBoundary()
    {
        await using var db = InMemoryAuthTestHarness.CreateDbContext();
        var world = await InMemoryAuthTestHarness.SeedStandardWorldAsync(db);
        var (scopeAuth, _) = InMemoryAuthTestHarness.CreateServices(db);

        var operatorA = InMemoryAuthTestHarness.CreateUser(db, "op-a@example.local");
        var operatorB = InMemoryAuthTestHarness.CreateUser(db, "op-b@example.local");

        db.UserScopeGrants.Add(new UserScopeGrant
        {
            UserId = operatorA.Id,
            RoleId = world.Roles[SystemRoles.Operator].Id,
            ScopeType = ScopeType.Own,
            ShopId = world.ShopA.Id,
            WarehouseId = world.WarehouseA1.Id
        });
        await db.SaveChangesAsync();

        var ownRecordingInA1 = new ResourceScopeContext(operatorA.Id, world.ShopA.Id, world.WarehouseA1.Id);
        var otherUserRecordingInA1 = new ResourceScopeContext(operatorB.Id, world.ShopA.Id, world.WarehouseA1.Id);
        var ownRecordingInA2 = new ResourceScopeContext(operatorA.Id, world.ShopA.Id, world.WarehouseA2.Id);

        Assert.True(await scopeAuth.HasPermissionAsync(operatorA.Id, PermissionCatalog.VideoView, ownRecordingInA1));
        Assert.False(await scopeAuth.HasPermissionAsync(operatorA.Id, PermissionCatalog.VideoDownload, ownRecordingInA1));
        Assert.False(await scopeAuth.HasPermissionAsync(operatorA.Id, PermissionCatalog.VideoView, otherUserRecordingInA1));
        Assert.False(await scopeAuth.HasPermissionAsync(operatorA.Id, PermissionCatalog.VideoView, ownRecordingInA2));
    }

    [Fact]
    public async Task WarehouseAndShopAndAllScopes_EvaluateBoundariesStrictly()
    {
        await using var db = InMemoryAuthTestHarness.CreateDbContext();
        var world = await InMemoryAuthTestHarness.SeedStandardWorldAsync(db);
        var (scopeAuth, _) = InMemoryAuthTestHarness.CreateServices(db);

        var managerWhA1 = InMemoryAuthTestHarness.CreateUser(db, "mgr-a1@example.local");
        var viewerShopA = InMemoryAuthTestHarness.CreateUser(db, "viewer-a@example.local");
        var superAdmin = InMemoryAuthTestHarness.CreateUser(db, "super@example.local");
        var forgedAllViewer = InMemoryAuthTestHarness.CreateUser(db, "forged@example.local");

        db.UserScopeGrants.AddRange(
            new UserScopeGrant
            {
                UserId = managerWhA1.Id,
                RoleId = world.Roles[SystemRoles.Manager].Id,
                ScopeType = ScopeType.Warehouse,
                ShopId = world.ShopA.Id,
                WarehouseId = world.WarehouseA1.Id
            },
            new UserScopeGrant
            {
                UserId = viewerShopA.Id,
                RoleId = world.Roles[SystemRoles.Viewer].Id,
                ScopeType = ScopeType.Shop,
                ShopId = world.ShopA.Id
            },
            new UserScopeGrant
            {
                UserId = superAdmin.Id,
                RoleId = world.Roles[SystemRoles.SuperAdmin].Id,
                ScopeType = ScopeType.All
            },
            new UserScopeGrant
            {
                UserId = forgedAllViewer.Id,
                RoleId = world.Roles[SystemRoles.Viewer].Id,
                ScopeType = ScopeType.All
            });
        await db.SaveChangesAsync();

        var resWhA1 = new ResourceScopeContext(Guid.NewGuid(), world.ShopA.Id, world.WarehouseA1.Id);
        var resWhA2 = new ResourceScopeContext(Guid.NewGuid(), world.ShopA.Id, world.WarehouseA2.Id);
        var resWhB1 = new ResourceScopeContext(Guid.NewGuid(), world.ShopB.Id, world.WarehouseB1.Id);

        // Manager in WH-A1 can view/hold in WH-A1, NOT in WH-A2, and has NO download by default
        Assert.True(await scopeAuth.HasPermissionAsync(managerWhA1.Id, PermissionCatalog.VideoView, resWhA1));
        Assert.True(await scopeAuth.HasPermissionAsync(managerWhA1.Id, PermissionCatalog.VideoHold, resWhA1));
        Assert.False(await scopeAuth.HasPermissionAsync(managerWhA1.Id, PermissionCatalog.VideoDownload, resWhA1));
        Assert.False(await scopeAuth.HasPermissionAsync(managerWhA1.Id, PermissionCatalog.VideoView, resWhA2));

        // ShopA Viewer can view across WH-A1 and WH-A2, NOT ShopB, and cannot hold/download
        Assert.True(await scopeAuth.HasPermissionAsync(viewerShopA.Id, PermissionCatalog.VideoView, resWhA1));
        Assert.True(await scopeAuth.HasPermissionAsync(viewerShopA.Id, PermissionCatalog.VideoView, resWhA2));
        Assert.False(await scopeAuth.HasPermissionAsync(viewerShopA.Id, PermissionCatalog.VideoView, resWhB1));
        Assert.False(await scopeAuth.HasPermissionAsync(viewerShopA.Id, PermissionCatalog.VideoHold, resWhA1));

        // SuperAdmin has full access across ShopA and ShopB
        Assert.True(await scopeAuth.HasPermissionAsync(superAdmin.Id, PermissionCatalog.StorageManage, resWhB1));
        Assert.True(await scopeAuth.HasPermissionAsync(superAdmin.Id, PermissionCatalog.VideoDownload, resWhB1));

        // Forged ScopeType.All on a non-SuperAdmin role is rejected
        Assert.False(await scopeAuth.HasPermissionAsync(forgedAllViewer.Id, PermissionCatalog.VideoView, resWhA1));
    }
}

