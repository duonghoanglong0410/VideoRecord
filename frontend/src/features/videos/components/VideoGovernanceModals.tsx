import type { FormEvent } from 'react';
import { AlertCircle, ShieldAlert, Trash2, X } from 'lucide-react';

export interface HoldModalProps {
  holdReasonInput: string;
  holdError: string | null;
  isUpdatingHold: boolean;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
}

export function VideoHoldModal({
  holdReasonInput,
  holdError,
  isUpdatingHold,
  onReasonChange,
  onClose,
  onSubmit
}: HoldModalProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-card max-w-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hold-modal-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
              <ShieldAlert className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2
                id="hold-modal-title"
                className="m-0 text-base font-bold text-slate-900"
              >
                Bật Giữ bằng chứng tranh chấp (Hold)
              </h2>
              <p className="mt-0.5 mb-0 text-xs text-slate-600">
                Khóa bảo vệ video khỏi mọi thao tác xóa thủ công và dọn dẹp tự động.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            onClick={onClose}
            disabled={isUpdatingHold}
            aria-label="Đóng hộp thoại"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form className="mt-4 space-y-3.5" onSubmit={onSubmit}>
          <div>
            <label
              htmlFor="hold-reason-textarea"
              className="mb-1.5 block text-xs font-semibold text-slate-700"
            >
              Lý do giữ bằng chứng (bắt buộc)
            </label>
            <textarea
              id="hold-reason-textarea"
              className="form-input"
              rows={3}
              maxLength={500}
              value={holdReasonInput}
              onChange={(e) => onReasonChange(e.target.value)}
              placeholder="Ví dụ: Khách khiếu nại thiếu phụ kiện trên TikTok Shop — giữ đối chiếu"
              required
            />
          </div>

          {holdError && (
            <div
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              <span>{holdError}</span>
            </div>
          )}

          <div className="modal-actions pt-2">
            <button
              type="button"
              className="btn btn-outline"
              onClick={onClose}
              disabled={isUpdatingHold}
            >
              Hủy
            </button>
            <button
              type="submit"
              className="btn btn-primary inline-flex items-center gap-1.5"
              disabled={isUpdatingHold}
            >
              <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{isUpdatingHold ? 'Đang lưu...' : 'Xác nhận bật Hold'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export interface DeleteRequestModalProps {
  deleteReasonInput: string;
  deleteReqError: string | null;
  isSubmittingDeleteReq: boolean;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
}

export function VideoDeleteRequestModal({
  deleteReasonInput,
  deleteReqError,
  isSubmittingDeleteReq,
  onReasonChange,
  onClose,
  onSubmit
}: DeleteRequestModalProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-card max-w-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-request-modal-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
              <Trash2 className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2
                id="delete-request-modal-title"
                className="m-0 text-base font-bold text-slate-900"
              >
                Gửi yêu cầu xóa video
              </h2>
              <p className="mt-0.5 mb-0 text-xs text-slate-600">
                Yêu cầu sẽ được gửi tới quản lý có quyền duyệt xóa để kiểm tra trước khi ẩn video.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            onClick={onClose}
            disabled={isSubmittingDeleteReq}
            aria-label="Đóng hộp thoại"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form className="mt-4 space-y-3.5" onSubmit={onSubmit}>
          <div>
            <label
              htmlFor="delete-reason-textarea"
              className="mb-1.5 block text-xs font-semibold text-slate-700"
            >
              Lý do yêu cầu xóa (bắt buộc)
            </label>
            <textarea
              id="delete-reason-textarea"
              className="form-input"
              rows={3}
              maxLength={500}
              value={deleteReasonInput}
              onChange={(e) => onReasonChange(e.target.value)}
              placeholder="Ví dụ: Video quay thử góc bàn, không chứa kiện hàng thật"
              required
            />
          </div>

          {deleteReqError && (
            <div
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              <span>{deleteReqError}</span>
            </div>
          )}

          <div className="modal-actions pt-2">
            <button
              type="button"
              className="btn btn-outline"
              onClick={onClose}
              disabled={isSubmittingDeleteReq}
            >
              Hủy
            </button>
            <button
              type="submit"
              className="btn btn-danger inline-flex items-center gap-1.5"
              disabled={isSubmittingDeleteReq}
            >
              <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {isSubmittingDeleteReq ? 'Đang gửi...' : 'Gửi yêu cầu xóa'}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

