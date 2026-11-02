import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Filter,
  History,
  Loader2,
  RotateCcw,
  ShieldCheck
} from 'lucide-react';
import {
  formatHoChiMinhDateTime,
  getAuditOutcomeBadge,
  type AuditOutcomeType
} from '../../app/formatters';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import {
  AUDIT_ACTION_FILTER_OPTIONS,
  AUDIT_ENTITY_FILTER_OPTIONS,
  extractFriendlyAuditMetadata,
  getAuditActionLabel,
  getAuditEntityLabel,
  type AuditActionMeta
} from '../../shared/labels/auditLabels';
import {
  fetchAccessibleShops,
  type ShopOption
} from '../recording/recordingApi';
import {
  listAuditEventsApi,
  type AuditEventDto
} from './adminApi';

const CATEGORY_BADGE_STYLES: Record<AuditActionMeta['category'], string> = {
  auth: 'border-slate-200 bg-slate-100 text-slate-700',
  recording: 'border-blue-200 bg-blue-50 text-blue-800',
  video: 'border-indigo-200 bg-indigo-50 text-indigo-800',
  user: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  storage: 'border-amber-200 bg-amber-50 text-amber-800',
  retention: 'border-orange-200 bg-orange-50 text-orange-800'
};

function formatPrettyMetadata(rawJson: string): string {
  if (!rawJson || !rawJson.trim()) {
    return '{}';
  }
  try {
    return JSON.stringify(JSON.parse(rawJson), null, 2);
  } catch {
    return rawJson;
  }
}

