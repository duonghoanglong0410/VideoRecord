import type { FormEvent } from 'react';
import { AlertCircle, FileVideo, Keyboard, Video, X } from 'lucide-react';

export interface ManualTrackingModalProps {
  manualCodeInput: string;
  manualReasonInput: string;
  manualFormError: string | null;
  canCreateLiveRecording: boolean;
  canImportVideo: boolean;
  isCreatingSession: boolean;
  isInspecting: boolean;
  onManualCodeChange: (value: string) => void;
  onManualReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmitLiveSession: (e: FormEvent) => void;
  onUseForImport: () => void;
}

export function ManualTrackingModal({
  manualCodeInput,
  manualReasonInput,
  manualFormError,
  canCreateLiveRecording,
  canImportVideo,
  isCreatingSession,
  isInspecting,
  onManualCodeChange,
  onManualReasonChange,
  onClose,
  onSubmitLiveSession,
  onUseForImport
}: ManualTrackingModalProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-card max-w-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-code-modal-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <Keyboard className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2
                id="manual-code-modal-title"
                className="m-0 text-base font-bold text-slate-900"
              >
                Nhập mã vận đơn thủ công
              </h2>
              <p className="mt-0.5 mb-0 text-xs text-slate-600">
                Dùng khi tem giấy bị rách hoặc mờ không quét được bằng camera.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            onClick={onClose}
            disabled={isCreatingSession || isInspecting}
            aria-label="Đóng hộp thoại"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form className="mt-4 space-y-3.5" onSubmit={onSubmitLiveSession}>
          <div>
            <label
              htmlFor="manual-tracking-input"
              className="mb-1.5 block text-xs font-semibold text-slate-700"
            >
              Mã vận đơn (nhập đủ cả số 0 ở đầu nếu có)
            </label>
            <input
              id="manual-tracking-input"
              type="text"
              className="form-input font-mono"
              value={manualCodeInput}
              onChange={(e) => onManualCodeChange(e.target.value)}
              maxLength={128}
              autoComplete="off"
              placeholder="Ví dụ: 00123456789 hoặc SPXVN048192"
              required
            />
          </div>

          <div>
            <label
              htmlFor="manual-reason-input"
              className="mb-1.5 block text-xs font-semibold text-slate-700"
            >
              Lý do nhập tay (bắt buộc)
            </label>
            <textarea
              id="manual-reason-input"
              className="form-input"
              rows={3}
              value={manualReasonInput}
              onChange={(e) => onManualReasonChange(e.target.value)}
              maxLength={500}
              placeholder="Ví dụ: Tem in nhiệt bị mờ vạch giữa, không quét được camera"
              required
            />
          </div>

          {manualFormError && (
            <div
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              <span>{manualFormError}</span>
            </div>
          )}

          <div className="modal-actions pt-2">
            <button
              type="button"
              className="btn btn-outline"
              onClick={onClose}
              disabled={isCreatingSession || isInspecting}
            >
              Đóng
            </button>
            {canImportVideo && (
              <button
                type="button"
                className="btn btn-navy inline-flex items-center gap-1.5"
                onClick={onUseForImport}
                disabled={isCreatingSession || isInspecting}
              >
                <FileVideo className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Dùng mã này để nhập tệp có sẵn</span>
              </button>
            )}
            {canCreateLiveRecording && (
              <button
                type="submit"
                className="btn btn-primary inline-flex items-center gap-1.5"
                disabled={isCreatingSession || isInspecting}
              >
                <Video className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {isCreatingSession
                    ? 'Đang tạo phiên...'
                    : 'Xác nhận & Tạo phiên quay'}
                </span>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

