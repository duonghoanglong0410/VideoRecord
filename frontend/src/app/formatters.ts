import type { ApprovalStatus, ScopeType, StorageMode } from './types';

export type CaptureStatusType =
  | 'Created'
  | 'Recording'
  | 'Captured'
  | 'Interrupted'
  | 'Cancelled';

export type StorageStatusType =
  | 'AwaitingUpload'
  | 'Uploading'
  | 'Validating'
  | 'WaitingForStorage'
  | 'CopyingToStorage'
  | 'Stored'
  | 'Failed';

export type PreviewStatusType =
  | 'NotRequired'
  | 'Pending'
  | 'Processing'
  | 'Ready'
  | 'Failed';

export type RecordingSourceType = 'RecordedInBrowser' | 'Imported';

export type DeletionRequestStatusType = 'Pending' | 'Approved' | 'Rejected';

export type AuditOutcomeType = 'Success' | 'Denied' | 'Failed';

const hcmDateTimeFormatter = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const hcmDateFormatter = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function formatHoChiMinhDateTime(isoUtc?: string | null): string {
  if (!isoUtc) {
    return '—';
  }
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return hcmDateTimeFormatter.format(date);
}

export function formatHoChiMinhDate(isoUtc?: string | null): string {
  if (!isoUtc) {
    return '—';
  }
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return hcmDateFormatter.format(date);
}

export function formatDurationSeconds(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatByteSize(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  const mib = kib / 1024;
  if (mib < 1024) {
    return `${mib.toFixed(2)} MiB`;
  }
  const gib = mib / 1024;
  return `${gib.toFixed(2)} GiB`;
}

export interface BadgeDescriptor {
  label: string;
  className: string;
}

export function getStorageStatusBadge(
  storageStatus: StorageStatusType,
  storageMode?: StorageMode | null
): BadgeDescriptor {
  switch (storageStatus) {
    case 'Stored':
      if (storageMode === 'SynologyMounted') {
        return {
          label: 'Đã lưu NAS',
          className: 'status-pill status-pill-completed'
        };
      }
      return {
        label: 'Đã lưu cục bộ (Local)',
        className: 'status-pill status-pill-ready'
      };
    case 'AwaitingUpload':
      return {
        label: 'Chờ tải lên',
        className: 'status-pill status-pill-muted'
      };
    case 'Uploading':
      return {
        label: 'Đang tải lên',
        className: 'status-pill status-pill-uploading'
      };
    case 'Validating':
      return {
        label: 'Đang kiểm tra tệp',
        className: 'status-pill status-pill-validating'
      };
    case 'WaitingForStorage':
      return {
        label: 'Chờ kết nối lưu trữ',
        className: 'status-pill status-pill-starting'
      };
    case 'CopyingToStorage':
      return {
        label: 'Đang ghi vào kho lưu trữ',
        className: 'status-pill status-pill-uploading'
      };
    case 'Failed':
      return {
        label: 'Lỗi lưu trữ',
        className: 'status-pill status-pill-interrupted'
      };
    default:
      return {
        label: storageStatus,
        className: 'status-pill status-pill-muted'
      };
  }
}

export function getCaptureStatusBadge(
  captureStatus: CaptureStatusType
): BadgeDescriptor {
  switch (captureStatus) {
    case 'Captured':
      return {
        label: 'Hoàn chỉnh',
        className: 'status-pill status-pill-completed'
      };
    case 'Interrupted':
      return {
        label: 'Bị gián đoạn',
        className: 'status-pill status-pill-interrupted'
      };
    case 'Recording':
      return {
        label: 'Đang quay',
        className: 'status-pill status-pill-recording'
      };
    case 'Created':
      return {
        label: 'Mới tạo phiên',
        className: 'status-pill status-pill-ready'
      };
    case 'Cancelled':
      return {
        label: 'Đã hủy',
        className: 'status-pill status-pill-muted'
      };
    default:
      return {
        label: captureStatus,
        className: 'status-pill status-pill-muted'
      };
  }
}

export function getPreviewStatusLabel(previewStatus: PreviewStatusType): string {
  switch (previewStatus) {
    case 'NotRequired':
      return 'Phát trực tiếp tệp gốc';
    case 'Pending':
      return 'Đang chờ tạo bản xem MP4';
    case 'Processing':
      return 'Đang chuyển mã bản xem MP4';
    case 'Ready':
      return 'Đã có bản xem MP4 tương thích';
    case 'Failed':
      return 'Không tạo được bản xem MP4 (vẫn giữ tệp gốc)';
    default:
      return previewStatus;
  }
}

export function getSourceBadge(source: RecordingSourceType): BadgeDescriptor & {
  shortLabel: string;
} {
  if (source === 'Imported') {
    return {
      label: 'Tải tệp có sẵn (Imported)',
      shortLabel: 'Tệp nhập (Imported)',
      className: 'status-pill status-pill-starting'
    };
  }
  return {
    label: 'Quay trực tiếp trên trình duyệt',
    shortLabel: 'Quay trực tiếp',
    className: 'status-pill status-pill-ready'
  };
}

export function getScopeTypeLabel(scopeType: ScopeType): string {
  switch (scopeType) {
    case 'Own':
      return 'Cá nhân (Own)';
    case 'Warehouse':
      return 'Theo Kho (Warehouse)';
    case 'Shop':
      return 'Theo Shop (Shop)';
    case 'All':
      return 'Toàn hệ thống (All)';
    default:
      return scopeType;
  }
}

export function getApprovalStatusBadge(status: ApprovalStatus): BadgeDescriptor {
  switch (status) {
    case 'Active':
      return {
        label: 'Đang hoạt động',
        className: 'status-pill status-pill-completed'
      };
    case 'PendingApproval':
      return {
        label: 'Chờ duyệt',
        className: 'status-pill status-pill-starting'
      };
    case 'Locked':
      return {
        label: 'Đã khóa',
        className: 'status-pill status-pill-interrupted'
      };
    default:
      return {
        label: status,
        className: 'status-pill status-pill-muted'
      };
  }
}

export function getDeletionStatusBadge(
  status: DeletionRequestStatusType
): BadgeDescriptor {
  switch (status) {
    case 'Pending':
      return {
        label: 'Chờ duyệt xóa',
        className: 'status-pill status-pill-starting'
      };
    case 'Approved':
      return {
        label: 'Đã duyệt xóa',
        className: 'status-pill status-pill-interrupted'
      };
    case 'Rejected':
      return {
        label: 'Đã từ chối',
        className: 'status-pill status-pill-muted'
      };
    default:
      return {
        label: status,
        className: 'status-pill status-pill-muted'
      };
  }
}

export function getAuditOutcomeBadge(outcome: AuditOutcomeType): BadgeDescriptor {
  switch (outcome) {
    case 'Success':
      return {
        label: 'Thành công',
        className: 'status-pill status-pill-completed'
      };
    case 'Denied':
      return {
        label: 'Từ chối quyền',
        className: 'status-pill status-pill-starting'
      };
    case 'Failed':
      return {
        label: 'Thất bại',
        className: 'status-pill status-pill-interrupted'
      };
    default:
      return {
        label: outcome,
        className: 'status-pill status-pill-muted'
      };
  }
}
