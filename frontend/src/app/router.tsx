import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { useAuth } from './authStore';
import type { PendingRecordingsCounter } from './pendingUploadsBridge';
import { Permissions } from './types';
import { AuditLogPage } from '../features/admin/AuditLogPage';
import { RolesAdminPage } from '../features/admin/RolesAdminPage';
import { StorageAdminPage } from '../features/admin/StorageAdminPage';
import { UsersAdminPage } from '../features/admin/UsersAdminPage';
import { WarehousesAdminPage } from '../features/admin/WarehousesAdminPage';
import { AccountProfilePage } from '../features/auth/AccountProfilePage';
import { LoginPage } from '../features/auth/LoginPage';
import { MfaSecurityPage } from '../features/auth/MfaSecurityPage';
import { PendingApprovalPage } from '../features/auth/PendingApprovalPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { RecordingPage } from '../features/recording/RecordingPage';
import { UploadQueuePage } from '../features/upload-queue/UploadQueuePage';
import { VideoDetailPage } from '../features/videos/VideoDetailPage';
import { VideoListPage } from '../features/videos/VideoListPage';

function LoadingScreen() {
  return (
    <div className="auth-container" role="status">
      <div className="surface-card" style={{ textAlign: 'center', maxWidth: 360 }}>
        Đang kiểm tra phiên đăng nhập...
      </div>
    </div>
  );
}

function RequireActiveUser({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.approvalStatus === 'PendingApproval') {
    return <Navigate to="/pending-approval" replace />;
  }

  return <>{children}</>;
}

function ForbiddenCard() {
  return (
    <div className="surface-card" role="alert">
      <h1 style={{ marginTop: 0, fontSize: '1.25rem' }}>Không đủ quyền truy cập</h1>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: 0 }}>
        Tài khoản của bạn không được cấp quyền để mở chức năng này.
      </p>
    </div>
  );
}

function RequireAnyPermission({
  permissions,
  children
}: {
  permissions: string[];
  children: ReactNode;
}) {
  const { hasPermission } = useAuth();
  const allowed = permissions.some((code) => hasPermission(code));

  if (!allowed) {
    return <ForbiddenCard />;
  }

  return <>{children}</>;
}

function RequireWarehouseAdminAccess({ children }: { children: ReactNode }) {
  const { user, hasPermission } = useAuth();
  const allowed =
    hasPermission(Permissions.StorageManage) ||
    (hasPermission(Permissions.UserManage) &&
      Boolean(
        user?.isSuperAdmin || user?.grants.some((g) => g.scopeType === 'Shop')
      ));

  if (!allowed) {
    return <ForbiddenCard />;
  }

  return <>{children}</>;
}

function RequireAuthenticatedForPending() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.approvalStatus === 'Active') {
    return <Navigate to="/" replace />;
  }

  return <PendingApprovalPage />;
}

export interface AppRoutesProps {
  checkPendingRecordingsCount?: PendingRecordingsCounter;
}

export function AppRoutes({ checkPendingRecordingsCount }: AppRoutesProps) {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/pending-approval" element={<RequireAuthenticatedForPending />} />

      <Route
        element={
          <RequireActiveUser>
            <AppLayout checkPendingRecordingsCount={checkPendingRecordingsCount} />
          </RequireActiveUser>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route
          path="record"
          element={
            <RequireAnyPermission
              permissions={[Permissions.RecordingCreate, Permissions.VideoImport]}
            >
              <RecordingPage />
            </RequireAnyPermission>
          }
        />
        <Route
          path="uploads"
          element={
            <RequireAnyPermission
              permissions={[
                Permissions.VideoUpload,
                Permissions.RecordingCreate,
                Permissions.VideoImport
              ]}
            >
              <UploadQueuePage />
            </RequireAnyPermission>
          }
        />
        <Route
          path="videos"
          element={
            <RequireAnyPermission permissions={[Permissions.VideoView]}>
              <VideoListPage />
            </RequireAnyPermission>
          }
        />
        <Route
          path="videos/:id"
          element={
            <RequireAnyPermission permissions={[Permissions.VideoView]}>
              <VideoDetailPage />
            </RequireAnyPermission>
          }
        />
        <Route path="account" element={<AccountProfilePage />} />
        <Route path="security/mfa" element={<MfaSecurityPage />} />
        <Route
          path="admin/users"
          element={
            <RequireAnyPermission permissions={[Permissions.UserManage]}>
              <UsersAdminPage />
            </RequireAnyPermission>
          }
        />
        <Route
          path="admin/warehouses"
          element={
            <RequireWarehouseAdminAccess>
              <WarehousesAdminPage />
            </RequireWarehouseAdminAccess>
          }
        />
        <Route
          path="admin/roles"
          element={
            <RequireAnyPermission permissions={[Permissions.RoleManage]}>
              <RolesAdminPage />
            </RequireAnyPermission>
          }
        />
        <Route
          path="admin/storage"
          element={
            <RequireAnyPermission permissions={[Permissions.StorageManage]}>
              <StorageAdminPage />
            </RequireAnyPermission>
          }
        />
        <Route
          path="admin/audit"
          element={
            <RequireAnyPermission permissions={[Permissions.AuditView]}>
              <AuditLogPage />
            </RequireAnyPermission>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
