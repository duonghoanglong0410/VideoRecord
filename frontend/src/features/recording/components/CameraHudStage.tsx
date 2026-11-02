import { useEffect, useRef, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  Flashlight,
  FlashlightOff,
  Loader2,
  Mic,
  RotateCcw,
  Square,
  Video,
  X
} from 'lucide-react';
import { formatBytes } from '../../upload-queue/db/storageQuota';
import type {
  RecordingOrientationMode,
  RecordingQualityTier
} from '../mediaCapabilities';
import type { RecorderStateSnapshot } from '../RecorderController';
import type { RecordingDto, RecordingRuntimeLimits } from '../recordingApi';

function formatDurationClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export interface CameraHudStageProps {
  activeSession: RecordingDto;
  activeLimits: RecordingRuntimeLimits;
  recorderState: RecorderStateSnapshot;
  sessionWarning: string | null;
  sessionActionError: string | null;
  orientation: RecordingOrientationMode;
  qualityTier: RecordingQualityTier;
  enableAudioOptIn: boolean;
  recordingTorchSupported: boolean;
  recordingTorchEnabled: boolean;
  canScanNextAfterFinish: boolean;
  previewVideoRef: RefObject<HTMLVideoElement | null>;
  onQualityTierChange: (tier: RecordingQualityTier) => void;
  onOrientationChange: (mode: RecordingOrientationMode) => void;
  onEnableAudioChange: (enabled: boolean) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelBeforeStart: () => void;
  onToggleRecordingTorch: () => void;
  onPrepareNextOrder: (relinkWrongCodeSession?: RecordingDto | null) => void;
}

