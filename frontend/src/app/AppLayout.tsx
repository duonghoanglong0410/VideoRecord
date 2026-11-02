import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Building2,
  Camera,
  CloudUpload,
  Film,
  HardDrive,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  PackageCheck,
  UserCheck,
  UserCircle2,
  Users,
  X
} from 'lucide-react';
import {
  reconcileCrashedSessions,
  wirePendingUploadsBridge
} from '../features/upload-queue/db/packingProofIdb';
import {
  TusUploadCoordinator,
  useTusUploadQueue
} from '../features/upload-queue/TusUploadCoordinator';
import { useAuth } from './authStore';
import {
  getPendingLocalRecordingsCount,
  type PendingRecordingsCounter
} from './pendingUploadsBridge';
import { StorageModeBanner } from './StorageModeBanner';
import { Permissions, type AuthMe } from './types';

export const RECORDING_ACTIVE_UI_EVENT = 'packingproof:recording-active';

interface NavItem {
  to: string;
  label: string;
  mobileLabel: string;
  group: 'operations' | 'admin';
  showInMobileBar: boolean;
  icon: ReactNode;
  requiredAnyPermissions?: string[];
  customCheck?: (
    user: AuthMe | null,
    hasPermission: (code: string) => boolean
  ) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    to: '/',
    label: 'Tổng quan',
    mobileLabel: 'Tổng quan',
    group: 'operations',
    showInMobileBar: true,
    icon: <LayoutDashboard className="h-4 w-4 shrink-0" />
  },
  {
    to: '/record',
    label: 'Quay đóng gói',
    mobileLabel: 'Quay đơn',
    group: 'operations',
    showInMobileBar: true,
    icon: <Camera className="h-4 w-4 shrink-0" />,
    requiredAnyPermissions: [Permissions.RecordingCreate, Permissions.VideoImport]
  },
  {
    to: '/uploads',
    label: 'Tiến trình tải lên',
    mobileLabel: 'Đang tải',
    group: 'operations',
    showInMobileBar: true,
    icon: <CloudUpload className="h-4 w-4 shrink-0" />,
    requiredAnyPermissions: [
      Permissions.VideoUpload,
      Permissions.RecordingCreate,
      Permissions.VideoImport
    ]
  },
  {
    to: '/videos',
    label: 'Thư viện video',
    mobileLabel: 'Tra cứu',
    group: 'operations',
    showInMobileBar: true,
    icon: <Film className="h-4 w-4 shrink-0" />,
    requiredAnyPermissions: [Permissions.VideoView]
  },
  {
    to: '/admin/users',
    label: 'Quản lý tài khoản',
    mobileLabel: 'Tài khoản',
    group: 'admin',
    showInMobileBar: false,
    icon: <Users className="h-4 w-4 shrink-0" />,
    requiredAnyPermissions: [Permissions.UserManage]
  },
  {
    to: '/admin/warehouses',
    label: 'Quản lý Shop & Kho',
    mobileLabel: 'Shop & Kho',
    group: 'admin',
    showInMobileBar: false,
    icon: <Building2 className="h-4 w-4 shrink-0" />,
    customCheck: (user, hasPerm) =>
      hasPerm(Permissions.StorageManage) ||
      (hasPerm(Permissions.UserManage) &&
        Boolean(
          user?.isSuperAdmin || user?.grants.some((g) => g.scopeType === 'Shop')
        ))
  },
  {
    to: '/admin/roles',
    label: 'Vai trò & Quyền hạn',
    mobileLabel: 'Vai trò',
    group: 'admin',
    showInMobileBar: false,
    icon: <UserCheck className="h-4 w-4 shrink-0" />,
    requiredAnyPermissions: [Permissions.RoleManage]
  },
  {
    to: '/admin/storage',
    label: 'Cấu hình ổ lưu trữ',
    mobileLabel: 'Ổ lưu trữ',
    group: 'admin',
    showInMobileBar: false,
    icon: <HardDrive className="h-4 w-4 shrink-0" />,
    requiredAnyPermissions: [Permissions.StorageManage]
  },
  {
    to: '/admin/audit',
    label: 'Nhật ký hoạt động',
    mobileLabel: 'Nhật ký',
    group: 'admin',
    showInMobileBar: false,
    icon: <History className="h-4 w-4 shrink-0" />,
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

function AppShellInner({ checkPendingRecordingsCount }: AppLayoutProps) {
  const { user, runtimeConfig, hasPermission, logout } = useAuth();
  const uploadQueue = useTusUploadQueue();
  const navigate = useNavigate();
  const [isCameraRecordingActive, setIsCameraRecordingActive] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    wirePendingUploadsBridge();
    if (user?.id) {
      void reconcileCrashedSessions(user.id).catch(() => undefined);
    }
  }, [user?.id]);

  useEffect(() => {
    const onRecordingState = (evt: Event) => {
      const custom = evt as CustomEvent<{ active?: boolean }>;
      setIsCameraRecordingActive(Boolean(custom.detail?.active));
    };
    window.addEventListener(RECORDING_ACTIVE_UI_EVENT, onRecordingState);
    return () => {
      window.removeEventListener(RECORDING_ACTIVE_UI_EVENT, onRecordingState);
    };
  }, []);

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
      if (item.customCheck) {
        return item.customCheck(user, hasPermission);
      }
      if (!item.requiredAnyPermissions || item.requiredAnyPermissions.length === 0) {
        return true;
      }
      return item.requiredAnyPermissions.some((code) => hasPermission(code));
    });
  }, [hasPermission, user]);

  const operationItems = useMemo(
    () => visibleNavItems.filter((item) => item.group === 'operations'),
    [visibleNavItems]
  );

  const adminItems = useMemo(
    () => visibleNavItems.filter((item) => item.group === 'admin'),
    [visibleNavItems]
  );

  const mobileNavItems = useMemo(
    () => visibleNavItems.filter((item) => item.showInMobileBar).slice(0, 4),
    [visibleNavItems]
  );

  const pendingUploadBadgeCount = useMemo(() => {
    const list = uploadQueue?.items ?? [];
    return list.filter(
      (item) =>
        item.captureStatus !== 'Cancelled' &&
        item.localSyncState !== 'StoredConfirmed' &&
        item.localSyncState !== 'Discarded'
    ).length;
  }, [uploadQueue?.items]);

  return (
    <div className="flex min-h-dvh w-full max-w-full flex-col overflow-x-clip bg-slate-50 text-slate-900">
      <StorageModeBanner storageMode={runtimeConfig?.storageMode} />

      {/* Top Header Bar — Strictly fits >=320px viewports with 44x44px touch targets */}
      <header className="sticky top-0 z-30 flex h-14 w-full items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(true)}
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 transition-colors hover:bg-slate-50 lg:hidden"
            aria-label="Mở menu chức năng"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>

          <NavLink
            to="/"
            className="flex min-w-0 min-h-11 items-center gap-2 font-bold tracking-tight text-slate-900 no-underline"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
              <PackageCheck className="h-4.5 w-4.5" aria-hidden="true" />
            </span>
            <span className="truncate text-sm sm:text-base">PackingProof</span>
          </NavLink>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {user && (
            <NavLink
              to="/account"
              title="Tài khoản của tôi — Đổi mật khẩu"
              aria-label={`Tài khoản của tôi: ${user.fullName}`}
              className={({ isActive }) =>
                `inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border px-2.5 text-xs font-semibold no-underline transition-colors ${
                  isActive
                    ? 'border-blue-200 bg-blue-50 text-blue-700'
                    : 'border-slate-200 bg-slate-50/80 text-slate-800 hover:bg-slate-100'
                }`
              }
            >
              <UserCircle2 className="h-5 w-5 shrink-0 text-blue-600 sm:h-4 sm:w-4" aria-hidden="true" />
              <span className="hidden max-w-[140px] truncate sm:inline">
                {user.fullName}
              </span>
            </NavLink>
          )}

          <button
            type="button"
            aria-label="Đăng xuất"
            title="Đăng xuất"
            className="inline-flex h-11 min-w-11 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 sm:px-3"
            onClick={() => void requestLogout()}
            disabled={isLoggingOut}
          >
            <LogOut className="h-4.5 w-4.5 sm:h-4 sm:w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Đăng xuất</span>
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <div
        className={`flex min-w-0 flex-1 ${
          isCameraRecordingActive
            ? 'pb-4'
            : 'pb-[calc(74px+env(safe-area-inset-bottom,0px))] lg:pb-0'
        }`}
      >
        {/* Desktop Sidebar */}
        <aside
          className="hidden w-60 shrink-0 border-r border-slate-200 bg-white px-3 py-4 lg:block"
          aria-label="Điều hướng chính"
        >
          <div className="space-y-5">
            <div>
              <nav className="flex flex-col gap-1">
                {operationItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      `flex min-h-[42px] items-center justify-between gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold no-underline transition-colors ${
                        isActive
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                      }`
                    }
                  >
                    <span className="flex items-center gap-2.5">
                      {item.icon}
                      <span>{item.label}</span>
                    </span>
                    {item.to === '/uploads' && pendingUploadBadgeCount > 0 && (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 font-mono text-[11px] font-bold text-white">
                        {pendingUploadBadgeCount}
                      </span>
                    )}
                  </NavLink>
                ))}
              </nav>
            </div>

            {adminItems.length > 0 && (
              <div>
                <div className="mb-1.5 px-3 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
                  Quản trị hệ thống
                </div>
                <nav className="flex flex-col gap-1">
                  {adminItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) =>
                        `flex min-h-[42px] items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold no-underline transition-colors ${
                          isActive
                            ? 'bg-blue-50 text-blue-700'
                            : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                        }`
                      }
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </NavLink>
                  ))}
                </nav>
              </div>
            )}

            <div className="border-t border-slate-100 pt-3">
              <NavLink
                to="/account"
                className={({ isActive }) =>
                  `flex min-h-[42px] items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold no-underline transition-colors ${
                    isActive
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                  }`
                }
              >
                <UserCircle2 className="h-4 w-4 shrink-0" />
                <span>Tài khoản của tôi</span>
              </NavLink>
            </div>
          </div>
        </aside>

        {/* Page Content — min-w-0 prevents inner wide tables/code blocks from stretching mobile viewport */}
        <main className="mx-auto min-w-0 w-full max-w-7xl flex-1 p-3 sm:p-5 lg:p-6">
          <Outlet />
        </main>
      </div>

      {/* Mobile Full Navigation Drawer (Gives access to Quản lý Kho, Quản lý Tài khoản, Tài khoản của tôi on Mobile/Tablet) */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 flex bg-slate-900/55 lg:hidden"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setIsMobileMenuOpen(false);
            }
          }}
        >
          <div
            className="flex h-full w-76 max-w-[86vw] flex-col justify-between overflow-y-auto bg-white p-4 pb-[calc(16px+env(safe-area-inset-bottom,0px))] shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-label="Menu điều hướng đầy đủ"
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <div className="flex items-center gap-2 font-bold text-slate-900">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
                    <PackageCheck className="h-4.5 w-4.5" aria-hidden="true" />
                  </span>
                  <span>Danh mục chức năng</span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                  aria-label="Đóng menu"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>

              {user && (
                <NavLink
                  to="/account"
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50/80 p-3 no-underline transition-colors hover:bg-slate-100"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700">
                    <UserCircle2 className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-slate-900">
                      {user.fullName}
                    </span>
                    <span className="block truncate text-xs text-slate-600">
                      {user.email}
                    </span>
                  </span>
                </NavLink>
              )}

              <div>
                <nav className="flex flex-col gap-1">
                  {operationItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      onClick={() => setIsMobileMenuOpen(false)}
                      className={({ isActive }) =>
                        `flex min-h-11 items-center justify-between gap-2.5 rounded-xl px-3 py-2 text-sm font-semibold no-underline ${
                          isActive
                            ? 'bg-blue-50 text-blue-700'
                            : 'text-slate-700 hover:bg-slate-100'
                        }`
                      }
                    >
                      <span className="flex items-center gap-2.5">
                        {item.icon}
                        <span>{item.label}</span>
                      </span>
                      {item.to === '/uploads' && pendingUploadBadgeCount > 0 && (
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 font-mono text-[11px] font-bold text-white">
                          {pendingUploadBadgeCount}
                        </span>
                      )}
                    </NavLink>
                  ))}
                </nav>
              </div>

              {adminItems.length > 0 && (
                <div>
                  <div className="mb-1.5 px-2.5 text-[11px] font-bold tracking-wider text-slate-500 uppercase">
                    Quản trị hệ thống
                  </div>
                  <nav className="flex flex-col gap-1">
                    {adminItems.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        onClick={() => setIsMobileMenuOpen(false)}
                        className={({ isActive }) =>
                          `flex min-h-11 items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-semibold no-underline ${
                            isActive
                              ? 'bg-blue-50 text-blue-700'
                              : 'text-slate-700 hover:bg-slate-100'
                          }`
                        }
                      >
                        {item.icon}
                        <span>{item.label}</span>
                      </NavLink>
                    ))}
                  </nav>
                </div>
              )}

              <div className="border-t border-slate-100 pt-2">
                <nav className="flex flex-col gap-1">
                  <NavLink
                    to="/account"
                    onClick={() => setIsMobileMenuOpen(false)}
                    className={({ isActive }) =>
                      `flex min-h-11 items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-semibold no-underline ${
                        isActive
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`
                    }
                  >
                    <UserCircle2 className="h-4 w-4 shrink-0" />
                    <span>Tài khoản của tôi</span>
                  </NavLink>
                </nav>
              </div>
            </div>

            <div className="mt-5 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  void requestLogout();
                }}
                disabled={isLoggingOut}
                className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50/70 px-3 py-2.5 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
              >
                <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Đăng xuất tài khoản</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Bottom Navigation Bar (Auto-hidden during active video recording) */}
      {!isCameraRecordingActive && (
        <nav
          className="fixed right-0 bottom-0 left-0 z-30 flex items-center justify-around gap-1 border-t border-slate-200 bg-white/98 px-1.5 pt-1.5 pb-[calc(6px+env(safe-area-inset-bottom,0px))] backdrop-blur-xs lg:hidden"
          aria-label="Điều hướng di động"
        >
          {mobileNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `relative flex min-h-[50px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-[11px] font-semibold no-underline transition-colors ${
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-600 hover:bg-slate-50'
                }`
              }
            >
              {item.icon}
              <span className="max-w-full truncate">{item.mobileLabel}</span>
              {item.to === '/uploads' && pendingUploadBadgeCount > 0 && (
                <span className="absolute top-1 right-1/4 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 font-mono text-[10px] font-bold text-white">
                  {pendingUploadBadgeCount}
                </span>
              )}
            </NavLink>
          ))}

          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(true)}
            className="relative flex min-h-[50px] min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-[11px] font-semibold text-slate-600 transition-colors hover:bg-slate-50"
          >
            <Menu className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="max-w-full truncate">Menu</span>
          </button>
        </nav>
      )}

      {/* Pending Videos Logout Confirmation Dialog */}
      {isDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="logout-warning-title"
          >
            <div className="mb-3 flex items-center gap-2.5 text-amber-700">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100">
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              </span>
              <h2 id="logout-warning-title" className="m-0 text-lg font-bold text-slate-900">
                Cảnh báo còn video chờ tải lên
              </h2>
            </div>

            <p className="m-0 text-sm leading-relaxed text-slate-600">
              Trên máy hiện còn <strong>{pendingWarningCount} bản ghi video</strong> đang chờ gửi
              lên hệ thống. Video vẫn được giữ an toàn cho tài khoản{' '}
              <strong className="text-slate-900">{user?.email}</strong>, nhưng quá trình gửi sẽ tạm
              dừng cho đến khi bạn đăng nhập lại.
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
  );
}

export function AppLayout(props: AppLayoutProps) {
  return (
    <TusUploadCoordinator>
      <AppShellInner {...props} />
    </TusUploadCoordinator>
  );
}
