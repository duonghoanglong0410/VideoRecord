import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  Camera,
  Clock,
  CloudUpload,
  Loader2,
  RefreshCw,
  Trash2
} from 'lucide-react';
import { useAuth } from '../../app/authStore';
import { Permissions, type StorageMode } from '../../app/types';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import {
  deleteLocalRecordingForUser,
  listLocalRecordingsForUser,
  reconcileCrashedSessions,
  verifyLocalRecordingIntegrity,
  type LocalRecordingManifest
} from './db/packingProofIdb';
import { formatBytes } from './db/storageQuota';
import { useTusUploadQueue } from './TusUploadCoordinator';
import type { LiveUploadProgress } from './tusQueueManager';

function resolveSyncBadge(
  item: LocalRecordingManifest,
  fallbackStorageMode: StorageMode | undefined
): { label: string; badgeClass: string } {
  switch (item.localSyncState) {
    case 'Recording':
      return {
        label: 'Đang quay trên máy',
        badgeClass: 'border-red-200 bg-red-50 text-red-700'
      };
    case 'ReadyToUpload':
      return {
        label:
          (item.uploadedBytes ?? 0) > 0
            ? 'Đã lưu trên máy — Chờ gửi tiếp'
            : 'Đã lưu trên máy — Chờ gửi lên',
        badgeClass: 'border-slate-200 bg-slate-100 text-slate-700'
      };
    case 'Uploading':
      return {
        label: 'Đang gửi lên hệ thống...',
        badgeClass: 'border-blue-200 bg-blue-50 text-blue-700'
      };
    case 'UploadedWaitingStorage':
      if (item.serverStorageStatus === 'WaitingForStorage') {
        return {
          label: 'Đã nhận trên máy chủ — Chờ kết nối kho lưu trữ',
          badgeClass: 'border-amber-200 bg-amber-50 text-amber-800'
        };
      }
      return {
        label: 'Đã nhận trên máy chủ — đang xác minh & lưu trữ',
        badgeClass: 'border-blue-200 bg-blue-50 text-blue-800'
      };
    case 'StoredConfirmed': {
      const effectiveMode =
        item.confirmedStorageMode ?? fallbackStorageMode ?? 'LocalDevelopment';
      return {
        label:
          effectiveMode === 'SynologyMounted'
            ? 'Đã lưu NAS'
            : 'Đã lưu cục bộ (Local)',
        badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-800'
      };
    }
    case 'Failed':
      return {
        label: item.integrityCorrupted
          ? 'Lỗi mất dữ liệu trên máy'
          : 'Tạm dừng — Gặp lỗi gửi lên',
        badgeClass: 'border-red-200 bg-red-50 text-red-700'
      };
    case 'Discarded':
      return {
        label: 'Đã hủy',
        badgeClass: 'border-slate-200 bg-slate-100 text-slate-600'
      };
    default:
      return {
        label: item.localSyncState,
        badgeClass: 'border-slate-200 bg-slate-100 text-slate-700'
      };
  }
}

function resolveByteProgress(
  item: LocalRecordingManifest,
  liveProgress: LiveUploadProgress | undefined
): { bytesSent: number; bytesTotal: number; percentage: number } {
  const bytesTotal = Math.max(0, item.totalBytes);
  if (bytesTotal === 0) {
    return { bytesSent: 0, bytesTotal: 0, percentage: 0 };
  }

  if (
    item.localSyncState === 'UploadedWaitingStorage' ||
    item.localSyncState === 'StoredConfirmed'
  ) {
    return {
      bytesSent: bytesTotal,
      bytesTotal,
      percentage: 100
    };
  }

  if (liveProgress) {
    const clampedSent = Math.max(0, Math.min(liveProgress.bytesSent, bytesTotal));
    return {
      bytesSent: clampedSent,
      bytesTotal,
      percentage: Math.min(100, Math.round((clampedSent / bytesTotal) * 100))
    };
  }

  const storedSent = Math.max(0, Math.min(item.uploadedBytes ?? 0, bytesTotal));
  return {
    bytesSent: storedSent,
    bytesTotal,
    percentage: Math.min(100, Math.round((storedSent / bytesTotal) * 100))
  };
}

function formatViDateTime(isoUtc: string): string {
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(isoUtc));
  } catch {
    return isoUtc;
  }
}

