import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  ChevronDown,
  Database,
  FolderCog,
  HardDrive,
  Loader2,
  Mic,
  Save,
  ShieldCheck,
  Sliders,
  Store,
  Trash2,
  X,
  XCircle
} from 'lucide-react';
import {
  formatByteSize,
  formatHoChiMinhDateTime
} from '../../app/formatters';
import { PageHeader } from '../../components/ui/PageHeader';
import {
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
          allowedStorageSubdir:
            (shopSubdirs[s.id] ?? '').trim() || s.allowedStorageSubdir
        }))
      });

      syncFormFromOverview(updated);
      setIsRetentionConfirmModalOpen(false);
      setSuccessMsg(
        'Đã lưu cấu hình giới hạn quay, thời hạn lưu giữ và thư mục lưu trữ thành công.'
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

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center gap-2.5 rounded-2xl border border-slate-200 bg-white p-10 text-sm font-medium text-slate-600 shadow-xs"
        role="status"
      >
        <Loader2
          className="h-5 w-5 animate-spin text-blue-600"
          aria-hidden="true"
        />
        <span>Đang tải thông tin kho lưu trữ và danh sách Shop...</span>
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

  const totalWarehouses =
    overview?.shops.reduce((acc, s) => acc + s.warehouses.length, 0) ?? 0;

  return (
    <div className="space-y-5">
      {/* Header & Storage Status Overview */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs sm:p-5">
        <PageHeader
          title="Cấu hình ổ lưu trữ & Giới hạn quay"
          subtitle="Theo dõi kết nối ổ lưu trữ video, kiểm soát bộ nhớ đệm và thiết lập quy tắc giữ bằng chứng cho toàn hệ thống."
          actions={
            <button
              type="button"
              className="btn btn-primary inline-flex cursor-pointer items-center gap-1.5"
              onClick={() => void handleRunHealthCheck()}
              disabled={isCheckingHealth}
            >
              {isCheckingHealth ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : (
                <Activity className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>
                {isCheckingHealth
                  ? 'Đang kiểm tra kết nối...'
                  : 'Kiểm tra kết nối lưu trữ'}
              </span>
            </button>
          }
        />

        {overview && (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2.5 sm:mt-5 sm:grid-cols-3 sm:gap-3">
              <div className="col-span-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 sm:col-span-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                  <HardDrive className="h-4 w-4 text-blue-600" aria-hidden="true" />
                  <span>Nơi lưu trữ video đang dùng</span>
                </div>
                <div className="mt-1.5">
                  {overview.storageMode === 'SynologyMounted' ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                      Synology NAS (Chính thức)
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                      <Database className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                      Ổ đĩa máy chủ (Cục bộ)
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                  <Store className="h-4 w-4 text-blue-600" aria-hidden="true" />
                  <span>Quy mô vận hành</span>
                </div>
                <div className="mt-1.5 text-sm font-bold text-slate-900">
                  {overview.shops.length} Shop • {totalWarehouses} Kho đóng gói
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
                  <ShieldCheck className="h-4 w-4 text-blue-600" aria-hidden="true" />
                  <span>Cập nhật cấu hình lần cuối</span>
                </div>
                <div className="mt-1.5 text-sm font-semibold text-slate-800">
                  {formatHoChiMinhDateTime(overview.updatedAtUtc)}
                </div>
              </div>
            </div>

            {/* Visual Server Upload Buffer Bar */}
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-semibold text-slate-800">
                  Bộ nhớ đệm tiếp nhận video đang tải lên
                </span>
                <span className="text-xs font-medium text-slate-600">
                  Đang dùng{' '}
                  <strong className="text-slate-900">
                    {formatByteSize(overview.stagingUsage.totalFootprintBytes)}
                  </strong>{' '}
                  / {formatByteSize(overview.stagingUsage.maxStagingBytes)} (
                  {stagingPercent}%) • Còn trống{' '}
                  <strong className="text-emerald-700">
                    {formatByteSize(overview.stagingUsage.availableBytes)}
                  </strong>
                </span>
              </div>

              <div className="mt-2.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className={`h-full rounded-full transition-all ${
                    stagingPercent >= 85
                      ? 'bg-red-600'
                      : stagingPercent >= 70
                        ? 'bg-amber-500'
                        : 'bg-blue-600'
                  }`}
                  style={{ width: `${Math.max(stagingPercent, 2)}%` }}
                />
              </div>

              <details className="group mt-3">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800">
                  <ChevronDown
                    className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  />
                  <span>Xem thông số kỹ thuật ổ lưu trữ</span>
                </summary>
                <div className="mt-2.5 grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600 sm:grid-cols-3">
                  <div>
                    <span className="text-slate-500">Tệp nhận diện ổ đĩa: </span>
                    <code className="mono-code font-semibold text-slate-800">
                      {overview.markerFileName}
                    </code>{' '}
                    <span>
                      ({overview.expectedStorageIdConfigured ? 'Đã khóa mã ổ đĩa' : 'Tự động'})
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">Kích thước gói truyền tải: </span>
                    <strong className="text-slate-800">
                      {formatByteSize(overview.uploadChunkBytes)}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-500">Chi tiết vùng đệm: </span>
                    <span>
                      Đã ghi {formatByteSize(overview.stagingUsage.diskUsedBytes)} • Giữ chỗ{' '}
                      {formatByteSize(overview.stagingUsage.reservedRemainingBytes)}
                    </span>
                  </div>
                </div>
              </details>
            </div>
          </>
        )}
      </div>

      {/* Health Check Result Card */}
      {healthReport && (
        <div
          className={`rounded-2xl border p-4 shadow-xs ${
            healthReport.isHealthy
              ? 'border-emerald-200 bg-emerald-50/90 text-emerald-950'
              : 'border-red-200 bg-red-50 text-red-950'
          }`}
          role="status"
          data-testid="storage-health-report"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-bold">
              {healthReport.isHealthy ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <XCircle className="h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
              )}
              <span>{healthReport.statusMessage}</span>
            </div>
            <span className="text-xs opacity-80">
              Kiểm tra lúc {formatHoChiMinhDateTime(healthReport.checkedAtUtc)}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2 text-xs">
              {healthReport.rootExists ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              )}
              <span>
                Thư mục gốc:{' '}
                <strong>{healthReport.rootExists ? 'Hoạt động tốt' : 'Không tìm thấy'}</strong>
              </span>
            </div>

            <div className="flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2 text-xs">
              {healthReport.markerValid ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              )}
              <span>
                Nhận diện đúng ổ đĩa:{' '}
                <strong>{healthReport.markerValid ? 'Hợp lệ' : 'Sai hoặc thiếu'}</strong>
              </span>
            </div>

            <div className="flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2 text-xs">
              {healthReport.canReadWrite ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              )}
              <span>
                Đọc &amp; ghi thử nghiệm:{' '}
                <strong>{healthReport.canReadWrite ? 'Thành công' : 'Thất bại'}</strong>
              </span>
            </div>

            {healthReport.availableFreeBytes != null && (
              <div className="flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2 text-xs">
                <HardDrive className="h-4 w-4 shrink-0 text-blue-600" aria-hidden="true" />
                <span>
                  Ổ đĩa còn trống:{' '}
                  <strong>{formatByteSize(healthReport.availableFreeBytes)}</strong>
                  {healthReport.totalCapacityBytes != null
                    ? ` / ${formatByteSize(healthReport.totalCapacityBytes)}`
                    : ''}
                </span>
              </div>
            )}
          </div>

          {healthReport.isLowSpaceWarning && healthReport.capacityWarningMessage && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              <span>{healthReport.capacityWarningMessage}</span>
            </div>
          )}
        </div>
      )}

      {successMsg && (
        <div
          className="flex items-start gap-2.5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"
          role="status"
        >
          <CheckCircle2
            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
            aria-hidden="true"
          />
          <span>{successMsg}</span>
        </div>
      )}

      {errorMsg && (
        <div
          className="flex items-start gap-2.5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
          role="alert"
        >
          <AlertCircle
            className="mt-0.5 h-4 w-4 shrink-0 text-red-600"
            aria-hidden="true"
          />
          <span>{errorMsg}</span>
        </div>
      )}

      {overview && (
        <form className="space-y-5" onSubmit={handleSettingsFormSubmit}>
          {/* Shops & Storage Directories Card */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Store className="h-5 w-5 text-blue-600" aria-hidden="true" />
                  <h2 className="m-0 text-base font-bold text-slate-900">
                    Thư mục lưu trữ theo Shop ({overview.shops.length})
                  </h2>
                </div>
                <p className="mt-0.5 mb-0 text-xs text-slate-600">
                  Mỗi Shop có thư mục lưu trữ video riêng biệt trên ổ đĩa. Để thêm hoặc chỉnh sửa Shop và Kho đóng gói, vui lòng sang trang Quản lý Shop &amp; Kho.
                </p>
              </div>

              <Link
                to="/admin/warehouses"
                className="btn btn-outline inline-flex items-center gap-1.5 text-xs no-underline"
              >
                <span>Quản lý Shop &amp; Kho</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </Link>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {overview.shops.map((shop) => {
                const currentSubdir =
                  shopSubdirs[shop.id] ?? shop.allowedStorageSubdir;
                return (
                  <div
                    key={shop.id}
                    className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50/60 p-3.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="m-0 text-sm font-bold text-slate-900">
                          {shop.name}
                        </h3>
                        <span className="mono-code rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700">
                          {shop.code}
                        </span>
                      </div>
                      <span className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50/80 px-2 py-0.5 text-xs font-semibold text-blue-900">
                        <Building2 className="h-3.5 w-3.5 text-blue-600" aria-hidden="true" />
                        <span>{shop.warehouses.length} kho</span>
                      </span>
                    </div>

                    <details className="group mt-2.5 border-t border-slate-200/80 pt-2">
                      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900">
                        <FolderCog className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                        <span>
                          Thư mục lưu trữ:{' '}
                          <code className="mono-code font-semibold text-slate-800">
                            {currentSubdir}
                          </code>
                        </span>
                        <ChevronDown
                          className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
                          aria-hidden="true"
                        />
                      </summary>
                      <div className="mt-2">
                        <label
                          htmlFor={`shop-subdir-${shop.id}`}
                          className="mb-1 block text-xs font-medium text-slate-600"
                        >
                          Tên thư mục lưu video trên ổ đĩa (chữ cái không dấu, số, dấu gạch ngang)
                        </label>
                        <input
                          id={`shop-subdir-${shop.id}`}
                          type="text"
                          className="form-input mono-code text-base sm:text-xs"
                          maxLength={64}
                          value={currentSubdir}
                          onChange={(e) =>
                            setShopSubdirs((prev) => ({
                              ...prev,
                              [shop.id]: e.target.value
                            }))
                          }
                        />
                      </div>
                    </details>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Operational Limits & Retention Card */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
            <div className="mb-4 flex items-center gap-2">
              <Sliders className="h-5 w-5 text-blue-600" aria-hidden="true" />
              <div>
                <h2 className="m-0 text-base font-bold text-slate-900">
                  Giới hạn quay video &amp; Quy tắc tự động dọn ổ đĩa
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-slate-600">
                  Áp dụng chung cho toàn bộ thiết bị quay đóng gói của nhân viên tại kho.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label
                  htmlFor="storage-max-seconds"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
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
                <span className="mt-1 block text-[11px] text-slate-500">
                  Tương đương khoảng {Math.round((maxRecordingSeconds / 60) * 10) / 10} phút mỗi đơn
                </span>
              </div>

              <div>
                <label
                  htmlFor="storage-max-upload-mib"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Dung lượng tối đa mỗi video (MB)
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
                <span className="mt-1 block text-[11px] text-slate-500">
                  Khuyến nghị 256 – 1024 MB cho đơn hàng lớn
                </span>
              </div>

              <div>
                <label
                  htmlFor="storage-max-pending"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Số video chờ tải tối đa trên máy
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
                <span className="mt-1 block text-[11px] text-slate-500">
                  Ngăn tràn bộ nhớ điện thoại khi mất mạng
                </span>
              </div>

              <div>
                <label
                  htmlFor="storage-retention-days"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Số ngày lưu giữ video
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
                <span className="mt-1 block text-[11px] text-slate-500">
                  Áp dụng khi bật chế độ tự động dọn bên dưới
                </span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors ${
                  enableAudio
                    ? 'border-blue-300 bg-blue-50/50'
                    : 'border-slate-200 bg-slate-50/60 hover:border-slate-300'
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
                  checked={enableAudio}
                  onChange={(e) => setEnableAudio(e.target.checked)}
                />
                <div className="text-xs leading-relaxed text-slate-700">
                  <div className="flex items-center gap-1.5 font-bold text-slate-900">
                    <Mic className="h-3.5 w-3.5 text-blue-600" aria-hidden="true" />
                    <span>Cho phép thu âm thanh khi quay đóng gói</span>
                  </div>
                  <p className="mt-0.5 mb-0 text-slate-600">
                    Mặc định tắt để tệp video nhẹ hơn, tải lên nhanh hơn và tránh thu tạp âm tại kho.
                  </p>
                </div>
              </label>

              <label
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors ${
                  retentionEnabled
                    ? 'border-amber-300 bg-amber-50/60'
                    : 'border-slate-200 bg-slate-50/60 hover:border-slate-300'
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-amber-600"
                  checked={retentionEnabled}
                  onChange={(e) => setRetentionEnabled(e.target.checked)}
                />
                <div className="text-xs leading-relaxed text-slate-700">
                  <div className="flex items-center gap-1.5 font-bold text-slate-900">
                    <Trash2 className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                    <span>Tự động dọn video cũ quá {retentionDays} ngày</span>
                  </div>
                  <p className="mt-0.5 mb-0 text-slate-600">
                    Mặc định tắt. Khi bật, hệ thống chỉ dọn video thường đã quá hạn; mọi video đang bật{' '}
                    <strong className="text-slate-900">Khóa giữ bằng chứng</strong> luôn được bảo vệ an toàn.
                  </p>
                </div>
              </label>
            </div>

            <div className="mt-5 flex items-center justify-end border-t border-slate-200 pt-4">
              <button
                type="submit"
                className="btn btn-primary inline-flex w-full cursor-pointer items-center justify-center gap-2 sm:w-auto"
                disabled={isSavingSettings}
              >
                {isSavingSettings ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {isSavingSettings ? 'Đang lưu cấu hình...' : 'Lưu cấu hình lưu trữ'}
                </span>
              </button>
            </div>
          </section>
        </form>
      )}

      {/* Explicit Confirmation Modal when enabling Retention */}
      {isRetentionConfirmModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSavingSettings) {
              setIsRetentionConfirmModalOpen(false);
            }
          }}
        >
          <div
            className="modal-card modal-card-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="retention-confirm-title"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
                <h2
                  id="retention-confirm-title"
                  className="m-0 text-lg font-bold text-slate-900"
                >
                  Xác nhận bật tự động dọn video quá hạn
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsRetentionConfirmModalOpen(false)}
                disabled={isSavingSettings}
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-950">
              <strong>Lưu ý quan trọng:</strong> Hệ thống sẽ tự động xóa tệp video của các đơn hàng đã quay quá{' '}
              <strong>{retentionDays} ngày</strong> để giải phóng dung lượng ổ đĩa.
            </div>

            <p className="mt-3 mb-0 text-sm text-slate-600">
              Các đơn hàng đang có khiếu nại được đánh dấu{' '}
              <strong className="text-slate-900">Khóa giữ bằng chứng (Hold)</strong> sẽ luôn được giữ lại an toàn và không bị ảnh hưởng bởi chế độ tự động dọn này.
            </p>

            <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4">
              <button
                type="button"
                className="btn btn-outline cursor-pointer"
                onClick={() => setIsRetentionConfirmModalOpen(false)}
                disabled={isSavingSettings}
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                className="btn btn-danger cursor-pointer"
                onClick={() => void performSaveSettings(true)}
                disabled={isSavingSettings}
              >
                {isSavingSettings
                  ? 'Đang xác nhận...'
                  : 'Tôi hiểu & Xác nhận bật'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
