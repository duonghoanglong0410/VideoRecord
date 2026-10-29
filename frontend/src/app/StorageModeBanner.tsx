import type { StorageMode } from './types';

export interface StorageModeBannerProps {
  storageMode?: StorageMode | null;
}

export function StorageModeBanner({ storageMode }: StorageModeBannerProps) {
  if (storageMode !== 'LocalDevelopment') {
    return null;
  }

  return (
    <div className="storage-mode-banner" role="status" data-testid="storage-mode-banner">
      <span className="storage-mode-badge">Chế độ thử nghiệm — lưu local</span>
      <span>
        Dữ liệu video đang lưu vào thư mục cục bộ trên máy chủ phát triển.
      </span>
    </div>
  );
}

