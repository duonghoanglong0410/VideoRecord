import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  formatByteSize,
  formatHoChiMinhDateTime
} from '../../app/formatters';
import {
  createAdminShopApi,
  createAdminWarehouseApi,
  getAdminStorageOverviewApi,
  runAdminStorageHealthCheckApi,
  updateAdminStorageSettingsApi,
  type AdminStorageOverviewDto,
  type StorageHealthCheckResponseDto
} from './adminApi';

export function StorageAdminPage() {
  const [overview, setOverview] = useState<AdminStorageOverviewDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Health check state
  const [healthReport, setHealthReport] =
    useState<StorageHealthCheckResponseDto | null>(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState<boolean>(false);

  // Editable settings form state
  const [maxRecordingSeconds, setMaxRecordingSeconds] = useState<number>(600);
  const [maxUploadMiB, setMaxUploadMiB] = useState<number>(512);
  const [maxLocalPending, setMaxLocalPending] = useState<number>(3);
  const [enableAudio, setEnableAudio] = useState<boolean>(false);
  const [retentionEnabled, setRetentionEnabled] = useState<boolean>(false);
  const [retentionDays, setRetentionDays] = useState<number>(90);
  const [shopSubdirs, setShopSubdirs] = useState<Record<string, string>>({});
  const [isSavingSettings, setIsSavingSettings] = useState<boolean>(false);

  // Explicit Retention Confirmation Modal state
  const [isRetentionConfirmModalOpen, setIsRetentionConfirmModalOpen] =
    useState<boolean>(false);

  // Create Shop Modal state
  const [isCreateShopOpen, setIsCreateShopOpen] = useState<boolean>(false);
  const [newShopCode, setNewShopCode] = useState<string>('');
  const [newShopName, setNewShopName] = useState<string>('');
  const [newShopSubdir, setNewShopSubdir] = useState<string>('');
  const [isCreatingShop, setIsCreatingShop] = useState<boolean>(false);
  const [shopModalError, setShopModalError] = useState<string | null>(null);

  // Create Warehouse Modal state
  const [warehouseTargetShopId, setWarehouseTargetShopId] = useState<string | null>(
    null
  );
  const [newWhCode, setNewWhCode] = useState<string>('');
  const [newWhName, setNewWhName] = useState<string>('');
  const [isCreatingWh, setIsCreatingWh] = useState<boolean>(false);
  const [whModalError, setWhModalError] = useState<string | null>(null);

  const syncFormFromOverview = (dto: AdminStorageOverviewDto) => {
    setOverview(dto);
    setMaxRecordingSeconds(dto.maxRecordingSeconds);
    setMaxUploadMiB(Math.max(1, Math.round(dto.maxUploadBytes / (1024 * 1024))));
    setMaxLocalPending(dto.maxLocalPendingRecordings);
    setEnableAudio(dto.enableAudioRecording);
    setRetentionEnabled(dto.retentionEnabled);
    setRetentionDays(dto.retentionDays);

    const subdirMap: Record<string, string> = {};
    for (const s of dto.shops) {
      subdirMap[s.id] = s.allowedStorageSubdir;
    }
    setShopSubdirs(subdirMap);
  };

  const loadOverview = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const dto = await getAdminStorageOverviewApi();
      syncFormFromOverview(dto);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể tải cấu hình lưu trữ hệ thống.'
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleRunHealthCheck = async () => {
    setIsCheckingHealth(true);
    setErrorMsg(null);
    try {
      const report = await runAdminStorageHealthCheckApi();
      setHealthReport(report);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể thực hiện kiểm tra kết nối lưu trữ.'
      );
    } finally {
      setIsCheckingHealth(false);
    }
  };

  const performSaveSettings = async (confirmRetentionEnable: boolean) => {
    if (!overview) {
      return;
    }

    setIsSavingSettings(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const updated = await updateAdminStorageSettingsApi({
        maxRecordingSeconds,
        maxUploadBytes: Math.round(maxUploadMiB * 1024 * 1024),
        maxLocalPendingRecordings: maxLocalPending,
        enableAudioRecording: enableAudio,
        retentionEnabled,
        retentionDays,
        confirmRetentionEnable,
        shopSubdirectories: overview.shops.map((s) => ({
          shopId: s.id,
          allowedStorageSubdir: shopSubdirs[s.id] ?? s.allowedStorageSubdir
        }))
      });

      syncFormFromOverview(updated);
      setIsRetentionConfirmModalOpen(false);
      setSuccessMsg(
        'Đã lưu cấu hình lưu trữ, giới hạn vận hành và danh sách thư mục Shop thành công.'
      );
    } catch (err) {
      setIsRetentionConfirmModalOpen(false);
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể lưu cập nhật cấu hình lưu trữ.'
      );
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleSettingsFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!overview) {
      return;
    }

    const requiresExplicitConfirmation =
      retentionEnabled &&
      (!overview.retentionEnabled || retentionDays < overview.retentionDays);

    if (requiresExplicitConfirmation) {
      setIsRetentionConfirmModalOpen(true);
      return;
    }

    void performSaveSettings(false);
  };

  const handleCreateShopSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setShopModalError(null);
    setIsCreatingShop(true);
    try {
      await createAdminShopApi({
        code: newShopCode.trim(),
        name: newShopName.trim(),
        allowedStorageSubdir: newShopSubdir.trim() || null
      });
      setIsCreateShopOpen(false);
      setNewShopCode('');
      setNewShopName('');
      setNewShopSubdir('');
      setSuccessMsg('Đã tạo Shop mới và đăng ký thư mục con lưu trữ an toàn.');
      await loadOverview();
    } catch (err) {
      setShopModalError(
        err instanceof Error ? err.message : 'Không thể tạo Shop mới.'
      );
    } finally {
      setIsCreatingShop(false);
    }
  };

  const handleCreateWarehouseSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!warehouseTargetShopId) {
      return;
    }
    setWhModalError(null);
    setIsCreatingWh(true);
    try {
      await createAdminWarehouseApi(warehouseTargetShopId, {
        code: newWhCode.trim(),
        name: newWhName.trim(),
        createDefaultStation: true
      });
      setWarehouseTargetShopId(null);
      setNewWhCode('');
      setNewWhName('');
      setSuccessMsg('Đã thêm Kho đóng gói mới thành công.');
      await loadOverview();
    } catch (err) {
      setWhModalError(
        err instanceof Error ? err.message : 'Không thể tạo Kho đóng gói mới.'
      );
    } finally {
      setIsCreatingWh(false);
    }
  };

  if (isLoading) {
    return (
      <div className="surface-card" role="status">
        Đang tải thông tin cấu hình lưu trữ...
      </div>
    );
  }

  const stagingPercent =
    overview && overview.stagingUsage.maxStagingBytes > 0
      ? Math.min(
          100,
          Math.round(
            (overview.stagingUsage.totalFootprintBytes /
              overview.stagingUsage.maxStagingBytes) *
              100
          )
        )
      : 0;

  return (
    <div>
      {/* Header & Storage Mode Status */}
      <div className="surface-card">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">
              Cấu hình lưu trữ Synology NAS, Shop &amp; Thời hạn giữ video
            </h1>
            <p className="page-subtitle">
              Kiểm tra định danh ổ lưu trữ (<code>.packingproof-storage-id</code>), giám
              sát vùng đệm tải lên (staging), phân tách thư mục từng Shop và cấu hình giới
              hạn vận hành.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleRunHealthCheck()}
            disabled={isCheckingHealth}
          >
            {isCheckingHealth
              ? 'Đang kiểm tra đọc/ghi...'
              : 'Kiểm tra kết nối lưu trữ'}
          </button>
        </div>

        {overview && (
          <div className="filter-grid" style={{ marginTop: 16 }}>
            <div className="kv-item">
              <div className="kv-term">Chế độ lưu trữ đang chạy</div>
              <div className="kv-desc">
                {overview.storageMode === 'SynologyMounted' ? (
                  <span className="status-pill status-pill-completed">
                    Synology NAS (Chính thức)
                  </span>
                ) : (
                  <span className="status-pill status-pill-starting">
                    Lưu cục bộ (LocalDevelopment)
                  </span>
                )}
              </div>
            </div>

            <div className="kv-item">
              <div className="kv-term">Tệp định danh chống ghi nhầm ổ</div>
              <div className="kv-desc">
                <code>{overview.markerFileName}</code>{' '}
                {overview.expectedStorageIdConfigured
                  ? '(Đã cấu hình STORAGE_ID)'
                  : '(Tự kiểm tra)'}
              </div>
            </div>

            <div className="kv-item">
              <div className="kv-term">Kích thước mỗi mảnh tải lên (tus)</div>
              <div className="kv-desc">
                {formatByteSize(overview.uploadChunkBytes)}
              </div>
            </div>

            <div className="kv-item">
              <div className="kv-term">Cập nhật cấu hình lần cuối</div>
              <div className="kv-desc">
                {formatHoChiMinhDateTime(overview.updatedAtUtc)}
              </div>
            </div>
          </div>
        )}

        {/* Live Staging Usage Bar */}
        {overview && (
          <div className="queue-progress-block" style={{ marginTop: 16 }}>
            <div className="queue-progress-labels">
              <strong>Dung lượng vùng đệm tải lên trên máy chủ (Staging)</strong>
              <span>
                Đang chiếm chỗ:{' '}
                <strong>
                  {formatByteSize(overview.stagingUsage.totalFootprintBytes)}
                </strong>{' '}
                / {formatByteSize(overview.stagingUsage.maxStagingBytes)} (
                {stagingPercent}%)
              </span>
            </div>
            <div className="queue-progress-track">
              <div
                className={`queue-progress-fill${
                  stagingPercent >= 85 ? ' queue-progress-fill-failed' : ''
                }`}
                style={{ width: `${stagingPercent}%` }}
              />
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: '0.82rem',
                color: 'var(--color-text-muted)'
              }}
            >
              Trên đĩa: {formatByteSize(overview.stagingUsage.diskUsedBytes)} • Đang giữ
              chỗ phiên tải dở:{' '}
              {formatByteSize(overview.stagingUsage.reservedRemainingBytes)} • Còn trống:{' '}
              {formatByteSize(overview.stagingUsage.availableBytes)}
            </div>
          </div>
        )}
      </div>

      {/* Health Check Result Card */}
      {healthReport && (
        <div
          className={`alert ${
            healthReport.isHealthy ? 'alert-success' : 'alert-error'
          }`}
          role="status"
          data-testid="storage-health-report"
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Kết quả kiểm tra lúc {formatHoChiMinhDateTime(healthReport.checkedAtUtc)}:{' '}
            {healthReport.statusMessage}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
              fontSize: '0.86rem'
            }}
          >
            <span>
              Thư mục gốc tồn tại:{' '}
              <strong>{healthReport.rootExists ? 'Đạt' : 'Không tìm thấy'}</strong>
            </span>
            <span>
              Tệp định danh STORAGE_ID:{' '}
              <strong>{healthReport.markerValid ? 'Hợp lệ' : 'Lỗi / Không khớp'}</strong>
            </span>
            <span>
              Đọc / Ghi thử nghiệm:{' '}
              <strong>{healthReport.canReadWrite ? 'Thành công' : 'Thất bại'}</strong>
            </span>
            {healthReport.availableFreeBytes != null && (
              <span>
                Dung lượng trống:{' '}
                <strong>{formatByteSize(healthReport.availableFreeBytes)}</strong>
                {healthReport.totalCapacityBytes != null
                  ? ` / ${formatByteSize(healthReport.totalCapacityBytes)}`
                  : ''}
              </span>
            )}
          </div>
          {healthReport.isLowSpaceWarning && healthReport.capacityWarningMessage && (
            <div style={{ marginTop: 8, fontWeight: 700 }}>
              {healthReport.capacityWarningMessage}
            </div>
          )}
        </div>
      )}

      {successMsg && (
        <div className="alert alert-success" role="status">
          {successMsg}
        </div>
      )}

      {errorMsg && (
        <div className="alert alert-error" role="alert">
          {errorMsg}
        </div>
      )}

      {overview && (
        <form onSubmit={handleSettingsFormSubmit}>
          {/* Limits & Retention Card */}
          <div className="surface-card">
            <h2 style={{ marginTop: 0, fontSize: '1.08rem' }}>
              Giới hạn phiên quay, dung lượng tải lên &amp; Thời hạn lưu giữ (Retention)
            </h2>

            <div className="filter-grid">
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="storage-max-seconds" className="form-label">
                  Thời lượng quay tối đa (giây)
                </label>
                <input
                  id="storage-max-seconds"
                  type="number"
                  min={10}
                  max={7200}
                  className="form-input"
                  value={maxRecordingSeconds}
                  onChange={(e) =>
                    setMaxRecordingSeconds(Number(e.target.value) || 600)
                  }
                  required
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="storage-max-upload-mib" className="form-label">
                  Dung lượng tệp tối đa (MiB)
                </label>
                <input
                  id="storage-max-upload-mib"
                  type="number"
                  min={1}
                  max={10240}
                  className="form-input"
                  value={maxUploadMiB}
                  onChange={(e) => setMaxUploadMiB(Number(e.target.value) || 512)}
                  required
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="storage-max-pending" className="form-label">
                  Số video chờ tối đa trên thiết bị
                </label>
                <input
                  id="storage-max-pending"
                  type="number"
                  min={1}
                  max={20}
                  className="form-input"
                  value={maxLocalPending}
                  onChange={(e) => setMaxLocalPending(Number(e.target.value) || 3)}
                  required
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="storage-retention-days" className="form-label">
                  Số ngày lưu giữ tự động (RetentionDays)
                </label>
                <input
                  id="storage-retention-days"
                  type="number"
                  min={1}
                  max={3650}
                  className="form-input"
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(Number(e.target.value) || 90)}
                  required
                />
              </div>
            </div>

            <div
              style={{
                marginTop: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 10
              }}
            >
              <label className="audio-optin-row">
                <input
                  type="checkbox"
                  checked={enableAudio}
                  onChange={(e) => setEnableAudio(e.target.checked)}
                />
                <span>
                  Cho phép nhân viên tùy chọn thu kèm âm thanh microphone khi quay đóng gói
                  (mặc định tắt để giảm kích thước tệp &amp; bảo vệ quyền riêng tư kho)
                </span>
              </label>

              <label className="audio-optin-row">
                <input
                  type="checkbox"
                  checked={retentionEnabled}
                  onChange={(e) => setRetentionEnabled(e.target.checked)}
                />
                <span>
                  <strong>Bật tự động dọn dẹp theo thời hạn lưu giữ (Retention)</strong> —
                  Mặc định TẮT. Khi bật, hệ thống chỉ xóa video quá hạn{' '}
                  <strong>không bật Hold</strong>; mọi video đang đánh dấu{' '}
                  <strong>Giữ bằng chứng (Hold)</strong> luôn được giữ lại an toàn.
                </span>
              </label>
            </div>
          </div>

          {/* Shops, Warehouses & Allowed Subdirectories Card */}
          <div className="surface-card">
            <div className="page-header-row" style={{ marginBottom: 14 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.08rem' }}>
                  Cấu trúc Shop, Kho &amp; Thư mục con lưu trữ an toàn
                </h2>
                <p className="page-subtitle">
                  Mỗi Shop sử dụng một tên thư mục con đơn cấp an toàn bên trong kho lưu
                  trữ (không cho phép ký tự đường dẫn <code>/</code>, <code>\</code> hay{' '}
                  <code>..</code>).
                </p>
              </div>

              <button
                type="button"
                className="btn btn-outline"
                onClick={() => {
                  setShopModalError(null);
                  setIsCreateShopOpen(true);
                }}
              >
                + Thêm Shop mới
              </button>
            </div>

            <div className="mobile-card-list">
              {overview.shops.map((shop) => (
                <div key={shop.id} className="mobile-data-card">
                  <div className="page-header-row">
                    <div>
                      <strong style={{ fontSize: '1.02rem' }}>{shop.name}</strong>{' '}
                      <span className="meta-chip mono-code">{shop.code}</span>
                    </div>

                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ padding: '6px 12px' }}
                      onClick={() => {
                        setWhModalError(null);
                        setWarehouseTargetShopId(shop.id);
                      }}
                    >
                      + Thêm Kho đóng gói
                    </button>
                  </div>

                  <div className="shop-warehouse-grid">
                    <div>
                      <label
                        htmlFor={`shop-subdir-${shop.id}`}
                        className="form-label"
                      >
                        Thư mục con lưu trữ (AllowedStorageSubdir)
                      </label>
                      <input
                        id={`shop-subdir-${shop.id}`}
                        type="text"
                        className="form-input mono-code"
                        maxLength={64}
                        value={shopSubdirs[shop.id] ?? shop.allowedStorageSubdir}
                        onChange={(e) =>
                          setShopSubdirs((prev) => ({
                            ...prev,
                            [shop.id]: e.target.value
                          }))
                        }
                        required
                      />
                    </div>

                    <div>
                      <div className="form-label">
                        Danh sách Kho trực thuộc ({shop.warehouses.length})
                      </div>
                      {shop.warehouses.length === 0 ? (
                        <div
                          style={{
                            fontSize: '0.85rem',
                            color: 'var(--color-text-muted)'
                          }}
                        >
                          Chưa có kho nào trong Shop này.
                        </div>
                      ) : (
                        <div className="badge-cluster">
                          {shop.warehouses.map((wh) => (
                            <span
                              key={wh.id}
                              className="status-pill status-pill-ready"
                            >
                              {wh.name} ({wh.code})
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 18 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSavingSettings}
              >
                {isSavingSettings ? 'Đang lưu cấu hình...' : 'Lưu cấu hình lưu trữ'}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Explicit Confirmation Modal when enabling Retention */}
      {isRetentionConfirmModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card modal-card-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="retention-confirm-title"
          >
            <h2
              id="retention-confirm-title"
              style={{ marginTop: 0, fontSize: '1.16rem' }}
            >
              Xác nhận bật tự động xóa theo thời hạn lưu giữ
            </h2>
            <div className="alert alert-warning">
              <strong>Cảnh báo quan trọng:</strong> Khi bật chế độ tự động lưu giữ với thời
              hạn <strong>{retentionDays} ngày</strong>, dịch vụ nền sẽ định kỳ xóa tệp
              vật lý và ẩn mềm các video đã lưu quá <strong>{retentionDays} ngày</strong>{' '}
              mà <strong>KHÔNG</strong> bật chế độ Giữ bằng chứng (Hold).
            </div>
            <p style={{ fontSize: '0.88rem', color: 'var(--color-text-muted)' }}>
              Các video đang bật <strong>Giữ bằng chứng (Hold)</strong> phục vụ khiếu nại
              sẽ luôn được bỏ qua an toàn và ghi nhận sự kiện{' '}
              <code>retention.skipped_hold</code> vào nhật ký kiểm toán.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setIsRetentionConfirmModalOpen(false)}
                disabled={isSavingSettings}
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void performSaveSettings(true)}
                disabled={isSavingSettings}
              >
                {isSavingSettings
                  ? 'Đang xác nhận...'
                  : 'Tôi hiểu & Xác nhận bật Retention'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Shop Modal */}
      {isCreateShopOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-shop-modal-title"
          >
            <h2
              id="create-shop-modal-title"
              style={{ marginTop: 0, fontSize: '1.15rem' }}
            >
              Thêm Shop TikTok mới
            </h2>
            <form onSubmit={(e) => void handleCreateShopSubmit(e)}>
              <div className="form-group">
                <label htmlFor="new-shop-code" className="form-label">
                  Mã Shop (chữ không dấu, số, - hoặc _)
                </label>
                <input
                  id="new-shop-code"
                  type="text"
                  className="form-input mono-code"
                  maxLength={32}
                  value={newShopCode}
                  onChange={(e) => setNewShopCode(e.target.value)}
                  placeholder="Ví dụ: ShopC"
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="new-shop-name" className="form-label">
                  Tên hiển thị Shop
                </label>
                <input
                  id="new-shop-name"
                  type="text"
                  className="form-input"
                  maxLength={128}
                  value={newShopName}
                  onChange={(e) => setNewShopName(e.target.value)}
                  placeholder="Ví dụ: TikTok Shop Thời Trang C"
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="new-shop-subdir" className="form-label">
                  Tên thư mục con lưu trữ (để trống sẽ tự lấy theo mã Shop)
                </label>
                <input
                  id="new-shop-subdir"
                  type="text"
                  className="form-input mono-code"
                  maxLength={64}
                  value={newShopSubdir}
                  onChange={(e) => setNewShopSubdir(e.target.value)}
                  placeholder="Ví dụ: shop-c"
                />
              </div>

              {shopModalError && (
                <div className="alert alert-error" role="alert">
                  {shopModalError}
                </div>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setIsCreateShopOpen(false)}
                  disabled={isCreatingShop}
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isCreatingShop}
                >
                  {isCreatingShop ? 'Đang tạo...' : 'Tạo Shop'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Warehouse Modal */}
      {warehouseTargetShopId && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-wh-modal-title"
          >
            <h2
              id="create-wh-modal-title"
              style={{ marginTop: 0, fontSize: '1.15rem' }}
            >
              Thêm Kho đóng gói mới
            </h2>
            <form onSubmit={(e) => void handleCreateWarehouseSubmit(e)}>
              <div className="form-group">
                <label htmlFor="new-wh-code" className="form-label">
                  Mã Kho (chữ không dấu, số, - hoặc _)
                </label>
                <input
                  id="new-wh-code"
                  type="text"
                  className="form-input mono-code"
                  maxLength={32}
                  value={newWhCode}
                  onChange={(e) => setNewWhCode(e.target.value)}
                  placeholder="Ví dụ: WH-HN-02"
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="new-wh-name" className="form-label">
                  Tên Kho đóng gói
                </label>
                <input
                  id="new-wh-name"
                  type="text"
                  className="form-input"
                  maxLength={128}
                  value={newWhName}
                  onChange={(e) => setNewWhName(e.target.value)}
                  placeholder="Ví dụ: Kho Hà Nội 02"
                  required
                />
              </div>

              {whModalError && (
                <div className="alert alert-error" role="alert">
                  {whModalError}
                </div>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setWarehouseTargetShopId(null)}
                  disabled={isCreatingWh}
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isCreatingWh}
                >
                  {isCreatingWh ? 'Đang thêm...' : 'Thêm Kho'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
