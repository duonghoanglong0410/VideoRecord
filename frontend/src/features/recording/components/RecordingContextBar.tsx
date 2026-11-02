import { Link } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  CloudUpload
} from 'lucide-react';
import type { LocalRecordingManifest } from '../../upload-queue/db/packingProofIdb';
import type { RecordingPreFlightReport } from '../mediaCapabilities';
import type {
  RecordingDto,
  RecordingRuntimeLimits,
  ShopOption,
  WarehouseOption
} from '../recordingApi';

export interface RecordingContextBarProps {
  preFlight: RecordingPreFlightReport | null;
  activeLimits: RecordingRuntimeLimits;
  crashedSessionsNotice: LocalRecordingManifest[];
  activeSession: RecordingDto | null;
  shops: ShopOption[];
  availableWarehouses: WarehouseOption[];
  selectedShopId: string;
  selectedWarehouseId: string;
  isLoadingShops: boolean;
  shopsError: string | null;
  onShopChange: (shopId: string) => void;
  onWarehouseChange: (warehouseId: string) => void;
}

export function RecordingContextBar({
  preFlight,
  crashedSessionsNotice,
  activeSession,
  shopsError
}: RecordingContextBarProps) {
  const hasAlerts =
    Boolean(shopsError) ||
    crashedSessionsNotice.length > 0 ||
    Boolean(preFlight && !preFlight.canRecord && !activeSession) ||
    Boolean(preFlight && preFlight.warnings.length > 0);

  if (activeSession && !hasAlerts) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-2xs sm:px-4 sm:py-3.5">
      {!activeSession && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="m-0 text-base font-bold tracking-tight text-slate-900 sm:text-lg">
            Quay đóng gói đơn hàng
          </h1>
        </div>
      )}

      {shopsError && (
        <div
          className="mt-2.5 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
          <span>{shopsError}</span>
        </div>
      )}

      {crashedSessionsNotice.length > 0 && (
        <div
          className="mt-2.5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div>
            <strong>Phát hiện phiên quay trước bị dừng đột ngột:</strong> Đã chuyển{' '}
            {crashedSessionsNotice.length} video dở dang (mã:{' '}
            <strong className="font-mono">
              {crashedSessionsNotice.map((s) => s.trackingNumber).join(', ')}
            </strong>
            ) sang trạng thái <strong>Bị gián đoạn</strong>. Xem tại{' '}
            <Link to="/uploads" className="font-semibold text-amber-950 underline">
              Hàng đợi tải lên
            </Link>
            .
          </div>
        </div>
      )}

      {preFlight && !preFlight.canRecord && !activeSession && (
        <div
          className="mt-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
          role="alert"
          data-testid="preflight-blocking-error"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
            <div>
              <strong>Chưa thể quay đơn mới:</strong> {preFlight.blockingError}
            </div>
          </div>
          {preFlight.pendingLocalCount >= preFlight.maxLocalPendingRecordings && (
            <div className="mt-3">
              <Link
                to="/uploads"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white no-underline hover:bg-slate-800"
              >
                <CloudUpload className="h-4 w-4" aria-hidden="true" />
                <span>Mở Hàng đợi tải lên ({preFlight.pendingLocalCount})</span>
              </Link>
            </div>
          )}
        </div>
      )}

      {preFlight &&
        preFlight.warnings.map((w, idx) => (
          <div
            key={idx}
            className="mt-2.5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <span>{w}</span>
          </div>
        ))}
    </div>
  );
}

