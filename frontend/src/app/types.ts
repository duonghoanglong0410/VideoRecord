export type ApprovalStatus = 'PendingApproval' | 'Active' | 'Locked';
export type StorageMode = 'LocalDevelopment' | 'SynologyMounted';
export type ScopeType = 'Own' | 'Warehouse' | 'Shop' | 'All';

export const Permissions = {
  RecordingCreate: 'recording.create',
  RecordingManualCode: 'recording.manual_code',
  VideoUpload: 'video.upload',
  VideoImport: 'video.import',
  VideoView: 'video.view',
  VideoDownload: 'video.download',
  VideoNote: 'video.note',
  VideoHold: 'video.hold',
  VideoDeleteRequest: 'video.delete.request',
  VideoDeleteApprove: 'video.delete.approve',
  UserManage: 'user.manage',
  RoleManage: 'role.manage',
  StorageManage: 'storage.manage',
  AuditView: 'audit.view'
} as const;

export interface UserGrant {
  id: string;
  roleId: string;
  roleName: string;
  scopeType: ScopeType;
  shopId: string | null;
  shopName: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
}

export interface RuntimeConfig {
  storageMode: StorageMode;
  maxRecordingSeconds: number;
  maxUploadBytes: number;
  maxLocalPendingRecordings: number;
  uploadChunkBytes: number;
  enableAudioRecording: boolean;
  smtpConfigured: boolean;
}

export interface AuthMe {
  id: string;
  email: string;
  fullName: string;
  approvalStatus: ApprovalStatus;
  twoFactorEnabled: boolean;
  forcePasswordReset: boolean;
  isSuperAdmin: boolean;
  defaultShopId: string | null;
  defaultWarehouseId: string | null;
  permissions: string[];
  grants: UserGrant[];
  runtimeConfig: RuntimeConfig;
  csrfToken?: string | null;
}

export interface LoginResponse {
  requiresTwoFactor: boolean;
  user: AuthMe | null;
  csrfToken?: string | null;
}

export interface MfaSetupResponse {
  sharedKey: string;
  authenticatorUri: string;
}

export interface MfaEnableResponse {
  enabled: boolean;
  recoveryCodes: string[];
}

export interface ApiErrorPayload {
  errorCode?: string;
  message?: string;
  details?: string[];
}

