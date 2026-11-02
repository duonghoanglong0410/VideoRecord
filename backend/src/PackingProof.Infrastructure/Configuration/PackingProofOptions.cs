using Microsoft.Extensions.Configuration;
using PackingProof.Core.Enums;

namespace PackingProof.Infrastructure.Configuration;

public sealed class PackingProofOptions
{
    public string AppPublicOrigin { get; set; } = "http://localhost:5173";
    public string DatabaseConnection { get; set; } = string.Empty;
    public string AuthCookieName { get; set; } = "PackingProof.Auth";
    public StorageMode StorageMode { get; set; } = StorageMode.LocalDevelopment;
    public string NasRootPath { get; set; } = "./.local-data/storage";
    public string StorageId { get; set; } = "packingproof-local-dev-storage-01";
    public string StagingRootPath { get; set; } = "./.local-data/staging";
    public bool NasWriteOnceMode { get; set; }
    public string? NasSmbUsername { get; set; }
    public string? NasSmbPassword { get; set; }

    public int MaxRecordingSeconds { get; set; } = 600;
    public long MaxUploadBytes { get; set; } = 536_870_912;
    public int MaxLocalPendingRecordings { get; set; } = 3;
    public int UploadChunkBytes { get; set; } = 5_242_880;
    public long StagingMaxBytes { get; set; } = 10_737_418_240;
    public int ProcessingConcurrency { get; set; } = 2;
    public bool EnableBackgroundWorker { get; set; } = true;
    public int WorkerPollIntervalMs { get; set; } = 1500;
    public int WorkerLeaseSeconds { get; set; } = 60;
    public int WorkerRetryBaseDelaySeconds { get; set; } = 2;
    public int WorkerMaxAttempts { get; set; } = 5;

    public bool RetentionEnabled { get; set; }
    public int RetentionDays { get; set; } = 90;

    public string? InitialAdminEmail { get; set; }
    public string? InitialAdminPassword { get; set; }

    public bool EnableAudioRecording { get; set; }
    public string FfprobePath { get; set; } = "ffprobe";
    public string FfmpegPath { get; set; } = "ffmpeg";
    public int PreviewTranscodeTimeoutSeconds { get; set; } = 300;
    public string DataProtectionKeysPath { get; set; } = "./.local-data/dataprotection-keys";
    public string? FrontendDistPath { get; set; }

    public string? SmtpHost { get; set; }
    public int SmtpPort { get; set; } = 587;
    public string? SmtpUser { get; set; }
    public string? SmtpPassword { get; set; }
    public string SmtpFrom { get; set; } = "noreply@example.local";

    public bool IsSmtpConfigured => !string.IsNullOrWhiteSpace(SmtpHost);

