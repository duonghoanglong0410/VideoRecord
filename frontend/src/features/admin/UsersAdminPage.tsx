import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../app/authStore';
import {
  formatHoChiMinhDateTime,
  getApprovalStatusBadge,
  getScopeTypeLabel
} from '../../app/formatters';
import type { ApprovalStatus, ScopeType } from '../../app/types';
import {
  fetchAccessibleShops,
  type ShopOption
} from '../recording/recordingApi';
import {
  approveAdminUserApi,
  initiateAdminPasswordResetApi,
  listAdminRolesApi,
  listAdminUsersApi,
  lockAdminUserApi,
  revokeAdminUserSessionsApi,
  unlockAdminUserApi,
  updateAdminUserGrantsApi,
  type AdminPasswordResetInitiatedResponse,
  type AdminUserSummaryDto,
  type GrantProposalDto,
  type RoleDto
} from './adminApi';

interface EditableGrantRow {
  rowKey: string;
  roleId: string;
  scopeType: ScopeType;
  shopId: string;
  warehouseId: string;
}

export function UsersAdminPage() {
  const { user: currentUser } = useAuth();
  const [searchParams] = useSearchParams();

  const initialStatus =
    (searchParams.get('approvalStatus') as ApprovalStatus | null) ?? '';

  const [statusFilter, setStatusFilter] = useState<ApprovalStatus | ''>(
    initialStatus === 'PendingApproval' ||
      initialStatus === 'Active' ||
      initialStatus === 'Locked'
      ? initialStatus
      : ''
  );
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [appliedQuery, setAppliedQuery] = useState<string>('');
  const [shopFilter, setShopFilter] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const pageSize = 20;

  const [users, setUsers] = useState<AdminUserSummaryDto[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [shops, setShops] = useState<ShopOption[]>([]);

  // Approve / Edit Grants Modal state
  const [editingUser, setEditingUser] = useState<AdminUserSummaryDto | null>(null);
  const [modalMode, setModalMode] = useState<'approve' | 'grants'>('grants');
  const [grantRows, setGrantRows] = useState<EditableGrantRow[]>([]);
  const [isSavingGrants, setIsSavingGrants] = useState<boolean>(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // One-time Password Reset Token Modal state
  const [resetResult, setResetResult] =
    useState<AdminPasswordResetInitiatedResponse | null>(null);
  const [copiedToken, setCopiedToken] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [rolesList, shopsRes] = await Promise.all([
          listAdminRolesApi(),
          fetchAccessibleShops().catch(() => ({ shops: [] }))
        ]);
        if (!active) {
          return;
        }
        setRoles(rolesList);
        setShops(shopsRes.shops);
      } catch {
        // Roles/shops errors handled when opening modal if empty
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const assignableRoles = useMemo(() => {
    const actorPerms = new Set(currentUser?.permissions ?? []);
    return roles.filter((r) => {
      if (r.name === 'SuperAdmin' && !currentUser?.isSuperAdmin) {
        return false;
      }
      if (currentUser?.isSuperAdmin) {
        return true;
      }
      return r.permissions.every((p) => actorPerms.has(p));
    });
  }, [currentUser?.isSuperAdmin, currentUser?.permissions, roles]);

  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await listAdminUsersApi({
        q: appliedQuery || undefined,
        approvalStatus: statusFilter,
        shopId: shopFilter || undefined,
        page,
        pageSize
      });
      setUsers(res.items);
      setTotalCount(res.totalCount);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể tải danh sách người dùng.'
      );
    } finally {
      setIsLoading(false);
    }
  }, [appliedQuery, page, shopFilter, statusFilter]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const openGrantsModal = (
    target: AdminUserSummaryDto,
    mode: 'approve' | 'grants'
  ) => {
    setEditingUser(target);
    setModalMode(mode);
    setModalError(null);

    if (target.grants.length > 0) {
      setGrantRows(
        target.grants.map((g, idx) => ({
          rowKey: `${g.id}-${idx}`,
          roleId: g.roleId,
          scopeType: g.scopeType,
          shopId: g.shopId ?? shops[0]?.id ?? '',
          warehouseId: g.warehouseId ?? ''
        }))
      );
    } else {
      const defaultRole =
        assignableRoles.find((r) => r.name === 'Operator') ??
        assignableRoles[0];
      const defaultShop = shops[0];
      const defaultWh = defaultShop?.warehouses[0];

      setGrantRows([
        {
          rowKey: `new-${Date.now()}`,
          roleId: defaultRole?.id ?? '',
          scopeType: 'Own',
          shopId: defaultShop?.id ?? '',
          warehouseId: defaultWh?.id ?? ''
        }
      ]);
    }
  };

  const handleAddGrantRow = () => {
    const defaultRole =
      assignableRoles.find((r) => r.name === 'Operator') ?? assignableRoles[0];
    const defaultShop = shops[0];
    const defaultWh = defaultShop?.warehouses[0];

    setGrantRows((prev) => [
      ...prev,
      {
        rowKey: `new-${Date.now()}-${prev.length}`,
        roleId: defaultRole?.id ?? '',
        scopeType: 'Shop',
        shopId: defaultShop?.id ?? '',
        warehouseId: defaultWh?.id ?? ''
      }
    ]);
  };

  const handleRemoveGrantRow = (rowKey: string) => {
    setGrantRows((prev) => prev.filter((r) => r.rowKey !== rowKey));
  };

  const handleUpdateGrantRow = (
    rowKey: string,
    patch: Partial<EditableGrantRow>
  ) => {
    setGrantRows((prev) =>
      prev.map((row) => {
        if (row.rowKey !== rowKey) {
          return row;
        }
        const next = { ...row, ...patch };
        if (patch.shopId !== undefined) {
          const shopObj = shops.find((s) => s.id === patch.shopId);
          next.warehouseId = shopObj?.warehouses[0]?.id ?? '';
        }
        if (patch.scopeType === 'All') {
          next.shopId = '';
          next.warehouseId = '';
        }
        return next;
      })
    );
  };

  const handleSaveGrantsSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingUser) {
      return;
    }

    if (grantRows.length === 0) {
      setModalError('Vui lòng gán ít nhất 1 phạm vi vai trò cho người dùng.');
      return;
    }

    const proposals: GrantProposalDto[] = [];
    for (const row of grantRows) {
      if (!row.roleId) {
        setModalError('Vui lòng chọn vai trò hợp lệ cho từng dòng phân quyền.');
        return;
      }

      if (row.scopeType === 'All') {
        proposals.push({
          roleId: row.roleId,
          scopeType: 'All',
          shopId: null,
          warehouseId: null
        });
      } else if (row.scopeType === 'Shop') {
        if (!row.shopId) {
          setModalError('Phạm vi Theo Shop yêu cầu chọn một Shop cụ thể.');
          return;
        }
        proposals.push({
          roleId: row.roleId,
          scopeType: 'Shop',
          shopId: row.shopId,
          warehouseId: null
        });
      } else if (row.scopeType === 'Warehouse') {
        if (!row.shopId || !row.warehouseId) {
          setModalError('Phạm vi Theo Kho yêu cầu chọn Shop và Kho cụ thể.');
          return;
        }
        proposals.push({
          roleId: row.roleId,
          scopeType: 'Warehouse',
          shopId: row.shopId,
          warehouseId: row.warehouseId
        });
      } else {
        if (!row.shopId) {
          setModalError('Phạm vi Cá nhân (Own) yêu cầu gắn với ít nhất một Shop.');
          return;
        }
        proposals.push({
          roleId: row.roleId,
          scopeType: 'Own',
          shopId: row.shopId,
          warehouseId: row.warehouseId || null
        });
      }
    }

    const firstScoped = proposals.find((p) => p.shopId);
    setIsSavingGrants(true);
    setModalError(null);

    try {
      if (modalMode === 'approve') {
        await approveAdminUserApi(editingUser.id, {
          grants: proposals,
          defaultShopId: firstScoped?.shopId ?? null,
          defaultWarehouseId: firstScoped?.warehouseId ?? null
        });
        setActionBanner(
          `Đã phê duyệt tài khoản ${editingUser.email} và gán quyền thành công.`
        );
      } else {
        await updateAdminUserGrantsApi(editingUser.id, {
          grants: proposals,
          defaultShopId: firstScoped?.shopId ?? null,
          defaultWarehouseId: firstScoped?.warehouseId ?? null
        });
        setActionBanner(
          `Đã cập nhật phạm vi quyền và làm mới dấu bảo mật phiên cho ${editingUser.email}.`
        );
      }

      setEditingUser(null);
      await loadUsers();
    } catch (err) {
      setModalError(
        err instanceof Error
          ? err.message
          : 'Không thể lưu phân quyền cho tài khoản này.'
      );
    } finally {
      setIsSavingGrants(false);
    }
  };

  const handleLockToggle = async (target: AdminUserSummaryDto) => {
    setBusyUserId(target.id);
    setErrorMsg(null);
    setActionBanner(null);
    try {
      if (target.approvalStatus === 'Locked' || target.isLockedOut) {
        const res = await unlockAdminUserApi(target.id);
        setActionBanner(res.message);
      } else {
        const res = await lockAdminUserApi(target.id);
        setActionBanner(res.message);
      }
      await loadUsers();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể thay đổi trạng thái khóa tài khoản.'
      );
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRevokeSessions = async (target: AdminUserSummaryDto) => {
    setBusyUserId(target.id);
    setErrorMsg(null);
    setActionBanner(null);
    try {
      const res = await revokeAdminUserSessionsApi(target.id);
      setActionBanner(`${res.message} (${target.email})`);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể thu hồi phiên đăng nhập của người dùng.'
      );
    } finally {
      setBusyUserId(null);
    }
  };

  const handleInitiatePasswordReset = async (target: AdminUserSummaryDto) => {
    setBusyUserId(target.id);
    setErrorMsg(null);
    setActionBanner(null);
    setCopiedToken(false);
    try {
      const res = await initiateAdminPasswordResetApi(target.id);
      setResetResult(res);
      await loadUsers();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể khởi tạo mã đặt lại mật khẩu cho người dùng.'
      );
    } finally {
      setBusyUserId(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <div>
      <div className="surface-card">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Quản trị người dùng &amp; Duyệt tài khoản</h1>
            <p className="page-subtitle">
              Duyệt nhân viên tự đăng ký, phân quyền theo phạm vi Shop/Kho (tuân thủ trần
              quyền Grant Ceiling), khóa tài khoản, thu hồi phiên và cấp mã đặt lại mật
              khẩu nội bộ.
            </p>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="segmented-tabs" role="tablist" aria-label="Lọc trạng thái tài khoản">
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === ''}
              className={`segmented-tab${statusFilter === '' ? ' active' : ''}`}
              onClick={() => {
                setStatusFilter('');
                setPage(1);
              }}
            >
              Tất cả
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === 'PendingApproval'}
              className={`segmented-tab${
                statusFilter === 'PendingApproval' ? ' active' : ''
              }`}
              onClick={() => {
                setStatusFilter('PendingApproval');
                setPage(1);
              }}
            >
              Chờ duyệt
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === 'Active'}
              className={`segmented-tab${
                statusFilter === 'Active' ? ' active' : ''
              }`}
              onClick={() => {
                setStatusFilter('Active');
                setPage(1);
              }}
            >
              Đang hoạt động
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === 'Locked'}
              className={`segmented-tab${
                statusFilter === 'Locked' ? ' active' : ''
              }`}
              onClick={() => {
                setStatusFilter('Locked');
                setPage(1);
              }}
            >
              Đã khóa
            </button>
          </div>
        </div>

        <form
          style={{
            marginTop: 14,
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            alignItems: 'flex-end'
          }}
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setAppliedQuery(searchQuery);
          }}
        >
          <div style={{ flex: '1 1 240px' }}>
            <label htmlFor="admin-user-search" className="form-label">
              Tìm theo họ tên hoặc email
            </label>
            <input
              id="admin-user-search"
              type="text"
              className="form-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Ví dụ: operator@congty.vn"
            />
          </div>

          <div style={{ minWidth: 210 }}>
            <label htmlFor="admin-user-shop-filter" className="form-label">
              Lọc theo Shop
            </label>
            <select
              id="admin-user-shop-filter"
              className="form-input"
              value={shopFilter}
              onChange={(e) => {
                setShopFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Tất cả Shop quản lý</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </div>

          <button type="submit" className="btn btn-primary">
            Lọc danh sách
          </button>
        </form>
      </div>

      {actionBanner && (
        <div className="alert alert-success" role="status">
          {actionBanner}
        </div>
      )}

      {errorMsg && (
        <div className="alert alert-error" role="alert">
          {errorMsg}
        </div>
      )}

      <div className="surface-card">
        {isLoading ? (
          <div role="status" style={{ color: 'var(--color-text-muted)' }}>
            Đang tải danh sách tài khoản...
          </div>
        ) : users.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
            Không có tài khoản nào khớp với bộ lọc hiện tại.
          </p>
        ) : (
          <>
            <div className="desktop-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Nhân viên</th>
                    <th>Trạng thái &amp; Bảo mật</th>
                    <th>Vai trò &amp; Phạm vi được cấp</th>
                    <th>Thời gian tạo</th>
                    <th>Quản trị</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const statusBadge = getApprovalStatusBadge(u.approvalStatus);
                    const isSelf = u.id === currentUser?.id;
                    const isBusy = busyUserId === u.id;

                    return (
                      <tr key={u.id}>
                        <td>
                          <strong>{u.fullName}</strong>
                          <div
                            style={{
                              fontSize: '0.84rem',
                              color: 'var(--color-text-muted)'
                            }}
                          >
                            {u.email}
                          </div>
                        </td>
                        <td>
                          <div className="badge-cluster">
                            <span className={statusBadge.className}>
                              {statusBadge.label}
                            </span>
                            {u.twoFactorEnabled && (
                              <span className="status-pill status-pill-ready">
                                Đã bật 2FA
                              </span>
                            )}
                            {u.forcePasswordReset && (
                              <span className="status-pill status-pill-starting">
                                Chờ đổi mật khẩu
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          {u.grants.length === 0 ? (
                            <span
                              style={{
                                fontSize: '0.84rem',
                                color: 'var(--color-text-muted)'
                              }}
                            >
                              Chưa gán vai trò
                            </span>
                          ) : (
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 4,
                                fontSize: '0.84rem'
                              }}
                            >
                              {u.grants.map((g) => (
                                <div key={g.id}>
                                  <strong>{g.roleName}</strong> •{' '}
                                  {getScopeTypeLabel(g.scopeType)}
                                  {g.shopName ? ` (${g.shopName}` : ''}
                                  {g.shopName && g.warehouseName
                                    ? ` / ${g.warehouseName})`
                                    : g.shopName
                                      ? ')'
                                      : ''}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td>{formatHoChiMinhDateTime(u.createdAtUtc)}</td>
                        <td>
                          <div className="badge-cluster">
                            {u.approvalStatus === 'PendingApproval' ? (
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ padding: '6px 12px' }}
                                disabled={isBusy}
                                onClick={() => openGrantsModal(u, 'approve')}
                              >
                                Duyệt &amp; Gán quyền
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-outline"
                                style={{ padding: '6px 12px' }}
                                disabled={isBusy || isSelf}
                                onClick={() => openGrantsModal(u, 'grants')}
                              >
                                Phân quyền
                              </button>
                            )}

                            {!isSelf && u.approvalStatus !== 'PendingApproval' && (
                              <button
                                type="button"
                                className={`btn ${
                                  u.approvalStatus === 'Locked' || u.isLockedOut
                                    ? 'btn-navy'
                                    : 'btn-danger'
                                }`}
                                style={{ padding: '6px 12px' }}
                                disabled={isBusy}
                                onClick={() => void handleLockToggle(u)}
                              >
                                {u.approvalStatus === 'Locked' || u.isLockedOut
                                  ? 'Mở khóa'
                                  : 'Khóa'}
                              </button>
                            )}

                            {!isSelf && u.approvalStatus === 'Active' && (
                              <button
                                type="button"
                                className="btn btn-outline"
                                style={{ padding: '6px 12px' }}
                                disabled={isBusy}
                                onClick={() => void handleRevokeSessions(u)}
                              >
                                Thu hồi phiên
                              </button>
                            )}

                            {!isSelf && (
                              <button
                                type="button"
                                className="btn btn-outline"
                                style={{ padding: '6px 12px' }}
                                disabled={isBusy}
                                onClick={() => void handleInitiatePasswordReset(u)}
                              >
                                Cấp mã đổi MK
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mobile-card-list mobile-card-list-hide-desktop">
              {users.map((u) => {
                const statusBadge = getApprovalStatusBadge(u.approvalStatus);
                const isSelf = u.id === currentUser?.id;
                const isBusy = busyUserId === u.id;

                return (
                  <div key={u.id} className="mobile-data-card">
                    <div className="page-header-row">
                      <div>
                        <strong>{u.fullName}</strong>
                        <div
                          style={{
                            fontSize: '0.84rem',
                            color: 'var(--color-text-muted)'
                          }}
                        >
                          {u.email}
                        </div>
                      </div>
                      <span className={statusBadge.className}>
                        {statusBadge.label}
                      </span>
                    </div>

                    <div style={{ fontSize: '0.85rem' }}>
                      {u.grants.length === 0
                        ? 'Chưa được gán phạm vi vai trò.'
                        : u.grants
                            .map(
                              (g) =>
                                `${g.roleName} (${getScopeTypeLabel(g.scopeType)}${
                                  g.shopName ? ` - ${g.shopName}` : ''
                                })`
                            )
                            .join(' • ')}
                    </div>

                    <div className="badge-cluster">
                      {u.approvalStatus === 'PendingApproval' ? (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={isBusy}
                          onClick={() => openGrantsModal(u, 'approve')}
                        >
                          Duyệt &amp; Gán quyền
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-outline"
                          disabled={isBusy || isSelf}
                          onClick={() => openGrantsModal(u, 'grants')}
                        >
                          Phân quyền
                        </button>
                      )}

                      {!isSelf && u.approvalStatus !== 'PendingApproval' && (
                        <button
                          type="button"
                          className="btn btn-outline"
                          disabled={isBusy}
                          onClick={() => void handleLockToggle(u)}
                        >
                          {u.approvalStatus === 'Locked' || u.isLockedOut
                            ? 'Mở khóa'
                            : 'Khóa'}
                        </button>
                      )}

                      {!isSelf && (
                        <button
                          type="button"
                          className="btn btn-outline"
                          disabled={isBusy}
                          onClick={() => void handleInitiatePasswordReset(u)}
                        >
                          Cấp mã đổi MK
                        </button>
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

      {/* Approve / Edit Grants Modal */}
      {editingUser && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card modal-card-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-grants-modal-title"
          >
            <h2
              id="user-grants-modal-title"
              style={{ marginTop: 0, fontSize: '1.16rem' }}
            >
              {modalMode === 'approve'
                ? `Duyệt & Phân quyền cho ${editingUser.fullName}`
                : `Cập nhật vai trò & phạm vi cho ${editingUser.fullName}`}
            </h2>
            <p style={{ fontSize: '0.86rem', color: 'var(--color-text-muted)' }}>
              Tài khoản: <strong>{editingUser.email}</strong>. Bạn chỉ có thể gán các vai
              trò và phạm vi nằm trong giới hạn quyền hạn hiện có của mình (Grant Ceiling).
            </p>

            <form onSubmit={(e) => void handleSaveGrantsSubmit(e)}>
              <div className="mobile-card-list" style={{ marginBottom: 12 }}>
                {grantRows.map((row, idx) => {
                  const selectedShop = shops.find((s) => s.id === row.shopId);
                  const whList = selectedShop?.warehouses ?? [];
                  const selectedRole = assignableRoles.find(
                    (r) => r.id === row.roleId
                  );
                  const canSelectAllScope =
                    Boolean(currentUser?.isSuperAdmin) &&
                    selectedRole?.name === 'SuperAdmin';

                  return (
                    <div key={row.rowKey} className="mobile-data-card">
                      <div className="page-header-row">
                        <strong>Phạm vi phân quyền #{idx + 1}</strong>
                        {grantRows.length > 1 && (
                          <button
                            type="button"
                            className="btn btn-outline"
                            style={{ padding: '4px 10px', minHeight: 36 }}
                            onClick={() => handleRemoveGrantRow(row.rowKey)}
                          >
                            Xóa dòng
                          </button>
                        )}
                      </div>

                      <div className="shop-warehouse-grid">
                        <div>
                          <label className="form-label">Vai trò</label>
                          <select
                            className="form-input"
                            value={row.roleId}
                            onChange={(e) =>
                              handleUpdateGrantRow(row.rowKey, {
                                roleId: e.target.value
                              })
                            }
                          >
                            {assignableRoles.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                                {r.isSystemRole ? ' (Hệ thống)' : ' (Tùy chỉnh)'}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="form-label">Cấp độ phạm vi</label>
                          <select
                            className="form-input"
                            value={row.scopeType}
                            onChange={(e) =>
                              handleUpdateGrantRow(row.rowKey, {
                                scopeType: e.target.value as ScopeType
                              })
                            }
                          >
                            <option value="Own">
                              Cá nhân — Chỉ bản ghi của chính mình (Own)
                            </option>
                            <option value="Warehouse">
                              Theo Kho cụ thể (Warehouse)
                            </option>
                            <option value="Shop">Theo toàn bộ Shop (Shop)</option>
                            {canSelectAllScope && (
                              <option value="All">
                                Toàn hệ thống (Chỉ SuperAdmin)
                              </option>
                            )}
                          </select>
                        </div>

                        {row.scopeType !== 'All' && (
                          <div>
                            <label className="form-label">Shop áp dụng</label>
                            <select
                              className="form-input"
                              value={row.shopId}
                              onChange={(e) =>
                                handleUpdateGrantRow(row.rowKey, {
                                  shopId: e.target.value
                                })
                              }
                            >
                              <option value="">-- Chọn Shop --</option>
                              {shops.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} ({s.code})
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        {(row.scopeType === 'Warehouse' ||
                          row.scopeType === 'Own') && (
                          <div>
                            <label className="form-label">
                              Kho áp dụng{' '}
                              {row.scopeType === 'Own' ? '(Tùy chọn)' : '(Bắt buộc)'}
                            </label>
                            <select
                              className="form-input"
                              value={row.warehouseId}
                              onChange={(e) =>
                                handleUpdateGrantRow(row.rowKey, {
                                  warehouseId: e.target.value
                                })
                              }
                            >
                              {row.scopeType === 'Own' && (
                                <option value="">Tất cả kho thuộc Shop</option>
                              )}
                              {whList.map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.name} ({w.code})
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                className="btn btn-outline"
                onClick={handleAddGrantRow}
              >
                + Thêm phạm vi vai trò
              </button>

              {modalError && (
                <div className="alert alert-error" role="alert" style={{ marginTop: 12 }}>
                  {modalError}
                </div>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setEditingUser(null)}
                  disabled={isSavingGrants}
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSavingGrants}
                >
                  {isSavingGrants
                    ? 'Đang lưu...'
                    : modalMode === 'approve'
                      ? 'Phê duyệt & Lưu quyền'
                      : 'Lưu cập nhật quyền'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Controlled One-Time Password Reset Token Modal */}
      {resetResult && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card modal-card-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-token-modal-title"
          >
            <h2
              id="reset-token-modal-title"
              style={{ marginTop: 0, fontSize: '1.15rem' }}
            >
              Mã đặt lại mật khẩu một lần (Nội bộ an toàn)
            </h2>
            <p style={{ fontSize: '0.88rem', color: 'var(--color-text-muted)' }}>
              {resetResult.message}
            </p>

            <div className="alert alert-warning">
              <strong>Lưu ý bảo mật:</strong> Mã này chỉ hiển thị một lần duy nhất trên
              màn hình HTTPS hiện tại và không được lưu dạng rõ trong nhật ký hệ thống.
              Nhân viên nhập mã này tại trang <code>/reset-password</code> cùng địa chỉ
              email <strong>{resetResult.email}</strong>.
            </div>

            <div className="form-group">
              <div className="form-label">Mã khôi phục một lần</div>
              <div className="code-box">{resetResult.resetToken}</div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-navy"
                onClick={async () => {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(resetResult.resetToken);
                    setCopiedToken(true);
                  }
                }}
              >
                {copiedToken ? 'Đã sao chép mã!' : 'Sao chép mã khôi phục'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setResetResult(null)}
              >
                Đã ghi nhận &amp; Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
