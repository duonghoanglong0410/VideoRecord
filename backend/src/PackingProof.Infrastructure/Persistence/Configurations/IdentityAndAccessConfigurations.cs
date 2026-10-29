using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using PackingProof.Core.Entities;

namespace PackingProof.Infrastructure.Persistence.Configurations;

public sealed class ApplicationUserConfiguration : IEntityTypeConfiguration<ApplicationUser>
{
    public void Configure(EntityTypeBuilder<ApplicationUser> builder)
    {
        builder.Property(u => u.FullName)
            .HasMaxLength(200)
            .IsRequired();

        builder.Property(u => u.ApprovalStatus)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.HasOne(u => u.DefaultShop)
            .WithMany()
            .HasForeignKey(u => u.DefaultShopId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasOne(u => u.DefaultWarehouse)
            .WithMany()
            .HasForeignKey(u => u.DefaultWarehouseId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasIndex(u => u.ApprovalStatus)
            .HasDatabaseName("IX_Users_ApprovalStatus");
    }
}

public sealed class ApplicationRoleConfiguration : IEntityTypeConfiguration<ApplicationRole>
{
    public void Configure(EntityTypeBuilder<ApplicationRole> builder)
    {
        builder.Property(r => r.Description)
            .HasMaxLength(500)
            .IsRequired();
    }
}

public sealed class PermissionConfiguration : IEntityTypeConfiguration<Permission>
{
    public void Configure(EntityTypeBuilder<Permission> builder)
    {
        builder.ToTable("Permissions");
        builder.HasKey(p => p.Code);

        builder.Property(p => p.Code)
            .HasMaxLength(64)
            .IsRequired();

        builder.Property(p => p.Group)
            .HasMaxLength(100)
            .IsRequired();

        builder.Property(p => p.Description)
            .HasMaxLength(500)
            .IsRequired();
    }
}

public sealed class RolePermissionConfiguration : IEntityTypeConfiguration<RolePermission>
{
    public void Configure(EntityTypeBuilder<RolePermission> builder)
    {
        builder.ToTable("RolePermissions");
        builder.HasKey(rp => new { rp.RoleId, rp.PermissionCode });

        builder.Property(rp => rp.PermissionCode)
            .HasMaxLength(64)
            .IsRequired();

        builder.HasOne(rp => rp.Role)
            .WithMany(r => r.RolePermissions)
            .HasForeignKey(rp => rp.RoleId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(rp => rp.Permission)
            .WithMany(p => p.RolePermissions)
            .HasForeignKey(rp => rp.PermissionCode)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class UserScopeGrantConfiguration : IEntityTypeConfiguration<UserScopeGrant>
{
    public void Configure(EntityTypeBuilder<UserScopeGrant> builder)
    {
        builder.ToTable("UserScopeGrants");
        builder.HasKey(g => g.Id);

        builder.Property(g => g.ScopeType)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.HasOne(g => g.User)
            .WithMany(u => u.ScopeGrants)
            .HasForeignKey(g => g.UserId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(g => g.Role)
            .WithMany(r => r.ScopeGrants)
            .HasForeignKey(g => g.RoleId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(g => g.Shop)
            .WithMany()
            .HasForeignKey(g => g.ShopId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(g => g.Warehouse)
            .WithMany()
            .HasForeignKey(g => g.WarehouseId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(g => g.GrantedByUser)
            .WithMany()
            .HasForeignKey(g => g.GrantedByUserId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasIndex(g => g.UserId)
            .HasDatabaseName("IX_UserScopeGrants_UserId");

        builder.HasIndex(g => new { g.ShopId, g.WarehouseId })
            .HasDatabaseName("IX_UserScopeGrants_ShopId_WarehouseId");
    }
}