export function AuditLogPage() {
  const [actionFilter, setActionFilter] = useState<string>('');
  const [actorEmailInput, setActorEmailInput] = useState<string>('');
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>('');
  const [outcomeFilter, setOutcomeFilter] = useState<AuditOutcomeType | ''>('');
  const [shopFilter, setShopFilter] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const pageSize = 25;

  const [appliedActorEmail, setAppliedActorEmail] = useState<string>('');

  const [shops, setShops] = useState<ShopOption[]>([]);
  const [events, setEvents] = useState<AuditEventDto[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetchAccessibleShops();
        if (active && Array.isArray(res?.shops)) {
          setShops(res.shops);
        }
      } catch {
        // Optional shop list
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadAuditLogs = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await listAuditEventsApi({
        action: actionFilter || undefined,
        actorEmail: appliedActorEmail || undefined,
        entityType: entityTypeFilter || undefined,
        outcome: outcomeFilter,
        shopId: shopFilter || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        page,
        pageSize
      });
      setEvents(res.items);
      setTotalCount(res.totalCount);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể tải dữ liệu nhật ký hoạt động.'
      );
    } finally {
      setIsLoading(false);
    }
  }, [
    actionFilter,
    appliedActorEmail,
    entityTypeFilter,
    fromDate,
    outcomeFilter,
    page,
    shopFilter,
    toDate
  ]);

  useEffect(() => {
    void loadAuditLogs();
  }, [loadAuditLogs]);

  const handleFilterSubmit = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setAppliedActorEmail(actorEmailInput.trim());
  };

  const handleResetFilters = () => {
    setActionFilter('');
    setActorEmailInput('');
    setAppliedActorEmail('');
    setEntityTypeFilter('');
    setOutcomeFilter('');
    setShopFilter('');
    setFromDate('');
    setToDate('');
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const activeAuditFilterCount =
    (actionFilter ? 1 : 0) +
    (entityTypeFilter ? 1 : 0) +
    (outcomeFilter ? 1 : 0) +
    (shopFilter ? 1 : 0) +
    (appliedActorEmail ? 1 : 0) +
    (fromDate ? 1 : 0) +
    (toDate ? 1 : 0);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
        <PageHeader
          title="Nhật ký hoạt động hệ thống"
          subtitle="Theo dõi minh bạch lịch sử đăng nhập, phân quyền, tải video gốc, khóa giữ bằng chứng và duyệt xóa."
          badge={
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
              <span>Bảo vệ chống chỉnh sửa</span>
            </span>
          }
        />

        {/* Mobile Filter Toggle (keeps audit events immediately visible above the fold on mobile) */}
        <div className="mt-3.5 flex items-center gap-2 sm:hidden">
          <button
            type="button"
            className="btn btn-outline flex flex-1 items-center justify-between gap-2 text-xs"
            aria-expanded={isMobileFilterOpen || activeAuditFilterCount > 0}
            onClick={() => setIsMobileFilterOpen((prev) => !prev)}
          >
            <span className="inline-flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-blue-600" aria-hidden="true" />
              <span>Bộ lọc nhật ký</span>
              {activeAuditFilterCount > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-[11px] font-bold text-white">
                  {activeAuditFilterCount}
                </span>
              )}
            </span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${
                isMobileFilterOpen || activeAuditFilterCount > 0 ? 'rotate-180' : ''
              }`}
              aria-hidden="true"
            />
          </button>

          {activeAuditFilterCount > 0 && (
            <button
              type="button"
              className="btn btn-outline inline-flex items-center justify-center gap-1.5 text-xs"
              onClick={handleResetFilters}
            >
              <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Đặt lại</span>
            </button>
          )}
        </div>

        <form
          className={`${
            isMobileFilterOpen || activeAuditFilterCount > 0
              ? 'block'
              : 'hidden sm:block'
          } mt-3.5 border-t border-slate-100 pt-3.5 sm:mt-4 sm:border-t-0 sm:pt-0`}
          onSubmit={handleFilterSubmit}
        >
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4">
            <div className="col-span-2 sm:col-span-1">
              <label
                htmlFor="audit-action-select"
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                Nhóm hoạt động
              </label>
              <select
                id="audit-action-select"
                className="form-input"
                value={actionFilter}
                onChange={(e) => {
                  setActionFilter(e.target.value);
                  setPage(1);
                }}
              >
                {AUDIT_ACTION_FILTER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label
                htmlFor="audit-entity-select"
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                Loại đối tượng
              </label>
              <select
                id="audit-entity-select"
                className="form-input"
                value={entityTypeFilter}
                onChange={(e) => {
                  setEntityTypeFilter(e.target.value);
                  setPage(1);
                }}
              >
                {AUDIT_ENTITY_FILTER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label
                htmlFor="audit-outcome-select"
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                Kết quả
              </label>
              <select
                id="audit-outcome-select"
                className="form-input"
                value={outcomeFilter}
                onChange={(e) => {
                  setOutcomeFilter(e.target.value as AuditOutcomeType | '');
                  setPage(1);
                }}
              >
                <option value="">Tất cả kết quả</option>
                <option value="Success">Thành công</option>
                <option value="Denied">Bị từ chối quyền</option>
                <option value="Failed">Gặp lỗi</option>
              </select>
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label
                htmlFor="audit-shop-select"
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                Shop
              </label>
              <select
                id="audit-shop-select"
                className="form-input"
                value={shopFilter}
                onChange={(e) => {
                  setShopFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Tất cả Shop</option>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label
                htmlFor="audit-actor-input"
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                Email người thực hiện
              </label>
              <input
                id="audit-actor-input"
                type="text"
                className="form-input"
                value={actorEmailInput}
                onChange={(e) => setActorEmailInput(e.target.value)}
                placeholder="VD: admin@congty.vn"
              />
            </div>

            <div>
              <label
                htmlFor="audit-from-date"
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                Từ ngày
              </label>
              <input
                id="audit-from-date"
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
              <label
                htmlFor="audit-to-date"
                className="mb-1 block text-xs font-semibold text-slate-700"
              >
                Đến ngày
              </label>
              <input
                id="audit-to-date"
                type="date"
                className="form-input"
                value={toDate}
                onChange={(e) => {
                  setToDate(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <div className="col-span-2 flex items-end gap-2 sm:col-span-1">
              <button
                type="submit"
                className="btn btn-primary inline-flex flex-1 items-center justify-center gap-1.5"
              >
                <Filter className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Lọc nhật ký</span>
              </button>
              <button
                type="button"
                className="btn btn-outline inline-flex items-center justify-center gap-1.5"
                onClick={handleResetFilters}
              >
                <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Đặt lại</span>
              </button>
            </div>
          </div>
        </form>
      </div>

      {errorMsg && (
        <div
          className="flex items-start gap-2.5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
        {isLoading ? (
          <div
            className="flex items-center justify-center gap-2.5 py-8 text-sm font-medium text-slate-600"
            role="status"
          >
            <Loader2 className="h-5 w-5 animate-spin text-blue-600" aria-hidden="true" />
            <span>Đang tải nhật ký hoạt động...</span>
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            icon={<History className="h-6 w-6" />}
            title="Không có hoạt động nào khớp bộ lọc"
            description="Hãy thử mở rộng khoảng ngày hoặc bấm Đặt lại để xem toàn bộ lịch sử hoạt động."
          />
        ) : (
          <>
            <div className="mb-3 text-xs text-slate-600">
              Tổng cộng <strong className="text-slate-900">{totalCount}</strong> hoạt động •
              Trang <strong className="text-slate-900">{page}</strong> /{' '}
              <strong className="text-slate-900">{totalPages}</strong>
            </div>

            <div className="desktop-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Thời gian</th>
                    <th>Hoạt động</th>
                    <th>Kết quả</th>
                    <th>Người thực hiện</th>
                    <th>Đối tượng &amp; Khu vực</th>
                    <th>Thông tin ghi nhận</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => {
                    const badge = getAuditOutcomeBadge(ev.outcome);
                    const actionMeta = getAuditActionLabel(ev.action);
                    const entityLabel = getAuditEntityLabel(ev.entityType);
                    const friendlyFields = extractFriendlyAuditMetadata(
                      ev.metadataJson
                    );
                    const hasRawJson =
                      Boolean(ev.metadataJson) &&
                      ev.metadataJson.trim() !== '{}' &&
                      ev.metadataJson.trim() !== '';

                    return (
                      <tr key={ev.id}>
                        <td className="whitespace-nowrap">
                          <div className="text-xs font-medium text-slate-800">
                            {formatHoChiMinhDateTime(ev.occurredAtUtc)}
                          </div>
                          <div className="font-mono text-[11px] text-slate-400">
                            #{ev.id}
                          </div>
                        </td>

                        <td>
                          <span
                            className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-semibold ${CATEGORY_BADGE_STYLES[actionMeta.category]}`}
                          >
                            {actionMeta.label}
                          </span>
                        </td>

                        <td>
                          <span className={badge.className}>{badge.label}</span>
                        </td>

                        <td>
                          <div className="text-xs font-semibold text-slate-800">
                            {ev.actorEmail ?? 'Tự động từ hệ thống'}
                          </div>
                          {ev.ipAddress && (
                            <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                              IP: {ev.ipAddress}
                            </div>
                          )}
                        </td>

                        <td>
                          <div className="text-xs font-semibold text-slate-800">
                            {entityLabel}
                          </div>
                          {(ev.shopName || ev.warehouseName) && (
                            <div className="mt-0.5 text-xs text-slate-500">
                              {ev.shopName ?? ''}
                              {ev.shopName && ev.warehouseName ? ' • ' : ''}
                              {ev.warehouseName ?? ''}
                            </div>
                          )}
                        </td>

                        <td className="max-w-sm">
                          {friendlyFields.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {friendlyFields.map((f) => (
                                <span
                                  key={f.key}
                                  className="inline-flex max-w-full flex-wrap items-center gap-1 break-all rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700"
                                >
                                  <span className="text-slate-500">{f.label}:</span>
                                  <strong className="break-all text-slate-900">{f.value}</strong>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}

                          <details className="mt-1.5">
                            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-800">
                              <Code2 className="h-3 w-3" aria-hidden="true" />
                              <span>Chi tiết kỹ thuật</span>
                              <ChevronDown className="h-3 w-3" aria-hidden="true" />
                            </summary>
                            <div className="mt-1.5 rounded-lg border border-slate-200 bg-slate-900 p-2.5 font-mono text-[11px] text-slate-100">
                              <div>Mã sự kiện: {ev.action}</div>
                              {ev.entityId && <div>ID đối tượng: {ev.entityId}</div>}
                              {hasRawJson && (
                                <pre className="mt-1.5 mb-0 max-w-xs overflow-x-auto text-[11px] text-slate-300">
                                  {formatPrettyMetadata(ev.metadataJson)}
                                </pre>
                              )}
                            </div>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mobile-card-list mobile-card-list-hide-desktop">
              {events.map((ev) => {
                const badge = getAuditOutcomeBadge(ev.outcome);
                const actionMeta = getAuditActionLabel(ev.action);
                const entityLabel = getAuditEntityLabel(ev.entityType);
                const friendlyFields = extractFriendlyAuditMetadata(ev.metadataJson);

                return (
                  <div key={ev.id} className="mobile-data-card">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span
                        className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-semibold ${CATEGORY_BADGE_STYLES[actionMeta.category]}`}
                      >
                        {actionMeta.label}
                      </span>
                      <span className={badge.className}>{badge.label}</span>
                    </div>

                    <div className="text-xs text-slate-500">
                      {formatHoChiMinhDateTime(ev.occurredAtUtc)} •{' '}
                      <strong className="text-slate-700">
                        {ev.actorEmail ?? 'Tự động từ hệ thống'}
                      </strong>
                    </div>

                    <div className="text-xs text-slate-700">
                      Đối tượng: <strong>{entityLabel}</strong>
                      {ev.shopName ? ` • Shop: ${ev.shopName}` : ''}
                    </div>

                    {friendlyFields.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {friendlyFields.map((f) => (
                          <span
                            key={f.key}
                            className="inline-flex max-w-full flex-wrap items-center gap-1 break-all rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700"
                          >
                            <span className="text-slate-500">{f.label}:</span>
                            <strong className="break-all text-slate-900">{f.value}</strong>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3.5">
                <button
                  type="button"
                  className="btn btn-outline inline-flex items-center gap-1 text-xs"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  <span>Trang trước</span>
                </button>
                <span className="text-xs font-semibold text-slate-700">
                  Trang {page} / {totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn-outline inline-flex items-center gap-1 text-xs"
                  disabled={page >= totalPages}
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
    </div>
  );
}
