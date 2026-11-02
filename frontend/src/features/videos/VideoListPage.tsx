import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  Camera,
  ChevronLeft,
  ChevronRight,
  Film,
  Loader2,
  RotateCcw,
  Search
} from 'lucide-react';
import { useAuth } from '../../app/authStore';
import {
  formatDurationSeconds,
  formatHoChiMinhDateTime,
  getDeletionStatusBadge,
  type CaptureStatusType
} from '../../app/formatters';
import { Permissions } from '../../app/types';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import {
  approveDeletionRequestApi,
  listDeletionRequestsApi,
  listVideosApi,
  rejectDeletionRequestApi,
  type DeletionRequestListItemDto,
  type PagedVideosResponse,
  type VideoListItemDto
} from './videosApi';

type ActiveListTab = 'videos' | 'deletions';

const VALID_CAPTURE_STATUSES: ReadonlyArray<CaptureStatusType> = [
  'Captured',
  'Interrupted',
  'Recording',
  'Created'
];

function isVideoFailed(item: VideoListItemDto): boolean {
  return (
    item.captureStatus !== 'Captured' ||
    item.storageStatus === 'Failed'
  );
}

export function VideoListPage() {
  const { hasPermission } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canApproveDelete = hasPermission(Permissions.VideoDeleteApprove);
  const canRecordOrImport =
    hasPermission(Permissions.RecordingCreate) ||
    hasPermission(Permissions.VideoImport);

  const initialTab: ActiveListTab =
    canApproveDelete && searchParams.get('tab') === 'deletions'
      ? 'deletions'
      : 'videos';

  const initialCaptureParam = searchParams.get('captureStatus') ?? '';
  const initialCaptureStatus: CaptureStatusType | '' =
    VALID_CAPTURE_STATUSES.includes(initialCaptureParam as CaptureStatusType)
      ? (initialCaptureParam as CaptureStatusType)
      : '';

  const [activeTab, setActiveTab] = useState<ActiveListTab>(initialTab);
  const [trackingInput, setTrackingInput] = useState<string>(
    searchParams.get('trackingNumber') ?? ''
  );
  const [captureStatus, setCaptureStatus] = useState<CaptureStatusType | ''>(
    initialCaptureStatus
  );
  const [page, setPage] = useState<number>(1);
  const pageSize = 20;

  const [appliedTracking, setAppliedTracking] = useState<string>(
    searchParams.get('trackingNumber') ?? ''
  );

  const [videosData, setVideosData] = useState<PagedVideosResponse | null>(null);
  const [isLoadingVideos, setIsLoadingVideos] = useState<boolean>(true);
  const [videosError, setVideosError] = useState<string | null>(null);

  const [deletionItems, setDeletionItems] = useState<DeletionRequestListItemDto[]>([]);
  const [deletionTotal, setDeletionTotal] = useState<number>(0);
  const [deletionStatusFilter, setDeletionStatusFilter] = useState<
    'Pending' | 'Approved' | 'Rejected' | ''
  >('Pending');
  const [isLoadingDeletions, setIsLoadingDeletions] = useState<boolean>(false);
  const [deletionsError, setDeletionsError] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const loadVideos = useCallback(async () => {
    setIsLoadingVideos(true);
    setVideosError(null);
    try {
      const res = await listVideosApi({
        trackingNumber: appliedTracking,
        captureStatus,
        page,
        pageSize
      });
      setVideosData(res);
    } catch (err) {
      setVideosError(
        err instanceof Error
          ? err.message
          : 'Không thể tải danh sách video bằng chứng.'
      );
    } finally {
      setIsLoadingVideos(false);
    }
  }, [
    appliedTracking,
    captureStatus,
    page
  ]);

  const loadDeletionRequests = useCallback(async () => {
    if (!canApproveDelete) {
      return;
    }
    setIsLoadingDeletions(true);
    setDeletionsError(null);
    try {
      const res = await listDeletionRequestsApi({
        status: deletionStatusFilter,
        page: 1,
        pageSize: 50
      });
      setDeletionItems(res.items);
      setDeletionTotal(res.totalCount);
    } catch (err) {
      setDeletionsError(
        err instanceof Error
          ? err.message
          : 'Không thể tải danh sách yêu cầu xóa video.'
      );
    } finally {
      setIsLoadingDeletions(false);
    }
  }, [
    canApproveDelete,
    deletionStatusFilter
  ]);

  useEffect(() => {
    if (activeTab === 'videos') {
      void loadVideos();
    } else {
      void loadDeletionRequests();
    }
  }, [activeTab, loadDeletionRequests, loadVideos]);

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setAppliedTracking(trackingInput);
  };

  const handleResetFilters = () => {
    setTrackingInput('');
    setAppliedTracking('');
    setCaptureStatus('');
    setPage(1);
    if (searchParams.size > 0) {
      setSearchParams({}, { replace: true });
    }
  };

  const handleQuickApproveDeletion = async (reqItem: DeletionRequestListItemDto) => {
    if (reqItem.recordingHold) {
      return;
    }
    setReviewingId(reqItem.id);
    setDeletionsError(null);
    try {
      await approveDeletionRequestApi(
        reqItem.id,
        'Đã phê duyệt ẩn video khỏi danh sách thư viện.'
      );
      await loadDeletionRequests();
    } catch (err) {
      setDeletionsError(
        err instanceof Error
          ? err.message
          : 'Không thể phê duyệt yêu cầu xóa video.'
      );
    } finally {
      setReviewingId(null);
    }
  };

  const handleQuickRejectDeletion = async (reqItem: DeletionRequestListItemDto) => {
    setReviewingId(reqItem.id);
    setDeletionsError(null);
    try {
      await rejectDeletionRequestApi(
        reqItem.id,
        'Giữ lại video bằng chứng theo quyết định của quản lý.'
      );
      await loadDeletionRequests();
    } catch (err) {
      setDeletionsError(
        err instanceof Error
          ? err.message
          : 'Không thể từ chối yêu cầu xóa video.'
      );
    } finally {
      setReviewingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
        <PageHeader
          title="Thư viện video"
          actions={
            canRecordOrImport ? (
              <Link
                to="/record"
                className="btn btn-primary inline-flex items-center gap-1.5"
              >
                <Camera className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Quay đơn mới</span>
              </Link>
            ) : undefined
          }
        />

        {canApproveDelete && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="segmented-tabs" role="tablist" aria-label="Phạm vi hiển thị">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'videos'}
                className={`segmented-tab cursor-pointer ${
                  activeTab === 'videos' ? 'active' : ''
                }`}
                onClick={() => {
                  setActiveTab('videos');
                  setPage(1);
                }}
              >
                Danh sách video
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'deletions'}
                className={`segmented-tab cursor-pointer ${
                  activeTab === 'deletions' ? 'active' : ''
                }`}
                onClick={() => setActiveTab('deletions')}
              >
                Duyệt yêu cầu xóa
              </button>
            </div>
          </div>
        )}
      </div>

      {activeTab === 'videos' && (
        <>
          {/* Search & Quick Filter Card */}
          <form
            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5"
            onSubmit={handleSearchSubmit}
          >
            <div>
              <label
                htmlFor="video-search-tracking"
                className="mb-1.5 block text-xs font-bold tracking-wide text-slate-700 uppercase"
              >
                Tìm theo mã vận đơn
              </label>
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400"
                    aria-hidden="true"
                  />
                  <input
                    id="video-search-tracking"
                    type="text"
                    className="form-input pl-10 font-mono text-base sm:text-sm"
                    value={trackingInput}
                    onChange={(e) => setTrackingInput(e.target.value)}
                    placeholder="Nhập mã vận đơn cần tra cứu..."
                    autoComplete="off"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    className="btn btn-primary inline-flex flex-1 items-center justify-center gap-1.5 sm:flex-initial"
                  >
                    <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Tìm kiếm</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline inline-flex items-center justify-center gap-1.5"
                    onClick={handleResetFilters}
                  >
                    <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>Xóa lọc</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 1-Tap Quick Filter Pills */}
            <div className="mt-3.5 flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:pb-0">
              <span className="shrink-0 text-xs font-semibold text-slate-500">
                Trạng thái:
              </span>
              <button
                type="button"
                className={`inline-flex min-h-10 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  captureStatus === ''
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                }`}
                onClick={() => {
                  setCaptureStatus('');
                  setPage(1);
                }}
              >
                Tất cả
              </button>
              <button
                type="button"
                className={`inline-flex min-h-10 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  captureStatus === 'Captured'
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                }`}
                onClick={() => {
                  setCaptureStatus('Captured');
                  setPage(1);
                }}
              >
                Thành công
              </button>
              <button
                type="button"
                className={`inline-flex min-h-10 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  captureStatus === 'Interrupted'
                    ? 'border-red-600 bg-red-600 text-white'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                }`}
                onClick={() => {
                  setCaptureStatus('Interrupted');
                  setPage(1);
                }}
              >
                Thất bại
              </button>
            </div>
          </form>

          {videosError && (
            <div
              className="flex items-start gap-2.5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              <span>{videosError}</span>
            </div>
          )}

          {/* Results Card */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
            {isLoadingVideos ? (
              <div
                className="flex items-center justify-center gap-2.5 py-8 text-sm font-medium text-slate-600"
                role="status"
              >
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" aria-hidden="true" />
                <span>Đang tải danh sách video bằng chứng...</span>
              </div>
            ) : !videosData || videosData.items.length === 0 ? (
              <EmptyState
                icon={<Film className="h-6 w-6" />}
                title="Không tìm thấy video phù hợp"
                description="Hãy kiểm tra lại mã vận đơn (bao gồm cả số 0 ở đầu) hoặc bấm Xóa lọc để xem toàn bộ danh sách."
                action={
                  <button
                    type="button"
                    className="btn btn-outline inline-flex items-center gap-1.5"
                    onClick={handleResetFilters}
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    <span>Xóa bộ lọc</span>
                  </button>
                }
              />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                  <span>
                    Tìm thấy <strong className="text-slate-900">{videosData.totalCount}</strong>{' '}
                    video • Trang <strong className="text-slate-900">{videosData.page}</strong> /{' '}
                    <strong className="text-slate-900">
                      {Math.max(1, videosData.totalPages)}
                    </strong>
                  </span>
                </div>

                {/* Desktop Table */}
                <div className="desktop-table-wrap">
                  <table className="data-table" data-testid="videos-desktop-table">
                    <thead>
                      <tr>
                        <th>Mã vận đơn</th>
                        <th>Shop / Kho</th>
                        <th>Nhân viên</th>
                        <th>Trạng thái</th>
                        <th>Thời lượng</th>
                        <th>Thời gian</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {videosData.items.map((item) => {
                        const failed = isVideoFailed(item);

                        return (
                          <tr key={item.id}>
                            <td>
                              <div className="mono-code text-slate-950">
                                {item.trackingNumber}
                              </div>
                            </td>
                            <td>
                              <div className="font-semibold text-slate-900">
                                {item.shopName}
                              </div>
                              <div className="text-xs text-slate-500">
                                {item.warehouseName}
                              </div>
                            </td>
                            <td>
                              <div className="font-medium text-slate-800">
                                {item.ownerFullName}
                              </div>
                            </td>
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
                            <td>
                              <div className="font-mono text-xs font-semibold text-slate-800">
                                {formatDurationSeconds(item.durationSeconds)}
                              </div>
                            </td>
                            <td>
                              <div className="text-xs text-slate-700">
                                {formatHoChiMinhDateTime(item.createdAtUtc)}
                              </div>
                            </td>
                            <td className="text-right">
                              <Link
                                to={`/videos/${item.id}`}
                                className="btn btn-navy px-3.5 py-2 text-xs"
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

                {/* Mobile Cards */}
                <div className="mobile-card-list mobile-card-list-hide-desktop">
                  {videosData.items.map((item) => {
                    const failed = isVideoFailed(item);

                    return (
                      <div key={item.id} className="mobile-data-card">
                        <div className="flex items-center justify-between gap-2.5">
                          <div className="mono-code text-base text-slate-950">
                            {item.trackingNumber}
                          </div>
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
                            {formatHoChiMinhDateTime(item.createdAtUtc)} •{' '}
                            <strong className="font-mono text-slate-700">
                              {formatDurationSeconds(item.durationSeconds)}
                            </strong>
                          </span>
                          <Link
                            to={`/videos/${item.id}`}
                            className="btn btn-navy shrink-0 px-3 py-1.5 text-xs"
                          >
                            Xem chi tiết
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {videosData.totalPages > 1 && (
                  <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3.5">
                    <button
                      type="button"
                      className="btn btn-outline inline-flex items-center gap-1 text-xs"
                      disabled={videosData.page <= 1 || isLoadingVideos}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                      <span>Trang trước</span>
                    </button>
                    <span className="text-xs font-semibold text-slate-700">
                      Trang {videosData.page} / {videosData.totalPages}
                    </span>
                    <button
                      type="button"
                      className="btn btn-outline inline-flex items-center gap-1 text-xs"
                      disabled={
                        videosData.page >= videosData.totalPages || isLoadingVideos
                      }
                      onClick={() => setPage((p) => p + 1)}
                    >
                      <span>Trang sau</span>
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* Deletion Requests Approval Tab */}
      {activeTab === 'deletions' && canApproveDelete && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="m-0 text-base font-bold text-slate-900">
                Danh sách yêu cầu xóa video ({deletionTotal})
              </h2>
              <p className="mt-0.5 mb-0 text-xs text-slate-600">
                Khi phê duyệt, video sẽ được ẩn khỏi danh sách tra cứu. Video đang bật{' '}
                <strong>Giữ bằng chứng (Hold)</strong> không thể xóa.
              </p>
            </div>

            <div className="min-w-44">
              <label
                htmlFor="deletion-status-filter"
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                Trạng thái yêu cầu
              </label>
              <select
                id="deletion-status-filter"
                className="form-input"
                value={deletionStatusFilter}
                onChange={(e) =>
                  setDeletionStatusFilter(
                    e.target.value as 'Pending' | 'Approved' | 'Rejected' | ''
                  )
                }
              >
                <option value="Pending">Đang chờ duyệt</option>
                <option value="Approved">Đã phê duyệt xóa</option>
                <option value="Rejected">Đã từ chối</option>
                <option value="">Tất cả</option>
              </select>
            </div>
          </div>

          {deletionsError && (
            <div
              className="mb-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              <span>{deletionsError}</span>
            </div>
          )}

          {isLoadingDeletions ? (
            <div
              className="flex items-center justify-center gap-2 py-8 text-sm text-slate-600"
              role="status"
            >
              <Loader2 className="h-5 w-5 animate-spin text-blue-600" aria-hidden="true" />
              <span>Đang tải danh sách yêu cầu xóa...</span>
            </div>
          ) : deletionItems.length === 0 ? (
            <EmptyState
              icon={<Film className="h-6 w-6" />}
              title="Không có yêu cầu xóa video nào"
              description="Hiện không có yêu cầu xóa nào ở trạng thái bạn đang chọn."
            />
          ) : (
            <div className="space-y-3">
              {deletionItems.map((req) => {
                const statusBadge = getDeletionStatusBadge(req.status);
                return (
                  <div
                    key={req.id}
                    className="rounded-xl border border-slate-200 bg-slate-50/50 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2.5">
                      <div>
                        <span className="mono-code text-base text-slate-950">
                          {req.trackingNumber}
                        </span>
                        <div className="mt-0.5 text-xs text-slate-600">
                          {req.shopName} • {req.warehouseName} • Người gửi:{' '}
                          <strong>{req.requestedByFullName}</strong> (
                          {req.requestedByEmail})
                        </div>
                      </div>

                      <div className="badge-cluster">
                        <span className={statusBadge.className}>
                          {statusBadge.label}
                        </span>
                        {req.recordingHold && (
                          <span className="status-pill status-pill-hold">
                            Đang giữ (Hold)
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mt-2.5 text-sm text-slate-800">
                      <strong>Lý do yêu cầu xóa:</strong> {req.reason}
                    </div>

                    <div className="mt-1 text-xs text-slate-500">
                      Gửi lúc: {formatHoChiMinhDateTime(req.createdAtUtc)}
                      {req.reviewedAtUtc
                        ? ` • Xử lý lúc: ${formatHoChiMinhDateTime(req.reviewedAtUtc)} bởi ${req.reviewedByFullName ?? req.reviewedByEmail ?? ''}`
                        : ''}
                    </div>

                    {req.recordingHold && req.status === 'Pending' && (
                      <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                        <AlertTriangle
                          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
                          aria-hidden="true"
                        />
                        <span>
                          Video này đang bật <strong>Giữ bằng chứng (Hold)</strong>
                          {req.recordingHoldReason
                            ? ` (${req.recordingHoldReason})`
                            : ''}
                          . Không thể phê duyệt xóa khi video đang được giữ.
                        </span>
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {!req.recordingIsSoftDeleted && (
                        <Link
                          to={`/videos/${req.recordingId}`}
                          className="btn btn-outline text-xs"
                        >
                          Mở chi tiết video
                        </Link>
                      )}
                      {req.status === 'Pending' && (
                        <>
                          <button
                            type="button"
                            className="btn btn-danger text-xs"
                            disabled={req.recordingHold || reviewingId === req.id}
                            onClick={() => void handleQuickApproveDeletion(req)}
                          >
                            Phê duyệt xóa
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline text-xs"
                            disabled={reviewingId === req.id}
                            onClick={() => void handleQuickRejectDeletion(req)}
                          >
                            Từ chối yêu cầu
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
