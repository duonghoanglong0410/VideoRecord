using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Infrastructure.Identity;

public sealed class SystemSeeder
{
    private readonly PackingProofDbContext _db;
    private readonly UserManager<ApplicationUser> _userManager;
    private readonly RoleManager<ApplicationRole> _roleManager;
    private readonly PackingProofOptions _options;
    private readonly IAuditLogger _auditLogger;
    private readonly ILogger<SystemSeeder> _logger;

    public SystemSeeder(
        PackingProofDbContext db,
        UserManager<ApplicationUser> userManager,
        RoleManager<ApplicationRole> roleManager,
        PackingProofOptions options,
        IAuditLogger auditLogger,
        ILogger<SystemSeeder> logger)
    {
        _db = db;
        _userManager = userManager;
        _roleManager = roleManager;
        _options = options;
        _auditLogger = auditLogger;
        _logger = logger;
    }

    public async Task SeedAsync(CancellationToken ct = default)
    {
        await SeedPermissionsAsync(ct);
        var rolesByName = await SeedSystemRolesAsync(ct);
        var (defaultShop, defaultWarehouse) = await SeedLocalDevelopmentDefaultsAsync(ct);
        await SeedStorageProfileAsync(defaultShop, ct);
        await BootstrapInitialSuperAdminIfConfiguredAsync(
            rolesByName[SystemRoles.SuperAdmin],
            defaultShop,
            defaultWarehouse,
            ct);
    }

    private async Task SeedPermissionsAsync(CancellationToken ct)
    {
        var existing = await _db.Permissions
            .ToDictionaryAsync(p => p.Code, StringComparer.Ordinal, ct);

        foreach (var def in PermissionCatalog.All)
        {
            if (existing.TryGetValue(def.Code, out var entity))
            {
                entity.Group = def.Group;
                entity.Description = def.Description;
            }
            else
            {
                _db.Permissions.Add(new Permission
                {
                    Code = def.Code,
                    Group = def.Group,
                    Description = def.Description
                });
            }
        }

        await _db.SaveChangesAsync(ct);
    }

    private async Task<Dictionary<string, ApplicationRole>> SeedSystemRolesAsync(CancellationToken ct)
    {
        var result = new Dictionary<string, ApplicationRole>(StringComparer.Ordinal);

        foreach (var def in SystemRoles.All)
        {
            var role = await _roleManager.FindByNameAsync(def.Name);
            if (role is null)
            {
                role = new ApplicationRole
                {
                    Name = def.Name,
                    Description = def.Description,
                    IsSystemRole = true,
                    CreatedAtUtc = DateTime.UtcNow
                };

                var createResult = await _roleManager.CreateAsync(role);
                if (!createResult.Succeeded)
                {
                    var errors = string.Join("; ", createResult.Errors.Select(e => e.Description));
                    throw new InvalidOperationException($"Failed to create system role '{def.Name}': {errors}");
                }
            }
            else
            {
                var updated = false;
                if (!role.IsSystemRole)
                {
                    role.IsSystemRole = true;
                    updated = true;
                }

                if (role.Description != def.Description)
                {
                    role.Description = def.Description;
                    updated = true;
                }

                if (updated)
                {
                    await _roleManager.UpdateAsync(role);
                }
            }

            var existingPerms = await _db.RolePermissions
                .Where(rp => rp.RoleId == role.Id)
                .ToListAsync(ct);

            var expectedSet = new HashSet<string>(def.DefaultPermissions, StringComparer.Ordinal);
            var existingSet = new HashSet<string>(existingPerms.Select(rp => rp.PermissionCode), StringComparer.Ordinal);

            foreach (var obsolete in existingPerms.Where(rp => !expectedSet.Contains(rp.PermissionCode)))
            {
                _db.RolePermissions.Remove(obsolete);
            }

            foreach (var missingCode in expectedSet.Where(code => !existingSet.Contains(code)))
            {
                _db.RolePermissions.Add(new RolePermission
                {
                    RoleId = role.Id,
                    PermissionCode = missingCode
                });
            }

            await _db.SaveChangesAsync(ct);
            result[def.Name] = role;
        }

        return result;
    }

    private async Task<(Shop? Shop, Warehouse? Warehouse)> SeedLocalDevelopmentDefaultsAsync(CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetFullPath(_options.StagingRootPath));

        if (_options.StorageMode != StorageMode.LocalDevelopment)
        {
            return (null, null);
        }

        Directory.CreateDirectory(Path.GetFullPath(_options.NasRootPath));

        var shop = await _db.Shops
            .FirstOrDefaultAsync(s => s.Slug == "shop-a" || s.Code == "ShopA", ct);

        if (shop is null)
        {
            shop = new Shop
            {
                Code = "ShopA",
                Slug = "shop-a",
                Name = "Shop A",
                AllowedStorageSubdir = "shop-a",
                IsActive = true,
                CreatedAtUtc = DateTime.UtcNow
            };
            _db.Shops.Add(shop);
            await _db.SaveChangesAsync(ct);
        }

