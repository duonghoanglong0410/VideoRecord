import { apiRequest } from '../../app/apiClient';

export type BarcodeFormatHint = 'Unknown' | 'OneDimensional' | 'QrCode' | 'ManualEntry';

export interface PackingStationOption {
  id: string;
  code: string;
  name: string;
}

export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
  packingStations: PackingStationOption[];
}

export interface ShopOption {
  id: string;
  code: string;
  slug: string;
  name: string;
  warehouses: WarehouseOption[];
}

export interface AccessibleShopsResponse {
  shops: ShopOption[];
}

export interface InspectTrackingCodeRequest {
  shopId: string;
  warehouseId: string;
  rawCode: string;
  formatHint?: BarcodeFormatHint;
}

export interface InspectTrackingCodeResponse {
  isValid: boolean;
  trackingNumber: string | null;
  carrierCode: string | null;
  tikTokOrderId: string | null;
  matchedRule: string | null;
  existingRecordingCount: number;
  warningMessage: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface RecordingRuntimeLimits {
  maxRecordingSeconds: number;
  maxUploadBytes: number;
  maxLocalPendingRecordings: number;
  enableAudioRecording: boolean;
}

export interface CreateRecordingRequest {
  shopId: string;
  warehouseId: string;
  packingStationId?: string | null;
  rawCode: string;
  formatHint?: BarcodeFormatHint;
  isManualEntry?: boolean;
  manualEntryReason?: string | null;
  linkedFromRecordingId?: string | null;
  clientMimeType?: string | null;
}

export interface RecordingDto {
  id: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerFullName: string;
  shopId: string;
  shopName: string;
  warehouseId: string;
  warehouseName: string;
  packingStationId: string | null;
  trackingNumber: string;
  safeTrackingSegment: string;
  carrierCode: string | null;
  tikTokOrderId: string | null;
  source: 'RecordedInBrowser' | 'Imported';
  manualEntryReason: string | null;
  linkedFromRecordingId: string | null;
  captureStatus: 'Created' | 'Recording' | 'Captured' | 'Interrupted' | 'Cancelled';
  storageStatus:
    | 'AwaitingUpload'
    | 'Uploading'
    | 'Validating'
    | 'WaitingForStorage'
    | 'CopyingToStorage'
    | 'Stored'
    | 'Failed';
  previewStatus: 'NotRequired' | 'Pending' | 'Processing' | 'Ready' | 'Failed';
  clientMimeType: string | null;
  durationSeconds: number | null;
  startedAtUtc: string | null;
  endedAtUtc: string | null;
  storedAtUtc: string | null;
  hold: boolean;
  lastErrorCode: string | null;
  userSafeErrorMessage: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
  isRetryable?: boolean;
  serverReceivedAtUtc?: string | null;
  actualContainer?: string | null;
  videoCodec?: string | null;
  storageMode?: 'LocalDevelopment' | 'SynologyMounted' | null;
}

export interface UploadSessionDto {
  uploadSessionId: string;
  recordingId: string;
  tusResourceId: string | null;
  tusUploadUrl: string | null;
  expectedBytes: number;
  receivedBytes: number;
  recommendedChunkBytes: number;
  sessionStatus: 'Initiated' | 'Receiving' | 'Completed' | 'Expired' | 'Aborted';
  recordingStorageStatus: RecordingDto['storageStatus'];
  expiresAtUtc: string;
}

export interface CreateRecordingResponse {
  recording: RecordingDto;
  existingRecordingCount: number;
  warningMessage: string | null;
  limits: RecordingRuntimeLimits;
}

export interface RecordingEventRequest {
  eventType: 'started' | 'captured' | 'interrupted' | 'cancelled';
  clientMimeType?: string | null;
  durationSeconds?: number | null;
  errorCode?: string | null;
  reason?: string | null;
}

export function fetchAccessibleShops(): Promise<AccessibleShopsResponse> {
  return apiRequest<AccessibleShopsResponse>('/api/shops', { method: 'GET' });
}

export function inspectTrackingCodeApi(
  payload: InspectTrackingCodeRequest
): Promise<InspectTrackingCodeResponse> {
  return apiRequest<InspectTrackingCodeResponse>('/api/recordings/inspect-code', {
    method: 'POST',
    body: payload
  });
}

export function createRecordingSessionApi(
  payload: CreateRecordingRequest
): Promise<CreateRecordingResponse> {
  return apiRequest<CreateRecordingResponse>('/api/recordings', {
    method: 'POST',
    body: payload
  });
}

export function postRecordingEventApi(
  recordingId: string,
  payload: RecordingEventRequest,
  options?: { suppressSessionExpiredEvent?: boolean }
): Promise<RecordingDto> {
  return apiRequest<RecordingDto>(`/api/recordings/${recordingId}/events`, {
    method: 'POST',
    body: payload,
    suppressSessionExpiredEvent: options?.suppressSessionExpiredEvent
  });
}

export function createOrGetUploadSessionApi(
  recordingId: string,
  expectedBytes: number,
  options?: { clientSha256?: string | null; suppressSessionExpiredEvent?: boolean }
): Promise<UploadSessionDto> {
  return apiRequest<UploadSessionDto>(`/api/recordings/${recordingId}/upload-session`, {
    method: 'POST',
    body: {
      expectedBytes,
      clientSha256: options?.clientSha256 ?? null
    },
    suppressSessionExpiredEvent: options?.suppressSessionExpiredEvent
  });
}

export function getRecordingByIdApi(
  recordingId: string,
  options?: { suppressSessionExpiredEvent?: boolean }
): Promise<RecordingDto> {
  return apiRequest<RecordingDto>(`/api/recordings/${recordingId}`, {
    method: 'GET',
    suppressSessionExpiredEvent: options?.suppressSessionExpiredEvent
  });
}

export function retryRecordingStorageApi(
  recordingId: string,
  options?: { suppressSessionExpiredEvent?: boolean }
): Promise<RecordingDto> {
  return apiRequest<RecordingDto>(`/api/recordings/${recordingId}/retry-storage`, {
    method: 'POST',
    body: {},
    suppressSessionExpiredEvent: options?.suppressSessionExpiredEvent
  });
}

