import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../app/authStore';
import { Permissions, type StorageMode } from '../../app/types';
import {
  deleteLocalRecordingForUser,
  listLocalRecordingsForUser,
  reconcileCrashedSessions,
  verifyLocalRecordingIntegrity,
  type LocalRecordingManifest
} from './db/packingProofIdb';
import {
  estimateStorageQuota,
  formatBytes,
  type StorageQuotaEstimate
} from './db/storageQuota';
import { useTusUploadQueue } from './TusUploadCoordinator';
import type { LiveUploadProgress } from './tusQueueManager';

function resolveSyncBadge(
  item: LocalRecordingManifest,
  fallbackStorageMode: StorageMode | undefined
): { label: string; className: string } {
  switch (item.localSyncState) {
    case 'Recording':
      return {
        label: 'Đang ghi hình cục bộ',
        className: 'status-pill status-pill-recording'
      };
    case 'ReadyToUpload':
      return {
        label:
          (item.uploadedBytes ?? 0) > 0
            ? 'Đã lưu tạm — Sẵn sàng nối lại tải lên'
            : 'Đã lưu tạm — Chờ tải lên máy chủ',
        className: 'status-pill status-pill-ready'
      };
    case 'Uploading':
      return {
        label: 'Đang tải lên máy chủ (tus)...',
        className: 'status-pill status-pill-uploading'
      };
    case 'UploadedWaitingStorage':
      if (item.serverStorageStatus === 'WaitingForStorage') {
        return {
          label: 'Đã nhận trên máy chủ — Chờ kết nối kho lưu trữ',
          className: 'status-pill status-pill-starting'
        };
      }
      return {
        label: 'Đã nhận trên máy chủ — đang xác minh & lưu trữ',
        className: 'status-pill status-pill-validating'
      };
    case 'StoredConfirmed': {
      const effectiveMode = item.confirmedStorageMode ?? fallbackStorageMode ?? 'LocalDevelopment';
      return {
        label:
          effectiveMode === 'SynologyMounted'
            ? 'Đã lưu NAS'
            : 'Đã lưu cục bộ (Local)',
        className: 'status-pill status-pill-completed'
      };
    }
    case 'Failed':
      return {
        label: item.integrityCorrupted
          ? 'Lỗi mất dữ liệu tạm'
          : 'Lỗi tải lên / lưu trữ',
        className: 'status-pill status-pill-interrupted'
      };
    case 'Discarded':
      return {
        label: 'Đã hủy',
        className: 'status-pill status-pill-interrupted'
      };
    default:
      return {
        label: item.localSyncState,
        className: 'status-pill status-pill-ready'
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
  const [quota, setQuota] = useState<StorageQuotaEstimate | null>(null);
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

      const [refreshedList, storageEst] = await Promise.all([
        listLocalRecordingsForUser(user.id),
        estimateStorageQuota()
      ]);

      setStandaloneItems(refreshedList);
      setQuota(storageEst);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể đọc dữ liệu hàng đợi lưu tạm từ trình duyệt.'
      );
    } finally {
      setStandaloneLoading(false);
    }
  }, [user?.id]);

  const handleRefresh = useCallback(async () => {
    setErrorMsg(null);
    if (coordinator) {
      await Promise.all([
        coordinator.refreshQueue(true),
        estimateStorageQuota().then(setQuota)
      ]);
    } else {
      await loadStandaloneQueue();
    }
  }, [coordinator, loadStandaloneQueue]);

  const hasCoordinator = Boolean(coordinator);

  useEffect(() => {
    let active = true;
    if (hasCoordinator) {
      void estimateStorageQuota().then((est) => {
        if (active) {
          setQuota(est);
        }
      });
    } else {
      void loadStandaloneQueue();
    }
    return () => {
      active = false;
    };
  }, [hasCoordinator, loadStandaloneQueue]);

  const items = coordinator ? coordinator.items : standaloneItems;
  const isLoading = coordinator ? coordinator.isLoading : standaloneLoading;
  const activeRecordingId = coordinator?.activeRecordingId ?? null;
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
            : 'Không thể thử lại tải lên cho bản ghi này.'
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
          err instanceof Error ? err.message : 'Không thể xóa bản ghi khỏi bộ nhớ tạm.'
        );
      }
    },
    [handleRefresh, user?.id]
  );

  const pendingCount = items.filter(
    (item) =>
      item.captureStatus !== 'Cancelled' &&
      item.localSyncState !== 'StoredConfirmed' &&
      item.localSyncState !== 'Discarded'
  ).length;

  const maxPending = runtimeConfig?.maxLocalPendingRecordings ?? 3;
  const combinedError = errorMsg ?? coordinator?.queueError ?? null;

  return (
    <div>
      <div className="surface-card">
        <div className="recording-header-row">
          <div>
            <h1 style={{ margin: 0, fontSize: '1.3rem' }}>
              Hàng đợi tải lên &amp; lưu trữ video
            </h1>
            <p
              style={{
                margin: '4px 0 0',
                fontSize: '0.9rem',
                color: 'var(--color-text-muted)'
              }}
            >
              Các bản ghi được cô lập riêng cho tài khoản <strong>{user?.email}</strong>, tự động
              tải nối lại qua giao thức tus (tối đa 1 luồng tại một thời điểm) và chỉ giải phóng
              dữ liệu tạm sau khi máy chủ xác nhận lưu trữ hoàn tất.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => void handleRefresh()}
              disabled={isLoading}
            >
              Làm mới
            </button>
            {hasPermission(Permissions.RecordingCreate) && (
              <Link to="/record" className="btn btn-primary">
                Quay đơn mới
              </Link>
            )}
          </div>
        </div>

        <div className="queue-stats-strip">
          <div>
            Bản ghi đang chờ hoàn tất: <strong>{pendingCount}</strong> / {maxPending} tối đa
          </div>
          {activeRecordingId && (
            <div data-testid="queue-active-transfer-indicator">
              Trạng thái luồng: <strong>Đang tải lên 1 video</strong>
            </div>
          )}
          {quota?.supported && quota.availableBytes !== null && (
            <div>
              Bộ nhớ trình duyệt khả dụng:{' '}
              <strong>{formatBytes(quota.availableBytes)}</strong>
              {quota.usageBytes !== null
                ? ` (Đang dùng ${formatBytes(quota.usageBytes)})`
                : ''}
            </div>
          )}
        </div>

        {isPausedForAuth && (
          <div
            className="alert alert-warning"
            role="alert"
            data-testid="queue-paused-auth-banner"
            style={{ marginTop: 12, marginBottom: 0 }}
          >
            Hàng đợi tải lên đã tạm dừng do phiên đăng nhập hết hạn hoặc bị thu hồi. Toàn bộ dữ
            liệu video trên thiết bị vẫn được bảo toàn — vui lòng đăng nhập lại để tiếp tục.
          </div>
        )}

        {combinedError && (
          <div
            className="alert alert-error"
            role="alert"
            style={{ marginTop: 12, marginBottom: 0 }}
          >
            {combinedError}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="surface-card" role="status">
          Đang kiểm tra dữ liệu lưu tạm IndexedDB...
        </div>
      ) : items.length === 0 ? (
        <div className="surface-card">
          <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
            Hiện không có video nào trong hàng đợi trên trình duyệt này cho tài khoản của bạn.
          </p>
        </div>
      ) : (
        <div className="queue-list" data-testid="local-upload-queue-list">
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
                className="surface-card queue-item-card"
                data-testid={`queue-item-${item.recordingId}`}
              >
                <div className="queue-item-header">
                  <div>
                    <div className="queue-item-tracking">{item.trackingNumber}</div>
                    <div className="queue-item-meta">
                      {item.shopName} • {item.warehouseName} • Tạo lúc{' '}
                      {formatViDateTime(item.createdAt)}
                    </div>
                  </div>

                  <div className="queue-item-badges">
                    {item.captureStatus === 'Captured' && !item.integrityCorrupted && (
                      <span
                        className="status-pill status-pill-completed"
                        data-testid={`capture-badge-${item.recordingId}`}
                      >
                        Hoàn chỉnh
                      </span>
                    )}
                    {item.captureStatus === 'Interrupted' && (
                      <span
                        className="status-pill status-pill-interrupted"
                        data-testid={`capture-badge-${item.recordingId}`}
                      >
                        Bị gián đoạn
                      </span>
                    )}
                    {item.integrityCorrupted && (
                      <span className="status-pill status-pill-interrupted">
                        Mất dữ liệu tạm
                      </span>
                    )}
                    <span
                      className={syncBadge.className}
                      data-testid={`storage-badge-${item.recordingId}`}
                    >
                      {syncBadge.label}
                    </span>
                  </div>
                </div>

                {progress.bytesTotal > 0 && item.localSyncState !== 'Recording' && (
                  <div
                    className="queue-progress-block"
                    data-testid={`upload-progress-${item.recordingId}`}
                  >
                    <div className="queue-progress-labels">
                      <span>
                        Tiến độ truyền tải:{' '}
                        <strong data-testid={`upload-bytes-${item.recordingId}`}>
                          {formatBytes(progress.bytesSent)} / {formatBytes(progress.bytesTotal)}
                        </strong>
                      </span>
                      <strong data-testid={`upload-percent-${item.recordingId}`}>
                        {progress.percentage}%
                      </strong>
                    </div>
                    <div
                      className="queue-progress-track"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress.percentage}
                    >
                      <div
                        className={`queue-progress-fill${
                          item.localSyncState === 'StoredConfirmed'
                            ? ' queue-progress-fill-stored'
                            : item.localSyncState === 'Failed'
                              ? ' queue-progress-fill-failed'
                              : ''
                        }`}
                        style={{ width: `${progress.percentage}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="queue-item-metrics">
                  <span>
                    Dung lượng gốc: <strong>{formatBytes(item.totalBytes)}</strong> (
                    {item.chunkCount} chunks)
                  </span>
                  <span>
                    Thời lượng ghi nhận: <strong>{item.durationSeconds.toFixed(1)} giây</strong>
                  </span>
                  <span>
                    Định dạng: <strong>{item.mimeType || 'video/webm'}</strong>
                  </span>
                  {item.chunksPurged && (
                    <span data-testid={`chunks-purged-note-${item.recordingId}`}>
                      Bộ nhớ tạm: <strong>Đã giải phóng khỏi thiết bị</strong>
                    </span>
                  )}
                </div>

                {item.interruptionReason && (
                  <div
                    className="alert alert-warning"
                    style={{ marginTop: 10, marginBottom: 0 }}
                  >
                    {item.interruptionReason}
                  </div>
                )}

                {item.lastError && item.lastError !== item.interruptionReason && (
                  <div
                    className="alert alert-error"
                    data-testid={`queue-error-${item.recordingId}`}
                    style={{ marginTop: 10, marginBottom: 0 }}
                  >
                    {item.lastError}
                  </div>
                )}

                {(canRetry ||
                  item.integrityCorrupted ||
                  item.localSyncState === 'StoredConfirmed') && (
                  <div className="queue-item-actions">
                    {canRetry && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        data-testid={`retry-btn-${item.recordingId}`}
                        disabled={retryingId === item.recordingId}
                        onClick={() => void handleRetryItem(item.recordingId)}
                      >
                        {retryingId === item.recordingId ? 'Đang thử lại...' : 'Thử lại'}
                      </button>
                    )}

                    {(item.integrityCorrupted ||
                      item.localSyncState === 'StoredConfirmed') && (
                      <button
                        type="button"
                        className="btn btn-outline"
                        data-testid={`cleanup-btn-${item.recordingId}`}
                        onClick={() =>
                          void handleRemoveCorruptedOrConfirmed(item.recordingId)
                        }
                      >
                        {item.integrityCorrupted
                          ? 'Gỡ mục hỏng khỏi thiết bị'
                          : 'Ẩn mục đã lưu trữ khỏi danh sách'}
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
