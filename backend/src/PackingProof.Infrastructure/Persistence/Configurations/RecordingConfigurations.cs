using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using PackingProof.Core.Entities;

namespace PackingProof.Infrastructure.Persistence.Configurations;

public sealed class RecordingConfiguration : IEntityTypeConfiguration<Recording>
{
    public void Configure(EntityTypeBuilder<Recording> builder)
    {
        builder.ToTable("Recordings");
        builder.HasKey(r => r.Id);

        builder.Property(r => r.TrackingNumber)
            .HasMaxLength(128)
            .IsRequired();

        builder.Property(r => r.SafeTrackingSegment)
            .HasMaxLength(128)
            .IsRequired();

        builder.Property(r => r.CarrierCode)
            .HasMaxLength(32);

        builder.Property(r => r.TikTokOrderId)
            .HasMaxLength(64);

        builder.Property(r => r.Source)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(r => r.ManualEntryReason)
            .HasMaxLength(500);

        builder.Property(r => r.CaptureStatus)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(r => r.StorageStatus)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(r => r.PreviewStatus)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(r => r.ClientMimeType).HasMaxLength(128);
        builder.Property(r => r.ActualMimeType).HasMaxLength(128);
        builder.Property(r => r.ActualContainer).HasMaxLength(64);
        builder.Property(r => r.VideoCodec).HasMaxLength(64);
        builder.Property(r => r.AudioCodec).HasMaxLength(64);
        builder.Property(r => r.HoldReason).HasMaxLength(500);
        builder.Property(r => r.LastErrorCode).HasMaxLength(64);
        builder.Property(r => r.UserSafeErrorMessage).HasMaxLength(500);

        // PostgreSQL xmin system column concurrency token
        builder.Property(r => r.Version)
            .IsRowVersion();

        builder.HasOne(r => r.OwnerUser)
            .WithMany()
            .HasForeignKey(r => r.OwnerUserId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(r => r.Shop)
            .WithMany()
            .HasForeignKey(r => r.ShopId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(r => r.Warehouse)
            .WithMany()
            .HasForeignKey(r => r.WarehouseId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(r => r.PackingStation)
            .WithMany()
            .HasForeignKey(r => r.PackingStationId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasOne(r => r.LinkedFromRecording)
            .WithMany()
            .HasForeignKey(r => r.LinkedFromRecordingId)
            .OnDelete(DeleteBehavior.SetNull);

        // Non-unique indexes (multiple recordings per tracking number are explicitly allowed)
        builder.HasIndex(r => new { r.ShopId, r.TrackingNumber })
            .HasDatabaseName("IX_Recordings_ShopId_TrackingNumber");

        builder.HasIndex(r => r.TrackingNumber)
            .HasDatabaseName("IX_Recordings_TrackingNumber");

        builder.HasIndex(r => new { r.ShopId, r.WarehouseId, r.CreatedAtUtc })
            .HasDatabaseName("IX_Recordings_ShopId_WarehouseId_CreatedAtUtc");

        builder.HasIndex(r => new { r.OwnerUserId, r.CreatedAtUtc })
            .HasDatabaseName("IX_Recordings_OwnerUserId_CreatedAtUtc");

        builder.HasIndex(r => new { r.StorageStatus, r.CaptureStatus })
            .HasDatabaseName("IX_Recordings_StorageStatus_CaptureStatus");
    }
}

public sealed class UploadSessionConfiguration : IEntityTypeConfiguration<UploadSession>
{
    public void Configure(EntityTypeBuilder<UploadSession> builder)
    {
        builder.ToTable("UploadSessions");
        builder.HasKey(u => u.Id);

        builder.Property(u => u.TusResourceId)
            .HasMaxLength(128)
            .IsRequired();

        builder.Property(u => u.ClientSha256)
            .HasMaxLength(64);

        builder.Property(u => u.Status)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(u => u.StagingFilePath)
            .HasMaxLength(1024)
            .IsRequired();

        builder.HasOne(u => u.Recording)
            .WithMany(r => r.UploadSessions)
            .HasForeignKey(u => u.RecordingId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(u => u.OwnerUser)
            .WithMany()
            .HasForeignKey(u => u.OwnerUserId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(u => u.TusResourceId)
            .IsUnique()
            .HasDatabaseName("UX_UploadSessions_TusResourceId");

        builder.HasIndex(u => u.RecordingId)
            .IsUnique()
            .HasDatabaseName("UX_UploadSessions_RecordingId");
    }
}

public sealed class VideoAssetConfiguration : IEntityTypeConfiguration<VideoAsset>
{
    public void Configure(EntityTypeBuilder<VideoAsset> builder)
    {
        builder.ToTable("VideoAssets");
        builder.HasKey(v => v.Id);

        builder.Property(v => v.Kind)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(v => v.RelativePath)
            .HasMaxLength(1024)
            .IsRequired();

        builder.Property(v => v.MimeType)
            .HasMaxLength(128)
            .IsRequired();

        builder.Property(v => v.Sha256)
            .HasMaxLength(64)
            .IsRequired();

        builder.HasOne(v => v.Recording)
            .WithMany(r => r.VideoAssets)
            .HasForeignKey(v => v.RecordingId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(v => v.StorageProfile)
            .WithMany()
            .HasForeignKey(v => v.StorageProfileId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasIndex(v => new { v.RecordingId, v.Kind })
            .IsUnique()
            .HasDatabaseName("UX_VideoAssets_RecordingId_Kind");
    }
}

public sealed class ProcessingJobConfiguration : IEntityTypeConfiguration<ProcessingJob>
{
    public void Configure(EntityTypeBuilder<ProcessingJob> builder)
    {
        builder.ToTable("ProcessingJobs");
        builder.HasKey(j => j.Id);

        builder.Property(j => j.JobType)
            .HasConversion<string>()
            .HasMaxLength(64)
            .IsRequired();

        builder.Property(j => j.Status)
            .HasConversion<string>()
            .HasMaxLength(32)
            .IsRequired();

        builder.Property(j => j.LeaseOwner)
            .HasMaxLength(128);

        builder.Property(j => j.LastErrorCode)
            .HasMaxLength(64);

        builder.Property(j => j.LastErrorDetail)
            .HasMaxLength(2000);

        builder.HasOne(j => j.Recording)
            .WithMany(r => r.ProcessingJobs)
            .HasForeignKey(j => j.RecordingId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(j => new { j.RecordingId, j.JobType })
            .IsUnique()
            .HasDatabaseName("UX_ProcessingJobs_RecordingId_JobType");

        builder.HasIndex(j => new { j.Status, j.NextAttemptAtUtc, j.LeaseExpiresAtUtc })
            .HasDatabaseName("IX_ProcessingJobs_Status_NextAttemptAtUtc_LeaseExpiresAtUtc");
    }
}

