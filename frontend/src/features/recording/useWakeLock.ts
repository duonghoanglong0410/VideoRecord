import { useCallback, useEffect, useRef, useState } from 'react';

export type WakeLockStatus =
  | 'unsupported'
  | 'idle'
  | 'active'
  | 'released'
  | 'denied';

export interface WakeLockState {
  status: WakeLockStatus;
  statusLabel: string;
}

const STATUS_LABELS: Record<WakeLockStatus, string> = {
  unsupported:
    'Trình duyệt không hỗ trợ tự giữ sáng màn hình — vui lòng chủ động chạm giữ màn hình sáng khi quay',
  idle: 'Chế độ giữ sáng màn hình chờ kích hoạt khi quay',
  active: 'Đang yêu cầu giữ sáng màn hình (vẫn cần giữ trang mở, không tự khóa máy)',
  released:
    'Chế độ giữ sáng màn hình vừa bị hệ thống thu hồi — chú ý giữ màn hình mở',
  denied:
    'Thiết bị từ chối giữ sáng màn hình (có thể do chế độ tiết kiệm pin) — chú ý không để màn hình tự tắt'
};

export function useWakeLock(shouldHold: boolean): WakeLockState {
  const isSupported =
    typeof navigator !== 'undefined' &&
    'wakeLock' in navigator &&
    typeof navigator.wakeLock?.request === 'function';

  const [status, setStatus] = useState<WakeLockStatus>(
    isSupported ? 'idle' : 'unsupported'
  );
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const shouldHoldRef = useRef<boolean>(shouldHold);
  shouldHoldRef.current = shouldHold;

  const acquire = useCallback(async () => {
    if (!isSupported || !shouldHoldRef.current) {
      return;
    }

    if (sentinelRef.current && !sentinelRef.current.released) {
      setStatus('active');
      return;
    }

    try {
      const sentinel = await navigator.wakeLock.request('screen');

      if (!shouldHoldRef.current) {
        await sentinel.release().catch(() => undefined);
        return;
      }

      const handleRelease = () => {
        if (sentinelRef.current === sentinel) {
          sentinelRef.current = null;
        }
        if (shouldHoldRef.current) {
          setStatus('released');
        } else {
          setStatus('idle');
        }
      };

      sentinel.addEventListener('release', handleRelease);
      sentinelRef.current = sentinel;
      setStatus('active');
    } catch {
      if (shouldHoldRef.current) {
        setStatus('denied');
      }
    }
  }, [isSupported]);

  useEffect(() => {
    if (!isSupported) {
      setStatus('unsupported');
      return;
    }

    if (!shouldHold) {
      const current = sentinelRef.current;
      sentinelRef.current = null;
      if (current && !current.released) {
        void current.release().catch(() => undefined);
      }
      setStatus('idle');
      return;
    }

    void acquire();

    const onVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        shouldHoldRef.current &&
        (!sentinelRef.current || sentinelRef.current.released)
      ) {
        void acquire();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [acquire, isSupported, shouldHold]);

  useEffect(() => {
    return () => {
      const current = sentinelRef.current;
      sentinelRef.current = null;
      if (current && !current.released) {
        void current.release().catch(() => undefined);
      }
    };
  }, []);

  return {
    status,
    statusLabel: STATUS_LABELS[status]
  };
}
