import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  Loader2
} from 'lucide-react';
import {
  formatDurationSeconds,
  formatHoChiMinhDateTime,
  getStorageStatusBadge
} from '../../app/formatters';
import { CinemaVideoPlayerCard } from './components/CinemaVideoPlayerCard';
import {
  buildVideoDownloadUrl,
  buildVideoStreamUrl,
  getVideoDetailApi,
  type VideoDetailDto
} from './videosApi';

export function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [detail, setDetail] = useState<VideoDetailDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [copiedTracking, setCopiedTracking] = useState<boolean>(false);

  const loadDetail = useCallback(async () => {
    if (!id) {
      return;
    }
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await getVideoDetailApi(id);
      setDetail(res);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : 'Không thể tải thông tin chi tiết video.'
      );
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const canPlayVideo =
    detail != null &&
    detail.storageStatus === 'Stored' &&
    (detail.hasOriginalAsset || detail.hasPreviewAsset);

  const streamUrl = useMemo(() => {
    if (!detail) {
      return '';
    }
    return buildVideoStreamUrl(detail.id, 'auto');
  }, [detail]);

  const handleCopyTracking = async () => {
    if (!detail) {
      return;
    }
    try {
      await navigator.clipboard.writeText(detail.trackingNumber);
      setCopiedTracking(true);
      window.setTimeout(() => setCopiedTracking(false), 1800);
    } catch {
      // Clipboard API may be restricted in non-secure test contexts
    }
  };

  const handleVideoElementError = useCallback(async () => {
    if (!streamUrl) {
      return;
    }

    try {
      const probe = await fetch(streamUrl, {
        method: 'HEAD',
        credentials: 'include'
      });

      if (probe.status === 503) {
        setPlaybackError(
          'Kho lưu trữ video (Synology NAS / ổ đĩa) hiện tạm thời chưa kết nối được (HTTP 503). Vui lòng kiểm tra lại kết nối lưu trữ.'
        );
        return;
      }

      if (probe.status === 401 || probe.status === 403) {
        setPlaybackError(
          'Phiên đăng nhập đã hết hạn hoặc bạn không có quyền xem video này.'
        );
        return;
      }
    } catch {
      // Fall through to generic playback error
    }

    setPlaybackError(
      'Không thể phát video ngay lúc này. Vui lòng kiểm tra lại kết nối mạng hoặc ổ lưu trữ.'
    );
  }, [streamUrl]);

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center gap-2.5 rounded-2xl border border-slate-200 bg-white p-8 text-sm font-medium text-slate-600"
        role="status"
      >
        <Loader2 className="h-5 w-5 animate-spin text-blue-600" aria-hidden="true" />
        <span>Đang tải chi tiết video...</span>
      </div>
    );
  }

  if (loadError || !detail) {
    return (
      <div
        className="rounded-2xl border border-red-200 bg-white p-5 shadow-2xs"
        role="alert"
      >
        <h1 className="m-0 text-lg font-bold text-slate-900">
          Không thể mở video
        </h1>
        <p className="mt-1.5 mb-4 text-sm text-red-700">
          {loadError ?? 'Bản ghi không tồn tại hoặc nằm ngoài phạm vi quyền của bạn.'}
        </p>
        <Link to="/videos" className="btn btn-outline inline-flex items-center gap-1.5">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span>Quay về danh sách video</span>
        </Link>
      </div>
    );
  }

  const storageBadge = getStorageStatusBadge(
    detail.storageStatus,
    detail.storageMode
  );
  const isFailed =
    detail.captureStatus !== 'Captured' || detail.storageStatus === 'Failed';

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {/* Header Card */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Link
              to="/videos"
              className="inline-flex items-center gap-1.5 py-1 text-xs font-semibold text-blue-600 no-underline hover:text-blue-700"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Quay lại thư viện video</span>
            </Link>

            <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
              <h1 className="m-0 flex flex-wrap items-baseline gap-2 text-lg font-bold text-slate-900 sm:text-xl">
                <span>Mã vận đơn:</span>
                <span
                  className="mono-code text-xl text-slate-950 sm:text-2xl"
                  data-testid="detail-tracking-number"
                >
                  {detail.trackingNumber}
                </span>
              </h1>

              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100"
                onClick={() => void handleCopyTracking()}
              >
                {copiedTracking ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                    <span>Đã sao chép</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Sao chép mã</span>
                  </>
                )}
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 sm:text-sm">
              <span>
                Thời gian quay:{' '}
                <strong className="text-slate-800">
                  {formatHoChiMinhDateTime(
                    detail.startedAtUtc ?? detail.createdAtUtc
                  )}
                </strong>
              </span>
              <span>
                Thời lượng:{' '}
                <strong className="text-slate-800">
                  {formatDurationSeconds(detail.durationSeconds)}
                </strong>
              </span>
              <span>
                Nhân viên:{' '}
                <strong className="text-slate-800">{detail.ownerFullName}</strong>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                isFailed
                  ? 'status-pill status-pill-failed'
                  : 'status-pill status-pill-stored'
              }
              data-testid="detail-status-badge"
            >
              {isFailed ? 'Thất bại' : 'Thành công'}
            </span>

            {detail.canDownload &&
              detail.storageStatus === 'Stored' &&
              detail.hasOriginalAsset && (
                <a
                  href={buildVideoDownloadUrl(detail.id)}
                  download
                  className="btn btn-primary inline-flex items-center gap-1.5 text-xs sm:text-sm"
                  data-testid="download-original-btn"
                >
                  <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Tải video</span>
                </a>
              )}
          </div>
        </div>

        {/* Interrupted Warning Banner */}
        {detail.captureStatus === 'Interrupted' && (
          <div
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
            role="alert"
            data-testid="detail-interrupted-banner"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
            <div>
              <strong>Cảnh báo: Phiên ghi hình bị gián đoạn!</strong> Video này dừng bất
              thường trước khi bấm kết thúc.
              {detail.userSafeErrorMessage ? (
                <div className="mt-1 text-xs">
                  Chi tiết sự cố: <strong>{detail.userSafeErrorMessage}</strong>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {/* Video Player Card */}
      <CinemaVideoPlayerCard
        detail={detail}
        canPlayVideo={canPlayVideo}
        streamUrl={streamUrl}
        storageBadgeLabel={storageBadge.label}
        playbackError={playbackError}
        onVideoElementError={() => void handleVideoElementError()}
      />
    </div>
  );
}
