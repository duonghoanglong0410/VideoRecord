import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../app/authStore';
import {
  formatDurationSeconds,
  formatHoChiMinhDateTime,
  getCaptureStatusBadge,
  getScopeTypeLabel,
  getSourceBadge,
  getStorageStatusBadge
} from '../../app/formatters';
import { Permissions } from '../../app/types';
import {
  fetchDashboardSummaryApi,
  type DashboardSummaryDto
} from '../admin/adminApi';
import { useTusUploadQueue } from '../upload-queue/TusUploadCoordinator';

export function DashboardPage() {
  const { user, runtimeConfig, hasPermission } = useAuth();
  const uploadQueue = useTusUploadQueue();

  const [summary, setSummary] = useState<DashboardSummaryDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetchDashboardSummaryApi({
        suppressSessionExpiredEvent: true
      });
      if (res && typeof res.todayRecordingsCount === 'number') {
        setSummary(res);
      } else {
        setSummary(null);
      }
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : 'Không thể tải số liệu tổng quan từ máy chủ.'
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const effectiveMode =
    summary?.activeStorageMode ?? runtimeConfig?.storageMode ?? 'LocalDevelopment';
  const canRecord = hasPermission(Permissions.RecordingCreate);
  const canImport = hasPermission(Permissions.VideoImport);
  const canViewVideos = hasPermission(Permissions.VideoView);
  const canUpload =
    hasPermission(Permissions.VideoUpload) || canRecord || canImport;
  const canManageUsers = hasPermission(Permissions.UserManage);
  const canManageStorage = hasPermission(Permissions.StorageManage);

  const localQueueCount = uploadQueue?.items.length ?? 0;

  return (
    <div>
      <div className="surface-card">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Bảng điều khiển vận hành</h1>
            <p className="page-subtitle">
              Xin chào <strong>{user?.fullName}</strong>. Số liệu dưới đây được tổng hợp
              trực tiếp từ cơ sở dữ liệu trong phạm vi quyền được cấp (múi giờ Việt Nam{' '}
              <code>Asia/Ho_Chi_Minh</code>).
            </p>
          </div>

          <button
            type="button"
            className="btn btn-outline"
            onClick={() => void loadSummary()}
            disabled={isLoading}
          >
            {isLoading ? 'Đang cập nhật...' : 'Làm mới số liệu'}
          </button>
        </div>

        <div className="quick-actions-row">
          {(canRecord || canImport) && (
            <Link to="/record" className="btn btn-primary">
              {canRecord ? 'Quay đóng gói đơn mới' : 'Nhập tệp video đóng gói'}
            </Link>
          )}
          {canUpload && (
            <Link to="/uploads" className="btn btn-outline">
              Hàng đợi tải lên trên thiết bị
              {localQueueCount > 0 ? ` (${localQueueCount})` : ''}
            </Link>
          )}
          {canViewVideos && (
            <Link to="/videos" className="btn btn-navy">
              Tra cứu thư viện video
            </Link>
          )}
          {canManageUsers && (
            <Link to="/admin/users" className="btn btn-outline">
              Quản trị tài khoản
            </Link>
          )}
          {canManageStorage && (
            <Link to="/admin/storage" className="btn btn-outline">
              Cấu hình lưu trữ
            </Link>
          )}
        </div>
      </div>

      {loadError && (
        <div className="alert alert-warning" role="alert">
          <strong>Chưa tải được thống kê trực tiếp:</strong> {loadError}
        </div>
      )}

      {summary && (
        <>
          <div className="metrics-grid" data-testid="dashboard-metrics-grid">
            <div className="metric-card">
              <span className="metric-label">Phiên ghi nhận hôm nay</span>
              <span className="metric-value metric-value-accent">
                {summary.todayRecordingsCount}
              </span>
              <span className="metric-caption">Theo ngày tại TP.HCM (GMT+7)</span>
            </div>

            <div className="metric-card">
              <span className="metric-label">
                {effectiveMode === 'SynologyMounted'
                  ? 'Đã lưu vào Synology NAS'
                  : 'Đã lưu cục bộ (Local)'}
              </span>
              <span className="metric-value">{summary.totalStoredCount}</span>
              <span className="metric-caption">
                {effectiveMode === 'SynologyMounted'
                  ? 'Chế độ lưu trữ chính thức Synology NAS'
                  : 'Chế độ thử nghiệm LocalDevelopment'}
              </span>
            </div>

            <div className="metric-card">
              <span className="metric-label">Đang tải lên / Kiểm tra</span>
              <span className="metric-value">{summary.awaitingOrValidatingCount}</span>
              <span className="metric-caption">Đang xử lý hoặc chờ ghi kho lưu trữ</span>
            </div>

            <div className="metric-card">
              <span className="metric-label">Bị gián đoạn / Lỗi</span>
              <span
                className={`metric-value${
                  summary.interruptedOrFailedCount > 0 ? ' metric-value-danger' : ''
                }`}
              >
                {summary.interruptedOrFailedCount}
              </span>
              <span className="metric-caption">Cần đối chiếu trước khi giao đơn</span>
            </div>

            <div className="metric-card">
              <span className="metric-label">Đang giữ bằng chứng (Hold)</span>
              <span
                className={`metric-value${
                  summary.onHoldCount > 0 ? ' metric-value-warning' : ''
                }`}
              >
                {summary.onHoldCount}
              </span>
              <span className="metric-caption">Khóa chống xóa thủ công &amp; tự động</span>
            </div>
          </div>

          {((summary.pendingDeletionRequestsCount ?? 0) > 0 ||
            (summary.pendingUserApprovalsCount ?? 0) > 0) && (
            <div className="surface-card">
              <h2 style={{ marginTop: 0, fontSize: '1.06rem' }}>
                Việc cần phê duyệt trong phạm vi quản lý
              </h2>
              <div className="quick-actions-row" style={{ marginTop: 8 }}>
                {(summary.pendingDeletionRequestsCount ?? 0) > 0 && canViewVideos && (
                  <Link to="/videos?tab=deletions" className="btn btn-outline">
                    {summary.pendingDeletionRequestsCount} yêu cầu xóa video đang chờ duyệt
                  </Link>
                )}
                {(summary.pendingUserApprovalsCount ?? 0) > 0 && canManageUsers && (
                  <Link
                    to="/admin/users?approvalStatus=PendingApproval"
                    className="btn btn-outline"
                  >
                    {summary.pendingUserApprovalsCount} tài khoản nhân viên đang chờ duyệt
                  </Link>
                )}
              </div>
            </div>
          )}

          {canViewVideos && (
            <div className="surface-card">
              <div className="page-header-row" style={{ marginBottom: 12 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: '1.08rem' }}>
                    Video bằng chứng gần đây
                  </h2>
                  <p className="page-subtitle">
                    Cập nhật lúc {formatHoChiMinhDateTime(summary.generatedAtUtc)}
                  </p>
                </div>
                <Link to="/videos" className="btn btn-outline">
                  Xem toàn bộ danh sách
                </Link>
              </div>

              {summary.recentVideos.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
                  Chưa có bản ghi video nào trong phạm vi quyền của bạn.
                </p>
              ) : (
                <>
                  <div className="desktop-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Mã vận đơn</th>
                          <th>Shop / Kho</th>
                          <th>Nhân viên</th>
                          <th>Trạng thái</th>
                          <th>Thời lượng</th>
                          <th>Thời điểm tạo</th>
                          <th>Thao tác</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.recentVideos.map((v) => {
                          const capBadge = getCaptureStatusBadge(v.captureStatus);
                          const stoBadge = getStorageStatusBadge(
                            v.storageStatus,
                            v.storageMode
                          );
                          const srcBadge = getSourceBadge(v.source);
                          return (
                            <tr key={v.id}>
                              <td>
                                <span className="mono-code">{v.trackingNumber}</span>
                                {v.hold && (
                                  <div style={{ marginTop: 4 }}>
                                    <span className="status-pill status-pill-hold">
                                      Đang giữ (Hold)
                                    </span>
                                  </div>
                                )}
                              </td>
                              <td>
                                <strong>{v.shopName}</strong>
                                <div
                                  style={{
                                    fontSize: '0.82rem',
                                    color: 'var(--color-text-muted)'
                                  }}
                                >
                                  {v.warehouseName}
                                </div>
                              </td>
                              <td>{v.ownerFullName}</td>
                              <td>
                                <div className="badge-cluster">
                                  <span className={capBadge.className}>
                                    {capBadge.label}
                                  </span>
                                  <span className={stoBadge.className}>
                                    {stoBadge.label}
                                  </span>
                                  {v.source === 'Imported' && (
                                    <span className={srcBadge.className}>
                                      {srcBadge.shortLabel}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td>{formatDurationSeconds(v.durationSeconds)}</td>
                              <td>{formatHoChiMinhDateTime(v.createdAtUtc)}</td>
                              <td>
                                <Link
                                  to={`/videos/${v.id}`}
                                  className="btn btn-outline"
                                  style={{ padding: '6px 12px' }}
                                >
                                  Chi tiết
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="mobile-card-list mobile-card-list-hide-desktop">
                    {summary.recentVideos.map((v) => {
                      const capBadge = getCaptureStatusBadge(v.captureStatus);
                      const stoBadge = getStorageStatusBadge(
                        v.storageStatus,
                        v.storageMode
                      );
                      return (
                        <div key={v.id} className="mobile-data-card">
                          <div className="page-header-row">
                            <span className="mono-code" style={{ fontSize: '1.05rem' }}>
                              {v.trackingNumber}
                            </span>
                            <Link
                              to={`/videos/${v.id}`}
                              className="btn btn-outline"
                              style={{ padding: '6px 12px' }}
                            >
                              Mở video
                            </Link>
                          </div>
                          <div
                            style={{
                              fontSize: '0.84rem',
                              color: 'var(--color-text-muted)'
                            }}
                          >
                            {v.shopName} • {v.warehouseName} • {v.ownerFullName}
                          </div>
                          <div className="badge-cluster">
                            <span className={capBadge.className}>{capBadge.label}</span>
                            <span className={stoBadge.className}>{stoBadge.label}</span>
                            {v.hold && (
                              <span className="status-pill status-pill-hold">
                                Đang giữ (Hold)
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      <div className="surface-card">
        <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>
          Phạm vi phân quyền hiện tại của tài khoản
        </h2>
        {user?.grants && user.grants.length > 0 ? (
          <div className="mobile-card-list">
            {user.grants.map((g) => (
              <div
                key={g.id}
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid #E2E8F0',
                  background: '#F8FAFC',
                  fontSize: '0.9rem'
                }}
              >
                <strong>{g.roleName}</strong> — Phạm vi:{' '}
                <strong>{getScopeTypeLabel(g.scopeType)}</strong>
                {g.shopName ? ` • Shop: ${g.shopName}` : ''}
                {g.warehouseName ? ` • Kho: ${g.warehouseName}` : ''}
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: 'var(--color-text-muted)', marginBottom: 0 }}>
            Tài khoản chưa có phạm vi vai trò nào được gán.
          </p>
        )}
      </div>
    </div>
  );
}
