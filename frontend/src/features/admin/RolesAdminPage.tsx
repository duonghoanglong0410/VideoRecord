import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../../app/authStore';
import {
  createCustomRoleApi,
  listAdminPermissionsApi,
  listAdminRolesApi,
  updateCustomRoleApi,
  type PermissionDto,
  type RoleDto
} from './adminApi';

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
          : 'Không thể tải ma trận vai trò và quyền hạn.'
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
      setModalError('Vui lòng nhập tên vai trò tùy chỉnh.');
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
          `Đã cập nhật vai trò tùy chỉnh "${trimmedName}" và đồng bộ hiệu lực phiên của người dùng liên quan.`
        );
      } else {
        await createCustomRoleApi(payload);
        setSuccessMsg(`Đã tạo vai trò tùy chỉnh "${trimmedName}" thành công.`);
      }

      setIsModalOpen(false);
      await loadMatrix();
    } catch (err) {
      setModalError(
        err instanceof Error
          ? err.message
          : 'Không thể lưu cấu hình vai trò tùy chỉnh.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div>
      <div className="surface-card">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Ma trận Vai trò, Quyền hạn &amp; Phạm vi</h1>
            <p className="page-subtitle">
              Hệ thống kiểm soát truy cập kết hợp giữa <strong>14 quyền chức năng</strong>{' '}
              và <strong>4 cấp độ phạm vi dữ liệu</strong>, bảo đảm không có quản trị viên
              nào tự nâng quyền vượt trần (Grant Ceiling).
            </p>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            onClick={openCreateModal}
          >
            + Tạo vai trò tùy chỉnh
          </button>
        </div>

        <div
          className="filter-grid"
          style={{ marginTop: 16 }}
        >
          <div className="kv-item">
            <div className="kv-term">Cá nhân (Own)</div>
            <div className="kv-desc" style={{ fontSize: '0.85rem', fontWeight: 500 }}>
              Chỉ thao tác trên các phiên quay do chính tài khoản đó tạo ra tại Shop/Kho
              được phân công.
            </div>
          </div>
          <div className="kv-item">
            <div className="kv-term">Theo Kho (Warehouse)</div>
            <div className="kv-desc" style={{ fontSize: '0.85rem', fontWeight: 500 }}>
              Áp dụng cho toàn bộ video và hoạt động đóng gói thuộc một Kho cụ thể.
            </div>
          </div>
          <div className="kv-item">
            <div className="kv-term">Theo Shop (Shop)</div>
            <div className="kv-desc" style={{ fontSize: '0.85rem', fontWeight: 500 }}>
              Áp dụng cho tất cả các Kho trực thuộc một Shop TikTok được giao quản lý.
            </div>
          </div>
          <div className="kv-item">
            <div className="kv-term">Toàn hệ thống (All)</div>
            <div className="kv-desc" style={{ fontSize: '0.85rem', fontWeight: 500 }}>
              Dành riêng cho vai trò <strong>SuperAdmin</strong> quản trị toàn bộ các Shop
              và cấu hình lưu trữ NAS.
            </div>
          </div>
        </div>
      </div>

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

      {isLoading ? (
        <div className="surface-card" role="status">
          Đang tải danh sách vai trò và ma trận 14 quyền...
        </div>
      ) : (
        <>
          {/* Roles Summary Cards */}
          <div className="surface-card">
            <h2 style={{ marginTop: 0, fontSize: '1.08rem' }}>
              Danh sách vai trò hiện có ({roles.length})
            </h2>
            <div className="mobile-card-list">
              {roles.map((r) => (
                <div key={r.id} className="mobile-data-card">
                  <div className="page-header-row">
                    <div>
                      <strong style={{ fontSize: '1.02rem' }}>{r.name}</strong>{' '}
                      <span
                        className={`status-pill ${
                          r.isSystemRole
                            ? 'status-pill-ready'
                            : 'status-pill-starting'
                        }`}
                        style={{ marginLeft: 6 }}
                      >
                        {r.isSystemRole
                          ? 'Vai trò hệ thống (Bất biến)'
                          : 'Vai trò tùy chỉnh'}
                      </span>
                      <div
                        style={{
                          fontSize: '0.86rem',
                          color: 'var(--color-text-muted)',
                          marginTop: 4
                        }}
                      >
                        {r.description || 'Không có mô tả'}
                      </div>
                    </div>

                    {!r.isSystemRole && (
                      <button
                        type="button"
                        className="btn btn-outline"
                        onClick={() => openEditModal(r)}
                      >
                        Chỉnh sửa quyền
                      </button>
                    )}
                  </div>

                  <div className="badge-cluster">
                    {r.permissions.length === 0 ? (
                      <span
                        style={{
                          fontSize: '0.82rem',
                          color: 'var(--color-text-muted)'
                        }}
                      >
                        Chưa gắn quyền nào
                      </span>
                    ) : (
                      r.permissions.map((code) => (
                        <span key={code} className="meta-chip mono-code">
                          {code}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 14-Permission Matrix Table */}
          <div className="surface-card">
            <h2 style={{ marginTop: 0, fontSize: '1.08rem' }}>
              Bảng đối chiếu chi tiết 14 quyền hạn
            </h2>
            <div className="permission-matrix-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Mã quyền</th>
                    <th>Nhóm &amp; Ý nghĩa</th>
                    {roles.map((r) => (
                      <th key={r.id} style={{ textAlign: 'center' }}>
                        {r.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {permissions.map((perm) => (
                    <tr key={perm.code}>
                      <td className="mono-code" style={{ whiteSpace: 'nowrap' }}>
                        {perm.code}
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: '0.82rem' }}>
                          {perm.group}
                        </div>
                        <div
                          style={{
                            fontSize: '0.84rem',
                            color: 'var(--color-text-muted)'
                          }}
                        >
                          {perm.description}
                        </div>
                      </td>
                      {roles.map((r) => {
                        const granted = r.permissions.includes(perm.code);
                        return (
                          <td
                            key={`${r.id}-${perm.code}`}
                            style={{
                              textAlign: 'center',
                              fontWeight: 700,
                              color: granted
                                ? 'var(--color-success)'
                                : '#CBD5E1'
                            }}
                          >
                            {granted ? '✓' : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Create / Edit Custom Role Modal */}
      {isModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card modal-card-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-role-modal-title"
          >
            <h2
              id="custom-role-modal-title"
              style={{ marginTop: 0, fontSize: '1.15rem' }}
            >
              {editingRole
                ? `Chỉnh sửa vai trò tùy chỉnh: ${editingRole.name}`
                : 'Tạo vai trò tùy chỉnh mới'}
            </h2>
            <p style={{ fontSize: '0.86rem', color: 'var(--color-text-muted)' }}>
              Theo quy tắc trần phân quyền (Grant Ceiling), bạn chỉ có thể bật các quyền
              mà chính tài khoản của bạn đang sở hữu.
            </p>

            <form onSubmit={(e) => void handleSaveRoleSubmit(e)}>
              <div className="form-group">
                <label htmlFor="custom-role-name" className="form-label">
                  Tên vai trò (tối đa 64 ký tự)
                </label>
                <input
                  id="custom-role-name"
                  type="text"
                  className="form-input"
                  maxLength={64}
                  value={roleNameInput}
                  onChange={(e) => setRoleNameInput(e.target.value)}
                  placeholder="Ví dụ: CSKH Khiếu Nại TikTok"
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="custom-role-desc" className="form-label">
                  Mô tả nhiệm vụ
                </label>
                <input
                  id="custom-role-desc"
                  type="text"
                  className="form-input"
                  maxLength={256}
                  value={roleDescInput}
                  onChange={(e) => setRoleDescInput(e.target.value)}
                  placeholder="Ví dụ: Xem, ghi chú và bật Hold video khi khách khiếu nại"
                />
              </div>

              <div className="form-group">
                <div className="form-label">Chọn các quyền chức năng</div>
                <div className="mobile-card-list">
                  {permissions.map((perm) => {
                    const allowedByCeiling =
                      Boolean(currentUser?.isSuperAdmin) ||
                      actorPermSet.has(perm.code);
                    const checked = selectedPerms.has(perm.code);

                    return (
                      <label
                        key={perm.code}
                        className="audio-optin-row"
                        style={{
                          opacity: allowedByCeiling ? 1 : 0.55,
                          cursor: allowedByCeiling ? 'pointer' : 'not-allowed'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!allowedByCeiling}
                          onChange={() => togglePermission(perm.code)}
                        />
                        <div>
                          <div>
                            <strong className="mono-code">{perm.code}</strong>{' '}
                            {!allowedByCeiling && (
                              <span
                                style={{
                                  fontSize: '0.78rem',
                                  color: 'var(--color-danger)'
                                }}
                              >
                                (Ngoài trần quyền của bạn)
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: '0.82rem',
                              color: 'var(--color-text-muted)'
                            }}
                          >
                            {perm.description}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {modalError && (
                <div className="alert alert-error" role="alert">
                  {modalError}
                </div>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setIsModalOpen(false)}
                  disabled={isSaving}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
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
