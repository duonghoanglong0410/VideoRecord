import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../app/authStore';
import {
  formatByteSize,
  formatDurationSeconds,
  formatHoChiMinhDateTime,
  getCaptureStatusBadge,
  getDeletionStatusBadge,
  getSourceBadge,
  getStorageStatusBadge,
  type CaptureStatusType,
  type RecordingSourceType,
  type StorageStatusType
} from '../../app/formatters';
import { Permissions } from '../../app/types';
import {
  fetchAccessibleShops,
  type ShopOption,
  type WarehouseOption
} from '../recording/recordingApi';
import {
  approveDeletionRequestApi,
  listDeletionRequestsApi,
  listVideosApi,
  rejectDeletionRequestApi,
  type DeletionRequestListItemDto,
  type PagedVideosResponse
} from './videosApi';

type ActiveListTab = 'videos' | 'deletions';

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

  const [activeTab, setActiveTab] = useState<ActiveListTab>(initialTab);

  // Scope toggle: "Phạm vi được cấp" (false) vs "Video của tôi" (true)
  const [mineOnly, setMineOnly] = useState<boolean>(
    searchParams.get('mineOnly') === 'true'
  );
  const [trackingInput, setTrackingInput] = useState<string>(
    searchParams.get('trackingNumber') ?? ''
  );
  const [exactMatch, setExactMatch] = useState<boolean>(
    searchParams.get('exact') === 'true'
  );
  const [selectedShopId, setSelectedShopId] = useState<string>(
    searchParams.get('shopId') ?? ''
  );
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>(
    searchParams.get('warehouseId') ?? ''
  );
  const [captureStatus, setCaptureStatus] = useState<CaptureStatusType | ''>('');
  const [storageStatus, setStorageStatus] = useState<StorageStatusType | ''>('');
  const [holdFilter, setHoldFilter] = useState<'all' | 'hold' | 'no_hold'>('all');
  const [sourceFilter, setSourceFilter] = useState<RecordingSourceType | ''>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const pageSize = 20;

  // Committed query trigger so typing in tracking box waits for form submit / filter button
  const [appliedTracking, setAppliedTracking] = useState<string>(
    searchParams.get('trackingNumber') ?? ''
  );
  const [appliedExact, setAppliedExact] = useState<boolean>(
    searchParams.get('exact') === 'true'
  );

  const [shops, setShops] = useState<ShopOption[]>([]);
  const [videosData, setVideosData] = useState<PagedVideosResponse | null>(null);
  const [isLoadingVideos, setIsLoadingVideos] = useState<boolean>(true);
  const [videosError, setVideosError] = useState<string | null>(null);

  // Deletion requests queue state (when user has video.delete.approve)
  const [deletionItems, setDeletionItems] = useState<DeletionRequestListItemDto[]>([]);
  const [deletionTotal, setDeletionTotal] = useState<number>(0);
  const [deletionStatusFilter, setDeletionStatusFilter] = useState<
    'Pending' | 'Approved' | 'Rejected' | ''
  >('Pending');
  const [isLoadingDeletions, setIsLoadingDeletions] = useState<boolean>(false);
  const [deletionsError, setDeletionsError] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetchAccessibleShops();
        if (active && Array.isArray(res?.shops)) {
          setShops(res.shops);
        }
      } catch {
        // Non-blocking: Shop filter stays optional if user only has Own scope
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const availableWarehouses: WarehouseOption[] = useMemo(() => {
    const found = shops.find((s) => s.id === selectedShopId);
    return found?.warehouses ?? [];
  }, [selectedShopId, shops]);

  const loadVideos = useCallback(async () => {
    setIsLoadingVideos(true);
    setVideosError(null);
    try {
      const res = await listVideosApi({
        trackingNumber: appliedTracking,
        exact: appliedExact,
        shopId: selectedShopId || undefined,
        warehouseId: selectedWarehouseId || undefined,
        mineOnly,
        captureStatus,
        storageStatus,
        hold:
          holdFilter === 'hold' ? true : holdFilter === 'no_hold' ? false : null,
        source: sourceFilter,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
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
    appliedExact,
    appliedTracking,
    captureStatus,
    fromDate,
    holdFilter,
    mineOnly,
    page,
    selectedShopId,
    selectedWarehouseId,
    sourceFilter,
    storageStatus,
    toDate
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
        shopId: selectedShopId || undefined,
        warehouseId: selectedWarehouseId || undefined,
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
    deletionStatusFilter,
    selectedShopId,
    selectedWarehouseId
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
    setAppliedExact(exactMatch);
  };

  const handleResetFilters = () => {
    setTrackingInput('');
    setExactMatch(false);
    setAppliedTracking('');
    setAppliedExact(false);
    setSelectedShopId('');
    setSelectedWarehouseId('');
    setCaptureStatus('');
    setStorageStatus('');
    setHoldFilter('all');
    setSourceFilter('');
    setFromDate('');
    setToDate('');
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
        'Đã phê duyệt ẩn mềm (soft-delete) khỏi danh sách thư viện.'
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
        'Giữ lại video bằng chứng theo quyết định của quản trị viên.'
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
    <div>
      <div className="surface-card">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Thư viện video bằng chứng đóng gói</h1>
            <p className="page-subtitle">
              Tra cứu theo mã vận đơn (bảo toàn số <code>0</code> ở đầu), trạng thái ghi
              hình, nơi lưu trữ và thời gian theo múi giờ <code>Asia/Ho_Chi_Minh</code>.
            </p>
          </div>

          {canRecordOrImport && (
            <Link to="/record" className="btn btn-primary">
              Quay đơn mới
            </Link>
          )}
        </div>

        <div
          style={{
            marginTop: 14,
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap'
          }}
        >
          <div className="segmented-tabs" role="tablist" aria-label="Phạm vi hiển thị">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'videos' && !mineOnly}
              className={`segmented-tab${
                activeTab === 'videos' && !mineOnly ? ' active' : ''
              }`}
              onClick={() => {
                setActiveTab('videos');
                setMineOnly(false);
                setPage(1);
              }}
            >
              Phạm vi được cấp
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'videos' && mineOnly}
              className={`segmented-tab${
                activeTab === 'videos' && mineOnly ? ' active' : ''
              }`}
              onClick={() => {
                setActiveTab('videos');
                setMineOnly(true);
                setPage(1);
              }}
            >
              Video của tôi
            </button>
            {canApproveDelete && (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'deletions'}
                className={`segmented-tab${
                  activeTab === 'deletions' ? ' active' : ''
                }`}
                onClick={() => setActiveTab('deletions')}
              >
                Duyệt yêu cầu xóa
              </button>
            )}
          </div>
        </div>
      </div>

      {activeTab === 'videos' && (
        <>
          <form className="surface-card" onSubmit={handleSearchSubmit}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr',
                gap: 12,
                marginBottom: 14
              }}
            >
              <div>
                <label htmlFor="video-search-tracking" className="form-label">
                  Tìm theo mã vận đơn hoặc mã đơn TikTok (giữ nguyên số 0 ở đầu)
                </label>
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    flexWrap: 'wrap',
                    alignItems: 'center'
                  }}
                >
                  <input
                    id="video-search-tracking"
                    type="text"
                    className="form-input"
                    style={{ flex: '1 1 260px' }}
                    value={trackingInput}
                    onChange={(e) => setTrackingInput(e.target.value)}
                    placeholder="Ví dụ: 0012345678 hoặc SPXVN048192"
                    autoComplete="off"
                  />
                  <label className="checkbox-inline-row">
                    <input
                      type="checkbox"
                      checked={exactMatch}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setExactMatch(checked);
                        setAppliedExact(checked);
                        setPage(1);
                      }}
                    />
                    <span>Khớp chính xác mã vận đơn</span>
                  </label>
                  <button type="submit" className="btn btn-primary">
                    Tìm kiếm
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={handleResetFilters}
                  >
                    Xóa bộ lọc
                  </button>
                </div>
              </div>
            </div>

            <div className="filter-grid">
              <div>
                <label htmlFor="filter-shop" className="form-label">
                  Shop
                </label>
                <select
                  id="filter-shop"
                  className="form-input"
                  value={selectedShopId}
                  onChange={(e) => {
                    setSelectedShopId(e.target.value);
                    setSelectedWarehouseId('');
                    setPage(1);
                  }}
                >
                  <option value="">Tất cả Shop trong phạm vi</option>
                  {shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="filter-warehouse" className="form-label">
                  Kho đóng gói
                </label>
                <select
                  id="filter-warehouse"
                  className="form-input"
                  value={selectedWarehouseId}
                  disabled={!selectedShopId || availableWarehouses.length === 0}
                  onChange={(e) => {
                    setSelectedWarehouseId(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">Tất cả Kho</option>
                  {availableWarehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="filter-from-date" className="form-label">
                  Từ ngày (GMT+7)
                </label>
                <input
                  id="filter-from-date"
                  type="date"
                  className="form-input"
                  value={fromDate}
                  onChange={(e) => {
                    setFromDate(e.target.value);
                    setPage(1);
                  }}
                />
              </div>

              <div>
                <label htmlFor="filter-to-date" className="form-label">
                  Đến ngày (GMT+7)
                </label>
                <input
                  id="filter-to-date"
                  type="date"
                  className="form-input"
                  value={toDate}
                  onChange={(e) => {
                    setToDate(e.target.value);
                    setPage(1);
                  }}
                />
              </div>

              <div>
                <label htmlFor="filter-capture-status" className="form-label">
                  Trạng thái ghi hình
                </label>
                <select
                  id="filter-capture-status"
                  className="form-input"
                  value={captureStatus}
                  onChange={(e) => {
                    setCaptureStatus(e.target.value as CaptureStatusType | '');
                    setPage(1);
                  }}
                >
                  <option value="">Tất cả trạng thái quay</option>
                  <option value="Captured">Hoàn chỉnh</option>
                  <option value="Interrupted">Bị gián đoạn</option>
                  <option value="Recording">Đang quay</option>
                  <option value="Created">Mới tạo phiên</option>
                </select>
              </div>

              <div>
                <label htmlFor="filter-storage-status" className="form-label">
                  Trạng thái lưu trữ
                </label>
                <select
                  id="filter-storage-status"
                  className="form-input"
                  value={storageStatus}
                  onChange={(e) => {
                    setStorageStatus(e.target.value as StorageStatusType | '');
                    setPage(1);
                  }}
                >
                  <option value="">Tất cả trạng thái lưu trữ</option>
                  <option value="Stored">Đã lưu hoàn tất</option>
                  <option value="AwaitingUpload">Chờ tải lên</option>
                  <option value="Uploading">Đang tải lên</option>
                  <option value="Validating">Đang kiểm tra tệp</option>
                  <option value="WaitingForStorage">Chờ kết nối lưu trữ</option>
                  <option value="Failed">Lỗi lưu trữ</option>
                </select>
              </div>

              <div>
                <label htmlFor="filter-hold" className="form-label">
                  Chế độ giữ bằng chứng (Hold)
                </label>
                <select
                  id="filter-hold"
                  className="form-input"
                  value={holdFilter}
                  onChange={(e) => {
                    setHoldFilter(e.target.value as 'all' | 'hold' | 'no_hold');
                    setPage(1);
                  }}
                >
                  <option value="all">Tất cả</option>
                  <option value="hold">Đang giữ (Hold)</option>
                  <option value="no_hold">Không giữ</option>
                </select>
              </div>

              <div>
                <label htmlFor="filter-source" className="form-label">
                  Nguồn tạo video
                </label>
                <select
                  id="filter-source"
                  className="form-input"
                  value={sourceFilter}
                  onChange={(e) => {
                    setSourceFilter(e.target.value as RecordingSourceType | '');
                    setPage(1);
                  }}
                >
                  <option value="">Tất cả nguồn</option>
                  <option value="RecordedInBrowser">
                    Quay trực tiếp trên trình duyệt
                  </option>
                  <option value="Imported">Tải tệp có sẵn (Imported)</option>
                </select>
              </div>
            </div>
          </form>

          {videosError && (
            <div className="alert alert-error" role="alert">
              {videosError}
            </div>
          )}

          <div className="surface-card">
            {isLoadingVideos ? (
              <div role="status" style={{ color: 'var(--color-text-muted)' }}>
                Đang tải danh sách video bằng chứng...
              </div>
            ) : !videosData || videosData.items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 8px' }}>
                <p
                  style={{
                    margin: '0 0 8px',
                    fontWeight: 600,
                    color: 'var(--color-navy)'
                  }}
                >
                  Không tìm thấy video phù hợp với điều kiện lọc hiện tại.
                </p>
                <p
                  style={{
                    margin: 0,
                    fontSize: '0.88rem',
                    color: 'var(--color-text-muted)'
                  }}
                >
                  Kiểm tra lại mã vận đơn (bao gồm các chữ số 0 ở đầu) hoặc phạm vi ngày
                  lọc.
                </p>
              </div>
            ) : (
              <>
                <div
                  style={{
                    marginBottom: 12,
                    fontSize: '0.88rem',
                    color: 'var(--color-text-muted)'
                  }}
                >
                  Tìm thấy <strong>{videosData.totalCount}</strong> bản ghi video • Trang{' '}
                  <strong>{videosData.page}</strong> /{' '}
                  <strong>{Math.max(1, videosData.totalPages)}</strong>
                </div>

                {/* Desktop Table */}
                <div className="desktop-table-wrap">
                  <table className="data-table" data-testid="videos-desktop-table">
                    <thead>
                      <tr>
                        <th>Mã vận đơn</th>
                        <th>Shop / Kho</th>
                        <th>Nhân viên</th>
                        <th>Trạng thái &amp; Nguồn</th>
                        <th>Thời lượng / Dung lượng</th>
                        <th>Thời gian (GMT+7)</th>
                        <th>Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      {videosData.items.map((item) => {
                        const capBadge = getCaptureStatusBadge(item.captureStatus);
                        const stoBadge = getStorageStatusBadge(
                          item.storageStatus,
                          item.storageMode
                        );
                        const srcBadge = getSourceBadge(item.source);

                        return (
                          <tr key={item.id}>
                            <td>
                              <div className="mono-code">{item.trackingNumber}</div>
                              <div
                                style={{
                                  fontSize: '0.78rem',
                                  color: 'var(--color-text-muted)',
                                  marginTop: 2
                                }}
                              >
                                {item.carrierCode ? `ĐVVC: ${item.carrierCode}` : ''}
                                {item.carrierCode && item.tikTokOrderId ? ' • ' : ''}
                                {item.tikTokOrderId
                                  ? `Đơn TikTok: ${item.tikTokOrderId}`
                                  : ''}
                              </div>
                              {item.isManualCode && (
                                <span
                                  className="status-pill status-pill-muted"
                                  style={{ marginTop: 4, fontSize: '0.75rem' }}
                                >
                                  Nhập mã thủ công
                                </span>
                              )}
                            </td>
                            <td>
                              <strong>{item.shopName}</strong>
                              <div
                                style={{
                                  fontSize: '0.82rem',
                                  color: 'var(--color-text-muted)'
                                }}
                              >
                                {item.warehouseName}
                              </div>
                            </td>
                            <td>
                              <div>{item.ownerFullName}</div>
                              <div
                                style={{
                                  fontSize: '0.78rem',
                                  color: 'var(--color-text-muted)'
                                }}
                              >
                                {item.ownerEmail}
                              </div>
                            </td>
                            <td>
                              <div className="badge-cluster">
                                <span className={capBadge.className}>
                                  {capBadge.label}
                                </span>
                                <span className={stoBadge.className}>
                                  {stoBadge.label}
                                </span>
                                <span className={srcBadge.className}>
                                  {srcBadge.shortLabel}
                                </span>
                                {item.hold && (
                                  <span className="status-pill status-pill-hold">
                                    Đang giữ (Hold)
                                  </span>
                                )}
                                {item.hasPendingDeletionRequest && (
                                  <span className="status-pill status-pill-starting">
                                    Chờ duyệt xóa
                                  </span>
                                )}
                              </div>
                              {item.noteCount > 0 && (
                                <div
                                  style={{
                                    marginTop: 4,
                                    fontSize: '0.78rem',
                                    color: 'var(--color-text-muted)'
                                  }}
                                >
                                  {item.noteCount} ghi chú nội bộ
                                </div>
                              )}
                            </td>
                            <td>
                              <div>{formatDurationSeconds(item.durationSeconds)}</div>
                              <div
                                style={{
                                  fontSize: '0.8rem',
                                  color: 'var(--color-text-muted)'
                                }}
                              >
                                {formatByteSize(item.originalSizeBytes)}
                              </div>
                            </td>
                            <td>
                              <div>{formatHoChiMinhDateTime(item.createdAtUtc)}</div>
                              {item.storedAtUtc && (
                                <div
                                  style={{
                                    fontSize: '0.78rem',
                                    color: 'var(--color-text-muted)'
                                  }}
                                >
                                  Lưu lúc: {formatHoChiMinhDateTime(item.storedAtUtc)}
                                </div>
                              )}
                            </td>
                            <td>
                              <Link
                                to={`/videos/${item.id}`}
                                className="btn btn-navy"
                                style={{ padding: '8px 14px' }}
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
                    const capBadge = getCaptureStatusBadge(item.captureStatus);
                    const stoBadge = getStorageStatusBadge(
                      item.storageStatus,
                      item.storageMode
                    );
                    const srcBadge = getSourceBadge(item.source);

                    return (
                      <div key={item.id} className="mobile-data-card">
                        <div className="page-header-row">
                          <div>
                            <div
                              className="mono-code"
                              style={{ fontSize: '1.08rem', color: 'var(--color-navy)' }}
                            >
                              {item.trackingNumber}
                            </div>
                            <div
                              style={{
                                fontSize: '0.82rem',
                                color: 'var(--color-text-muted)'
                              }}
                            >
                              {item.shopName} • {item.warehouseName}
                            </div>
                          </div>
                          <Link to={`/videos/${item.id}`} className="btn btn-navy">
                            Xem chi tiết
                          </Link>
                        </div>

                        <div className="badge-cluster">
                          <span className={capBadge.className}>{capBadge.label}</span>
                          <span className={stoBadge.className}>{stoBadge.label}</span>
                          <span className={srcBadge.className}>
                            {srcBadge.shortLabel}
                          </span>
                          {item.hold && (
                            <span className="status-pill status-pill-hold">
                              Đang giữ (Hold)
                            </span>
                          )}
                        </div>

                        <div
                          style={{
                            fontSize: '0.84rem',
                            color: 'var(--color-text-muted)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: 8,
                            flexWrap: 'wrap'
                          }}
                        >
                          <span>NV: {item.ownerFullName}</span>
                          <span>
                            {formatDurationSeconds(item.durationSeconds)} •{' '}
                            {formatByteSize(item.originalSizeBytes)}
                          </span>
                          <span>{formatHoChiMinhDateTime(item.createdAtUtc)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {videosData.totalPages > 1 && (
                  <div className="pagination-bar">
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={videosData.page <= 1 || isLoadingVideos}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      Trang trước
                    </button>
                    <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                      Trang {videosData.page} / {videosData.totalPages}
                    </span>
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={
                        videosData.page >= videosData.totalPages || isLoadingVideos
                      }
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Trang sau
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {activeTab === 'deletions' && canApproveDelete && (
        <div className="surface-card">
          <div className="page-header-row" style={{ marginBottom: 14 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.1rem' }}>
                Danh sách yêu cầu xóa video ({deletionTotal})
              </h2>
              <p className="page-subtitle">
                Khi phê duyệt, video sẽ được ẩn mềm (soft-delete) khỏi danh sách tra cứu
                thông thường và ghi nhận vào nhật ký kiểm toán. Video đang ở trạng thái{' '}
                <strong>Hold</strong> sẽ bị chặn phê duyệt xóa.
              </p>
            </div>

            <div>
              <label htmlFor="deletion-status-filter" className="form-label">
                Lọc trạng thái
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
            <div className="alert alert-error" role="alert">
              {deletionsError}
            </div>
          )}

          {isLoadingDeletions ? (
            <div role="status" style={{ color: 'var(--color-text-muted)' }}>
              Đang tải danh sách yêu cầu xóa...
            </div>
          ) : deletionItems.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
              Không có yêu cầu xóa video nào ở trạng thái đã chọn.
            </p>
          ) : (
            <div className="mobile-card-list">
              {deletionItems.map((req) => {
                const statusBadge = getDeletionStatusBadge(req.status);
                return (
                  <div key={req.id} className="mobile-data-card">
                    <div className="page-header-row">
                      <div>
                        <span className="mono-code" style={{ fontSize: '1.05rem' }}>
                          {req.trackingNumber}
                        </span>
                        <div
                          style={{
                            fontSize: '0.84rem',
                            color: 'var(--color-text-muted)'
                          }}
                        >
                          {req.shopName} • {req.warehouseName} • Người yêu cầu:{' '}
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

                    <div style={{ fontSize: '0.9rem' }}>
                      <strong>Lý do yêu cầu xóa:</strong> {req.reason}
                    </div>

                    <div
                      style={{
                        fontSize: '0.82rem',
                        color: 'var(--color-text-muted)'
                      }}
                    >
                      Gửi lúc: {formatHoChiMinhDateTime(req.createdAtUtc)}
                      {req.reviewedAtUtc
                        ? ` • Duyệt lúc: ${formatHoChiMinhDateTime(req.reviewedAtUtc)} bởi ${req.reviewedByFullName ?? req.reviewedByEmail ?? ''}`
                        : ''}
                    </div>

                    {req.recordingHold && req.status === 'Pending' && (
                      <div className="alert alert-warning" style={{ marginBottom: 0 }}>
                        Video này đang bật <strong>Giữ bằng chứng (Hold)</strong>
                        {req.recordingHoldReason
                          ? ` (${req.recordingHoldReason})`
                          : ''}
                        . Không thể phê duyệt xóa khi video đang được giữ.
                      </div>
                    )}

                    <div className="quick-actions-row" style={{ marginTop: 4 }}>
                      {!req.recordingIsSoftDeleted && (
                        <Link
                          to={`/videos/${req.recordingId}`}
                          className="btn btn-outline"
                        >
                          Mở chi tiết video
                        </Link>
                      )}
                      {req.status === 'Pending' && (
                        <>
                          <button
                            type="button"
                            className="btn btn-danger"
                            disabled={req.recordingHold || reviewingId === req.id}
                            onClick={() => void handleQuickApproveDeletion(req)}
                          >
                            Phê duyệt xóa mềm
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline"
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
