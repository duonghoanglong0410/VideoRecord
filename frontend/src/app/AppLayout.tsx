import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  reconcileCrashedSessions,
  wirePendingUploadsBridge
} from '../features/upload-queue/db/packingProofIdb';
import { TusUploadCoordinator } from '../features/upload-queue/TusUploadCoordinator';
import { useAuth } from './authStore';
import {
  getPendingLocalRecordingsCount,
  type PendingRecordingsCounter
} from './pendingUploadsBridge';
import { StorageModeBanner } from './StorageModeBanner';
import { Permissions } from './types';

interface NavItem {
  to: string;
  label: string;
  mobileLabel: string;
  showInMobileBar: boolean;
  requiredAnyPermissions?: string[];
}

const NAV_ITEMS: NavItem[] = [
  {
    to: '/',
    label: 'Tổng quan',
    mobileLabel: 'Tổng quan',
    showInMobileBar: true
  },
  {
    to: '/record',
    label: 'Quay đóng gói',
    mobileLabel: 'Quay mới',
    showInMobileBar: true,
    requiredAnyPermissions: [Permissions.RecordingCreate, Permissions.VideoImport]
  },
  {
    to: '/uploads',
    label: 'Hàng đợi tải lên',
    mobileLabel: 'Hàng đợi',
    showInMobileBar: true,
    requiredAnyPermissions: [
      Permissions.VideoUpload,
      Permissions.RecordingCreate,
      Permissions.VideoImport
    ]
  },
  {
    to: '/videos',
    label: 'Danh sách video',
    mobileLabel: 'Video',
    showInMobileBar: true,
    requiredAnyPermissions: [Permissions.VideoView]
  },
  {
    to: '/security/mfa',
    label: 'Bảo mật 2FA',
    mobileLabel: 'Bảo mật',
    showInMobileBar: false
  },
  {
    to: '/admin/users',
    label: 'Quản trị tài khoản',
    mobileLabel: 'Tài khoản',
    showInMobileBar: true,
    requiredAnyPermissions: [Permissions.UserManage]
  },
  {
    to: '/admin/roles',
    label: 'Vai trò & Quyền',
    mobileLabel: 'Vai trò',
    showInMobileBar: false,
    requiredAnyPermissions: [Permissions.RoleManage]
  },
  {
    to: '/admin/storage',
    label: 'Cấu hình lưu trữ',
    mobileLabel: 'Lưu trữ',
    showInMobileBar: false,
    requiredAnyPermissions: [Permissions.StorageManage]
  },
  {
    to: '/admin/audit',
    label: 'Nhật ký kiểm toán',
    mobileLabel: 'Audit',
    showInMobileBar: false,
    requiredAnyPermissions: [Permissions.AuditView]
  }
];

export interface UseLogoutConfirmationOptions {
  userId: string | undefined;
  onPerformLogout: () => Promise<void>;
  checkPendingCount?: PendingRecordingsCounter;
}

export function useLogoutConfirmation({
  userId,
  onPerformLogout,
  checkPendingCount
}: UseLogoutConfirmationOptions) {
  const [pendingWarningCount, setPendingWarningCount] = useState<number>(0);
  const [isDialogOpen, setIsDialogOpen] = useState<boolean>(false);
  const [isLoggingOut, setIsLoggingOut] = useState<boolean>(false);

  const requestLogout = useCallback(async () => {
    if (!userId) {
      await onPerformLogout();
      return;
    }

    const counter = checkPendingCount ?? getPendingLocalRecordingsCount;
    const count = await counter(userId);
    if (count > 0) {
      setPendingWarningCount(count);
      setIsDialogOpen(true);
      return;
    }

    setIsLoggingOut(true);
    try {
      await onPerformLogout();
    } finally {
      setIsLoggingOut(false);
    }
  }, [userId, onPerformLogout, checkPendingCount]);

  const confirmLogout = useCallback(async () => {
    setIsLoggingOut(true);
    try {
      setIsDialogOpen(false);
      await onPerformLogout();
    } finally {
      setIsLoggingOut(false);
    }
  }, [onPerformLogout]);

  const cancelLogout = useCallback(() => {
    setIsDialogOpen(false);
    setPendingWarningCount(0);
  }, []);

  return {
    isDialogOpen,
    pendingWarningCount,
    isLoggingOut,
    requestLogout,
    confirmLogout,
    cancelLogout
  };
}

