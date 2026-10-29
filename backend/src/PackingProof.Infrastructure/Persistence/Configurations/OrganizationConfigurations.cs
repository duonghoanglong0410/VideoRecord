using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using PackingProof.Core.Entities;

namespace PackingProof.Infrastructure.Persistence.Configurations;

public sealed class ShopConfiguration : IEntityTypeConfiguration<Shop>
{
    public void Configure(EntityTypeBuilder<Shop> builder)
    {
        builder.ToTable("Shops");
        builder.HasKey(s => s.Id);

        builder.Property(s => s.Code)
            .HasMaxLength(64)
            .IsRequired();

        builder.Property(s => s.Slug)
            .HasMaxLength(64)
            .IsRequired();

        builder.Property(s => s.Name)
            .HasMaxLength(200)
            .IsRequired();

        builder.Property(s => s.AllowedStorageSubdir)
            .HasMaxLength(128)
            .IsRequired();

        builder.HasIndex(s => s.Code)
            .IsUnique()
            .HasDatabaseName("UX_Shops_Code");

        builder.HasIndex(s => s.Slug)
            .IsUnique()
            .HasDatabaseName("UX_Shops_Slug");
    }
}

public sealed class WarehouseConfiguration : IEntityTypeConfiguration<Warehouse>
{
    public void Configure(EntityTypeBuilder<Warehouse> builder)
    {
        builder.ToTable("Warehouses");
        builder.HasKey(w => w.Id);

        builder.Property(w => w.Code)
            .HasMaxLength(64)
            .IsRequired();

        builder.Property(w => w.Name)
            .HasMaxLength(200)
            .IsRequired();

        builder.HasOne(w => w.Shop)
            .WithMany(s => s.Warehouses)
            .HasForeignKey(w => w.ShopId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(w => new { w.ShopId, w.Code })
            .IsUnique()
            .HasDatabaseName("UX_Warehouses_ShopId_Code");
    }
}

public sealed class PackingStationConfiguration : IEntityTypeConfiguration<PackingStation>
{
    public void Configure(EntityTypeBuilder<PackingStation> builder)
    {
        builder.ToTable("PackingStations");
        builder.HasKey(p => p.Id);

        builder.Property(p => p.Code)
            .HasMaxLength(64)
            .IsRequired();

        builder.Property(p => p.Name)
            .HasMaxLength(200)
            .IsRequired();

        builder.HasOne(p => p.Warehouse)
            .WithMany(w => w.PackingStations)
            .HasForeignKey(p => p.WarehouseId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(p => new { p.WarehouseId, p.Code })
            .IsUnique()
            .HasDatabaseName("UX_PackingStations_WarehouseId_Code");
    }
}

