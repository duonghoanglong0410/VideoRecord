import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Unlock,
  UserCheck,
  UserPlus,
  Users,
  X
} from 'lucide-react';
import { useAuth } from '../../app/authStore';
import {
  formatHoChiMinhDateTime,
  getApprovalStatusBadge,
  getScopeTypeLabel
} from '../../app/formatters';
import type { ApprovalStatus, ScopeType } from '../../app/types';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { SYSTEM_ROLE_VIETNAMESE_TITLES } from '../../shared/labels/permissionLabels';
import {
  fetchAccessibleShops,
  type ShopOption
} from '../recording/recordingApi';
import {
  approveAdminUserApi,
  createAdminUserApi,
  initiateAdminPasswordResetApi,
  listAdminRolesApi,
  listAdminUsersApi,
  lockAdminUserApi,
  revokeAdminUserSessionsApi,
  setAdminUserPasswordDirectApi,
  unlockAdminUserApi,
  updateAdminUserGrantsApi,
  updateAdminUserProfileApi,
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

  // Direct Create User Modal state
  const [isCreateUserOpen, setIsCreateUserOpen] = useState<boolean>(false);
  const [newFullName, setNewFullName] = useState<string>('');
  const [newEmail, setNewEmail] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [showNewPassword, setShowNewPassword] = useState<boolean>(false);
  const [newRoleId, setNewRoleId] = useState<string>('');
  const [newShopId, setNewShopId] = useState<string>('');
  const [newWarehouseId, setNewWarehouseId] = useState<string>('');
  const [newForceReset, setNewForceReset] = useState<boolean>(false);
  const [isCreatingUser, setIsCreatingUser] = useState<boolean>(false);
  const [createUserError, setCreateUserError] = useState<string | null>(null);

  // Edit User Profile Modal state
  const [profileUser, setProfileUser] = useState<AdminUserSummaryDto | null>(null);
  const [editFullName, setEditFullName] = useState<string>('');
  const [editDefaultShopId, setEditDefaultShopId] = useState<string>('');
  const [editDefaultWarehouseId, setEditDefaultWarehouseId] = useState<string>('');
  const [isSavingProfile, setIsSavingProfile] = useState<boolean>(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Direct Set Password Modal state
  const [directPwdUser, setDirectPwdUser] = useState<AdminUserSummaryDto | null>(
    null
  );
  const [directPwdInput, setDirectPwdInput] = useState<string>('');
  const [showDirectPwd, setShowDirectPwd] = useState<boolean>(false);
  const [directPwdForceReset, setDirectPwdForceReset] = useState<boolean>(false);
  const [isSettingDirectPwd, setIsSettingDirectPwd] = useState<boolean>(false);
  const [directPwdError, setDirectPwdError] = useState<string | null>(null);

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
      setModalError('Vui lòng gán ít nhất 1 phạm vi vai trò cho nhân viên.');
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
          setModalError('Phạm vi Cá nhân yêu cầu gắn với ít nhất một Shop.');
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
          `Đã duyệt kích hoạt tài khoản ${editingUser.email} và gán quyền thành công.`
        );
      } else {
        await updateAdminUserGrantsApi(editingUser.id, {
          grants: proposals,
          defaultShopId: firstScoped?.shopId ?? null,
          defaultWarehouseId: firstScoped?.warehouseId ?? null
        });
        setActionBanner(
          `Đã cập nhật quyền làm việc cho tài khoản ${editingUser.email}.`
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
          : 'Không thể đăng xuất tài khoản khỏi các thiết bị.'
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
          : 'Không thể cấp mã đặt lại mật khẩu cho nhân viên.'
      );
    } finally {
      setBusyUserId(null);
    }
  };

  const openCreateUserModal = () => {
    const defaultRole =
      assignableRoles.find((r) => r.name === 'Operator') ?? assignableRoles[0];
    const defaultShop = shops[0];
    const defaultWh = defaultShop?.warehouses[0];

    setNewFullName('');
    setNewEmail('');
    setNewPassword('');
    setShowNewPassword(false);
    setNewRoleId(defaultRole?.id ?? '');
    setNewShopId(defaultShop?.id ?? '');
    setNewWarehouseId(defaultWh?.id ?? '');
    setNewForceReset(false);
    setCreateUserError(null);
    setIsCreateUserOpen(true);
  };

  const handleCreateUserSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setCreateUserError(null);

    const selectedRole = assignableRoles.find((r) => r.id === newRoleId);
    if (!selectedRole) {
      setCreateUserError('Vui lòng chọn vai trò công việc cho tài khoản mới.');
      return;
    }

    const isSuperRole = selectedRole.name === 'SuperAdmin';
    if (!isSuperRole && !newShopId) {
      setCreateUserError('Vui lòng chọn Shop làm việc cho nhân viên.');
      return;
    }

    const grant: GrantProposalDto = isSuperRole
      ? {
          roleId: selectedRole.id,
          scopeType: 'All',
          shopId: null,
          warehouseId: null
        }
      : newWarehouseId
        ? {
            roleId: selectedRole.id,
            scopeType: 'Warehouse',
            shopId: newShopId,
            warehouseId: newWarehouseId
          }
        : {
            roleId: selectedRole.id,
            scopeType: 'Shop',
            shopId: newShopId,
            warehouseId: null
          };

    setIsCreatingUser(true);
    try {
      const created = await createAdminUserApi({
        fullName: newFullName.trim(),
        email: newEmail.trim(),
        password: newPassword,
        grants: [grant],
        defaultShopId: isSuperRole ? null : newShopId || null,
        defaultWarehouseId: isSuperRole ? null : newWarehouseId || null,
        forcePasswordReset: newForceReset
      });
      setIsCreateUserOpen(false);
      setActionBanner(
        `Đã tạo và kích hoạt tài khoản cho "${created.fullName}" (${created.email}). Nhân viên có thể đăng nhập làm việc ngay.`
      );
      await loadUsers();
    } catch (err) {
      setCreateUserError(
        err instanceof Error ? err.message : 'Không thể tạo tài khoản mới.'
      );
    } finally {
      setIsCreatingUser(false);
    }
  };

  const openEditProfileModal = (target: AdminUserSummaryDto) => {
    setProfileUser(target);
    setEditFullName(target.fullName);
    setEditDefaultShopId(target.defaultShopId ?? '');
    setEditDefaultWarehouseId(target.defaultWarehouseId ?? '');
    setProfileError(null);
  };

  const handleEditProfileSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!profileUser) {
      return;
    }
    setProfileError(null);
    setIsSavingProfile(true);
    try {
      await updateAdminUserProfileApi(profileUser.id, {
        fullName: editFullName.trim(),
        defaultShopId: editDefaultShopId || null,
        defaultWarehouseId: editDefaultWarehouseId || null
      });
      setProfileUser(null);
      setActionBanner(`Đã cập nhật thông tin tài khoản "${editFullName.trim()}".`);
      await loadUsers();
    } catch (err) {
      setProfileError(
        err instanceof Error
          ? err.message
          : 'Không thể cập nhật thông tin tài khoản.'
      );
    } finally {
      setIsSavingProfile(false);
    }
  };

  const openDirectPwdModal = (target: AdminUserSummaryDto) => {
    setDirectPwdUser(target);
    setDirectPwdInput('');
    setShowDirectPwd(false);
    setDirectPwdForceReset(false);
    setDirectPwdError(null);
  };

  const handleDirectPwdSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!directPwdUser) {
      return;
    }
    setDirectPwdError(null);
    setIsSettingDirectPwd(true);
    try {
      const res = await setAdminUserPasswordDirectApi(directPwdUser.id, {
        newPassword: directPwdInput,
        forcePasswordReset: directPwdForceReset
      });
      setDirectPwdUser(null);
      setActionBanner(res.message);
      await loadUsers();
    } catch (err) {
      setDirectPwdError(
        err instanceof Error ? err.message : 'Không thể đặt mật khẩu mới.'
      );
    } finally {
      setIsSettingDirectPwd(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const pendingInCurrentList = users.filter(
    (u) => u.approvalStatus === 'PendingApproval'
  ).length;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
        <PageHeader
          title="Quản lý tài khoản — Quản trị người dùng"
          subtitle="Tạo tài khoản nhân viên mới, duyệt đăng ký, phân công Shop / Kho và hỗ trợ đổi mật khẩu."
          actions={
            <button
              type="button"
              onClick={openCreateUserModal}
              className="btn btn-primary inline-flex cursor-pointer items-center gap-1.5"
            >
              <UserPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Tạo tài khoản mới</span>
            </button>
          }
        />

        {/* Status Tabs */}
        <div className="mt-4">
          <div
            className="segmented-tabs"
            role="tablist"
            aria-label="Lọc trạng thái tài khoản"
          >
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === ''}
              className={`segmented-tab cursor-pointer ${
                statusFilter === '' ? 'active' : ''
              }`}
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
              className={`segmented-tab inline-flex cursor-pointer items-center gap-1.5 ${
                statusFilter === 'PendingApproval' ? 'active' : ''
              }`}
              onClick={() => {
                setStatusFilter('PendingApproval');
                setPage(1);
              }}
            >
              <span>Chờ duyệt</span>
              {pendingInCurrentList > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-bold text-white">
                  {pendingInCurrentList}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={statusFilter === 'Active'}
              className={`segmented-tab cursor-pointer ${
                statusFilter === 'Active' ? 'active' : ''
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
              className={`segmented-tab cursor-pointer ${
                statusFilter === 'Locked' ? 'active' : ''
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

        {/* Search & Shop Filter */}
        <form
          className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setAppliedQuery(searchQuery);
          }}
        >
          <div className="flex-1">
            <label
              htmlFor="admin-user-search"
              className="mb-1 block text-xs font-semibold text-slate-700"
            >
              Tìm theo họ tên hoặc email
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="admin-user-search"
                type="text"
                className="form-input pl-10"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Nhập họ tên hoặc email nhân viên..."
              />
            </div>
          </div>

          <div className="sm:w-56">
            <label
              htmlFor="admin-user-shop-filter"
              className="mb-1 block text-xs font-semibold text-slate-700"
            >
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

          <button
            type="submit"
            className="btn btn-primary inline-flex items-center justify-center gap-1.5"
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Lọc danh sách</span>
          </button>
        </form>
      </div>

      {actionBanner && (
        <div
          className="flex items-start gap-2.5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"
          role="status"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <span>{actionBanner}</span>
        </div>
      )}

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
            <span>Đang tải danh sách nhân sự...</span>
          </div>
        ) : users.length === 0 ? (
          <EmptyState
            icon={<Users className="h-6 w-6" />}
            title="Không tìm thấy tài khoản nào"
            description="Hiện chưa có nhân sự nào khớp với điều kiện lọc."
          />
        ) : (
          <>
            <div className="desktop-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Nhân viên</th>
                    <th>Trạng thái</th>
                    <th>Vai trò &amp; Khu vực làm việc</th>
                    <th>Ngày đăng ký</th>
                    <th>Thao tác</th>
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
                          <div className="font-semibold text-slate-900">
                            {u.fullName}
                          </div>
                          <div className="text-xs text-slate-500">{u.email}</div>
                        </td>

                        <td>
                          <div className="badge-cluster">
                            <span className={statusBadge.className}>
                              {statusBadge.label}
                            </span>
                            {u.twoFactorEnabled && (
                              <span className="status-pill status-pill-ready">
                                Bảo mật 2 lớp
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
                            <span className="text-xs text-slate-400">
                              Chưa phân công vai trò
                            </span>
                          ) : (
                            <div className="space-y-1 text-xs">
                              {u.grants.map((g) => {
                                const friendlyRole =
                                  SYSTEM_ROLE_VIETNAMESE_TITLES[g.roleName];
                                return (
                                  <div key={g.id} className="text-slate-700">
                                    <strong className="text-slate-900">
                                      {g.roleName}
                                    </strong>
                                    {friendlyRole ? ` (${friendlyRole})` : ''} •{' '}
                                    {getScopeTypeLabel(g.scopeType)}
                                    {g.shopName ? ` — ${g.shopName}` : ''}
                                    {g.warehouseName ? ` / ${g.warehouseName}` : ''}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </td>

                        <td className="whitespace-nowrap text-xs text-slate-600">
                          {formatHoChiMinhDateTime(u.createdAtUtc)}
                        </td>

                        <td>
                          <div className="flex flex-wrap items-center gap-2">
                            {u.approvalStatus === 'PendingApproval' ? (
                              <button
                                type="button"
                                className="btn btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                                disabled={isBusy}
                                onClick={() => openGrantsModal(u, 'approve')}
                              >
                                <UserCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span>Duyệt &amp; Gán quyền</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-outline inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                                disabled={isBusy || isSelf}
                                onClick={() => openGrantsModal(u, 'grants')}
                              >
                                <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span>Phân quyền</span>
                              </button>
                            )}

                            {!isSelf && (
                              <details className="relative">
                                <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                                  <span>Khác</span>
                                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                                </summary>
                                <div className="mt-1.5 flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-1.5 shadow-md">
                                  <button
                                    type="button"
                                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                                    disabled={isBusy}
                                    onClick={() => openEditProfileModal(u)}
                                  >
                                    <Edit3 className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                                    <span>Sửa họ tên &amp; Kho mặc định</span>
                                  </button>

                                  <button
                                    type="button"
                                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                                    disabled={isBusy}
                                    onClick={() => openDirectPwdModal(u)}
                                  >
                                    <KeyRound className="h-3.5 w-3.5 text-blue-600" aria-hidden="true" />
                                    <span>Đặt mật khẩu mới trực tiếp</span>
                                  </button>

                                  <button
                                    type="button"
                                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                                    disabled={isBusy}
                                    onClick={() => void handleInitiatePasswordReset(u)}
                                  >
                                    <KeyRound className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                                    <span>Cấp mã đổi mật khẩu 1 lần</span>
                                  </button>

                                  {u.approvalStatus === 'Active' && (
                                    <button
                                      type="button"
                                      className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                                      disabled={isBusy}
                                      onClick={() => void handleRevokeSessions(u)}
                                    >
                                      <LogOut className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                                      <span>Đăng xuất mọi thiết bị</span>
                                    </button>
                                  )}

                                  {u.approvalStatus !== 'PendingApproval' && (
                                    <button
                                      type="button"
                                      className={`inline-flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-semibold hover:bg-slate-100 disabled:opacity-50 ${
                                        u.approvalStatus === 'Locked' || u.isLockedOut
                                          ? 'text-emerald-700'
                                          : 'text-red-600'
                                      }`}
                                      disabled={isBusy}
                                      onClick={() => void handleLockToggle(u)}
                                    >
                                      {u.approvalStatus === 'Locked' || u.isLockedOut ? (
                                        <>
                                          <Unlock className="h-3.5 w-3.5" aria-hidden="true" />
                                          <span>Mở khóa tài khoản</span>
                                        </>
                                      ) : (
                                        <>
                                          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                                          <span>Khóa tài khoản</span>
                                        </>
                                      )}
                                    </button>
                                  )}
                                </div>
                              </details>
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
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <strong className="text-slate-900">{u.fullName}</strong>
                        <div className="text-xs text-slate-500">{u.email}</div>
                      </div>
                      <span className={statusBadge.className}>
                        {statusBadge.label}
                      </span>
                    </div>

                    <div className="text-xs text-slate-700">
                      {u.grants.length === 0
                        ? 'Chưa được phân công vai trò.'
                        : u.grants
                            .map(
                              (g) =>
                                `${g.roleName} (${getScopeTypeLabel(g.scopeType)}${
                                  g.shopName ? ` - ${g.shopName}` : ''
                                })`
                            )
                            .join(' • ')}
                    </div>

                    <div className="flex flex-wrap gap-2 pt-1">
                      {u.approvalStatus === 'PendingApproval' ? (
                        <button
                          type="button"
                          className="btn btn-primary text-xs"
                          disabled={isBusy}
                          onClick={() => openGrantsModal(u, 'approve')}
                        >
                          Duyệt &amp; Gán quyền
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-outline text-xs"
                          disabled={isBusy || isSelf}
                          onClick={() => openGrantsModal(u, 'grants')}
                        >
                          Phân quyền
                        </button>
                      )}

                      {!isSelf && u.approvalStatus !== 'PendingApproval' && (
                        <button
                          type="button"
                          className="btn btn-outline text-xs"
                          disabled={isBusy}
                          onClick={() => void handleLockToggle(u)}
                        >
                          {u.approvalStatus === 'Locked' || u.isLockedOut
                            ? 'Mở khóa'
                            : 'Khóa'}
                        </button>
                      )}

                      {!isSelf && (
                        <>
                          <button
                            type="button"
                            className="btn btn-outline text-xs"
                            disabled={isBusy}
                            onClick={() => openEditProfileModal(u)}
                          >
                            Sửa thông tin
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline text-xs"
                            disabled={isBusy}
                            onClick={() => openDirectPwdModal(u)}
                          >
                            Đặt mật khẩu mới
                          </button>
                        </>
                      )}
                    </div>
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

      {/* Approve / Edit Grants Modal (Exact 3-select order preserved for Playwright E2E) */}
      {editingUser && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card modal-card-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-grants-modal-title"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2
                  id="user-grants-modal-title"
                  className="m-0 text-base font-bold text-slate-900 sm:text-lg"
                >
                  {modalMode === 'approve'
                    ? `Duyệt & Phân quyền cho ${editingUser.fullName}`
                    : `Cập nhật quyền làm việc cho ${editingUser.fullName}`}
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-slate-600">
                  Tài khoản: <strong>{editingUser.email}</strong> — Chọn công việc và
                  Shop / Kho được phép truy cập.
                </p>
              </div>
              <button
                type="button"
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                onClick={() => setEditingUser(null)}
                disabled={isSavingGrants}
                aria-label="Đóng hộp thoại"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <form className="mt-4" onSubmit={(e) => void handleSaveGrantsSubmit(e)}>
              <div className="space-y-3">
                {grantRows.map((row, idx) => {
                  const selectedShop = shops.find((s) => s.id === row.shopId);
                  const whList = selectedShop?.warehouses ?? [];
                  const selectedRole = assignableRoles.find(
                    (r) => r.id === row.roleId
                  );
                  const canSelectAllScope =
                    Boolean(currentUser?.isSuperAdmin) &&
                    selectedRole?.name === 'SuperAdmin';
                  const friendlyRoleTitle = selectedRole
                    ? SYSTEM_ROLE_VIETNAMESE_TITLES[selectedRole.name]
                    : undefined;

                  return (
                    <div
                      key={row.rowKey}
                      className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5"
                    >
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <strong className="text-xs font-bold text-slate-800 uppercase">
                          Phân công khu vực #{idx + 1}
                        </strong>
                        {grantRows.length > 1 && (
                          <button
                            type="button"
                            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                            onClick={() => handleRemoveGrantRow(row.rowKey)}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Xóa dòng</span>
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-xs font-semibold text-slate-700">
                            Vai trò công việc
                          </label>
                          <select
                            className="form-input bg-white"
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
                          {friendlyRoleTitle && (
                            <div className="mt-1 text-[11px] text-slate-500">
                              Chức danh: <strong>{friendlyRoleTitle}</strong>
                            </div>
                          )}
                        </div>

                        <div>
                          <label className="mb-1 block text-xs font-semibold text-slate-700">
                            Phạm vi dữ liệu được xem
                          </label>
                          <select
                            className="form-input bg-white"
                            value={row.scopeType}
                            onChange={(e) =>
                              handleUpdateGrantRow(row.rowKey, {
                                scopeType: e.target.value as ScopeType
                              })
                            }
                          >
                            <option value="Own">
                              Cá nhân — Chỉ đơn do chính mình quay
                            </option>
                            <option value="Warehouse">
                              Theo Kho cụ thể
                            </option>
                            <option value="Shop">Theo toàn bộ Shop</option>
                            {canSelectAllScope && (
                              <option value="All">
                                Toàn hệ thống (Quản trị cao nhất)
                              </option>
                            )}
                          </select>
                        </div>

                        {row.scopeType !== 'All' && (
                          <div>
                            <label className="mb-1 block text-xs font-semibold text-slate-700">
                              Shop áp dụng
                            </label>
                            <select
                              className="form-input bg-white"
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
                            <label className="mb-1 block text-xs font-semibold text-slate-700">
                              Kho đóng gói{' '}
                              {row.scopeType === 'Own' ? '(Tùy chọn)' : '(Bắt buộc)'}
                            </label>
                            <select
                              className="form-input bg-white"
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
                className="btn btn-outline mt-3 inline-flex items-center gap-1.5 text-xs"
                onClick={handleAddGrantRow}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Thêm khu vực làm việc khác</span>
              </button>

              {modalError && (
                <div
                  className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
                  <span>{modalError}</span>
                </div>
              )}

              <div className="modal-actions mt-5">
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
            className="modal-card max-w-lg"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-token-modal-title"
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                <KeyRound className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2
                  id="reset-token-modal-title"
                  className="m-0 text-base font-bold text-slate-900"
                >
                  Mã đặt lại mật khẩu một lần
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-slate-600">
                  {resetResult.message}
                </p>
              </div>
            </div>

            <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              <div>
                <strong>Lưu ý:</strong> Mã này chỉ hiện một lần duy nhất. Hãy sao chép và
                gửi cho nhân viên nhập tại trang Đặt lại mật khẩu cùng email{' '}
                <strong>{resetResult.email}</strong>.
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-1.5 text-xs font-semibold text-slate-700">
                Mã khôi phục một lần
              </div>
              <div className="code-box select-all font-mono text-sm">
                {resetResult.resetToken}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className="btn btn-navy inline-flex items-center gap-1.5"
                onClick={async () => {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(resetResult.resetToken);
                    setCopiedToken(true);
                  }
                }}
              >
                {copiedToken ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                    <span>Đã sao chép mã!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    <span>Sao chép mã khôi phục</span>
                  </>
                )}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setResetResult(null)}
              >
                Đã gửi &amp; Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Direct Create Account Modal */}
      {isCreateUserOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isCreatingUser) {
              setIsCreateUserOpen(false);
            }
          }}
        >
          <div
            className="modal-card modal-card-wide max-h-[90vh] overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-user-modal-title"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
              <div>
                <h2
                  id="create-user-modal-title"
                  className="m-0 text-lg font-bold text-slate-900"
                >
                  Tạo tài khoản nhân viên mới
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-slate-600">
                  Tài khoản được kích hoạt ngay lập tức — nhân viên có thể đăng nhập làm việc ngay mà không cần chờ duyệt.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateUserOpen(false)}
                disabled={isCreatingUser}
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => void handleCreateUserSubmit(e)}
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="create-user-fullname"
                    className="mb-1 block text-xs font-semibold text-slate-700"
                  >
                    Họ và tên nhân viên <span className="text-red-600">*</span>
                  </label>
                  <input
                    id="create-user-fullname"
                    type="text"
                    className="form-input"
                    maxLength={200}
                    value={newFullName}
                    onChange={(e) => setNewFullName(e.target.value)}
                    placeholder="Ví dụ: Nguyễn Văn An"
                    required
                  />
                </div>

                <div>
                  <label
                    htmlFor="create-user-email"
                    className="mb-1 block text-xs font-semibold text-slate-700"
                  >
                    Email đăng nhập <span className="text-red-600">*</span>
                  </label>
                  <input
                    id="create-user-email"
                    type="email"
                    className="form-input"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="Ví dụ: an.nguyen@shop.vn"
                    required
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="create-user-password"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Mật khẩu khởi tạo <span className="text-red-600">*</span>
                </label>
                <div className="relative">
                  <input
                    id="create-user-password"
                    type={showNewPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    className="form-input pr-12"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Ví dụ: NhanVien@2026"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword((v) => !v)}
                    className="absolute top-1/2 right-1 inline-flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                    aria-label={showNewPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  >
                    {showNewPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <span className="mt-1 block text-[11px] text-slate-500">
                  Mật khẩu cần tối thiểu 8 ký tự, gồm chữ hoa, chữ thường, chữ số và ký tự đặc biệt (@, #, !...).
                </span>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
                <div className="mb-3 text-xs font-bold text-slate-800">
                  Phân công Vai trò &amp; Nơi làm việc
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label
                      htmlFor="create-user-role"
                      className="mb-1 block text-xs font-semibold text-slate-700"
                    >
                      Vai trò công việc
                    </label>
                    <select
                      id="create-user-role"
                      className="form-input bg-white"
                      value={newRoleId}
                      onChange={(e) => setNewRoleId(e.target.value)}
                      required
                    >
                      {assignableRoles.map((r) => {
                        const vnTitle = SYSTEM_ROLE_VIETNAMESE_TITLES[r.name];
                        return (
                          <option key={r.id} value={r.id}>
                            {vnTitle ? `${vnTitle} (${r.name})` : r.name}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {assignableRoles.find((r) => r.id === newRoleId)?.name !==
                    'SuperAdmin' && (
                    <>
                      <div>
                        <label
                          htmlFor="create-user-shop"
                          className="mb-1 block text-xs font-semibold text-slate-700"
                        >
                          Thuộc Shop
                        </label>
                        <select
                          id="create-user-shop"
                          className="form-input bg-white"
                          value={newShopId}
                          onChange={(e) => {
                            const nextShopId = e.target.value;
                            setNewShopId(nextShopId);
                            const foundShop = shops.find(
                              (s) => s.id === nextShopId
                            );
                            setNewWarehouseId(
                              foundShop?.warehouses[0]?.id ?? ''
                            );
                          }}
                          required
                        >
                          <option value="">-- Chọn Shop --</option>
                          {shops.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} ({s.code})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label
                          htmlFor="create-user-warehouse"
                          className="mb-1 block text-xs font-semibold text-slate-700"
                        >
                          Kho đóng gói
                        </label>
                        <select
                          id="create-user-warehouse"
                          className="form-input bg-white"
                          value={newWarehouseId}
                          onChange={(e) => setNewWarehouseId(e.target.value)}
                        >
                          <option value="">Toàn bộ các Kho trong Shop</option>
                          {(
                            shops.find((s) => s.id === newShopId)?.warehouses ??
                            []
                          ).map((wh) => (
                            <option key={wh.id} value={wh.id}>
                              {wh.name} ({wh.code})
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <label className="flex cursor-pointer items-center gap-2.5 text-xs text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-blue-600"
                  checked={newForceReset}
                  onChange={(e) => setNewForceReset(e.target.checked)}
                />
                <span>
                  Đánh dấu nhắc nhân viên tự đổi sang mật khẩu riêng sau khi nhận tài khoản
                </span>
              </label>

              {createUserError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
                  <span>{createUserError}</span>
                </div>
              )}

              <div className="modal-actions border-t border-slate-200 pt-4">
                <button
                  type="button"
                  className="btn btn-outline cursor-pointer"
                  onClick={() => setIsCreateUserOpen(false)}
                  disabled={isCreatingUser}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn btn-primary cursor-pointer"
                  disabled={isCreatingUser}
                >
                  {isCreatingUser ? 'Đang tạo tài khoản...' : 'Tạo & Kích hoạt ngay'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit User Profile & Default Warehouse Modal */}
      {profileUser && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSavingProfile) {
              setProfileUser(null);
            }
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-profile-modal-title"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <div>
                <h2
                  id="edit-profile-modal-title"
                  className="m-0 text-lg font-bold text-slate-900"
                >
                  Sửa thông tin tài khoản
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-slate-500">
                  {profileUser.email}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setProfileUser(null)}
                disabled={isSavingProfile}
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => void handleEditProfileSubmit(e)}
            >
              <div>
                <label
                  htmlFor="edit-user-fullname"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Họ và tên <span className="text-red-600">*</span>
                </label>
                <input
                  id="edit-user-fullname"
                  type="text"
                  className="form-input"
                  maxLength={200}
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="edit-user-default-shop"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Shop làm việc mặc định khi mở máy quay
                </label>
                <select
                  id="edit-user-default-shop"
                  className="form-input"
                  value={editDefaultShopId}
                  onChange={(e) => {
                    setEditDefaultShopId(e.target.value);
                    setEditDefaultWarehouseId('');
                  }}
                >
                  <option value="">-- Tự động theo phân quyền --</option>
                  {shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </select>
              </div>

              {editDefaultShopId && (
                <div>
                  <label
                    htmlFor="edit-user-default-wh"
                    className="mb-1 block text-xs font-semibold text-slate-700"
                  >
                    Kho đóng gói mặc định
                  </label>
                  <select
                    id="edit-user-default-wh"
                    className="form-input"
                    value={editDefaultWarehouseId}
                    onChange={(e) => setEditDefaultWarehouseId(e.target.value)}
                  >
                    <option value="">-- Tự động chọn kho đầu tiên --</option>
                    {(
                      shops.find((s) => s.id === editDefaultShopId)
                        ?.warehouses ?? []
                    ).map((wh) => (
                      <option key={wh.id} value={wh.id}>
                        {wh.name} ({wh.code})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {profileError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
                  <span>{profileError}</span>
                </div>
              )}

              <div className="modal-actions border-t border-slate-200 pt-4">
                <button
                  type="button"
                  className="btn btn-outline cursor-pointer"
                  onClick={() => setProfileUser(null)}
                  disabled={isSavingProfile}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn btn-primary cursor-pointer"
                  disabled={isSavingProfile}
                >
                  {isSavingProfile ? 'Đang lưu...' : 'Lưu thông tin'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Direct Set Password Modal (1-Step for Non-Tech Staff) */}
      {directPwdUser && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSettingDirectPwd) {
              setDirectPwdUser(null);
            }
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="direct-pwd-modal-title"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <div>
                <h2
                  id="direct-pwd-modal-title"
                  className="m-0 text-lg font-bold text-slate-900"
                >
                  Đặt mật khẩu mới cho nhân viên
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-slate-500">
                  {directPwdUser.fullName} ({directPwdUser.email})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDirectPwdUser(null)}
                disabled={isSettingDirectPwd}
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => void handleDirectPwdSubmit(e)}
            >
              <div>
                <label
                  htmlFor="direct-new-password"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Nhập mật khẩu mới <span className="text-red-600">*</span>
                </label>
                <div className="relative">
                  <input
                    id="direct-new-password"
                    type={showDirectPwd ? 'text' : 'password'}
                    autoComplete="new-password"
                    className="form-input pr-12"
                    value={directPwdInput}
                    onChange={(e) => setDirectPwdInput(e.target.value)}
                    placeholder="Ví dụ: KhoMoi@2026"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowDirectPwd((v) => !v)}
                    className="absolute top-1/2 right-1 inline-flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                    aria-label={showDirectPwd ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  >
                    {showDirectPwd ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <span className="mt-1 block text-[11px] text-slate-500">
                  Tối thiểu 8 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt. Các thiết bị cũ của nhân viên sẽ tự động đăng xuất.
                </span>
              </div>

              <label className="flex cursor-pointer items-center gap-2.5 text-xs text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-blue-600"
                  checked={directPwdForceReset}
                  onChange={(e) => setDirectPwdForceReset(e.target.checked)}
                />
                <span>Nhắc nhân viên tự đổi mật khẩu sau khi đăng nhập</span>
              </label>

              {directPwdError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
                  <span>{directPwdError}</span>
                </div>
              )}

              <div className="modal-actions border-t border-slate-200 pt-4">
                <button
                  type="button"
                  className="btn btn-outline cursor-pointer"
                  onClick={() => setDirectPwdUser(null)}
                  disabled={isSettingDirectPwd}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn btn-primary cursor-pointer"
                  disabled={isSettingDirectPwd}
                >
                  {isSettingDirectPwd ? 'Đang lưu...' : 'Lưu mật khẩu mới'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
