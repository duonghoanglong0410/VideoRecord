import { AlertCircle, Film, Info } from 'lucide-react';
import type { VideoDetailDto } from '../videosApi';

export interface CinemaVideoPlayerCardProps {
  detail: VideoDetailDto;
  canPlayVideo: boolean;
  streamUrl: string;
  storageBadgeLabel: string;
  playbackError: string | null;
  onVideoElementError: () => void;
}

export function CinemaVideoPlayerCard({
  detail,
  canPlayVideo,
  streamUrl,
  storageBadgeLabel,
  playbackError,
  onVideoElementError
}: CinemaVideoPlayerCardProps) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-zinc-100 shadow-lg sm:p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-bold text-zinc-100">
        <Film className="h-4 w-4 text-blue-400" aria-hidden="true" />
        <h2 className="m-0 text-sm font-bold text-zinc-100 sm:text-base">
          Xem video đóng gói
        </h2>
      </div>

      {canPlayVideo ? (
        <div className="video-player-frame overflow-hidden rounded-xl border border-zinc-800 bg-black">
          <video
            key={streamUrl}
            className="video-player-element"
            src={streamUrl}
            controls
            playsInline
            preload="metadata"
            controlsList={detail.canDownload ? undefined : 'nodownload'}
            onError={onVideoElementError}
            data-testid="authenticated-video-player"
          />
        </div>
      ) : (
        <div
          className="flex items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-200"
          role="status"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" aria-hidden="true" />
          <div>
            <strong>Video chưa sẵn sàng để phát:</strong> Trạng thái hiện tại là{' '}
            <strong className="text-white">{storageBadgeLabel}</strong>.
            {detail.userSafeErrorMessage ? (
              <div className="mt-1 text-xs text-zinc-400">
                Thông báo: {detail.userSafeErrorMessage}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {playbackError && (
        <div
          className="mt-3 flex items-start gap-2.5 rounded-xl border border-red-500/40 bg-red-950/70 p-3.5 text-sm text-red-100"
          role="alert"
          data-testid="video-playback-error"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
          <span>{playbackError}</span>
        </div>
      )}
    </div>
  );
}