export function CameraHudStage({
  activeSession,
  activeLimits,
  recorderState,
  sessionWarning,
  sessionActionError,
  orientation,
  enableAudioOptIn,
  recordingTorchSupported,
  recordingTorchEnabled,
  canScanNextAfterFinish,
  previewVideoRef,
  onQualityTierChange,
  onOrientationChange,
  onEnableAudioChange,
  onStartRecording,
  onStopRecording,
  onCancelBeforeStart,
  onToggleRecordingTorch,
  onPrepareNextOrder
}: CameraHudStageProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const isFullscreenLandscape =
    recorderState.phase === 'starting' ||
    recorderState.phase === 'recording' ||
    recorderState.phase === 'finalizing';

  useEffect(() => {
    if (isFullscreenLandscape) {
      return;
    }

    try {
      const screenOrientation = (
        globalThis.screen as Screen & {
          orientation?: ScreenOrientation & { unlock?: () => void };
        }
      )?.orientation;
      screenOrientation?.unlock?.();
    } catch {
      // Ignore orientation unlock errors
    }

    try {
      if (
        typeof document !== 'undefined' &&
        document.fullscreenElement &&
        typeof document.exitFullscreen === 'function'
      ) {
        void document.exitFullscreen().catch(() => undefined);
      }
    } catch {
      // Ignore exitFullscreen errors
    }
  }, [isFullscreenLandscape]);

  const handleStartButtonClick = () => {
    // Mặc định chuẩn 1080p/30fps & khung ngang toàn màn hình khi bắt đầu quay
    onQualityTierChange('1080p');
    onOrientationChange('landscape');

    try {
      const el = stageRef.current as
        | (HTMLDivElement & {
            webkitRequestFullscreen?: () => Promise<void>;
          })
        | null;
      if (
        el &&
        typeof document !== 'undefined' &&
        !document.fullscreenElement
      ) {
        if (typeof el.requestFullscreen === 'function') {
          void el.requestFullscreen().catch(() => undefined);
        } else if (typeof el.webkitRequestFullscreen === 'function') {
          void el.webkitRequestFullscreen().catch(() => undefined);
        }
      }
    } catch {
      // Fallback to CSS fullscreen landscape stage
    }

    try {
      const screenOrientation = (
        globalThis.screen as Screen & {
          orientation?: ScreenOrientation & {
            lock?: (mode: string) => Promise<void>;
          };
        }
      )?.orientation;
      if (screenOrientation && typeof screenOrientation.lock === 'function') {
        void screenOrientation.lock('landscape').catch(() => undefined);
      }
    } catch {
      // Ignore orientation lock restrictions on desktop/iOS
    }

    onStartRecording();
  };

  return (
    <div
      ref={stageRef}
      className={`rounded-2xl border border-zinc-800 bg-zinc-950 p-3.5 text-zinc-100 shadow-xl sm:p-5 recording-stage-${orientation} ${
        isFullscreenLandscape ? 'recording-stage-fullscreen-landscape' : ''
      }`}
      data-testid="recording-session-stage"
    >
      {/* Locked Tracking Header */}
      <div
        className={`flex flex-wrap items-center justify-between gap-2.5 border-b border-zinc-800 pb-3 ${
          isFullscreenLandscape ? 'recording-fullscreen-top-bar' : ''
        }`}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span className="font-semibold tracking-wider uppercase">Mã vận đơn</span>
          </div>
          <div
            className="mt-0.5 break-all font-mono text-xl font-bold tracking-wide text-white sm:text-2xl"
            data-testid="locked-tracking-number"
          >
            {activeSession.trackingNumber}
          </div>
        </div>

        <div className="shrink-0">
          {recorderState.phase === 'idle' && (
            <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-semibold text-zinc-200">
              Sẵn sàng quay
            </span>
          )}
          {recorderState.phase === 'starting' && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/40 bg-blue-950/80 px-3 py-1 text-xs font-semibold text-blue-200">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span>Đang mở camera...</span>
            </span>
          )}
          {recorderState.phase === 'recording' && (
            <span
              className="inline-flex items-center gap-2 rounded-full border border-red-500/50 bg-red-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-sm"
              data-testid="recording-active-badge"
            >
              <span className="recording-pulse-dot" aria-hidden="true" />
              <span>Đang quay</span>
            </span>
          )}
          {recorderState.phase === 'finalizing' && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/40 bg-blue-950/80 px-3 py-1 text-xs font-semibold text-blue-200">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span>Đang lưu video...</span>
            </span>
          )}
          {recorderState.phase === 'completed' && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-950/80 px-3 py-1 text-xs font-semibold text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Đã lưu trên máy</span>
            </span>
          )}
          {recorderState.phase === 'interrupted' && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-950/80 px-3 py-1 text-xs font-semibold text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Bị gián đoạn</span>
            </span>
          )}
        </div>
      </div>

      {sessionWarning && recorderState.phase === 'idle' && (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-950/50 p-3 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <span>{sessionWarning}</span>
        </div>
      )}

      {recorderState.phase === 'idle' && activeLimits.enableAudioRecording && (
        <div className="mt-3 flex items-center justify-end">
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-blue-600"
              checked={enableAudioOptIn}
              onChange={(e) => onEnableAudioChange(e.target.checked)}
            />
            <Mic className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
            <span>Thu âm</span>
          </label>
        </div>
      )}

      {/* Live Camera Viewport */}
      {(recorderState.phase === 'idle' ||
        recorderState.phase === 'starting' ||
        recorderState.phase === 'recording' ||
        recorderState.phase === 'finalizing' ||
        recorderState.phase === 'error') && (
        <div
          className={`camera-viewport camera-viewport-${orientation} ${
            isFullscreenLandscape ? 'camera-viewport-fullscreen-landscape' : ''
          }`}
          style={{ marginTop: isFullscreenLandscape ? 0 : 12 }}
        >
          <video
            ref={previewVideoRef}
            className="camera-video"
            muted
            playsInline
            autoPlay
            disablePictureInPicture
            disableRemotePlayback
            aria-label="Khung hình ghi video đóng gói"
          />

          {recorderState.phase === 'idle' && (
            <div className="camera-overlay-msg">
              Đã sẵn sàng
            </div>
          )}

          {recorderState.phase === 'starting' && (
            <div className="camera-overlay-msg" role="status">
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Đang mở camera...</span>
              </span>
            </div>
          )}

          {recorderState.phase === 'recording' && (
            <div className="recording-hud">
              <div className="recording-hud-metrics">
                <span
                  className="font-mono text-base font-bold tracking-wider text-white sm:text-lg"
                  data-testid="recording-timer"
                >
                  {formatDurationClock(recorderState.elapsedSeconds)} /{' '}
                  {formatDurationClock(activeLimits.maxRecordingSeconds)}
                </span>
                <span
                  className="font-mono text-xs font-semibold text-zinc-200 sm:text-sm"
                  data-testid="recording-bytes"
                >
                  Đã lưu: {formatBytes(recorderState.committedBytes)}
                </span>
              </div>
              <div className="recording-keep-open-reminder">
                Giữ trang này đang mở trong khi quay
              </div>
            </div>
          )}
        </div>
      )}

      {recorderState.audioFallbackWarning && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-950/60 p-3 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <span>{recorderState.audioFallbackWarning}</span>
        </div>
      )}

      {recorderState.limitWarningMessage && recorderState.phase === 'recording' && (
        <div
          className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-950/70 p-3 text-xs font-medium text-amber-100"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <span>{recorderState.limitWarningMessage}</span>
        </div>
      )}

      {sessionActionError && (
        <div
          className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-950/70 p-3 text-sm text-red-100"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
          <span>{sessionActionError}</span>
        </div>
      )}

      {/* Primary Action Controls */}
      {(recorderState.phase === 'idle' || recorderState.phase === 'error') && (
        <div className="mt-3.5 flex flex-col gap-2.5 sm:flex-row">
          <button
            type="button"
            className="inline-flex min-h-14 flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-xl bg-blue-600 px-6 py-3.5 text-base font-bold text-white shadow-md transition-colors hover:bg-blue-500"
            onClick={handleStartButtonClick}
          >
            <Video className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>Bắt đầu quay đóng gói</span>
          </button>
          <button
            type="button"
            className="inline-flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3.5 text-sm font-semibold text-zinc-200 transition-colors hover:bg-zinc-800"
            onClick={onCancelBeforeStart}
          >
            <X className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Hủy phiên &amp; Quét mã khác</span>
          </button>
        </div>
      )}

      {recorderState.phase === 'recording' && (
        <div
          className={`mt-3.5 flex flex-col gap-2.5 sm:flex-row ${
            isFullscreenLandscape ? 'recording-fullscreen-bottom-bar' : ''
          }`}
        >
          <button
            type="button"
            className="inline-flex min-h-14 flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-xl bg-red-600 px-6 py-3.5 text-base font-bold text-white shadow-md transition-colors hover:bg-red-500"
            onClick={onStopRecording}
          >
            <Square className="h-5 w-5 fill-current shrink-0" aria-hidden="true" />
            <span>Kết thúc &amp; Lưu video</span>
          </button>

          {recordingTorchSupported && (
            <button
              type="button"
              className={`inline-flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-xl border px-4 py-3.5 text-sm font-semibold transition-colors ${
                recordingTorchEnabled
                  ? 'border-amber-400/60 bg-amber-400 text-zinc-950 hover:bg-amber-300'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800'
              }`}
              onClick={onToggleRecordingTorch}
              aria-pressed={recordingTorchEnabled}
            >
              {recordingTorchEnabled ? (
                <FlashlightOff className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <Flashlight className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>
                {recordingTorchEnabled
                  ? 'Tắt đèn Flash chiếu tem'
                  : 'Bật đèn Flash chiếu tem'}
              </span>
            </button>
          )}
        </div>
      )}

      {recorderState.phase === 'finalizing' && (
        <div
          className={`mt-4 flex items-center gap-2.5 rounded-xl border border-blue-500/30 bg-blue-950/60 p-3.5 text-sm text-blue-100 ${
            isFullscreenLandscape ? 'recording-fullscreen-bottom-bar' : ''
          }`}
          role="status"
        >
          <Loader2 className="h-4 w-4 animate-spin shrink-0 text-blue-400" aria-hidden="true" />
          <span>Đang hoàn tất lưu video an toàn vào thiết bị...</span>
        </div>
      )}

      {/* Interrupted Outcome */}
      {recorderState.phase === 'interrupted' && (
        <div
          className="mt-4 rounded-2xl border border-red-500/40 bg-red-950/60 p-4 text-red-50"
          role="alert"
          data-testid="recording-interrupted-banner"
        >
          <div className="flex items-center gap-2 text-base font-bold text-red-200">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" aria-hidden="true" />
            <h2 className="m-0 text-base font-bold">Phiên quay đã bị gián đoạn</h2>
          </div>
          <p className="mt-1.5 mb-2 text-sm text-red-100/90">
            {recorderState.interruptionMessage ??
              'Quá trình ghi hình bị dừng bất thường. Hệ thống đánh dấu video này là Bị gián đoạn để bạn kiểm tra lại.'}
          </p>
          <div className="text-xs text-red-200">
            Thời điểm dừng:{' '}
            <strong className="font-mono">
              {formatDurationClock(recorderState.elapsedSeconds)}
            </strong>{' '}
            • Đã kịp lưu:{' '}
            <strong className="font-mono">
              {formatBytes(recorderState.committedBytes)}
            </strong>
          </div>

          <div className="mt-4 flex flex-wrap gap-2.5">
            {canScanNextAfterFinish && (
              <button
                type="button"
                className="inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-500"
                onClick={() => onPrepareNextOrder(null)}
              >
                <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Quay lại kiện hàng mới</span>
              </button>
            )}
            <Link
              to="/uploads"
              className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white no-underline hover:bg-zinc-800"
            >
              <CloudUpload className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Kiểm tra Hàng đợi tải lên</span>
            </Link>
          </div>
        </div>
      )}

      {/* Normal Completed Outcome */}
      {recorderState.phase === 'completed' && (
        <div
          className="mt-4 rounded-2xl border border-emerald-500/40 bg-emerald-950/60 p-4 text-emerald-50"
          role="status"
          data-testid="recording-completed-banner"
        >
          <div className="flex items-center gap-2 text-base font-bold text-emerald-200">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
            <h2 className="m-0 text-base font-bold">
              Đã lưu video trên máy — Sẵn sàng tải lên
            </h2>
          </div>

          {recorderState.autoStopReason && (
            <p className="mt-1.5 mb-2 text-sm font-semibold text-amber-200">
              {recorderState.autoStopReason}
            </p>
          )}

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-emerald-100">
            <span>
              Mã vận đơn:{' '}
              <strong className="font-mono text-white">
                {activeSession.trackingNumber}
              </strong>
            </span>
            <span>
              Thời lượng:{' '}
              <strong className="font-mono text-white">
                {formatDurationClock(recorderState.elapsedSeconds)}
              </strong>
            </span>
            <span>
              Dung lượng:{' '}
              <strong className="font-mono text-white">
                {formatBytes(recorderState.committedBytes)}
              </strong>
            </span>
          </div>

          <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
            {canScanNextAfterFinish ? (
              <button
                type="button"
                className="inline-flex min-h-12 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white shadow-sm hover:bg-emerald-500"
                onClick={() => onPrepareNextOrder(null)}
              >
                <Video className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Quét &amp; Quay đơn tiếp theo</span>
              </button>
            ) : (
              <div className="rounded-xl border border-amber-500/40 bg-amber-950/60 px-3.5 py-2.5 text-xs font-semibold text-amber-200">
                Đã đầy {activeLimits.maxLocalPendingRecordings} video chờ gửi trên máy — vui
                lòng chờ gửi xong trước khi quay tiếp.
              </div>
            )}

            {canScanNextAfterFinish && (
              <button
                type="button"
                className="inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-zinc-200 hover:bg-zinc-800"
                onClick={() => onPrepareNextOrder(activeSession)}
              >
                <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Quay lại do nhầm mã vận đơn</span>
              </button>
            )}

            <Link
              to="/uploads"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white no-underline hover:bg-zinc-800"
            >
              <CloudUpload className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Xem Hàng đợi tải lên</span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
