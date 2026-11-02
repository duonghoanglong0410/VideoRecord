import type { ChangeEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FileVideo,
  Loader2,
  RotateCcw,
  Truck,
  Video
} from 'lucide-react';
import { formatBytes } from '../../upload-queue/db/storageQuota';
import type {
  InspectTrackingCodeResponse,
  RecordingRuntimeLimits
} from '../recordingApi';

export interface TrackingConfirmCardProps {
  inspectedCode: InspectTrackingCodeResponse;
  canCreateLiveRecording: boolean;
  canImportVideo: boolean;
  canRecordPreFlight: boolean;
  isCreatingSession: boolean;
  isImportingFile: boolean;
  activeLimits: RecordingRuntimeLimits;
  selectedImportFile: File | null;
  importProgressText: string | null;
  onConfirmAndCreateSession: () => void;
  onRescanOtherCode: () => void;
  onSelectImportFile: (e: ChangeEvent<HTMLInputElement>) => void;
  onImportVideoSubmit: () => void;
}

export function TrackingConfirmCard({
  inspectedCode,
  canCreateLiveRecording,
  canImportVideo,
  canRecordPreFlight,
  isCreatingSession,
  isImportingFile,
  activeLimits,
  selectedImportFile,
  importProgressText,
  onConfirmAndCreateSession,
  onRescanOtherCode,
  onSelectImportFile,
  onImportVideoSubmit
}: TrackingConfirmCardProps) {
  return (
    <div
      className="mt-3.5 rounded-2xl border-2 border-emerald-500/70 bg-emerald-50/70 p-4 shadow-sm sm:p-5"
      data-testid="recognized-tracking-banner"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-emerald-800 uppercase">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          <span>Đã nhận diện mã vận đơn</span>
        </div>

        {(inspectedCode.carrierCode || inspectedCode.tikTokOrderId) && (
          <div className="flex flex-wrap gap-1.5">
            {inspectedCode.carrierCode && (
              <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700">
                <Truck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                <span>ĐVVC: {inspectedCode.carrierCode}</span>
              </span>
            )}
            {inspectedCode.tikTokOrderId && (
              <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700">
                <span>Đơn: {inspectedCode.tikTokOrderId}</span>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="mt-1.5 break-all font-mono text-2xl font-bold tracking-wide text-slate-950 sm:text-3xl">
        {inspectedCode.trackingNumber}
      </div>

      {inspectedCode.existingRecordingCount > 0 && (
        <div
          className="mt-2.5 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          role="status"
          data-testid="duplicate-recording-warning"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div>
            <strong>Đã có {inspectedCode.existingRecordingCount} phiên quay trước đó:</strong>{' '}
            {inspectedCode.warningMessage}
          </div>
        </div>
      )}

      <div className="mt-3.5 flex flex-col gap-2 sm:flex-row">
        {canCreateLiveRecording && (
          <button
            type="button"
            className="inline-flex min-h-13 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-base font-bold text-white shadow-xs transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onConfirmAndCreateSession}
            disabled={isCreatingSession || isImportingFile || !canRecordPreFlight}
          >
            {isCreatingSession ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              <Video className="h-5 w-5 shrink-0" aria-hidden="true" />
            )}
            <span>
              {isCreatingSession
                ? 'Đang tạo phiên quay...'
                : 'Xác nhận mã & Tạo phiên quay'}
            </span>
          </button>
        )}

        <button
          type="button"
          className="inline-flex min-h-13 cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onRescanOtherCode}
          disabled={isCreatingSession || isImportingFile}
        >
          <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Quét lại mã khác</span>
        </button>
      </div>

      {canImportVideo && (
        <details
          className="group mt-3 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5"
          data-testid="video-import-panel"
          open={Boolean(selectedImportFile || importProgressText)}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold text-slate-700 hover:text-slate-900">
            <span className="inline-flex items-center gap-1.5">
              <FileVideo className="h-4 w-4 text-blue-600" aria-hidden="true" />
              <span>Nhập tệp video có sẵn từ máy (tối đa {formatBytes(activeLimits.maxUploadBytes)})</span>
            </span>
            <ChevronDown
              className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>

          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="mb-2.5">
              <label
                htmlFor="video-import-file-input"
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                Chọn tệp video đóng gói (.mp4, .webm, .mov)
              </label>
              <input
                id="video-import-file-input"
                type="file"
                className="form-input text-base sm:text-sm"
                accept="video/mp4,video/webm,video/quicktime,video/*"
                onChange={onSelectImportFile}
                disabled={isImportingFile || isCreatingSession}
              />
            </div>

            {selectedImportFile && (
              <div className="mb-2.5 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
                Đã chọn: <strong>{selectedImportFile.name}</strong> (
                {formatBytes(selectedImportFile.size)})
              </div>
            )}

            {importProgressText && (
              <div
                className="mb-2.5 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-800"
                role="status"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" aria-hidden="true" />
                <span>{importProgressText}</span>
              </div>
            )}

            <button
              type="button"
              className="inline-flex min-h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onImportVideoSubmit}
              disabled={!selectedImportFile || isImportingFile || isCreatingSession}
            >
              <FileVideo className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {isImportingFile
                  ? 'Đang đưa tệp vào hàng đợi tải lên...'
                  : 'Xác nhận mã & Nhập tệp video có sẵn'}
              </span>
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
