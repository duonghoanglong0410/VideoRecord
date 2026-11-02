import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  Copy,
  Link2,
  PackageCheck
} from 'lucide-react';
import {
  formatDurationSeconds,
  formatHoChiMinhDateTime
} from '../../../app/formatters';
import type { VideoDetailDto } from '../videosApi';

export interface VideoEvidenceSummaryCardProps {
  detail: VideoDetailDto;
  sourceBadgeLabel?: string;
  storageBadgeLabel?: string;
}

export function VideoEvidenceSummaryCard({
  detail
}: VideoEvidenceSummaryCardProps) {
  const [copiedTracking, setCopiedTracking] = useState(false);

  const handleCopyTracking = async () => {
    try {
      await navigator.clipboard.writeText(detail.trackingNumber);
      setCopiedTracking(true);
      setTimeout(() => setCopiedTracking(false), 2000);
    } catch {
      // Clipboard blocked in non-secure / test env
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
      <div className="flex items-center gap-2">
        <PackageCheck className="h-5 w-5 text-blue-600" aria-hidden="true" />
        <h2 className="m-0 text-base font-bold text-slate-900">
          Thông tin đơn hàng
        </h2>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-2 sm:gap-3">
        <div className="col-span-2 rounded-xl border border-slate-100 bg-slate-50/80 p-3">
          <dt className="text-xs font-medium text-slate-500">
            Mã vận đơn
          </dt>
          <dd className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <span className="mono-code break-all text-base text-slate-950">
              {detail.trackingNumber}
            </span>
            <button
              type="button"
              className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              onClick={() => void handleCopyTracking()}
            >
              {copiedTracking ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                  <span>Đã chép</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                  <span>Sao chép mã</span>
                </>
              )}
            </button>
          </dd>
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
          <dt className="text-xs font-medium text-slate-500">Thời lượng video</dt>
          <dd className="mt-0.5 font-mono text-sm font-semibold text-slate-900">
            {formatDurationSeconds(detail.durationSeconds)}
          </dd>
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
          <dt className="text-xs font-medium text-slate-500">Thời điểm đóng gói</dt>
          <dd className="mt-0.5 text-xs font-semibold text-slate-800">
            {formatHoChiMinhDateTime(detail.startedAtUtc ?? detail.createdAtUtc)}
          </dd>
        </div>

        {detail.linkedFromRecordingId && (
          <div className="col-span-2 rounded-xl border border-blue-200 bg-blue-50/60 p-3">
            <dt className="text-xs font-semibold text-blue-800">
              Quay thay thế cho video nhầm mã trước đó
            </dt>
            <dd className="mt-1">
              <Link
                to={`/videos/${detail.linkedFromRecordingId}`}
                className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-700 hover:underline"
              >
                <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  Xem phiên cũ ({detail.linkedFromTrackingNumber ?? detail.linkedFromRecordingId})
                </span>
              </Link>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}


