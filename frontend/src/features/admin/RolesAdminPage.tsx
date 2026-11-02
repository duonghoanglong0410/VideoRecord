import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Edit3,
  Loader2,
  Lock,
  Minus,
  Plus,
  Shield,
  Sparkles,
  X
} from 'lucide-react';
import { useAuth } from '../../app/authStore';
import { PageHeader } from '../../components/ui/PageHeader';
import {
  PERMISSION_GROUP_TITLES,
  SYSTEM_ROLE_VIETNAMESE_TITLES,
  getFriendlyPermissionInfo,
  type PermissionFriendlyInfo
} from '../../shared/labels/permissionLabels';
import {
  createCustomRoleApi,
  listAdminPermissionsApi,
  listAdminRolesApi,
  updateCustomRoleApi,
  type PermissionDto,
  type RoleDto
} from './adminApi';

const ORDERED_GROUPS: PermissionFriendlyInfo['group'][] = [
  'packing',
  'video',
  'people',
  'system'
];

export function RolesAdminPage() {
  const { user: currentUser } = useAuth();

  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [permissions, setPermissions] = useState<PermissionDto[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Create / Edit Custom Role modal state
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [editingRole, setEditingRole] = useState<RoleDto | null>(null);
  const [roleNameInput, setRoleNameInput] = useState<string>('');
  const [roleDescInput, setRoleDescInput] = useState<string>('');
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const actorPermSet = useMemo(
    () => new Set(currentUser?.permissions ?? []),
    [currentUser?.permissions]
  );

  const groupedPermissions = useMemo(() => {
    const buckets: Record<PermissionFriendlyInfo['group'], PermissionDto[]> = {
      packing: [],
      video: [],
      people: [],
      system: []
    };
    for (const perm of permissions) {
      const info = getFriendlyPermissionInfo(perm.code, perm.description);
      buckets[info.group].push(perm);
    }
    return ORDERED_GROUPS.map((groupKey) => ({
      groupKey,
      title: PERMISSION_GROUP_TITLES[groupKey],
      items: buckets[groupKey]
    })).filter((g) => g.items.length > 0);
  }, [permissions]);

  const loadMatrix = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const [rolesRes, permsRes] = await Promise.all([
        listAdminRolesApi(),
        listAdminPermissionsApi()
      ]);
      setRoles(rolesRes);
      setPermissions(permsRes);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể tải danh sách vai trò và quyền hạn.'
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  const openCreateModal = () => {
    setEditingRole(null);
    setRoleNameInput('');
    setRoleDescInput('');
    setSelectedPerms(new Set());
    setModalError(null);
    setIsModalOpen(true);
  };

  const openEditModal = (role: RoleDto) => {
    if (role.isSystemRole) {
      return;
    }
    setEditingRole(role);
    setRoleNameInput(role.name);
    setRoleDescInput(role.description);
    setSelectedPerms(new Set(role.permissions));
    setModalError(null);
    setIsModalOpen(true);
  };

  const togglePermission = (code: string) => {
    if (!currentUser?.isSuperAdmin && !actorPermSet.has(code)) {
      return;
    }
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  };

  const handleSaveRoleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = roleNameInput.trim();
    if (!trimmedName) {
      setModalError('Vui lòng nhập tên nhóm vai trò.');
      return;
    }

    setIsSaving(true);
    setModalError(null);
    setSuccessMsg(null);

    try {
      const payload = {
        name: trimmedName,
        description: roleDescInput.trim(),
        permissions: Array.from(selectedPerms)
      };

      if (editingRole) {
        await updateCustomRoleApi(editingRole.id, payload);
        setSuccessMsg(
          `Đã cập nhật nhóm vai trò "${trimmedName}" và áp dụng ngay cho các nhân viên liên quan.`
        );
      } else {
        await createCustomRoleApi(payload);
        setSuccessMsg(`Đã tạo nhóm vai trò "${trimmedName}" thành công.`);
      }

      setIsModalOpen(false);
      await loadMatrix();
    } catch (err) {
      setModalError(
        err instanceof Error
          ? err.message
          : 'Không thể lưu cấu hình nhóm vai trò.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
        <PageHeader
          title="Vai trò & Phân quyền công việc"
          subtitle="Xem rõ từng vị trí nhân sự được phép làm những gì và tạo thêm nhóm quyền riêng theo nhu cầu vận hành của Shop."
          actions={
            <button
              type="button"
              className="btn btn-primary inline-flex cursor-pointer items-center gap-1.5"
              onClick={openCreateModal}
            >
              <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Tạo vai trò tùy chỉnh</span>
            </button>
          }
        />
      </div>

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

      {isLoading ? (
        <div
          className="flex items-center justify-center gap-2.5 rounded-2xl border border-slate-200 bg-white p-10 text-sm font-medium text-slate-600 shadow-xs"
          role="status"
        >
          <Loader2
            className="h-5 w-5 animate-spin text-blue-600"
            aria-hidden="true"
          />
          <span>Đang tải danh sách vai trò và bảng phân quyền...</span>
        </div>
      ) : (
        <>
          {/* Roles Summary Cards */}
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-blue-600" aria-hidden="true" />
                <h2 className="m-0 text-base font-bold text-slate-900">
                  Các nhóm vai trò hiện có ({roles.length})
                </h2>
              </div>
              <span className="text-xs text-slate-500">
                Nhấn &ldquo;Chỉnh sửa quyền&rdquo; ở các nhóm tùy chỉnh để thay đổi chức năng
              </span>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {roles.map((r) => {
                const friendlyRoleTitle = SYSTEM_ROLE_VIETNAMESE_TITLES[r.name];
                return (
                  <div
                    key={r.id}
                    className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-50/60 p-4 transition-colors hover:border-slate-300"
                  >
                    <div>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="m-0 text-base font-bold text-slate-900">
                              {friendlyRoleTitle ?? r.name}
                            </h3>
                            {friendlyRoleTitle && (
                              <span className="rounded-md bg-slate-200/80 px-2 py-0.5 text-xs font-medium text-slate-700">
                                {r.name}
                              </span>
                            )}
                            {r.isSystemRole ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-600">
                                <Lock className="h-3 w-3" aria-hidden="true" />
                                Mặc định hệ thống
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                                <Sparkles className="h-3 w-3" aria-hidden="true" />
                                Vai trò tùy chỉnh
                              </span>
                            )}
                          </div>

                          <p className="mt-1 mb-0 text-sm text-slate-600">
                            {r.description || 'Nhóm quyền phục vụ vận hành kho và đối soát đơn hàng.'}
                          </p>
                        </div>

                        {!r.isSystemRole && (
                          <button
                            type="button"
                            className="btn btn-outline inline-flex cursor-pointer items-center gap-1.5 text-xs"
                            onClick={() => openEditModal(r)}
                          >
                            <Edit3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span>Chỉnh sửa quyền</span>
                          </button>
                        )}
                      </div>

                      <div className="mt-3 border-t border-slate-200/80 pt-3">
                        <div className="mb-2 text-xs font-semibold text-slate-500">
                          Quyền hạn được phép ({r.permissions.length}/{permissions.length || 14}):
                        </div>
                        {r.permissions.length === 0 ? (
                          <span className="text-xs italic text-slate-500">
                            Chưa cấp quyền chức năng nào
                          </span>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex flex-wrap gap-1.5">
                              {r.permissions.slice(0, 5).map((code) => {
                                const info = getFriendlyPermissionInfo(code);
                                return (
                                  <span
                                    key={code}
                                    title={code}
                                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700"
                                  >
                                    <Check
                                      className="h-3 w-3 shrink-0 text-emerald-600"
                                      aria-hidden="true"
                                    />
                                    <span>{info.label}</span>
                                  </span>
                                );
                              })}
                            </div>
                            {r.permissions.length > 5 && (
                              <details className="group">
                                <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-lg border border-blue-200 bg-blue-50/70 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100/70">
                                  <ChevronDown
                                    className="h-3 w-3 transition-transform group-open:rotate-180"
                                    aria-hidden="true"
                                  />
                                  <span>
                                    +{r.permissions.length - 5} quyền khác
                                  </span>
                                </summary>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {r.permissions.slice(5).map((code) => {
                                    const info = getFriendlyPermissionInfo(code);
                                    return (
                                      <span
                                        key={code}
                                        title={code}
                                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700"
                                      >
                                        <Check
                                          className="h-3 w-3 shrink-0 text-emerald-600"
                                          aria-hidden="true"
                                        />
                                        <span>{info.label}</span>
                                      </span>
                                    );
                                  })}
                                </div>
                              </details>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Grouped Permission Comparison Matrix (Collapsible to avoid duplicating Role Cards) */}
          <details className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <div>
                <h2 className="m-0 text-base font-bold text-slate-900">
                  Bảng so sánh chi tiết quyền hạn giữa các vai trò
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-slate-500">
                  Nhấn để mở bảng đối chiếu đầy đủ từng thao tác nghiệp vụ giữa các vai trò.
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 group-hover:bg-slate-100">
                <ChevronDown
                  className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
                <span>Xem bảng đối chiếu</span>
              </span>
            </summary>

            <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[680px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="px-4 py-3 font-semibold text-slate-700">
                      Chức năng công việc
                    </th>
                    {roles.map((r) => {
                      const friendlyTitle = SYSTEM_ROLE_VIETNAMESE_TITLES[r.name];
                      return (
                        <th
                          key={r.id}
                          className="px-3 py-3 text-center font-semibold text-slate-800"
                        >
                          <div className="text-xs font-bold text-slate-900">
                            {friendlyTitle ?? r.name}
                          </div>
                          {friendlyTitle && (
                            <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                              {r.name}
                            </div>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {groupedPermissions.map((group) => (
                    <Fragment key={group.groupKey}>
                      <tr className="border-y border-slate-200 bg-slate-100/80">
                        <td
                          colSpan={roles.length + 1}
                          className="px-4 py-2 text-xs font-bold tracking-wide text-slate-700 uppercase"
                        >
                          {group.title}
                        </td>
                      </tr>
                      {group.items.map((perm) => {
                        const friendly = getFriendlyPermissionInfo(
                          perm.code,
                          perm.description
                        );
                        return (
                          <tr
                            key={perm.code}
                            className="border-b border-slate-100 transition-colors last:border-b-0 hover:bg-slate-50/70"
                          >
                            <td className="px-4 py-3" title={perm.code}>
                              <div className="font-medium text-slate-900">
                                {friendly.label}
                              </div>
                            </td>
                            {roles.map((r) => {
                              const granted = r.permissions.includes(perm.code);
                              return (
                                <td
                                  key={`${r.id}-${perm.code}`}
                                  className="px-3 py-3 text-center"
                                >
                                  {granted ? (
                                    <span
                                      className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
                                      aria-label="Được phép"
                                      title="Được phép"
                                    >
                                      <Check className="h-3.5 w-3.5 stroke-[2.5]" aria-hidden="true" />
                                    </span>
                                  ) : (
                                    <span
                                      className="inline-flex h-6 w-6 items-center justify-center text-slate-300"
                                      aria-label="Không cấp"
                                      title="Không cấp"
                                    >
                                      <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                                    </span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}

      {/* Create / Edit Custom Role Modal */}
      {isModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSaving) {
              setIsModalOpen(false);
            }
          }}
        >
          <div
            className="modal-card modal-card-wide max-h-[90vh] overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-role-modal-title"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
              <div>
                <h2
                  id="custom-role-modal-title"
                  className="m-0 text-lg font-bold text-slate-900"
                >
                  {editingRole
                    ? `Chỉnh sửa vai trò: ${editingRole.name}`
                    : 'Tạo vai trò tùy chỉnh mới'}
                </h2>
                <p className="mt-1 mb-0 text-xs text-slate-600">
                  Tạo nhóm quyền phù hợp với từng vị trí công việc. Để đảm bảo an toàn, bạn chỉ có thể tích chọn những quyền mà tài khoản của bạn đang có.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                disabled={isSaving}
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                aria-label="Đóng hộp thoại"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => void handleSaveRoleSubmit(e)}
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="custom-role-name"
                    className="mb-1 block text-xs font-semibold text-slate-700"
                  >
                    Tên vai trò công việc <span className="text-red-600">*</span>
                  </label>
                  <input
                    id="custom-role-name"
                    type="text"
                    className="form-input"
                    maxLength={64}
                    value={roleNameInput}
                    onChange={(e) => setRoleNameInput(e.target.value)}
                    placeholder="Ví dụ: CSKH Xử lý Khiếu nại"
                    required
                  />
                </div>

                <div>
                  <label
                    htmlFor="custom-role-desc"
                    className="mb-1 block text-xs font-semibold text-slate-700"
                  >
                    Mô tả ngắn gọn nhiệm vụ
                  </label>
                  <input
                    id="custom-role-desc"
                    type="text"
                    className="form-input"
                    maxLength={256}
                    value={roleDescInput}
                    onChange={(e) => setRoleDescInput(e.target.value)}
                    placeholder="Ví dụ: Tra cứu video, ghi chú và khóa giữ bằng chứng"
                  />
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700">
                    Tích chọn các thao tác được phép thực hiện
                  </span>
                  <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                    Đã chọn {selectedPerms.size} quyền
                  </span>
                </div>

                <div className="space-y-3">
                  {groupedPermissions.map((group) => (
                    <div
                      key={group.groupKey}
                      className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5"
                    >
                      <div className="mb-2 text-xs font-bold text-slate-700">
                        {group.title}
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {group.items.map((perm) => {
                          const allowedByCeiling =
                            Boolean(currentUser?.isSuperAdmin) ||
                            actorPermSet.has(perm.code);
                          const checked = selectedPerms.has(perm.code);
                          const friendly = getFriendlyPermissionInfo(
                            perm.code,
                            perm.description
                          );

                          return (
                            <label
                              key={perm.code}
                              className={`flex min-h-11 items-start gap-2.5 rounded-lg border p-2.5 text-sm transition-colors ${
                                checked
                                  ? 'border-blue-300 bg-blue-50/70 text-slate-900'
                                  : 'border-slate-200 bg-white text-slate-800'
                              } ${
                                allowedByCeiling
                                  ? 'cursor-pointer hover:border-blue-300'
                                  : 'cursor-not-allowed opacity-55'
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
                                checked={checked}
                                disabled={!allowedByCeiling}
                                onChange={() => togglePermission(perm.code)}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="text-xs font-semibold leading-snug text-slate-900">
                                  {friendly.label}
                                </div>
                                {!allowedByCeiling && (
                                  <div className="mt-0.5 text-[11px] font-medium text-amber-700">
                                    Tài khoản của bạn chưa có quyền này
                                  </div>
                                )}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {modalError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-red-600"
                    aria-hidden="true"
                  />
                  <span>{modalError}</span>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4">
                <button
                  type="button"
                  className="btn btn-outline cursor-pointer"
                  onClick={() => setIsModalOpen(false)}
                  disabled={isSaving}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn btn-primary cursor-pointer"
                  disabled={isSaving}
                >
                  {isSaving ? 'Đang lưu...' : 'Lưu vai trò'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
