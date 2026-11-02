import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronDown,
  Edit3,
  Film,
  FolderOpen,
  Loader2,
  PauseCircle,
  PlayCircle,
  Plus,
  Search,
  Store,
  Trash2,
  Users,
  X
} from 'lucide-react';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { StatCard } from '../../components/ui/StatCard';
import {
  createAdminShopApi,
  createManagedWarehouseApi,
  deleteAdminShopApi,
  deleteManagedWarehouseApi,
  getAdminWarehousesOverviewApi,
  updateAdminShopInfoApi,
  updateManagedWarehouseApi,
  type AdminShopWarehouseTreeDto,
  type AdminWarehouseDetailDto,
  type AdminWarehousesOverviewDto
} from './adminApi';

type StatusFilter = 'all' | 'active' | 'inactive';

function toSuggestedSubdir(code: string): string {
  return code
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function WarehousesAdminPage() {
  const [overview, setOverview] = useState<AdminWarehousesOverviewDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedShopFilterId, setSelectedShopFilterId] = useState<string>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create Shop Modal state
  const [isCreateShopOpen, setIsCreateShopOpen] = useState<boolean>(false);
  const [newShopCode, setNewShopCode] = useState<string>('');
  const [newShopName, setNewShopName] = useState<string>('');
  const [newShopSubdir, setNewShopSubdir] = useState<string>('');
  const [newShopCreateDefaultWh, setNewShopCreateDefaultWh] = useState<boolean>(true);
  const [newShopDefaultWhName, setNewShopDefaultWhName] =
    useState<string>('Kho chính 01');
  const [isSavingShop, setIsSavingShop] = useState<boolean>(false);
  const [shopModalError, setShopModalError] = useState<string | null>(null);

  // Edit Shop Modal state
  const [editingShop, setEditingShop] = useState<AdminShopWarehouseTreeDto | null>(
    null
  );
  const [editShopCode, setEditShopCode] = useState<string>('');
  const [editShopName, setEditShopName] = useState<string>('');
  const [editShopSubdir, setEditShopSubdir] = useState<string>('');
  const [editShopActive, setEditShopActive] = useState<boolean>(true);

  // Delete Shop Confirmation Modal state
  const [deletingShop, setDeletingShop] =
    useState<AdminShopWarehouseTreeDto | null>(null);
  const [confirmForceDeleteShop, setConfirmForceDeleteShop] =
    useState<boolean>(false);
  const [isDeletingShop, setIsDeletingShop] = useState<boolean>(false);
  const [deleteShopError, setDeleteShopError] = useState<string | null>(null);

  // Create / Edit Warehouse Modal state
  const [createWhShop, setCreateWhShop] = useState<AdminShopWarehouseTreeDto | null>(
    null
  );
  const [editingWh, setEditingWh] = useState<AdminWarehouseDetailDto | null>(null);
  const [whCodeInput, setWhCodeInput] = useState<string>('');
  const [whNameInput, setWhNameInput] = useState<string>('');
  const [whActiveInput, setWhActiveInput] = useState<boolean>(true);
  const [isSavingWh, setIsSavingWh] = useState<boolean>(false);
  const [whModalError, setWhModalError] = useState<string | null>(null);

  // Delete Warehouse Confirmation Modal state
  const [deletingWh, setDeletingWh] = useState<{
    shop: AdminShopWarehouseTreeDto;
    warehouse: AdminWarehouseDetailDto;
  } | null>(null);
  const [confirmForceDeleteWh, setConfirmForceDeleteWh] =
    useState<boolean>(false);
  const [isDeletingWh, setIsDeletingWh] = useState<boolean>(false);
  const [deleteWhError, setDeleteWhError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const data = await getAdminWarehousesOverviewApi();
      setOverview(data);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể tải danh sách Shop và Kho đóng gói.'
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const metrics = useMemo(() => {
    const shops = overview?.shops ?? [];
    let totalWarehouses = 0;
    let activeWarehouses = 0;
    let totalVideos = 0;

    for (const s of shops) {
      totalVideos += s.recordingCount;
      for (const w of s.warehouses) {
        totalWarehouses += 1;
        if (w.isActive && s.isActive) {
          activeWarehouses += 1;
        }
      }
    }

    return {
      totalShops: shops.length,
      activeShops: shops.filter((s) => s.isActive).length,
      totalWarehouses,
      activeWarehouses,
      totalVideos
    };
  }, [overview]);

  const filteredShops = useMemo(() => {
    const shops = overview?.shops ?? [];
    const q = searchQuery.trim().toLowerCase();

    return shops
      .filter((shop) =>
        selectedShopFilterId === 'all' ? true : shop.id === selectedShopFilterId
      )
      .map((shop) => {
        const shopMatchesText =
          !q ||
          shop.name.toLowerCase().includes(q) ||
          shop.code.toLowerCase().includes(q) ||
          shop.allowedStorageSubdir.toLowerCase().includes(q);

        const filteredWarehouses = shop.warehouses.filter((wh) => {
          if (statusFilter === 'active' && (!wh.isActive || !shop.isActive)) {
            return false;
          }
          if (statusFilter === 'inactive' && wh.isActive && shop.isActive) {
            return false;
          }
          if (!q || shopMatchesText) {
            return true;
          }
          return (
            wh.name.toLowerCase().includes(q) ||
            wh.code.toLowerCase().includes(q)
          );
        });

        const keepShop =
          filteredWarehouses.length > 0 ||
          (shopMatchesText &&
            (statusFilter === 'all' ||
              (statusFilter === 'active' && shop.isActive) ||
              (statusFilter === 'inactive' && !shop.isActive)));

        return keepShop ? { ...shop, warehouses: filteredWarehouses } : null;
      })
      .filter((s): s is AdminShopWarehouseTreeDto => s !== null);
  }, [overview, searchQuery, statusFilter, selectedShopFilterId]);

  const handleCreateShopSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setShopModalError(null);
    setIsSavingShop(true);
    try {
      await createAdminShopApi({
        code: newShopCode.trim(),
        name: newShopName.trim(),
        allowedStorageSubdir: newShopSubdir.trim() || null,
        createDefaultWarehouse: newShopCreateDefaultWh,
        defaultWarehouseName: newShopCreateDefaultWh
          ? newShopDefaultWhName.trim() || 'Kho chính 01'
          : null
      });
      setIsCreateShopOpen(false);
      setNewShopCode('');
      setNewShopName('');
      setNewShopSubdir('');
      setNewShopCreateDefaultWh(true);
      setNewShopDefaultWhName('Kho chính 01');
      setSuccessMsg(
        newShopCreateDefaultWh
          ? 'Đã tạo Shop mới kèm Kho chính mặc định sẵn sàng sử dụng.'
          : 'Đã thêm Shop mới thành công.'
      );
      await loadOverview();
    } catch (err) {
      setShopModalError(
        err instanceof Error ? err.message : 'Không thể tạo Shop mới.'
      );
    } finally {
      setIsSavingShop(false);
    }
  };

  const openEditShopModal = (shop: AdminShopWarehouseTreeDto) => {
    setEditingShop(shop);
    setEditShopCode(shop.code);
    setEditShopName(shop.name);
    setEditShopSubdir(shop.allowedStorageSubdir);
    setEditShopActive(shop.isActive);
    setShopModalError(null);
  };

  const handleEditShopSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingShop) {
      return;
    }
    setShopModalError(null);
    setIsSavingShop(true);
    try {
      await updateAdminShopInfoApi(editingShop.id, {
        code: editShopCode.trim(),
        name: editShopName.trim(),
        allowedStorageSubdir: editShopSubdir.trim(),
        isActive: editShopActive
      });
      setEditingShop(null);
      setSuccessMsg(`Đã cập nhật thông tin Shop "${editShopName.trim()}".`);
      await loadOverview();
    } catch (err) {
      setShopModalError(
        err instanceof Error ? err.message : 'Không thể cập nhật thông tin Shop.'
      );
    } finally {
      setIsSavingShop(false);
    }
  };

  const handleToggleShopActive = async (shop: AdminShopWarehouseTreeDto) => {
    setBusyId(shop.id);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const nextActive = !shop.isActive;
      await updateAdminShopInfoApi(shop.id, {
        code: shop.code,
        name: shop.name,
        allowedStorageSubdir: shop.allowedStorageSubdir,
        isActive: nextActive
      });
      setSuccessMsg(
        nextActive
          ? `Đã mở lại hoạt động cho Shop "${shop.name}".`
          : `Đã tạm ngưng Shop "${shop.name}". Toàn bộ video lịch sử của Shop vẫn được bảo toàn.`
      );
      await loadOverview();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể thay đổi trạng thái hoạt động của Shop.'
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDeleteShop = async () => {
    if (!deletingShop) {
      return;
    }
    setDeleteShopError(null);
    setIsDeletingShop(true);
    try {
      const res = await deleteAdminShopApi(
        deletingShop.id,
        confirmForceDeleteShop
      );
      if (selectedShopFilterId === deletingShop.id) {
        setSelectedShopFilterId('all');
      }
      setDeletingShop(null);
      setConfirmForceDeleteShop(false);
      setSuccessMsg(res.message);
      await loadOverview();
    } catch (err) {
      setDeleteShopError(
        err instanceof Error ? err.message : 'Không thể xóa Shop này.'
      );
    } finally {
      setIsDeletingShop(false);
    }
  };

  const openCreateWarehouseModal = (shop: AdminShopWarehouseTreeDto) => {
    setEditingWh(null);
    setCreateWhShop(shop);
    const nextIdx = String(shop.warehouses.length + 1).padStart(2, '0');
    setWhCodeInput(`WH-${shop.code.toUpperCase().slice(0, 8)}-${nextIdx}`);
    setWhNameInput('');
    setWhModalError(null);
  };

  const openEditWarehouseModal = (wh: AdminWarehouseDetailDto) => {
    setCreateWhShop(null);
    setEditingWh(wh);
    setWhCodeInput(wh.code);
    setWhNameInput(wh.name);
    setWhActiveInput(wh.isActive);
    setWhModalError(null);
  };

  const handleWarehouseSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setWhModalError(null);
    setIsSavingWh(true);
    try {
      if (editingWh) {
        await updateManagedWarehouseApi(editingWh.id, {
          code: whCodeInput.trim(),
          name: whNameInput.trim(),
          isActive: whActiveInput
        });
        setEditingWh(null);
        setSuccessMsg(`Đã cập nhật thông tin Kho "${whNameInput.trim()}".`);
      } else if (createWhShop) {
        await createManagedWarehouseApi(createWhShop.id, {
          code: whCodeInput.trim(),
          name: whNameInput.trim(),
          createDefaultStation: false
        });
        setCreateWhShop(null);
        setSuccessMsg(`Đã thêm Kho đóng gói "${whNameInput.trim()}" thành công.`);
      }
      await loadOverview();
    } catch (err) {
      setWhModalError(
        err instanceof Error
          ? err.message
          : 'Không thể lưu thông tin Kho đóng gói.'
      );
    } finally {
      setIsSavingWh(false);
    }
  };

  const handleToggleWarehouseActive = async (wh: AdminWarehouseDetailDto) => {
    setBusyId(wh.id);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const nextActive = !wh.isActive;
      await updateManagedWarehouseApi(wh.id, {
        code: wh.code,
        name: wh.name,
        isActive: nextActive
      });
      setSuccessMsg(
        nextActive
          ? `Đã mở lại hoạt động cho Kho "${wh.name}".`
          : `Đã tạm ngưng Kho "${wh.name}". Các video lịch sử của kho vẫn được giữ nguyên an toàn.`
      );
      await loadOverview();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Không thể thay đổi trạng thái hoạt động của Kho.'
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDeleteWarehouse = async () => {
    if (!deletingWh) {
      return;
    }
    setDeleteWhError(null);
    setIsDeletingWh(true);
    try {
      const res = await deleteManagedWarehouseApi(
        deletingWh.warehouse.id,
        confirmForceDeleteWh
      );
      setDeletingWh(null);
      setConfirmForceDeleteWh(false);
      setSuccessMsg(res.message);
      await loadOverview();
    } catch (err) {
      setDeleteWhError(
        err instanceof Error ? err.message : 'Không thể xóa Kho đóng gói này.'
      );
    } finally {
      setIsDeletingWh(false);
    }
  };

  const allShops = overview?.shops ?? [];

  return (
    <div className="space-y-5">
      {/* Header & Filter Bar */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs sm:p-5">
        <PageHeader
          title="Quản lý Shop & Kho đóng gói"
          subtitle="Quản trị danh sách Shop bán hàng và các Kho đóng gói trực thuộc theo thực tế vận hành."
          actions={
            overview?.canManageShops ? (
              <button
                type="button"
                className="btn btn-primary inline-flex cursor-pointer items-center gap-1.5"
                onClick={() => {
                  setShopModalError(null);
                  setIsCreateShopOpen(true);
                }}
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Thêm Shop mới</span>
              </button>
            ) : undefined
          }
        />

        {/* Search & Status Filter */}
        <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 sm:max-w-md">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              type="text"
              className="form-input pl-10"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm theo tên Shop, mã Shop, tên Kho hoặc mã Kho..."
              aria-label="Tìm kiếm Kho và Shop"
            />
          </div>

          <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:pb-0">
            {(
              [
                { key: 'all', label: 'Tất cả trạng thái' },
                { key: 'active', label: 'Đang hoạt động' },
                { key: 'inactive', label: 'Đang tạm ngưng' }
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStatusFilter(tab.key)}
                className={`inline-flex min-h-10 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  statusFilter === tab.key
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Shop Quick-Selector Bar (when > 1 shop exists) */}
        {!isLoading && allShops.length > 1 && (
          <div className="mt-3 flex items-center gap-2 overflow-x-auto border-t border-slate-100 pt-3 pb-1">
            <span className="shrink-0 text-xs font-semibold text-slate-500">
              Chọn nhanh Shop:
            </span>
            <button
              type="button"
              onClick={() => setSelectedShopFilterId('all')}
              className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                selectedShopFilterId === 'all'
                  ? 'border-blue-600 bg-blue-50 text-blue-800'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <span>Tất cả Shop ({allShops.length})</span>
            </button>
            {allShops.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() =>
                  setSelectedShopFilterId((prev) => (prev === s.id ? 'all' : s.id))
                }
                className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  selectedShopFilterId === s.id
                    ? 'border-blue-600 bg-blue-50 text-blue-800'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    s.isActive ? 'bg-emerald-500' : 'bg-amber-500'
                  }`}
                  aria-hidden="true"
                />
                <span>{s.name}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-600">
                  {s.warehouses.length} kho
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* KPI Summary Strip */}
      {!isLoading && overview && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard
            label="Shop đang quản lý"
            value={metrics.activeShops}
            hint={`Tổng cộng ${metrics.totalShops} Shop`}
            tone="blue"
            icon={<Store className="h-5 w-5" aria-hidden="true" />}
          />
          <StatCard
            label="Kho đang hoạt động"
            value={metrics.activeWarehouses}
            hint={`Trên tổng ${metrics.totalWarehouses} kho`}
            tone="green"
            icon={<Building2 className="h-5 w-5" aria-hidden="true" />}
          />
          <StatCard
            label="Video đã quay tại kho"
            value={metrics.totalVideos}
            hint="Đơn hàng lưu trong hệ thống"
            tone="slate"
            icon={<Film className="h-5 w-5" aria-hidden="true" />}
          />
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

      {isLoading ? (
        <div
          className="flex items-center justify-center gap-2.5 rounded-2xl border border-slate-200 bg-white p-10 text-sm font-medium text-slate-600 shadow-xs"
          role="status"
        >
          <Loader2
            className="h-5 w-5 animate-spin text-blue-600"
            aria-hidden="true"
          />
          <span>Đang tải danh sách Shop và Kho đóng gói...</span>
        </div>
      ) : filteredShops.length === 0 ? (
        <EmptyState
          icon={<Building2 className="h-6 w-6" aria-hidden="true" />}
          title="Không tìm thấy Shop hoặc Kho đóng gói phù hợp"
          description={
            searchQuery || statusFilter !== 'all' || selectedShopFilterId !== 'all'
              ? 'Thử xóa từ khóa tìm kiếm hoặc chuyển bộ lọc sang "Tất cả trạng thái".'
              : 'Chưa có Shop hoặc Kho đóng gói nào trong phạm vi quản lý của bạn.'
          }
        />
      ) : (
        <div className="space-y-5">
          {filteredShops.map((shop) => {
            const isShopBusy = busyId === shop.id;

            return (
              <section
                key={shop.id}
                className={`overflow-hidden rounded-2xl border bg-white shadow-xs ${
                  shop.isActive
                    ? 'border-slate-200'
                    : 'border-amber-200 bg-amber-50/15'
                }`}
              >
                {/* Shop Header Banner */}
                <div
                  className={`flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4 ${
                    shop.isActive
                      ? 'border-slate-100 bg-slate-50/70'
                      : 'border-amber-200/70 bg-amber-50/60'
                  }`}
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                          shop.isActive
                            ? 'bg-blue-600 text-white'
                            : 'bg-amber-200 text-amber-900'
                        }`}
                      >
                        <Store className="h-4.5 w-4.5" aria-hidden="true" />
                      </span>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="m-0 text-lg font-bold text-slate-900">
                            {shop.name}
                          </h2>
                          <span className="mono-code rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700">
                            {shop.code}
                          </span>
                          <span
                            className="mono-code inline-flex items-center gap-1 rounded-md border border-blue-100 bg-blue-50/80 px-2 py-0.5 text-xs text-blue-800"
                            title="Thư mục lưu trữ video của Shop"
                          >
                            <FolderOpen className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span>/{shop.allowedStorageSubdir}</span>
                          </span>
                          {shop.isActive ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                              <CheckCircle2
                                className="h-3 w-3 text-emerald-600"
                                aria-hidden="true"
                              />
                              Shop đang hoạt động
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
                              <PauseCircle
                                className="h-3 w-3 text-amber-700"
                                aria-hidden="true"
                              />
                              Shop đang tạm ngưng
                            </span>
                          )}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-600">
                          <span>
                            <strong>{shop.warehouses.length}</strong> Kho trực thuộc
                          </span>
                          <span>•</span>
                          <span>
                            <strong>{shop.assignedUserCount}</strong> Nhân sự thuộc Shop
                          </span>
                          <span>•</span>
                          <span>
                            <strong>{shop.recordingCount}</strong> Video đơn hàng
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Shop CRUD Action Toolbar */}
                  <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
                    <button
                      type="button"
                      className="btn btn-primary inline-flex cursor-pointer items-center gap-1.5 text-xs"
                      onClick={() => openCreateWarehouseModal(shop)}
                    >
                      <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>Thêm Kho mới</span>
                    </button>

                    {overview?.canManageShops && (
                      <>
                        <button
                          type="button"
                          className="btn btn-outline inline-flex cursor-pointer items-center gap-1.5 text-xs"
                          onClick={() => openEditShopModal(shop)}
                        >
                          <Edit3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>Sửa Shop</span>
                        </button>

                        <button
                          type="button"
                          disabled={isShopBusy}
                          onClick={() => void handleToggleShopActive(shop)}
                          className={`btn btn-outline inline-flex cursor-pointer items-center gap-1 text-xs ${
                            shop.isActive
                              ? 'text-amber-800 hover:bg-amber-50'
                              : 'text-emerald-800 hover:bg-emerald-50'
                          }`}
                        >
                          {shop.isActive ? (
                            <>
                              <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Tạm ngưng Shop</span>
                            </>
                          ) : (
                            <>
                              <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Mở lại Shop</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setDeleteShopError(null);
                            setConfirmForceDeleteShop(false);
                            setDeletingShop(shop);
                          }}
                          className="btn btn-outline inline-flex cursor-pointer items-center gap-1 text-xs text-red-700 hover:border-red-300 hover:bg-red-50"
                          title="Xóa Shop"
                        >
                          <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>Xóa Shop</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Warehouses Grid inside Shop */}
                <div className="p-5">
                  {shop.warehouses.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/70 p-6 text-center text-sm text-slate-600">
                      Shop này chưa có kho đóng gói nào. Nhấn{' '}
                      <strong>&ldquo;Thêm Kho mới&rdquo;</strong> ở góc phải để khởi tạo kho đầu tiên.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      {shop.warehouses.map((wh) => {
                        const isBusy = busyId === wh.id;

                        return (
                          <div
                            key={wh.id}
                            className={`flex flex-col justify-between rounded-xl border border-l-4 p-4 transition-colors ${
                              wh.isActive
                                ? 'border-slate-200 border-l-emerald-500 bg-slate-50/40 hover:border-slate-300'
                                : 'border-slate-200 border-l-slate-400 bg-slate-100/70 opacity-85'
                            }`}
                          >
                            <div>
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Building2
                                    className={`h-4 w-4 shrink-0 ${
                                      wh.isActive ? 'text-blue-600' : 'text-slate-400'
                                    }`}
                                    aria-hidden="true"
                                  />
                                  <h3 className="m-0 text-base font-bold text-slate-900">
                                    {wh.name}
                                  </h3>
                                  <span className="mono-code rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs font-semibold text-slate-700">
                                    {wh.code}
                                  </span>
                                </div>

                                {wh.isActive ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                                    Đang hoạt động
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
                                    Đang tạm ngưng
                                  </span>
                                )}
                              </div>

                              {/* Warehouse Mini Metrics */}
                              <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-slate-200/80 bg-white p-2.5 text-center text-xs">
                                <div className="border-r border-slate-100">
                                  <div className="text-slate-500">Nhân sự tại kho</div>
                                  <div className="mt-0.5 inline-flex items-center gap-1 font-bold text-slate-900">
                                    <Users
                                      className="h-3 w-3 text-slate-400"
                                      aria-hidden="true"
                                    />
                                    {wh.assignedUserCount}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-slate-500">Video đã lưu</div>
                                  <div className="mt-0.5 font-bold text-slate-900">
                                    {wh.recordingCount}
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Warehouse Actions */}
                            <div className="mt-4 flex flex-wrap items-center justify-end gap-1.5 border-t border-slate-200/80 pt-3">
                              <button
                                type="button"
                                onClick={() => openEditWarehouseModal(wh)}
                                className="btn btn-outline inline-flex cursor-pointer items-center gap-1 text-xs"
                              >
                                <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Sửa kho</span>
                              </button>

                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleToggleWarehouseActive(wh)}
                                className={`btn inline-flex cursor-pointer items-center gap-1 text-xs ${
                                  wh.isActive
                                    ? 'btn-outline text-amber-800 hover:bg-amber-50'
                                    : 'btn-primary'
                                }`}
                              >
                                {wh.isActive ? (
                                  <>
                                    <PauseCircle
                                      className="h-3.5 w-3.5"
                                      aria-hidden="true"
                                    />
                                    <span>Tạm ngưng</span>
                                  </>
                                ) : (
                                  <>
                                    <PlayCircle
                                      className="h-3.5 w-3.5"
                                      aria-hidden="true"
                                    />
                                    <span>Mở lại</span>
                                  </>
                                )}
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  setDeleteWhError(null);
                                  setConfirmForceDeleteWh(false);
                                  setDeletingWh({ shop, warehouse: wh });
                                }}
                                className="btn btn-outline inline-flex cursor-pointer items-center gap-1 text-xs text-red-700 hover:border-red-300 hover:bg-red-50"
                                title="Xóa Kho đóng gói"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Xóa kho</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Create Shop Modal */}
      {isCreateShopOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSavingShop) {
              setIsCreateShopOpen(false);
            }
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wh-create-shop-title"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <div>
                <h2
                  id="wh-create-shop-title"
                  className="m-0 text-lg font-bold text-slate-900"
                >
                  Thêm Shop mới
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-slate-500">
                  Khởi tạo gian hàng mới cùng thư mục lưu trữ và kho mặc định.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateShopOpen(false)}
                disabled={isSavingShop}
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => void handleCreateShopSubmit(e)}
            >
              <div>
                <label
                  htmlFor="wh-new-shop-name"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Tên hiển thị của Shop <span className="text-red-600">*</span>
                </label>
                <input
                  id="wh-new-shop-name"
                  type="text"
                  className="form-input"
                  maxLength={128}
                  value={newShopName}
                  onChange={(e) => setNewShopName(e.target.value)}
                  placeholder="Ví dụ: TikTok Shop Mỹ Phẩm B"
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="wh-new-shop-code"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Mã viết tắt của Shop <span className="text-red-600">*</span>
                </label>
                <input
                  id="wh-new-shop-code"
                  type="text"
                  className="form-input mono-code"
                  maxLength={32}
                  value={newShopCode}
                  onChange={(e) => setNewShopCode(e.target.value)}
                  placeholder="Ví dụ: ShopMyPhamB"
                  required
                />
                <span className="mt-1 block text-[11px] text-slate-500">
                  Dùng chữ không dấu, số hoặc dấu gạch ngang (-). Thư mục lưu trữ tự động:{' '}
                  <strong className="mono-code text-slate-700">
                    /{newShopSubdir.trim() || toSuggestedSubdir(newShopCode) || 'ten-shop'}
                  </strong>
                </span>
              </div>

              <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3">
                <label className="flex cursor-pointer items-start gap-2.5 text-xs font-semibold text-slate-900">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
                    checked={newShopCreateDefaultWh}
                    onChange={(e) => setNewShopCreateDefaultWh(e.target.checked)}
                  />
                  <div>
                    <div>Tự động tạo sẵn Kho đóng gói mặc định</div>
                    <div className="mt-0.5 font-normal text-slate-600">
                      Giúp Shop mới sẵn sàng quay đơn hàng ngay sau khi tạo.
                    </div>
                  </div>
                </label>

                {newShopCreateDefaultWh && (
                  <div className="mt-2.5 pl-6">
                    <label
                      htmlFor="wh-new-shop-default-wh-name"
                      className="mb-1 block text-[11px] font-semibold text-slate-700"
                    >
                      Tên Kho khởi tạo mặc định
                    </label>
                    <input
                      id="wh-new-shop-default-wh-name"
                      type="text"
                      className="form-input bg-white text-xs"
                      maxLength={128}
                      value={newShopDefaultWhName}
                      onChange={(e) => setNewShopDefaultWhName(e.target.value)}
                      placeholder="Kho chính 01"
                    />
                  </div>
                )}
              </div>

              <details className="group rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-slate-600">
                  <ChevronDown
                    className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  />
                  <span>Tùy chỉnh tên thư mục lưu trữ trên ổ đĩa/NAS (nâng cao)</span>
                </summary>
                <div className="mt-2.5">
                  <input
                    type="text"
                    className="form-input mono-code text-base sm:text-xs"
                    maxLength={64}
                    value={newShopSubdir}
                    onChange={(e) => setNewShopSubdir(e.target.value)}
                    placeholder="Để trống sẽ tự tạo theo Mã Shop"
                  />
                </div>
              </details>

              {shopModalError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-red-600"
                    aria-hidden="true"
                  />
                  <span>{shopModalError}</span>
                </div>
              )}

              <div className="modal-actions border-t border-slate-200 pt-4">
                <button
                  type="button"
                  className="btn btn-outline cursor-pointer"
                  onClick={() => setIsCreateShopOpen(false)}
                  disabled={isSavingShop}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn btn-primary cursor-pointer"
                  disabled={isSavingShop}
                >
                  {isSavingShop ? 'Đang tạo...' : 'Tạo Shop'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Shop Modal */}
      {editingShop && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSavingShop) {
              setEditingShop(null);
            }
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wh-edit-shop-title"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <div>
                <h2
                  id="wh-edit-shop-title"
                  className="m-0 text-lg font-bold text-slate-900"
                >
                  Chỉnh sửa thông tin Shop
                </h2>
                <p className="mt-0.5 mb-0 text-xs text-slate-500">
                  Cập nhật tên hiển thị, mã định danh, thư mục lưu trữ hoặc trạng thái hoạt động.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingShop(null)}
                disabled={isSavingShop}
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => void handleEditShopSubmit(e)}
            >
              <div>
                <label
                  htmlFor="wh-edit-shop-name"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Tên hiển thị của Shop <span className="text-red-600">*</span>
                </label>
                <input
                  id="wh-edit-shop-name"
                  type="text"
                  className="form-input"
                  maxLength={128}
                  value={editShopName}
                  onChange={(e) => setEditShopName(e.target.value)}
                  required
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="wh-edit-shop-code"
                    className="mb-1 block text-xs font-semibold text-slate-700"
                  >
                    Mã viết tắt của Shop <span className="text-red-600">*</span>
                  </label>
                  <input
                    id="wh-edit-shop-code"
                    type="text"
                    className="form-input mono-code"
                    maxLength={32}
                    value={editShopCode}
                    onChange={(e) => setEditShopCode(e.target.value)}
                    required
                  />
                </div>

                <div>
                  <label
                    htmlFor="wh-edit-shop-subdir"
                    className="mb-1 block text-xs font-semibold text-slate-700"
                  >
                    Thư mục lưu trữ video <span className="text-red-600">*</span>
                  </label>
                  <input
                    id="wh-edit-shop-subdir"
                    type="text"
                    className="form-input mono-code"
                    maxLength={64}
                    value={editShopSubdir}
                    onChange={(e) => setEditShopSubdir(e.target.value)}
                    required
                  />
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
                  checked={editShopActive}
                  onChange={(e) => setEditShopActive(e.target.checked)}
                />
                <div>
                  <div className="font-semibold text-slate-900">
                    Cho phép Shop hoạt động quay đơn hàng mới
                  </div>
                  <div className="mt-0.5 text-xs text-slate-600">
                    Nếu bỏ chọn, Shop sẽ tạm ngưng quay đơn mới nhưng mọi video cũ vẫn tra cứu bình thường.
                  </div>
                </div>
              </label>

              {shopModalError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-red-600"
                    aria-hidden="true"
                  />
                  <span>{shopModalError}</span>
                </div>
              )}

              <div className="modal-actions border-t border-slate-200 pt-4">
                <button
                  type="button"
                  className="btn btn-outline cursor-pointer"
                  onClick={() => setEditingShop(null)}
                  disabled={isSavingShop}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn btn-primary cursor-pointer"
                  disabled={isSavingShop}
                >
                  {isSavingShop ? 'Đang lưu...' : 'Lưu thay đổi'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Shop Confirmation Modal */}
      {deletingShop && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isDeletingShop) {
              setDeletingShop(null);
            }
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wh-delete-shop-title"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <h2
                id="wh-delete-shop-title"
                className="m-0 text-lg font-bold text-slate-900"
              >
                Xóa Shop ({deletingShop.code})
              </h2>
              <button
                type="button"
                onClick={() => setDeletingShop(null)}
                disabled={isDeletingShop}
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm text-slate-700">
              {deletingShop.recordingCount > 0 ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-amber-950">
                    <AlertTriangle
                      className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                      aria-hidden="true"
                    />
                    <div>
                      <div className="font-bold">
                        Shop đang lưu {deletingShop.recordingCount} video đơn hàng
                      </div>
                      <p className="mt-1 mb-0 text-xs leading-relaxed">
                        Nếu chỉ muốn ngừng quay đơn mới mà vẫn giữ lại video cũ để đối soát, bạn nên chọn{' '}
                        <strong>Tạm ngưng Shop</strong>.
                      </p>
                    </div>
                  </div>

                  <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-red-200 bg-red-50/70 p-3 text-xs font-medium text-red-950">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-red-600"
                      checked={confirmForceDeleteShop}
                      onChange={(e) => setConfirmForceDeleteShop(e.target.checked)}
                    />
                    <span>
                      Tôi xác nhận muốn xóa vĩnh viễn Shop{' '}
                      <strong>{deletingShop.name}</strong> cùng toàn bộ{' '}
                      <strong>{deletingShop.warehouses.length}</strong> kho và{' '}
                      <strong>{deletingShop.recordingCount}</strong> bản ghi video bên trong.
                    </span>
                  </label>
                </div>
              ) : (
                <p className="m-0 leading-relaxed">
                  Bạn có chắc chắn muốn xóa vĩnh viễn Shop{' '}
                  <strong>{deletingShop.name}</strong> ({deletingShop.code}) cùng{' '}
                  <strong>{deletingShop.warehouses.length}</strong> kho trực thuộc không? Thao tác này không thể hoàn tác.
                </p>
              )}

              {deleteShopError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-red-600"
                    aria-hidden="true"
                  />
                  <span>{deleteShopError}</span>
                </div>
              )}

              <div className="modal-actions border-t border-slate-200 pt-4">
                <button
                  type="button"
                  className="btn btn-outline cursor-pointer"
                  onClick={() => setDeletingShop(null)}
                  disabled={isDeletingShop}
                >
                  Đóng
                </button>
                {deletingShop.recordingCount > 0 && deletingShop.isActive && (
                  <button
                    type="button"
                    className="btn btn-outline cursor-pointer text-amber-800 hover:bg-amber-50"
                    onClick={() => {
                      const target = deletingShop;
                      setDeletingShop(null);
                      void handleToggleShopActive(target);
                    }}
                  >
                    Tạm ngưng Shop
                  </button>
                )}
                <button
                  type="button"
                  disabled={
                    isDeletingShop ||
                    (deletingShop.recordingCount > 0 && !confirmForceDeleteShop)
                  }
                  onClick={() => void handleConfirmDeleteShop()}
                  className="btn cursor-pointer bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {isDeletingShop ? 'Đang xóa...' : 'Xác nhận xóa Shop'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit Warehouse Modal */}
      {(createWhShop || editingWh) && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isSavingWh) {
              setCreateWhShop(null);
              setEditingWh(null);
            }
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wh-upsert-title"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <div>
                <h2
                  id="wh-upsert-title"
                  className="m-0 text-lg font-bold text-slate-900"
                >
                  {editingWh ? 'Chỉnh sửa Kho đóng gói' : 'Thêm Kho đóng gói mới'}
                </h2>
                {createWhShop && (
                  <p className="mt-0.5 mb-0 text-xs text-slate-500">
                    Trực thuộc: <strong>{createWhShop.name}</strong>
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setCreateWhShop(null);
                  setEditingWh(null);
                }}
                disabled={isSavingWh}
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => void handleWarehouseSubmit(e)}
            >
              <div>
                <label
                  htmlFor="wh-upsert-name"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Tên Kho đóng gói <span className="text-red-600">*</span>
                </label>
                <input
                  id="wh-upsert-name"
                  type="text"
                  className="form-input"
                  maxLength={128}
                  value={whNameInput}
                  onChange={(e) => setWhNameInput(e.target.value)}
                  placeholder="Ví dụ: Kho Cầu Giấy - Hà Nội"
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="wh-upsert-code"
                  className="mb-1 block text-xs font-semibold text-slate-700"
                >
                  Mã định danh Kho <span className="text-red-600">*</span>
                </label>
                <input
                  id="wh-upsert-code"
                  type="text"
                  className="form-input mono-code"
                  maxLength={32}
                  value={whCodeInput}
                  onChange={(e) => setWhCodeInput(e.target.value)}
                  placeholder="Ví dụ: WH-HN-01"
                  required
                />
                <span className="mt-1 block text-[11px] text-slate-500">
                  Chỉ gồm chữ không dấu, số, dấu gạch ngang (-) hoặc gạch dưới (_)
                </span>
              </div>

              {editingWh && (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
                    checked={whActiveInput}
                    onChange={(e) => setWhActiveInput(e.target.checked)}
                  />
                  <div>
                    <div className="font-semibold text-slate-900">
                      Kho đang hoạt động
                    </div>
                    <div className="mt-0.5 text-xs text-slate-600">
                      Khi tạm ngưng, kho sẽ không hiện ở màn hình quay đơn mới nhưng giữ nguyên toàn bộ video cũ.
                    </div>
                  </div>
                </label>
              )}

              {whModalError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-red-600"
                    aria-hidden="true"
                  />
                  <span>{whModalError}</span>
                </div>
              )}

              <div className="modal-actions border-t border-slate-200 pt-4">
                <button
                  type="button"
                  className="btn btn-outline cursor-pointer"
                  onClick={() => {
                    setCreateWhShop(null);
                    setEditingWh(null);
                  }}
                  disabled={isSavingWh}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn btn-primary cursor-pointer"
                  disabled={isSavingWh}
                >
                  {isSavingWh
                    ? 'Đang lưu...'
                    : editingWh
                      ? 'Lưu thay đổi'
                      : 'Thêm Kho'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Warehouse Confirmation Modal */}
      {deletingWh && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isDeletingWh) {
              setDeletingWh(null);
            }
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wh-delete-warehouse-title"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <h2
                id="wh-delete-warehouse-title"
                className="m-0 text-lg font-bold text-slate-900"
              >
                Xóa Kho đóng gói ({deletingWh.warehouse.code})
              </h2>
              <button
                type="button"
                onClick={() => setDeletingWh(null)}
                disabled={isDeletingWh}
                className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm text-slate-700">
              {deletingWh.warehouse.recordingCount > 0 ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-amber-950">
                    <AlertTriangle
                      className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                      aria-hidden="true"
                    />
                    <div>
                      <div className="font-bold">
                        Kho này đang lưu {deletingWh.warehouse.recordingCount} video đơn hàng
                      </div>
                      <p className="mt-1 mb-0 text-xs leading-relaxed">
                        Nếu muốn giữ lại video cũ để đối soát, bạn nên chọn{' '}
                        <strong>Tạm ngưng kho</strong>.
                      </p>
                    </div>
                  </div>

                  <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-red-200 bg-red-50/70 p-3 text-xs font-medium text-red-950">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-red-600"
                      checked={confirmForceDeleteWh}
                      onChange={(e) => setConfirmForceDeleteWh(e.target.checked)}
                    />
                    <span>
                      Tôi xác nhận muốn xóa vĩnh viễn Kho{' '}
                      <strong>{deletingWh.warehouse.name}</strong> cùng toàn bộ{' '}
                      <strong>{deletingWh.warehouse.recordingCount}</strong> bản ghi video bên trong.
                    </span>
                  </label>
                </div>
              ) : (
                <p className="m-0 leading-relaxed">
                  Bạn có chắc chắn muốn xóa Kho{' '}
                  <strong>{deletingWh.warehouse.name}</strong> (
                  {deletingWh.warehouse.code}) thuộc{' '}
                  <strong>{deletingWh.shop.name}</strong> không?
                </p>
              )}

              {deleteWhError && (
                <div
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-red-600"
                    aria-hidden="true"
                  />
                  <span>{deleteWhError}</span>
                </div>
              )}

              <div className="modal-actions border-t border-slate-200 pt-4">
                <button
                  type="button"
                  className="btn btn-outline cursor-pointer"
                  onClick={() => setDeletingWh(null)}
                  disabled={isDeletingWh}
                >
                  Đóng
                </button>
                {deletingWh.warehouse.recordingCount > 0 &&
                  deletingWh.warehouse.isActive && (
                    <button
                      type="button"
                      className="btn btn-outline cursor-pointer text-amber-800 hover:bg-amber-50"
                      onClick={() => {
                        const target = deletingWh.warehouse;
                        setDeletingWh(null);
                        void handleToggleWarehouseActive(target);
                      }}
                    >
                      Tạm ngưng kho
                    </button>
                  )}
                <button
                  type="button"
                  disabled={
                    isDeletingWh ||
                    (deletingWh.warehouse.recordingCount > 0 &&
                      !confirmForceDeleteWh)
                  }
                  onClick={() => void handleConfirmDeleteWarehouse()}
                  className="btn cursor-pointer bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {isDeletingWh ? 'Đang xóa...' : 'Xác nhận xóa Kho'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
