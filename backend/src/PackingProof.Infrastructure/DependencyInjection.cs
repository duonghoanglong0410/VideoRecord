using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Storage;
using PackingProof.Core.Tracking;
using PackingProof.Infrastructure.Auditing;
using PackingProof.Infrastructure.Authorization;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Identity;
using PackingProof.Infrastructure.Media;
using PackingProof.Infrastructure.Notifications;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Storage;
using PackingProof.Infrastructure.Uploads;
using PackingProof.Infrastructure.Workers;

namespace PackingProof.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddPackingProofInfrastructure(this IServiceCollection services)
    {
        services.AddSingleton(sp =>
            PackingProofOptions.BindFrom(sp.GetRequiredService<IConfiguration>()));

        services.AddDataProtection();
        services.AddOptions<KeyManagementOptions>()
            .Configure<PackingProofOptions, ILoggerFactory>((keyOpts, packingOpts, loggerFactory) =>
            {
                keyOpts.AutoGenerateKeys = true;
                var dpDir = new DirectoryInfo(Path.GetFullPath(packingOpts.DataProtectionKeysPath));
                dpDir.Create();
                keyOpts.XmlRepository = new FileSystemXmlRepository(dpDir, loggerFactory);
            });

        services.AddDbContext<PackingProofDbContext>((sp, dbOptions) =>
        {
            var options = sp.GetRequiredService<PackingProofOptions>();
            var connStr = string.IsNullOrWhiteSpace(options.DatabaseConnection)
                ? "Host=localhost;Port=5432;Database=packingproof_dev;Username=postgres"
                : options.DatabaseConnection;
            dbOptions.UseNpgsql(connStr);
        });

        services
            .AddIdentity<ApplicationUser, ApplicationRole>(identityOptions =>
            {
                identityOptions.User.RequireUniqueEmail = true;

                identityOptions.Password.RequiredLength = 8;
                identityOptions.Password.RequireDigit = true;
                identityOptions.Password.RequireLowercase = true;
                identityOptions.Password.RequireUppercase = true;
                identityOptions.Password.RequireNonAlphanumeric = false;

                identityOptions.Lockout.AllowedForNewUsers = true;
                identityOptions.Lockout.MaxFailedAccessAttempts = 5;
                identityOptions.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);

                identityOptions.SignIn.RequireConfirmedAccount = false;
                identityOptions.SignIn.RequireConfirmedEmail = false;
            })
            .AddEntityFrameworkStores<PackingProofDbContext>()
            .AddDefaultTokenProviders();

        services.AddScoped<IAuditLogger, AuditLogger>();
        services.AddScoped<IScopeAuthorizationService, ScopeAuthorizationService>();
        services.AddScoped<IGrantCeilingValidator, GrantCeilingValidator>();
        services.AddSingleton<IOrderLinkResolver, NoOpOrderLinkResolver>();
        services.AddSingleton<ITrackingCodeParser, TrackingCodeParser>();
        services.AddScoped<IPasswordResetEmailSender, SmtpPasswordResetEmailSender>();
        services.AddScoped<SystemSeeder>();

        services.AddSingleton<IVideoStorage, FileSystemVideoStorage>();
        services.AddSingleton<IMediaInspector, FfprobeMediaInspector>();
        services.AddSingleton<IPreviewTranscoder, FfmpegPreviewTranscoder>();
        services.AddSingleton<StagingQuotaGuard>();
        services.AddSingleton<IProcessingJobSignal, ProcessingJobSignal>();
        services.AddScoped<RecordingUploadCoordinator>();
        services.AddSingleton<ProcessingJobProcessor>();
        services.AddHostedService<ProcessingJobWorker>();
        services.AddSingleton<RetentionCleanupProcessor>();
        services.AddHostedService<RetentionCleanupService>();

        return services;
    }
}
