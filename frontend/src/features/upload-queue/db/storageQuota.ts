export const LOW_STORAGE_WARNING_BYTES = 150 * 1024 * 1024; // 150 MiB
export const CRITICAL_MIN_STORAGE_BYTES = 24 * 1024 * 1024; // 24 MiB

export interface StorageQuotaEstimate {
  supported: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  availableBytes: number | null;
  isLowSpace: boolean;
  isCriticallyLow: boolean;
  warningMessage: string | null;
}

export interface PersistentStorageResult {
  supported: boolean;
  persisted: boolean;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
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

export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeDomErr = error as { name?: string; code?: number; message?: string };
  if (
    maybeDomErr.name === 'QuotaExceededError' ||
    maybeDomErr.name === 'NS_ERROR_DOM_QUOTA_REACHED'
  ) {
    return true;
  }

  if (maybeDomErr.code === 22 || maybeDomErr.code === 1014) {
    return true;
  }

  if (
    typeof maybeDomErr.message === 'string' &&
    /quota/i.test(maybeDomErr.message) &&
    /exceed/i.test(maybeDomErr.message)
  ) {
    return true;
  }

  return false;
}

export async function estimateStorageQuota(): Promise<StorageQuotaEstimate> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.estimate !== 'function'
  ) {
    return {
      supported: false,
      usageBytes: null,
      quotaBytes: null,
      availableBytes: null,
      isLowSpace: false,
      isCriticallyLow: false,
      warningMessage: null
    };
  }

  try {
    const estimate = await navigator.storage.estimate();
    const usage = typeof estimate.usage === 'number' ? estimate.usage : null;
    const quota = typeof estimate.quota === 'number' ? estimate.quota : null;
    const available =
      usage !== null && quota !== null ? Math.max(0, quota - usage) : null;

    if (available === null) {
      return {
        supported: true,
        usageBytes: usage,
        quotaBytes: quota,
        availableBytes: null,
        isLowSpace: false,
        isCriticallyLow: false,
        warningMessage: null
      };
    }

    const isCriticallyLow = available < CRITICAL_MIN_STORAGE_BYTES;
    const isLowSpace = available < LOW_STORAGE_WARNING_BYTES;

    const isLikelyIncognitoQuota =
      quota !== null && quota > 0 && quota < 250 * 1024 * 1024;

    let warningMessage: string | null = null;
    if (isCriticallyLow) {
      warningMessage = isLikelyIncognitoQuota
        ? `Bộ nhớ trình duyệt còn quá ít (${formatBytes(available)} khả dụng / hạn mức ${formatBytes(quota)}). Có thể bạn đang mở Tab Ẩn danh (Incognito) nên Chrome giới hạn bộ nhớ tạm rất thấp — vui lòng mở bằng Tab Chrome thông thường.`
        : `Bộ nhớ trình duyệt còn quá ít (${formatBytes(available)} khả dụng). Vui lòng chờ các video đang chờ tải lên hoàn tất lưu trữ hoặc giải phóng bộ nhớ thiết bị trước khi quay mới.`;
    } else if (isLowSpace) {
      warningMessage = isLikelyIncognitoQuota
        ? `Bộ nhớ lưu tạm còn khoảng ${formatBytes(available)} (tổng hạn mức ${formatBytes(quota)}). Nếu đang dùng Tab Ẩn danh (Incognito), hãy chuyển sang Tab Chrome thông thường để mở khóa toàn bộ dung lượng lưu trữ của điện thoại.`
        : `Bộ nhớ lưu tạm còn khoảng ${formatBytes(available)}. Nên quay ngắn gọn và hoàn tất tải lên sớm để tránh đầy bộ nhớ giữa chừng.`;
    }

    return {
      supported: true,
      usageBytes: usage,
      quotaBytes: quota,
      availableBytes: available,
      isLowSpace,
      isCriticallyLow,
      warningMessage
    };
  } catch {
    return {
      supported: false,
      usageBytes: null,
      quotaBytes: null,
      availableBytes: null,
      isLowSpace: false,
      isCriticallyLow: false,
      warningMessage: null
    };
  }
}

export async function requestPersistentStorage(): Promise<PersistentStorageResult> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.persist !== 'function'
  ) {
    return { supported: false, persisted: false };
  }

  try {
    if (typeof navigator.storage.persisted === 'function') {
      const already = await navigator.storage.persisted();
      if (already) {
        return { supported: true, persisted: true };
      }
    }

    const granted = await navigator.storage.persist();
    return { supported: true, persisted: Boolean(granted) };
  } catch {
    return { supported: true, persisted: false };
  }
}