export function UploadQueuePage() {
  const { user, runtimeConfig, hasPermission } = useAuth();
  const coordinator = useTusUploadQueue();

  const [standaloneItems, setStandaloneItems] = useState<LocalRecordingManifest[]>([]);
  const [standaloneLoading, setStandaloneLoading] = useState<boolean>(!coordinator);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loadStandaloneQueue = useCallback(async () => {
    if (!user?.id) {
      setStandaloneItems([]);
      setStandaloneLoading(false);
      return;
    }

    setStandaloneLoading(true);
    setErrorMsg(null);

    try {
      await reconcileCrashedSessions(user.id);
      const initialList = await listLocalRecordingsForUser(user.id);

      for (const rec of initialList) {
        if (
          rec.localSyncState !== 'Recording' &&
          rec.localSyncState !== 'StoredConfirmed' &&
          rec.localSyncState !== 'Discarded' &&
          !rec.chunksPurged &&
          !rec.integrityCorrupted
        ) {
          await verifyLocalRecordingIntegrity(rec.recordingId, user.id);
        }
      }

      const refreshedList = await listLocalRecordingsForUser(user.id);
      setStandaloneItems(refreshedList);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể đọc dữ liệu hàng đợi video trên thiết bị này.'
      );
    } finally {
      setStandaloneLoading(false);
    }
  }, [user?.id]);

  const handleRefresh = useCallback(async () => {
    setErrorMsg(null);
    if (coordinator) {
      await coordinator.refreshQueue(true);
    } else {
      await loadStandaloneQueue();
    }
  }, [coordinator, loadStandaloneQueue]);

  const hasCoordinator = Boolean(coordinator);

  useEffect(() => {
    if (!hasCoordinator) {
      void loadStandaloneQueue();
    }
  }, [hasCoordinator, loadStandaloneQueue]);

  const rawItems = coordinator ? coordinator.items : standaloneItems;
  const items = rawItems.filter(
    (item) =>
      item.captureStatus !== 'Created' &&
      item.captureStatus !== 'Cancelled' &&
      item.localSyncState !== 'Discarded'
  );
  const isLoading = coordinator ? coordinator.isLoading : standaloneLoading;
  const liveProgressById = coordinator?.liveProgressById ?? {};
  const isPausedForAuth = coordinator?.isPausedForAuth ?? false;

  const handleRetryItem = useCallback(
    async (recordingId: string) => {
      if (!coordinator) {
        return;
      }
      setErrorMsg(null);
      setRetryingId(recordingId);
      try {
        await coordinator.retryRecording(recordingId);
      } catch (err) {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'Không thể thử gửi lại video này.'
        );
      } finally {
        setRetryingId(null);
      }
    },
    [coordinator]
  );

  const handleRemoveCorruptedOrConfirmed = useCallback(
    async (recordingId: string) => {
      if (!user?.id) {
        return;
      }
      try {
        await deleteLocalRecordingForUser(recordingId, user.id);
        await handleRefresh();
      } catch (err) {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'Không thể dọn mục này khỏi danh sách trên máy.'
        );
      }
    },
    [handleRefresh, user?.id]
  );

  const combinedError = errorMsg ?? coordinator?.queueError ?? null;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
        <PageHeader
          title="Tiến trình tải lên"
          actions={
            <>
              <button
                type="button"
                className="btn btn-outline inline-flex items-center gap-1.5"
                onClick={() => void handleRefresh()}
                disabled={isLoading}
              >
                <RefreshCw
                  className={`h-4 w-4 shrink-0 ${isLoading ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>Làm mới</span>
              </button>
              {hasPermission(Permissions.RecordingCreate) && (
                <Link
                  to="/record"
                  className="btn btn-primary inline-flex items-center gap-1.5"
                >
                  <Camera className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Quay đơn mới</span>
                </Link>
              )}
            </>
          }
        />

        {isPausedForAuth && (
          <div
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-sm text-amber-950"
            role="alert"
            data-testid="queue-paused-auth-banner"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <span>
              Tạm dừng gửi video do phiên đăng nhập đã hết hạn. Toàn bộ video quay xong vẫn an
              toàn trên máy — vui lòng đăng nhập lại để hệ thống tự gửi tiếp.
            </span>
          </div>
        )}

        {combinedError && (
          <div
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
            role="alert"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
            <span>{combinedError}</span>
          </div>
        )}
      </div>

      {isLoading ? (
        <div
          className="flex items-center justify-center gap-2.5 rounded-2xl border border-slate-200 bg-white p-8 text-sm font-medium text-slate-600"
          role="status"
        >
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" aria-hidden="true" />
          <span>Đang kiểm tra danh sách video trên máy...</span>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
          <EmptyState
            icon={<CloudUpload className="h-6 w-6" />}
            title="Chưa có video nào trong hàng đợi trên máy này"
            description="Khi bạn quay xong đơn hàng, video sẽ xuất hiện tại đây và tự động gửi lên hệ thống."
            action={
              hasPermission(Permissions.RecordingCreate) ? (
                <Link
                  to="/record"
                  className="btn btn-primary inline-flex items-center gap-2"
                >
                  <Camera className="h-4 w-4" aria-hidden="true" />
                  <span>Bắt đầu quay đơn mới</span>
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="space-y-3" data-testid="local-upload-queue-list">
          {items.map((item) => {
            const syncBadge = resolveSyncBadge(item, runtimeConfig?.storageMode);
            const progress = resolveByteProgress(
              item,
              liveProgressById[item.recordingId]
            );
            const canRetry =
              Boolean(coordinator) &&
              !item.integrityCorrupted &&
              (item.localSyncState === 'Failed' ||
                item.serverStorageStatus === 'WaitingForStorage');

            return (
              <div
                key={item.recordingId}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5"
                data-testid={`queue-item-${item.recordingId}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2.5">
                  <div>
                    <div className="break-all font-mono text-base font-bold tracking-wide text-slate-950 sm:text-lg">
                      {item.trackingNumber}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        <span>{formatViDateTime(item.createdAt)}</span>
                      </span>
                      <span>•</span>
                      <span className="font-mono">{item.durationSeconds.toFixed(1)}s</span>
                      <span>•</span>
                      <span className="font-mono">{formatBytes(item.totalBytes)}</span>
                    </div>
                  </div>

                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${syncBadge.badgeClass}`}
                    data-testid={`storage-badge-${item.recordingId}`}
                  >
                    {syncBadge.label}
                  </span>
                </div>

                {progress.bytesTotal > 0 && item.localSyncState !== 'Recording' && (
                  <div
                    className="mt-3 rounded-xl border border-slate-100 bg-slate-50/80 p-3"
                    data-testid={`upload-progress-${item.recordingId}`}
                  >
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-slate-600">
                      <span>
                        Đã gửi:{' '}
                        <strong
                          className="font-mono text-slate-900"
                          data-testid={`upload-bytes-${item.recordingId}`}
                        >
                          {formatBytes(progress.bytesSent)} / {formatBytes(progress.bytesTotal)}
                        </strong>
                      </span>
                      <strong
                        className="font-mono text-slate-900"
                        data-testid={`upload-percent-${item.recordingId}`}
                      >
                        {progress.percentage}%
                      </strong>
                    </div>
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress.percentage}
                    >
                      <div
                        className={`h-full rounded-full transition-all duration-200 ${
                          item.localSyncState === 'StoredConfirmed'
                            ? 'bg-emerald-600'
                            : item.localSyncState === 'Failed'
                              ? 'bg-red-500'
                              : 'bg-blue-600'
                        }`}
                        style={{ width: `${progress.percentage}%` }}
                      />
                    </div>
                  </div>
                )}

                {item.interruptionReason && (
                  <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
                    <span>{item.interruptionReason}</span>
                  </div>
                )}

                {item.lastError && item.lastError !== item.interruptionReason && (
                  <div
                    className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-900"
                    data-testid={`queue-error-${item.recordingId}`}
                  >
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" aria-hidden="true" />
                    <span>{item.lastError}</span>
                  </div>
                )}

                {(canRetry ||
                  item.integrityCorrupted ||
                  item.localSyncState === 'StoredConfirmed') && (
                  <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    {canRetry && (
                      <button
                        type="button"
                        className="btn btn-primary inline-flex items-center gap-1.5"
                        data-testid={`retry-btn-${item.recordingId}`}
                        disabled={retryingId === item.recordingId}
                        onClick={() => void handleRetryItem(item.recordingId)}
                      >
                        <RefreshCw
                          className={`h-4 w-4 shrink-0 ${
                            retryingId === item.recordingId ? 'animate-spin' : ''
                          }`}
                          aria-hidden="true"
                        />
                        <span>
                          {retryingId === item.recordingId ? 'Đang thử lại...' : 'Thử lại'}
                        </span>
                      </button>
                    )}

                    {(item.integrityCorrupted ||
                      item.localSyncState === 'StoredConfirmed') && (
                      <button
                        type="button"
                        className="btn btn-outline inline-flex items-center gap-1.5"
                        data-testid={`cleanup-btn-${item.recordingId}`}
                        onClick={() =>
                          void handleRemoveCorruptedOrConfirmed(item.recordingId)
                        }
                      >
                        <Trash2 className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                        <span>
                          {item.integrityCorrupted
                            ? 'Gỡ mục lỗi khỏi máy'
                            : 'Ẩn mục đã lưu xong'}
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