    public static PackingProofOptions BindFrom(IConfiguration configuration)
    {
        var opts = new PackingProofOptions();

        opts.AppPublicOrigin = GetString(configuration, "APP_PUBLIC_ORIGIN", opts.AppPublicOrigin);
        opts.DatabaseConnection = GetString(configuration, "DATABASE_CONNECTION", opts.DatabaseConnection);
        opts.AuthCookieName = GetString(configuration, "AUTH_COOKIE_NAME", opts.AuthCookieName);

        var modeRaw = configuration["STORAGE_MODE"];
        if (!string.IsNullOrWhiteSpace(modeRaw) &&
            Enum.TryParse<StorageMode>(modeRaw.Trim(), ignoreCase: true, out var parsedMode))
        {
            opts.StorageMode = parsedMode;
        }

        opts.NasRootPath = GetString(configuration, "NAS_ROOT_PATH", opts.NasRootPath);
        opts.StorageId = GetString(configuration, "STORAGE_ID", opts.StorageId);
        opts.StagingRootPath = GetString(configuration, "STAGING_ROOT_PATH", opts.StagingRootPath);
        opts.NasWriteOnceMode = GetBool(configuration, "NAS_WRITE_ONCE_MODE", opts.NasWriteOnceMode);
        opts.NasSmbUsername = configuration["NAS_SMB_USERNAME"]?.Trim();
        opts.NasSmbPassword = configuration["NAS_SMB_PASSWORD"];

        opts.MaxRecordingSeconds = GetInt(configuration, "MAX_RECORDING_SECONDS", opts.MaxRecordingSeconds);
        opts.MaxUploadBytes = GetLong(configuration, "MAX_UPLOAD_BYTES", opts.MaxUploadBytes);
        opts.MaxLocalPendingRecordings = GetInt(configuration, "MAX_LOCAL_PENDING_RECORDINGS", opts.MaxLocalPendingRecordings);
        opts.UploadChunkBytes = GetInt(configuration, "UPLOAD_CHUNK_BYTES", opts.UploadChunkBytes);
        opts.StagingMaxBytes = GetLong(configuration, "STAGING_MAX_BYTES", opts.StagingMaxBytes);
        opts.ProcessingConcurrency = GetInt(configuration, "PROCESSING_CONCURRENCY", opts.ProcessingConcurrency);
        opts.EnableBackgroundWorker = GetBool(configuration, "ENABLE_BACKGROUND_WORKER", opts.EnableBackgroundWorker);
        opts.WorkerPollIntervalMs = GetInt(configuration, "WORKER_POLL_INTERVAL_MS", opts.WorkerPollIntervalMs);
        opts.WorkerLeaseSeconds = GetInt(configuration, "WORKER_LEASE_SECONDS", opts.WorkerLeaseSeconds);
        opts.WorkerRetryBaseDelaySeconds = GetInt(configuration, "WORKER_RETRY_BASE_DELAY_SECONDS", opts.WorkerRetryBaseDelaySeconds);
        opts.WorkerMaxAttempts = GetInt(configuration, "WORKER_MAX_ATTEMPTS", opts.WorkerMaxAttempts);

        opts.RetentionEnabled = GetBool(configuration, "RETENTION_ENABLED", opts.RetentionEnabled);
        opts.RetentionDays = GetInt(configuration, "RETENTION_DAYS", opts.RetentionDays);

        opts.InitialAdminEmail = configuration["INITIAL_ADMIN_EMAIL"]?.Trim();
        opts.InitialAdminPassword = configuration["INITIAL_ADMIN_PASSWORD"];

        opts.EnableAudioRecording = GetBool(configuration, "ENABLE_AUDIO_RECORDING", opts.EnableAudioRecording);
        opts.FfprobePath = GetString(configuration, "FFPROBE_PATH", opts.FfprobePath);
        opts.FfmpegPath = GetString(configuration, "FFMPEG_PATH", opts.FfmpegPath);
        opts.PreviewTranscodeTimeoutSeconds = GetInt(configuration, "PREVIEW_TRANSCODE_TIMEOUT_SECONDS", opts.PreviewTranscodeTimeoutSeconds);
        opts.DataProtectionKeysPath = GetString(configuration, "DATA_PROTECTION_KEYS_PATH", opts.DataProtectionKeysPath);
        opts.FrontendDistPath = configuration["FRONTEND_DIST_PATH"]?.Trim();

        opts.SmtpHost = configuration["SMTP_HOST"]?.Trim();
        opts.SmtpPort = GetInt(configuration, "SMTP_PORT", opts.SmtpPort);
        opts.SmtpUser = configuration["SMTP_USER"]?.Trim();
        opts.SmtpPassword = configuration["SMTP_PASSWORD"];
        opts.SmtpFrom = GetString(configuration, "SMTP_FROM", opts.SmtpFrom);

        return opts;
    }

    private static string GetString(IConfiguration config, string key, string fallback)
    {
        var val = config[key];
        return string.IsNullOrWhiteSpace(val) ? fallback : val.Trim();
    }

    private static int GetInt(IConfiguration config, string key, int fallback)
    {
        var val = config[key];
        return int.TryParse(val, out var parsed) && parsed > 0 ? parsed : fallback;
    }

    private static long GetLong(IConfiguration config, string key, long fallback)
    {
        var val = config[key];
        return long.TryParse(val, out var parsed) && parsed > 0 ? parsed : fallback;
    }

    private static bool GetBool(IConfiguration config, string key, bool fallback)
    {
        var val = config[key];
        return bool.TryParse(val, out var parsed) ? parsed : fallback;
    }
}

