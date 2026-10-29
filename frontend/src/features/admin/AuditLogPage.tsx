import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  formatHoChiMinhDateTime,
  getAuditOutcomeBadge,
  type AuditOutcomeType
} from '../../app/formatters';
import {
  fetchAccessibleShops,
  type ShopOption
} from '../recording/recordingApi';
import {
  listAuditEventsApi,
  type AuditEventDto
} from './adminApi';

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
  const [actionInput, setActionInput] = useState<string>('');
  const [actorEmailInput, setActorEmailInput] = useState<string>('');
  const [entityTypeInput, setEntityTypeInput] = useState<string>('');
  const [outcomeFilter, setOutcomeFilter] = useState<AuditOutcomeType | ''>('');
  const [shopFilter, setShopFilter] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const pageSize = 25;

  const [appliedFilters, setAppliedFilters] = useState({
    action: '',
    actorEmail: '',
    entityType: ''
  });

  const [shops, setShops] = useState<ShopOption[]>([]);
  const [events, setEvents] = useState<AuditEventDto[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

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
        action: appliedFilters.action || undefined,
        actorEmail: appliedFilters.actorEmail || undefined,
        entityType: appliedFilters.entityType || undefined,
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
          : 'Không thể tải dữ liệu nhật ký kiểm toán.'
      );
    } finally {
      setIsLoading(false);
    }
  }, [
    appliedFilters.action,
    appliedFilters.actorEmail,
    appliedFilters.entityType,
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
    setAppliedFilters({
      action: actionInput,
      actorEmail: actorEmailInput,
      entityType: entityTypeInput
    });
  };

  const handleResetFilters = () => {
    setActionInput('');
    setActorEmailInput('');
    setEntityTypeInput('');
    setAppliedFilters({ action: '', actorEmail: '', entityType: '' });
    setOutcomeFilter('');
    setShopFilter('');
    setFromDate('');
    setToDate('');
    setPage(1);
  };

  const toggleExpandMetadata = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <div>
      <div className="surface-card">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Nhật ký kiểm toán bất biến (Audit Log)</h1>
            <p className="page-subtitle">
              Ghi nhận đầy đủ mọi hoạt động đăng nhập, phân quyền, tải xuống tệp gốc, nhập
              mã thủ công, giữ bằng chứng (Hold), duyệt xóa và lưu trữ theo phạm vi Shop
              được cấp (múi giờ <code>Asia/Ho_Chi_Minh</code>).
            </p>
          </div>

          <span className="status-pill status-pill-ready">
            Chỉ thêm mới (Append-Only)
          </span>
        </div>

        <form style={{ marginTop: 16 }} onSubmit={handleFilterSubmit}>
          <div className="filter-grid">
            <div>
              <label htmlFor="audit-action-input" className="form-label">
                Mã hành động (Action)
              </label>
              <input
                id="audit-action-input"
                type="text"
                className="form-input mono-code"
                value={actionInput}
                onChange={(e) => setActionInput(e.target.value)}
                placeholder="Ví dụ: video.download, video.hold_updated"
              />
            </div>

            <div>
              <label htmlFor="audit-actor-input" className="form-label">
                Email người thực hiện
              </label>
              <input
                id="audit-actor-input"
                type="text"
                className="form-input"
                value={actorEmailInput}
                onChange={(e) => setActorEmailInput(e.target.value)}
                placeholder="Ví dụ: admin@congty.vn"
              />
            </div>

            <div>
              <label htmlFor="audit-entity-input" className="form-label">
                Loại đối tượng (EntityType)
              </label>
              <input
                id="audit-entity-input"
                type="text"
                className="form-input"
                value={entityTypeInput}
                onChange={(e) => setEntityTypeInput(e.target.value)}
                placeholder="Ví dụ: Recording, User, StorageProfile"
              />
            </div>

            <div>
              <label htmlFor="audit-outcome-select" className="form-label">
                Kết quả xử lý
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
                <option value="Success">Thành công (Success)</option>
                <option value="Denied">Từ chối quyền (Denied)</option>
                <option value="Failed">Thất bại (Failed)</option>
              </select>
            </div>

            <div>
              <label htmlFor="audit-shop-select" className="form-label">
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
                <option value="">Tất cả Shop trong phạm vi</option>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="audit-from-date" className="form-label">
                Từ ngày (GMT+7)
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
              <label htmlFor="audit-to-date" className="form-label">
                Đến ngày (GMT+7)
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

            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 8,
                flexWrap: 'wrap'
              }}
            >
              <button type="submit" className="btn btn-primary">
                Lọc nhật ký
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={handleResetFilters}
              >
                Đặt lại
              </button>
            </div>
          </div>
        </form>
      </div>

      {errorMsg && (
        <div className="alert alert-error" role="alert">
          {errorMsg}
        </div>
      )}

      <div className="surface-card">
        {isLoading ? (
          <div role="status" style={{ color: 'var(--color-text-muted)' }}>
            Đang tải nhật ký kiểm toán...
          </div>
        ) : events.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
            Không có sự kiện kiểm toán nào khớp với điều kiện lọc hiện tại.
          </p>
        ) : (
          <>
            <div
              style={{
                marginBottom: 12,
                fontSize: '0.88rem',
                color: 'var(--color-text-muted)'
              }}
            >
              Tổng cộng <strong>{totalCount}</strong> sự kiện kiểm toán • Trang{' '}
              <strong>{page}</strong> / <strong>{totalPages}</strong>
            </div>

            <div className="desktop-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Thời gian (GMT+7)</th>
                    <th>Hành động</th>
                    <th>Kết quả</th>
                    <th>Người thực hiện &amp; IP</th>
                    <th>Đối tượng / Phạm vi</th>
                    <th>Chi tiết (Đã lọc bí mật)</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => {
                    const badge = getAuditOutcomeBadge(ev.outcome);
                    const isExpanded = expandedIds.has(ev.id);

                    return (
                      <tr key={ev.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {formatHoChiMinhDateTime(ev.occurredAtUtc)}
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--color-text-muted)'
                            }}
                          >
                            #{ev.id}
                          </div>
                        </td>
                        <td className="mono-code">{ev.action}</td>
                        <td>
                          <span className={badge.className}>{badge.label}</span>
                        </td>
                        <td>
                          <div>{ev.actorEmail ?? 'Hệ thống (System Worker)'}</div>
                          {ev.ipAddress && (
                            <div
                              style={{
                                fontSize: '0.78rem',
                                color: 'var(--color-text-muted)'
                              }}
                            >
                              IP: {ev.ipAddress}
                            </div>
                          )}
                        </td>
                        <td>
                          <div>
                            <strong>{ev.entityType}</strong>
                            {ev.entityId ? ` (${ev.entityId})` : ''}
                          </div>
                          {(ev.shopName || ev.warehouseName) && (
                            <div
                              style={{
                                fontSize: '0.8rem',
                                color: 'var(--color-text-muted)'
                              }}
                            >
                              {ev.shopName ?? ''}
                              {ev.shopName && ev.warehouseName ? ' • ' : ''}
                              {ev.warehouseName ?? ''}
                            </div>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-outline"
                            style={{ padding: '4px 10px', minHeight: 36 }}
                            onClick={() => toggleExpandMetadata(ev.id)}
                          >
                            {isExpanded ? 'Thu gọn JSON' : 'Xem chi tiết JSON'}
                          </button>
                          {isExpanded && (
                            <pre
                              className="code-box"
                              style={{
                                marginTop: 8,
                                marginBottom: 0,
                                fontSize: '0.8rem',
                                maxWidth: 380,
                                overflowX: 'auto'
                              }}
                            >
                              {formatPrettyMetadata(ev.metadataJson)}
                            </pre>
                          )}
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
                const isExpanded = expandedIds.has(ev.id);

                return (
                  <div key={ev.id} className="mobile-data-card">
                    <div className="page-header-row">
                      <span className="mono-code">{ev.action}</span>
                      <span className={badge.className}>{badge.label}</span>
                    </div>

                    <div
                      style={{
                        fontSize: '0.84rem',
                        color: 'var(--color-text-muted)'
                      }}
                    >
                      {formatHoChiMinhDateTime(ev.occurredAtUtc)} •{' '}
                      {ev.actorEmail ?? 'Hệ thống'}
                    </div>

                    <div style={{ fontSize: '0.86rem' }}>
                      Đối tượng: <strong>{ev.entityType}</strong>
                      {ev.shopName ? ` • Shop: ${ev.shopName}` : ''}
                    </div>

                    <div>
                      <button
                        type="button"
                        className="btn btn-outline"
                        onClick={() => toggleExpandMetadata(ev.id)}
                      >
                        {isExpanded ? 'Thu gọn JSON' : 'Xem chi tiết JSON'}
                      </button>
                      {isExpanded && (
                        <pre
                          className="code-box"
                          style={{
                            marginTop: 8,
                            marginBottom: 0,
                            fontSize: '0.8rem',
                            overflowX: 'auto'
                          }}
                        >
                          {formatPrettyMetadata(ev.metadataJson)}
                        </pre>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="pagination-bar">
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Trang trước
                </button>
                <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                  Trang {page} / {totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Trang sau
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
