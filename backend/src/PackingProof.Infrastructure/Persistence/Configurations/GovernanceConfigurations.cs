using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using PackingProof.Core.Entities;

namespace PackingProof.Infrastructure.Persistence.Configurations;

public sealed class StorageProfileConfiguration : IEntityTypeConfiguration<StorageProfile>
{
    public void Configure(EntityTypeBuilder<StorageProfile> builder)
    {
        builder.ToTable("StorageProfiles");
        builder.HasKey(s => s.Id);

        builder.Property(s => s.Name)
            .HasMaxLength(128)
            .IsRequired();

        builder.Property(s => s.Mode)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(s => s.ExpectedStorageId)
            .HasMaxLength(128)
            .IsRequired();

        builder.Property(s => s.AllowedSubdirectoriesJson)
            .HasMaxLength(4000)
            .IsRequired();
    }
}

public sealed class VideoNoteConfiguration : IEntityTypeConfiguration<VideoNote>
{
    public void Configure(EntityTypeBuilder<VideoNote> builder)
    {
        builder.ToTable("VideoNotes");
        builder.HasKey(n => n.Id);

        builder.Property(n => n.Content)
            .HasMaxLength(2000)
            .IsRequired();

        builder.HasOne(n => n.Recording)
            .WithMany(r => r.Notes)
            .HasForeignKey(n => n.RecordingId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(n => n.AuthorUser)
            .WithMany()
            .HasForeignKey(n => n.AuthorUserId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(n => new { n.RecordingId, n.CreatedAtUtc })
            .HasDatabaseName("IX_VideoNotes_RecordingId_CreatedAtUtc");
    }
}

public sealed class DeletionRequestConfiguration : IEntityTypeConfiguration<DeletionRequest>
{
    public void Configure(EntityTypeBuilder<DeletionRequest> builder)
    {
        builder.ToTable("DeletionRequests");
        builder.HasKey(d => d.Id);

        builder.Property(d => d.Reason)
            .HasMaxLength(1000)
            .IsRequired();

        builder.Property(d => d.Status)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(d => d.ReviewNote)
            .HasMaxLength(1000);

        builder.HasOne(d => d.Recording)
            .WithMany(r => r.DeletionRequests)
            .HasForeignKey(d => d.RecordingId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(d => d.RequestedByUser)
            .WithMany()
            .HasForeignKey(d => d.RequestedByUserId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(d => d.ReviewedByUser)
            .WithMany()
            .HasForeignKey(d => d.ReviewedByUserId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(d => new { d.Status, d.CreatedAtUtc })
            .HasDatabaseName("IX_DeletionRequests_Status_CreatedAtUtc");
    }
}

public sealed class AuditEventConfiguration : IEntityTypeConfiguration<AuditEvent>
{
    public void Configure(EntityTypeBuilder<AuditEvent> builder)
    {
        builder.ToTable("AuditEvents");
        builder.HasKey(a => a.Id);

        builder.Property(a => a.Id)
            .UseIdentityAlwaysColumn();

        builder.Property(a => a.ActorEmail)
            .HasMaxLength(256);

        builder.Property(a => a.Action)
            .HasMaxLength(128)
            .IsRequired();

        builder.Property(a => a.EntityType)
            .HasMaxLength(128)
            .IsRequired();

        builder.Property(a => a.EntityId)
            .HasMaxLength(128);

        builder.Property(a => a.Outcome)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(a => a.IpAddress)
            .HasMaxLength(64);

        builder.Property(a => a.UserAgent)
            .HasMaxLength(512);

        builder.Property(a => a.MetadataJson)
            .IsRequired();

        builder.HasIndex(a => a.OccurredAtUtc)
            .HasDatabaseName("IX_AuditEvents_OccurredAtUtc");

        builder.HasIndex(a => new { a.ShopId, a.OccurredAtUtc })
            .HasDatabaseName("IX_AuditEvents_ShopId_OccurredAtUtc");

        builder.HasIndex(a => new { a.ActorUserId, a.OccurredAtUtc })
            .HasDatabaseName("IX_AuditEvents_ActorUserId_OccurredAtUtc");
    }
}

