using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PackingProof.Infrastructure.Configuration;

namespace PackingProof.Infrastructure.Workers;

public sealed class RetentionCleanupService : BackgroundService
{
    private static readonly TimeSpan SweepInterval = TimeSpan.FromHours(6);

    private readonly RetentionCleanupProcessor _processor;
    private readonly PackingProofOptions _options;
    private readonly ILogger<RetentionCleanupService> _logger;

    public RetentionCleanupService(
        RetentionCleanupProcessor processor,
        PackingProofOptions options,
        ILogger<RetentionCleanupService> logger)
    {
        _processor = processor;
        _options = options;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.EnableBackgroundWorker)
        {
            return;
        }

        try
        {
            await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var result = await _processor.RunSweepOnceAsync(
                    skipRecentHoldAuditWindow: true,
                    ct: stoppingToken);

                if (result.RetentionEnabled && result.EvaluatedCount > 0)
                {
                    _logger.LogInformation(
                        "Retention sweep completed: evaluated={Evaluated}, deleted={Deleted}, skippedHold={SkippedHold}, failed={Failed}.",
                        result.EvaluatedCount,
                        result.DeletedCount,
                        result.SkippedHoldCount,
                        result.FailedCount);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Unhandled exception during scheduled retention cleanup sweep.");
            }

            try
            {
                await Task.Delay(SweepInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}
