import { apiRequest } from '../../app/apiClient';
import type {
  AuditOutcomeType,
  CaptureStatusType,
  RecordingSourceType,
  StorageStatusType
} from '../../app/formatters';
import type { ApprovalStatus, ScopeType, StorageMode, UserGrant } from '../../app/types';

export interface PaginatedResponse<T> {
  items: T[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface DashboardRecentVideoDto {
  id: string;
  trackingNumber: string;
  shopName: string;
  warehouseName: string;
  ownerFullName: string;
  source: RecordingSourceType;
  captureStatus: CaptureStatusType;
  storageStatus: StorageStatusType;
  storageMode: StorageMode;
  hold: boolean;
  durationSeconds: number | null;
  createdAtUtc: string;
  storedAtUtc: string | null;
}

export interface DashboardSummaryDto {
  activeStorageMode: StorageMode;
  todayRecordingsCount: number;
  totalStoredCount: number;
  awaitingOrValidatingCount: number;
  interruptedOrFailedCount: number;
  onHoldCount: number;
  pendingDeletionRequestsCount: number | null;
  pendingUserApprovalsCount: number | null;
  hasVideoViewScope: boolean;
  canCreateRecording: boolean;
  recentVideos: DashboardRecentVideoDto[];
  generatedAtUtc: string;
}

export interface GrantProposalDto {
  roleId: string;
  scopeType: ScopeType;
  shopId?: string | null;
  warehouseId?: string | null;
}

export interface AdminUserSummaryDto {
  id: string;
  email: string;
  fullName: string;
  approvalStatus: ApprovalStatus;
  twoFactorEnabled: boolean;
  isLockedOut: boolean;
  forcePasswordReset: boolean;
  defaultShopId: string | null;
  defaultWarehouseId: string | null;
  createdAtUtc: string;
  approvedAtUtc: string | null;
  grants: UserGrant[];
}

export interface AdminPasswordResetInitiatedResponse {
  userId: string;
  email: string;
  resetToken: string;
  message: string;
}

export interface RoleDto {
  id: string;
  name: string;
  description: string;
  isSystemRole: boolean;
  createdAtUtc: string;
  permissions: string[];
}

export interface PermissionDto {
  code: string;
  group: string;
  description: string;
}

export interface UpsertCustomRoleRequest {
  name: string;
  description: string;
  permissions: string[];
}

export interface AdminWarehouseStorageDto {
  id: string;
  shopId: string;
  code: string;
  name: string;
  isActive: boolean;
  packingStationCount: number;
  createdAtUtc: string;
}

export interface AdminShopStorageDto {
  id: string;
  code: string;
  slug: string;
  name: string;
  allowedStorageSubdir: string;
  isActive: boolean;
  createdAtUtc: string;
  warehouses: AdminWarehouseStorageDto[];
}

export interface StagingUsageDto {
  maxStagingBytes: number;
  diskUsedBytes: number;
  reservedRemainingBytes: number;
  totalFootprintBytes: number;
  availableBytes: number;
}

export interface AdminStorageOverviewDto {
  profileId: string;
  profileName: string;
  storageMode: StorageMode;
  expectedStorageIdConfigured: boolean;
  markerFileName: string;
  maxRecordingSeconds: number;
  maxUploadBytes: number;
  maxLocalPendingRecordings: number;
  uploadChunkBytes: number;
  enableAudioRecording: boolean;
  retentionEnabled: boolean;
  retentionDays: number;
  stagingUsage: StagingUsageDto;
  allowedSubdirectories: string[];
  shops: AdminShopStorageDto[];
  updatedAtUtc: string;
}

export interface StorageHealthCheckResponseDto {
  mode: StorageMode;
  isHealthy: boolean;
  rootExists: boolean;
  markerValid: boolean;
  canReadWrite: boolean;
  availableFreeBytes: number | null;
  totalCapacityBytes: number | null;
  isLowSpaceWarning: boolean;
  capacityWarningMessage: string | null;
  errorCode: string | null;
  statusMessage: string;
  checkedAtUtc: string;
}

export interface ShopStorageSubdirUpdateDto {
  shopId: string;
  allowedStorageSubdir: string;
}

export interface UpdateAdminStorageRequest {
  maxRecordingSeconds: number;
  maxUploadBytes: number;
  maxLocalPendingRecordings: number;
  enableAudioRecording: boolean;
  retentionEnabled: boolean;
  retentionDays: number;
  confirmRetentionEnable: boolean;
  shopSubdirectories?: ShopStorageSubdirUpdateDto[];
}

export interface CreateAdminShopRequest {
  code: string;
  name: string;
  slug?: string | null;
  allowedStorageSubdir?: string | null;
  createDefaultWarehouse?: boolean;
  defaultWarehouseName?: string | null;
}

export interface CreateAdminWarehouseRequest {
  code: string;
  name: string;
  createDefaultStation?: boolean;
}

export interface AdminPackingStationDto {
  id: string;
  warehouseId: string;
  code: string;
  name: string;
  isActive: boolean;
  createdAtUtc: string;
}

export interface AdminWarehouseDetailDto {
  id: string;
  shopId: string;
  code: string;
  name: string;
  isActive: boolean;
  assignedUserCount: number;
  recordingCount: number;
  createdAtUtc: string;
  packingStations: AdminPackingStationDto[];
}

export interface AdminShopWarehouseTreeDto {
  id: string;
  code: string;
  slug: string;
  name: string;
  allowedStorageSubdir: string;
  isActive: boolean;
  assignedUserCount: number;
  recordingCount: number;
  createdAtUtc: string;
  warehouses: AdminWarehouseDetailDto[];
}

export interface AdminWarehousesOverviewDto {
  canManageShops: boolean;
  shops: AdminShopWarehouseTreeDto[];
}

export interface CreateAdminUserRequest {
  fullName: string;
  email: string;
  password: string;
  grants?: GrantProposalDto[];
  defaultShopId?: string | null;
  defaultWarehouseId?: string | null;
  forcePasswordReset?: boolean;
}

export interface UpdateAdminUserProfileRequest {
  fullName: string;
  defaultShopId?: string | null;
  defaultWarehouseId?: string | null;
}

export interface AdminSetUserPasswordRequest {
  newPassword: string;
  forcePasswordReset?: boolean;
}

export interface AuditEventDto {
  id: number;
  occurredAtUtc: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  shopId: string | null;
  shopName: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  outcome: AuditOutcomeType;
  ipAddress: string | null;
  userAgent: string | null;
  metadataJson: string;
}

export function fetchDashboardSummaryApi(options?: {
  suppressSessionExpiredEvent?: boolean;
}): Promise<DashboardSummaryDto> {
  return apiRequest<DashboardSummaryDto>('/api/dashboard/summary', {
    method: 'GET',
    suppressSessionExpiredEvent: options?.suppressSessionExpiredEvent
  });
}

export function listAdminUsersApi(params: {
  q?: string;
  approvalStatus?: ApprovalStatus | '';
  shopId?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<AdminUserSummaryDto>> {
  const qs = new URLSearchParams();
  if (params.q && params.q.trim()) {
    qs.set('q', params.q.trim());
  }
  if (params.approvalStatus) {
    qs.set('approvalStatus', params.approvalStatus);
  }
  if (params.shopId) {
    qs.set('shopId', params.shopId);
  }
  qs.set('page', String(params.page ?? 1));
  qs.set('pageSize', String(params.pageSize ?? 20));

  return apiRequest<PaginatedResponse<AdminUserSummaryDto>>(
    `/api/admin/users?${qs.toString()}`,
    { method: 'GET' }
  );
}

export function approveAdminUserApi(
  userId: string,
  payload: {
    grants?: GrantProposalDto[];
    defaultShopId?: string | null;
    defaultWarehouseId?: string | null;
  }
): Promise<AdminUserSummaryDto> {
  return apiRequest<AdminUserSummaryDto>(`/api/admin/users/${userId}/approve`, {
    method: 'POST',
    body: payload
  });
}

export function lockAdminUserApi(userId: string): Promise<{ message: string }> {
  return apiRequest<{ message: string }>(`/api/admin/users/${userId}/lock`, {
    method: 'POST',
    body: {}
  });
}

export function unlockAdminUserApi(userId: string): Promise<{ message: string }> {
  return apiRequest<{ message: string }>(`/api/admin/users/${userId}/unlock`, {
    method: 'POST',
    body: {}
  });
}

export function revokeAdminUserSessionsApi(userId: string): Promise<{ message: string }> {
  return apiRequest<{ message: string }>(`/api/admin/users/${userId}/revoke-sessions`, {
    method: 'POST',
    body: {}
  });
}

export function updateAdminUserGrantsApi(
  userId: string,
  payload: {
    grants: GrantProposalDto[];
    defaultShopId?: string | null;
    defaultWarehouseId?: string | null;
  }
): Promise<AdminUserSummaryDto> {
  return apiRequest<AdminUserSummaryDto>(`/api/admin/users/${userId}/grants`, {
    method: 'PUT',
    body: payload
  });
}

export function initiateAdminPasswordResetApi(
  userId: string
): Promise<AdminPasswordResetInitiatedResponse> {
  return apiRequest<AdminPasswordResetInitiatedResponse>(
    `/api/admin/users/${userId}/initiate-password-reset`,
    {
      method: 'POST',
      body: {}
    }
  );
}

export function createAdminUserApi(
  payload: CreateAdminUserRequest
): Promise<AdminUserSummaryDto> {
  return apiRequest<AdminUserSummaryDto>('/api/admin/users', {
    method: 'POST',
    body: payload
  });
}

export function updateAdminUserProfileApi(
  userId: string,
  payload: UpdateAdminUserProfileRequest
): Promise<AdminUserSummaryDto> {
  return apiRequest<AdminUserSummaryDto>(`/api/admin/users/${userId}/profile`, {
    method: 'PUT',
    body: payload
  });
}

export function setAdminUserPasswordDirectApi(
  userId: string,
  payload: AdminSetUserPasswordRequest
): Promise<{ message: string }> {
  return apiRequest<{ message: string }>(`/api/admin/users/${userId}/set-password`, {
    method: 'POST',
    body: payload
  });
}

export function listAdminRolesApi(): Promise<RoleDto[]> {
  return apiRequest<RoleDto[]>('/api/admin/roles', { method: 'GET' });
}

export function listAdminPermissionsApi(): Promise<PermissionDto[]> {
  return apiRequest<PermissionDto[]>('/api/admin/permissions', { method: 'GET' });
}

export function createCustomRoleApi(payload: UpsertCustomRoleRequest): Promise<RoleDto> {
  return apiRequest<RoleDto>('/api/admin/roles', {
    method: 'POST',
    body: payload
  });
}

export function updateCustomRoleApi(
  roleId: string,
  payload: UpsertCustomRoleRequest
): Promise<RoleDto> {
  return apiRequest<RoleDto>(`/api/admin/roles/${roleId}`, {
    method: 'PUT',
    body: payload
  });
}

export function getAdminStorageOverviewApi(): Promise<AdminStorageOverviewDto> {
  return apiRequest<AdminStorageOverviewDto>('/api/admin/storage', { method: 'GET' });
}

export function runAdminStorageHealthCheckApi(): Promise<StorageHealthCheckResponseDto> {
  return apiRequest<StorageHealthCheckResponseDto>('/api/admin/storage/health-check', {
    method: 'POST',
    body: {}
  });
}

export function updateAdminStorageSettingsApi(
  payload: UpdateAdminStorageRequest
): Promise<AdminStorageOverviewDto> {
  return apiRequest<AdminStorageOverviewDto>('/api/admin/storage', {
    method: 'PUT',
    body: payload
  });
}

export function createAdminShopApi(
  payload: CreateAdminShopRequest
): Promise<AdminShopStorageDto> {
  return apiRequest<AdminShopStorageDto>('/api/admin/shops', {
    method: 'POST',
    body: payload
  });
}

export function createAdminWarehouseApi(
  shopId: string,
  payload: CreateAdminWarehouseRequest
): Promise<AdminWarehouseStorageDto> {
  return apiRequest<AdminWarehouseStorageDto>(`/api/admin/shops/${shopId}/warehouses`, {
    method: 'POST',
    body: payload
  });
}

export function getAdminWarehousesOverviewApi(): Promise<AdminWarehousesOverviewDto> {
  return apiRequest<AdminWarehousesOverviewDto>('/api/admin/warehouses/overview', {
    method: 'GET'
  });
}

export function updateAdminShopInfoApi(
  shopId: string,
  payload: {
    code?: string;
    name: string;
    allowedStorageSubdir?: string;
    isActive: boolean;
  }
): Promise<{ message: string }> {
  return apiRequest<{ message: string }>(`/api/admin/warehouses/shops/${shopId}`, {
    method: 'PUT',
    body: payload
  });
}

export function deleteAdminShopApi(
  shopId: string,
  force = false
): Promise<{ message: string }> {
  const qs = force ? '?force=true' : '';
  return apiRequest<{ message: string }>(`/api/admin/warehouses/shops/${shopId}${qs}`, {
    method: 'DELETE'
  });
}

export function createManagedWarehouseApi(
  shopId: string,
  payload: CreateAdminWarehouseRequest
): Promise<AdminWarehouseDetailDto> {
  return apiRequest<AdminWarehouseDetailDto>(`/api/admin/warehouses/shops/${shopId}`, {
    method: 'POST',
    body: payload
  });
}

export function updateManagedWarehouseApi(
  warehouseId: string,
  payload: { code: string; name: string; isActive: boolean }
): Promise<AdminWarehouseDetailDto> {
  return apiRequest<AdminWarehouseDetailDto>(`/api/admin/warehouses/${warehouseId}`, {
    method: 'PUT',
    body: payload
  });
}

export function deleteManagedWarehouseApi(
  warehouseId: string,
  force = false
): Promise<{ message: string }> {
  const qs = force ? '?force=true' : '';
  return apiRequest<{ message: string }>(`/api/admin/warehouses/${warehouseId}${qs}`, {
    method: 'DELETE'
  });
}

export function createPackingStationApi(
  warehouseId: string,
  payload: { code: string; name: string }
): Promise<AdminPackingStationDto> {
  return apiRequest<AdminPackingStationDto>(
    `/api/admin/warehouses/${warehouseId}/stations`,
    {
      method: 'POST',
      body: payload
    }
  );
}

export function updatePackingStationApi(
  stationId: string,
  payload: { code: string; name: string; isActive: boolean }
): Promise<AdminPackingStationDto> {
  return apiRequest<AdminPackingStationDto>(
    `/api/admin/warehouses/stations/${stationId}`,
    {
      method: 'PUT',
      body: payload
    }
  );
}

export function deletePackingStationApi(
  stationId: string
): Promise<{ message: string }> {
  return apiRequest<{ message: string }>(
    `/api/admin/warehouses/stations/${stationId}`,
    {
      method: 'DELETE'
    }
  );
}

export function listAuditEventsApi(params: {
  action?: string;
  actorEmail?: string;
  entityType?: string;
  outcome?: AuditOutcomeType | '';
  shopId?: string;
  warehouseId?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<AuditEventDto>> {
  const qs = new URLSearchParams();
  if (params.action && params.action.trim()) {
    qs.set('action', params.action.trim());
  }
  if (params.actorEmail && params.actorEmail.trim()) {
    qs.set('actorEmail', params.actorEmail.trim());
  }
  if (params.entityType && params.entityType.trim()) {
    qs.set('entityType', params.entityType.trim());
  }
  if (params.outcome) {
    qs.set('outcome', params.outcome);
  }
  if (params.shopId) {
    qs.set('shopId', params.shopId);
  }
  if (params.warehouseId) {
    qs.set('warehouseId', params.warehouseId);
  }
  if (params.fromDate) {
    qs.set('fromDate', params.fromDate);
  }
  if (params.toDate) {
    qs.set('toDate', params.toDate);
  }
  qs.set('page', String(params.page ?? 1));
  qs.set('pageSize', String(params.pageSize ?? 25));

  return apiRequest<PaginatedResponse<AuditEventDto>>(
    `/api/admin/audit?${qs.toString()}`,
    { method: 'GET' }
  );
}
