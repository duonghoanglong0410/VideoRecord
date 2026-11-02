import { AlertTriangle } from 'lucide-react';
import type { StorageMode } from './types';

export interface StorageModeBannerProps {
  storageMode?: StorageMode | null;
}

export function StorageModeBanner({ storageMode }: StorageModeBannerProps) {
  if (storageMode !== 'LocalDevelopment') {
    return null;
  }

  return (
    <div
      className="storage-mode-banner"
      role="status"
      data-testid="storage-mode-banner"
    >
      <span className="storage-mode-badge">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        Chế độ thử nghiệm — lưu local
      </span>
      <span>Video hiện đang lưu tạm trên thư mục máy chủ cục bộ.</span>
    </div>
  );
}