        var warehouse = await _db.Warehouses
            .FirstOrDefaultAsync(w => w.ShopId == shop.Id && w.Code == "WH-HCM-01", ct);

        if (warehouse is null)
        {
            warehouse = new Warehouse
            {
                ShopId = shop.Id,
                Code = "WH-HCM-01",
                Name = "Kho TP.HCM 01",
                IsActive = true,
                CreatedAtUtc = DateTime.UtcNow
            };
            _db.Warehouses.Add(warehouse);
            await _db.SaveChangesAsync(ct);
        }

        return (shop, warehouse);
    }

    private async Task SeedStorageProfileAsync(Shop? defaultShop, CancellationToken ct)
    {
        var profile = await _db.StorageProfiles.FirstOrDefaultAsync(ct);
        if (profile is null)
        {
            var allowedDirs = defaultShop is not null
                ? JsonSerializer.Serialize(new[] { defaultShop.AllowedStorageSubdir })
                : "[]";

            profile = new StorageProfile
            {
                Name = "Default",
                Mode = _options.StorageMode,
                ExpectedStorageId = _options.StorageId,
                AllowedSubdirectoriesJson = allowedDirs,
                MaxRecordingSeconds = _options.MaxRecordingSeconds,
                MaxUploadBytes = _options.MaxUploadBytes,
                MaxLocalPendingRecordings = _options.MaxLocalPendingRecordings,
                RetentionEnabled = _options.RetentionEnabled,
                RetentionDays = _options.RetentionDays,
                EnableAudioRecording = _options.EnableAudioRecording,
                UpdatedAtUtc = DateTime.UtcNow
            };
            _db.StorageProfiles.Add(profile);
        }
        else
        {
            profile.Mode = _options.StorageMode;
            profile.ExpectedStorageId = _options.StorageId;
            profile.MaxRecordingSeconds = _options.MaxRecordingSeconds;
            profile.MaxUploadBytes = _options.MaxUploadBytes;
            profile.MaxLocalPendingRecordings = _options.MaxLocalPendingRecordings;
            profile.EnableAudioRecording = _options.EnableAudioRecording;
            profile.UpdatedAtUtc = DateTime.UtcNow;
        }

        await _db.SaveChangesAsync(ct);
    }

    private async Task BootstrapInitialSuperAdminIfConfiguredAsync(
        ApplicationRole superAdminRole,
        Shop? defaultShop,
        Warehouse? defaultWarehouse,
        CancellationToken ct)
    {
        var anySuperAdminExists = await _db.UserScopeGrants
            .AnyAsync(g => g.RoleId == superAdminRole.Id && g.ScopeType == ScopeType.All, ct);

        if (anySuperAdminExists)
        {
            return;
        }

        var email = _options.InitialAdminEmail?.Trim();
        var password = _options.InitialAdminPassword;

        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(password))
        {
            _logger.LogInformation(
                "No SuperAdmin exists and INITIAL_ADMIN_EMAIL/INITIAL_ADMIN_PASSWORD are not set; skipping SuperAdmin bootstrap.");
            return;
        }

        if (email.StartsWith("CHANGE_ME", StringComparison.OrdinalIgnoreCase) ||
            password.TrimStart().StartsWith("CHANGE_ME", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogWarning(
                "INITIAL_ADMIN_EMAIL or INITIAL_ADMIN_PASSWORD contains a CHANGE_ME placeholder; refusing to bootstrap SuperAdmin.");
            return;
        }

        var user = await _userManager.FindByEmailAsync(email);
        if (user is null)
        {
            user = new ApplicationUser
            {
                UserName = email,
                Email = email,
                EmailConfirmed = true,
                FullName = "Quản trị viên Hệ thống",
                ApprovalStatus = ApprovalStatus.Active,
                ApprovedAtUtc = DateTime.UtcNow,
                DefaultShopId = defaultShop?.Id,
                DefaultWarehouseId = defaultWarehouse?.Id,
                CreatedAtUtc = DateTime.UtcNow
            };

            var createResult = await _userManager.CreateAsync(user, password);
            if (!createResult.Succeeded)
            {
                var errors = string.Join("; ", createResult.Errors.Select(e => e.Description));
                _logger.LogError("Failed to bootstrap initial SuperAdmin '{Email}': {Errors}", email, errors);
                return;
            }
        }
        else
        {
            user.ApprovalStatus = ApprovalStatus.Active;
            user.ApprovedAtUtc ??= DateTime.UtcNow;
            await _userManager.UpdateAsync(user);
        }

        _db.UserScopeGrants.Add(new UserScopeGrant
        {
            UserId = user.Id,
            RoleId = superAdminRole.Id,
            ScopeType = ScopeType.All,
            CreatedAtUtc = DateTime.UtcNow
        });

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "system.bootstrap_superadmin",
            EntityType: "User",
            EntityId: user.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: user.Id,
            ActorEmail: user.Email,
            Metadata: new { email = user.Email, role = SystemRoles.SuperAdmin, scope = "All" }), ct);

        _logger.LogInformation("Bootstrapped initial SuperAdmin account '{Email}'.", email);
    }
}

