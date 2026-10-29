using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PackingProof.Infrastructure.Configuration;

namespace PackingProof.Infrastructure.Workers;

public sealed class ProcessingJobWorker : BackgroundService
{
    private readonly ProcessingJobProcessor _processor;
    private readonly IProcessingJobSignal _signal;
    private readonly PackingProofOptions _options;
    private readonly ILogger<ProcessingJobWorker> _logger;

    public ProcessingJobWorker(
        ProcessingJobProcessor processor,
        IProcessingJobSignal signal,
        PackingProofOptions options,
        ILogger<ProcessingJobWorker> logger)
    {
        _processor = processor;
        _signal = signal;
        _options = options;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.EnableBackgroundWorker)
        {
            _logger.LogInformation("ProcessingJobWorker background loop is disabled by configuration.");
            return;
        }

        // Brief yield so host startup and EF Core migrations complete before polling ProcessingJobs
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(200), stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        var concurrency = Math.Clamp(_options.ProcessingConcurrency, 1, 8);
        var workerPrefix = $"{Environment.MachineName}-{Environment.ProcessId}";
        _logger.LogInformation(
            "ProcessingJobWorker started with concurrency={Concurrency}, pollIntervalMs={PollIntervalMs}.",
            concurrency,
            _options.WorkerPollIntervalMs);

        var loops = Enumerable.Range(0, concurrency)
            .Select(slot => RunWorkerSlotAsync($"{workerPrefix}-slot{slot}", stoppingToken))
            .ToArray();

        await Task.WhenAll(loops);
    }

    private async Task RunWorkerSlotAsync(string workerId, CancellationToken stoppingToken)
    {
        var pollInterval = TimeSpan.FromMilliseconds(Math.Max(200, _options.WorkerPollIntervalMs));

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var processedAny = await _processor.TryClaimAndProcessNextAsync(workerId, stoppingToken);
                if (processedAny)
                {
                    // Immediately check for more queued jobs before sleeping
                    continue;
                }

                await _signal.WaitForWorkOrTimeoutAsync(pollInterval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Unhandled exception in ProcessingJobWorker slot '{WorkerId}'.", workerId);
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }
    }
}