export interface AppLayoutProps {
  checkPendingRecordingsCount?: PendingRecordingsCounter;
}

export function AppLayout({ checkPendingRecordingsCount }: AppLayoutProps) {
  const { user, runtimeConfig, hasPermission, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    wirePendingUploadsBridge();
    if (user?.id) {
      void reconcileCrashedSessions(user.id).catch(() => undefined);
    }
  }, [user?.id]);

  const handleLogoutDone = useCallback(async () => {
    await logout();
    navigate('/login', { replace: true });
  }, [logout, navigate]);

  const {
    isDialogOpen,
    pendingWarningCount,
    isLoggingOut,
    requestLogout,
    confirmLogout,
    cancelLogout
  } = useLogoutConfirmation({
    userId: user?.id,
    onPerformLogout: handleLogoutDone,
    checkPendingCount: checkPendingRecordingsCount
  });

  const visibleNavItems = useMemo(() => {
    return NAV_ITEMS.filter((item) => {
      if (!item.requiredAnyPermissions || item.requiredAnyPermissions.length === 0) {
        return true;
      }
      return item.requiredAnyPermissions.some((code) => hasPermission(code));
    });
  }, [hasPermission]);

  const mobileNavItems = useMemo(
    () => visibleNavItems.filter((item) => item.showInMobileBar).slice(0, 5),
    [visibleNavItems]
  );

  return (
    <TusUploadCoordinator>
      <div className="app-root">
      <StorageModeBanner storageMode={runtimeConfig?.storageMode} />

      <header className="app-topbar">
        <div className="topbar-brand">
          <span className="topbar-brand-dot" aria-hidden="true" />
          <span>PackingProof Web</span>
        </div>

        <div className="topbar-actions">
          {user && (
            <span className="topbar-user">
              {user.fullName} ({user.email})
            </span>
          )}
          <NavLink to="/security/mfa" className="btn btn-navy" style={{ padding: '8px 12px' }}>
            2FA
          </NavLink>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => void requestLogout()}
            disabled={isLoggingOut}
          >
            Đăng xuất
          </button>
        </div>
      </header>

      <div className="app-body">
        <aside className="app-sidebar" aria-label="Điều hướng chính">
          <nav className="sidebar-nav">
            {visibleNavItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `sidebar-link${isActive ? ' active' : ''}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className="app-main">
          <Outlet />
        </main>
      </div>

      <nav className="mobile-bottom-nav" aria-label="Điều hướng di động">
        {mobileNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `mobile-nav-link${isActive ? ' active' : ''}`
            }
          >
            <span>{item.mobileLabel}</span>
          </NavLink>
        ))}
      </nav>

      {isDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="logout-warning-title"
          >
            <h2 id="logout-warning-title" style={{ marginTop: 0, fontSize: '1.18rem' }}>
              Cảnh báo còn video chờ tải lên
            </h2>
            <p style={{ color: 'var(--color-text-muted)', marginBottom: 0 }}>
              Thiết bị hiện còn <strong>{pendingWarningCount} bản ghi video</strong> đang chờ
              tải lên và xác nhận lưu trữ. Dữ liệu tạm vẫn được giữ an toàn riêng cho tài khoản{' '}
              <strong>{user?.email}</strong>, nhưng quá trình tải lên sẽ tạm dừng cho đến khi
              bạn đăng nhập lại đúng tài khoản này.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={cancelLogout}>
                Ở lại trang
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void confirmLogout()}
                disabled={isLoggingOut}
              >
                Vẫn đăng xuất
              </button>
            </div>
          </div>
          </div>
        )}
      </div>
    </TusUploadCoordinator>
  );
}

