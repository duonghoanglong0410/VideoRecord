using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using PackingProof.Core.Entities;

namespace PackingProof.Infrastructure.Persistence;

public class PackingProofDbContext : IdentityDbContext<ApplicationUser, ApplicationRole, Guid>
{
    public PackingProofDbContext(DbContextOptions<PackingProofDbContext> options)
        : base(options)
    {
    }

    public DbSet<Permission> Permissions => Set<Permission>();
    public DbSet<RolePermission> RolePermissions => Set<RolePermission>();
    public DbSet<UserScopeGrant> UserScopeGrants => Set<UserScopeGrant>();
    public DbSet<Shop> Shops => Set<Shop>();
    public DbSet<Warehouse> Warehouses => Set<Warehouse>();
    public DbSet<PackingStation> PackingStations => Set<PackingStation>();
    public DbSet<Recording> Recordings => Set<Recording>();
    public DbSet<UploadSession> UploadSessions => Set<UploadSession>();
    public DbSet<VideoAsset> VideoAssets => Set<VideoAsset>();
    public DbSet<ProcessingJob> ProcessingJobs => Set<ProcessingJob>();
    public DbSet<StorageProfile> StorageProfiles => Set<StorageProfile>();
    public DbSet<VideoNote> VideoNotes => Set<VideoNote>();
    public DbSet<DeletionRequest> DeletionRequests => Set<DeletionRequest>();
    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<ApplicationUser>(b => b.ToTable("Users"));
        builder.Entity<ApplicationRole>(b => b.ToTable("Roles"));
        builder.Entity<IdentityUserRole<Guid>>(b => b.ToTable("UserRoles"));
        builder.Entity<IdentityUserClaim<Guid>>(b => b.ToTable("UserClaims"));
        builder.Entity<IdentityUserLogin<Guid>>(b => b.ToTable("UserLogins"));
        builder.Entity<IdentityRoleClaim<Guid>>(b => b.ToTable("RoleClaims"));
        builder.Entity<IdentityUserToken<Guid>>(b => b.ToTable("UserTokens"));

        builder.ApplyConfigurationsFromAssembly(typeof(PackingProofDbContext).Assembly);
    }
}

