import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Camera,
  Film,
  Loader2,
  RefreshCw,
  UserCheck,
  Video
} from 'lucide-react';
import { useAuth } from '../../app/authStore';
import {
  formatDurationSeconds,
  formatHoChiMinhDateTime
} from '../../app/formatters';
import { Permissions } from '../../app/types';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { StatCard } from '../../components/ui/StatCard';
import {
  fetchDashboardSummaryApi,
  type DashboardRecentVideoDto,
  type DashboardSummaryDto
} from '../admin/adminApi';

function isRecentVideoFailed(video: DashboardRecentVideoDto): boolean {
  return (
    video.captureStatus !== 'Captured' ||
    video.storageStatus === 'Failed'
  );
}

export function DashboardPage() {
  const { user, hasPermission } = useAuth();

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

  const canRecord = hasPermission(Permissions.RecordingCreate);
  const canImport = hasPermission(Permissions.VideoImport);
  const canViewVideos = hasPermission(Permissions.VideoView);
  const canManageUsers = hasPermission(Permissions.UserManage);

  const hasPendingActions =
    ((summary?.pendingDeletionRequestsCount ?? 0) > 0 && canViewVideos) ||
    ((summary?.pendingUserApprovalsCount ?? 0) > 0 && canManageUsers);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
        <PageHeader
          title="Bảng điều khiển vận hành"
          subtitle={
            <>
              Xin chào <strong className="text-slate-800">{user?.fullName}</strong> — Tổng hợp
              nhanh tình hình đóng gói và lưu trữ video hôm nay.
            </>
          }
          actions={
            <>
              <button
                type="button"
                className="btn btn-outline inline-flex items-center gap-1.5"
                onClick={() => void loadSummary()}
                disabled={isLoading}
              >
                <RefreshCw
                  className={`h-4 w-4 shrink-0 ${isLoading ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>{isLoading ? 'Đang cập nhật...' : 'Làm mới'}</span>
              </button>
              {(canRecord || canImport) && (
                <Link
                  to="/record"
                  className="btn btn-primary inline-flex items-center gap-1.5"
                >
                  <Camera className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{canRecord ? 'Quay đơn mới' : 'Nhập video có sẵn'}</span>
                </Link>
              )}
            </>
          }
        />
      </div>

      {loadError && (
        <div
          className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div>
            <strong>Chưa tải được thống kê trực tiếp:</strong> {loadError}
          </div>
        </div>
      )}

      {isLoading && !summary && (
        <div
          className="flex items-center justify-center gap-2.5 rounded-2xl border border-slate-200 bg-white p-8 text-sm font-medium text-slate-600"
          role="status"
        >
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" aria-hidden="true" />
          <span>Đang tổng hợp số liệu vận hành...</span>
        </div>
      )}

      {summary && (
        <>
          <div
            className="max-w-sm"
            data-testid="dashboard-metrics-grid"
          >
            <StatCard
              label="Đơn đã quay hôm nay"
              value={summary.todayRecordingsCount}
              hint="Trong ngày hôm nay"
              icon={<Video className="h-4.5 w-4.5 sm:h-5 sm:w-5" />}
              tone="blue"
              to={canViewVideos ? '/videos' : undefined}
            />
          </div>

          {/* Action-Required Approval Callout */}
          {hasPendingActions && (
            <div className="rounded-2xl border border-amber-300 bg-amber-50/80 p-4 shadow-2xs">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                    <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <div>
                    <h2 className="m-0 text-sm font-bold text-amber-950">
                      Cần phê duyệt ngay
                    </h2>
                    <p className="m-0 text-xs text-amber-800">
                      Có yêu cầu đang chờ quản lý xử lý trong phạm vi của bạn.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {(summary.pendingDeletionRequestsCount ?? 0) > 0 && canViewVideos && (
                    <Link
                      to="/videos?tab=deletions"
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-amber-300 bg-white px-3.5 py-2 text-xs font-bold text-amber-950 no-underline shadow-2xs transition-colors hover:bg-amber-100/60"
                    >
                      <Film className="h-4 w-4 text-amber-700" aria-hidden="true" />
                      <span>
                        {summary.pendingDeletionRequestsCount} yêu cầu xóa video chờ duyệt
                      </span>
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                  )}

                  {(summary.pendingUserApprovalsCount ?? 0) > 0 && canManageUsers && (
                    <Link
                      to="/admin/users?approvalStatus=PendingApproval"
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-amber-300 bg-white px-3.5 py-2 text-xs font-bold text-amber-950 no-underline shadow-2xs transition-colors hover:bg-amber-100/60"
                    >
                      <UserCheck className="h-4 w-4 text-amber-700" aria-hidden="true" />
                      <span>
                        {summary.pendingUserApprovalsCount} tài khoản nhân viên chờ duyệt
                      </span>
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Recent Videos Table & Mobile Cards */}
          {canViewVideos && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="m-0 text-base font-bold text-slate-900">
                    Video đóng gói gần đây
                  </h2>
                  <p className="mt-0.5 mb-0 text-xs text-slate-500">
                    Cập nhật lúc {formatHoChiMinhDateTime(summary.generatedAtUtc)}
                  </p>
                </div>
                <Link
                  to="/videos"
                  className="btn btn-outline inline-flex items-center gap-1.5 text-xs"
                >
                  <span>Xem tất cả video</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>

              {summary.recentVideos.length === 0 ? (
                <EmptyState
                  icon={<Film className="h-6 w-6" />}
                  title="Chưa có video đóng gói nào"
                  description="Các video sau khi quay và tải lên hệ thống sẽ hiển thị ngay tại đây."
                  action={
                    canRecord || canImport ? (
                      <Link
                        to="/record"
                        className="btn btn-primary inline-flex items-center gap-2"
                      >
                        <Camera className="h-4 w-4" aria-hidden="true" />
                        <span>Quay đơn hàng đầu tiên</span>
                      </Link>
                    ) : undefined
                  }
                />
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
                          <th>Thời gian quay</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.recentVideos.map((v) => {
                          const failed = isRecentVideoFailed(v);
                          return (
                            <tr key={v.id}>
                              <td>
                                <span className="mono-code text-slate-900">
                                  {v.trackingNumber}
                                </span>
                              </td>
                              <td>
                                <div className="font-semibold text-slate-900">
                                  {v.shopName}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {v.warehouseName}
                                </div>
                              </td>
                              <td className="text-slate-700">{v.ownerFullName}</td>
                              <td>
                                <span
                                  className={
                                    failed
                                      ? 'status-pill status-pill-interrupted'
                                      : 'status-pill status-pill-completed'
                                  }
                                >
                                  {failed ? 'Thất bại' : 'Thành công'}
                                </span>
                              </td>
                              <td className="font-mono text-xs text-slate-700">
                                {formatDurationSeconds(v.durationSeconds)}
                              </td>
                              <td className="text-xs text-slate-600">
                                {formatHoChiMinhDateTime(v.createdAtUtc)}
                              </td>
                              <td className="text-right">
                                <Link
                                  to={`/videos/${v.id}`}
                                  className="btn btn-outline px-3 py-1.5 text-xs"
                                >
                                  Xem chi tiết
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
                      const failed = isRecentVideoFailed(v);
                      return (
                        <div key={v.id} className="mobile-data-card">
                          <div className="flex items-center justify-between gap-2">
                            <span className="mono-code text-base text-slate-950">
                              {v.trackingNumber}
                            </span>
                            <span
                              className={
                                failed
                                  ? 'status-pill status-pill-interrupted'
                                  : 'status-pill status-pill-completed'
                              }
                            >
                              {failed ? 'Thất bại' : 'Thành công'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2 pt-1 text-xs text-slate-500">
                            <span>
                              {formatHoChiMinhDateTime(v.createdAtUtc)} •{' '}
                              <strong className="font-mono text-slate-700">
                                {formatDurationSeconds(v.durationSeconds)}
                              </strong>
                            </span>
                            <Link
                              to={`/videos/${v.id}`}
                              className="btn btn-outline shrink-0 px-3 py-1.5 text-xs"
                            >
                              Xem chi tiết
                            </Link>
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
    </div>
  );
}
