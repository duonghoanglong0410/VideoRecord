using System.Threading.Channels;

namespace PackingProof.Infrastructure.Workers;

public interface IProcessingJobSignal
{
    void NotifyNewWork();
    ValueTask<bool> WaitForWorkOrTimeoutAsync(TimeSpan timeout, CancellationToken ct);
}

public sealed class ProcessingJobSignal : IProcessingJobSignal
{
    private readonly Channel<bool> _channel = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = false,
            SingleWriter = false
        });

    public void NotifyNewWork()
    {
        _channel.Writer.TryWrite(true);
    }

    public async ValueTask<bool> WaitForWorkOrTimeoutAsync(TimeSpan timeout, CancellationToken ct)
    {
        if (_channel.Reader.TryRead(out _))
        {
            return true;
        }

        using var delayCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        delayCts.CancelAfter(timeout);

        try
        {
            return await _channel.Reader.WaitToReadAsync(delayCts.Token) &&
                   _channel.Reader.TryRead(out _);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return false;
        }
    }
}

