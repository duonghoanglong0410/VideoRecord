import { apiRequest } from '../../app/apiClient';
import type {
  CaptureStatusType,
  DeletionRequestStatusType,
  PreviewStatusType,
  RecordingSourceType,
  StorageStatusType
} from '../../app/formatters';
import type { StorageMode } from '../../app/types';
import type {
  BarcodeFormatHint,
  RecordingDto,
  RecordingRuntimeLimits,
  UploadSessionDto
} from '../recording/recordingApi';

export interface VideoListItemDto {
  id: string;
  trackingNumber: string;
  carrierCode: string | null;
  tikTokOrderId: string | null;
  shopId: string;
  shopName: string;
  warehouseId: string;
  warehouseName: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerFullName: string;
  source: RecordingSourceType;
  isManualCode: boolean;
  captureStatus: CaptureStatusType;
  storageStatus: StorageStatusType;
  previewStatus: PreviewStatusType;
  storageMode: StorageMode;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  actualMimeType: string | null;
  originalSizeBytes: number | null;
  hasPreviewAsset: boolean;
  hold: boolean;
  holdReason: string | null;
  noteCount: number;
  hasPendingDeletionRequest: boolean;
  startedAtUtc: string | null;
  endedAtUtc: string | null;
  storedAtUtc: string | null;
  createdAtUtc: string;
  lastErrorCode: string | null;
  userSafeErrorMessage: string | null;
}

export interface PagedVideosResponse {
  items: VideoListItemDto[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface VideoNoteDto {
  id: string;
  recordingId: string;
  authorUserId: string;
  authorEmail: string;
  authorFullName: string;
  content: string;
  createdAtUtc: string;
}

export interface VideoDeletionRequestSummaryDto {
  id: string;
  recordingId: string;
  requestedByUserId: string;
  requestedByEmail: string;
  requestedByFullName: string;
  reason: string;
  status: DeletionRequestStatusType;
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedByFullName: string | null;
  reviewNote: string | null;
  createdAtUtc: string;
  reviewedAtUtc: string | null;
}

export interface VideoDetailDto {
  id: string;
  trackingNumber: string;
  carrierCode: string | null;
  tikTokOrderId: string | null;
  shopId: string;
  shopCode: string;
  shopName: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  packingStationName: string | null;
  ownerUserId: string;
  ownerEmail: string;
  ownerFullName: string;
  source: RecordingSourceType;
  isManualCode: boolean;
  manualEntryReason: string | null;
  linkedFromRecordingId: string | null;
  linkedFromTrackingNumber: string | null;
  captureStatus: CaptureStatusType;
  storageStatus: StorageStatusType;
  previewStatus: PreviewStatusType;
  storageMode: StorageMode;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  actualMimeType: string | null;
  actualContainer: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  originalSizeBytes: number | null;
  originalSha256: string | null;
  hasOriginalAsset: boolean;
  hasPreviewAsset: boolean;
  previewSizeBytes: number | null;
  startedAtUtc: string | null;
  endedAtUtc: string | null;
  serverReceivedAtUtc: string | null;
  storedAtUtc: string | null;
  createdAtUtc: string;
  lastErrorCode: string | null;
  userSafeErrorMessage: string | null;
  isRetryable: boolean;
  hold: boolean;
  holdReason: string | null;
  holdUpdatedByUserId: string | null;
  holdUpdatedAtUtc: string | null;
  notes: VideoNoteDto[];
  deletionRequests: VideoDeletionRequestSummaryDto[];
  canDownload: boolean;
  canNote: boolean;
  canHold: boolean;
  canRequestDelete: boolean;
  canApproveDelete: boolean;
  canReRecordWithCorrectCode: boolean;
}

export interface VideoSearchFilters {
  trackingNumber?: string;
  q?: string;
  exact?: boolean;
  shopId?: string;
  warehouseId?: string;
  ownerUserId?: string;
  mineOnly?: boolean;
  captureStatus?: CaptureStatusType | '';
  storageStatus?: StorageStatusType | '';
  previewStatus?: PreviewStatusType | '';
  hold?: boolean | null;
  source?: RecordingSourceType | '';
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}

export interface CreateVideoImportRequest {
  shopId: string;
  warehouseId: string;
  rawCode?: string | null;
  trackingNumber?: string | null;
  formatHint?: BarcodeFormatHint;
  isManualEntry?: boolean;
  manualEntryReason?: string | null;
  packingStationId?: string | null;
  linkedFromRecordingId?: string | null;
  clientMimeType?: string | null;
  expectedBytes?: number | null;
  clientSha256?: string | null;
}

export interface CreateVideoImportResponse {
  recording: RecordingDto;
  uploadSession: UploadSessionDto | null;
  existingRecordingCount: number;
  warningMessage: string | null;
  limits: RecordingRuntimeLimits;
}

export interface VideoHoldStateDto {
  recordingId: string;
  hold: boolean;
  holdReason: string | null;
  holdUpdatedByUserId: string | null;
  holdUpdatedAtUtc: string | null;
}

export interface DeletionRequestListItemDto {
  id: string;
  recordingId: string;
  trackingNumber: string;
  shopId: string;
  shopName: string;
  warehouseId: string;
  warehouseName: string;
  recordingHold: boolean;
  recordingHoldReason: string | null;
  recordingIsSoftDeleted: boolean;
  requestedByUserId: string;
  requestedByEmail: string;
  requestedByFullName: string;
  reason: string;
  status: DeletionRequestStatusType;
  reviewedByUserId: string | null;
  reviewedByEmail: string | null;
  reviewedByFullName: string | null;
  reviewNote: string | null;
  createdAtUtc: string;
  reviewedAtUtc: string | null;
}

export interface PaginatedList<T> {
  items: T[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export type StreamVariantChoice = 'auto' | 'preview' | 'original';

export function buildVideosQueryString(filters: VideoSearchFilters): string {
  const params = new URLSearchParams();

  // Preserve leading zeros in tracking codes strictly as strings
  if (filters.trackingNumber !== undefined && filters.trackingNumber.trim().length > 0) {
    params.set('trackingNumber', filters.trackingNumber.trim());
  } else if (filters.q !== undefined && filters.q.trim().length > 0) {
    params.set('q', filters.q.trim());
  }

  if (filters.exact !== undefined) {
    params.set('exact', filters.exact ? 'true' : 'false');
  }
  if (filters.shopId) {
    params.set('shopId', filters.shopId);
  }
  if (filters.warehouseId) {
    params.set('warehouseId', filters.warehouseId);
  }
  if (filters.ownerUserId) {
    params.set('ownerUserId', filters.ownerUserId);
  }
  if (filters.mineOnly) {
    params.set('mineOnly', 'true');
  }
  if (filters.captureStatus) {
    params.set('captureStatus', filters.captureStatus);
  }
  if (filters.storageStatus) {
    params.set('storageStatus', filters.storageStatus);
  }
  if (filters.previewStatus) {
    params.set('previewStatus', filters.previewStatus);
  }
  if (filters.hold !== undefined && filters.hold !== null) {
    params.set('hold', filters.hold ? 'true' : 'false');
  }
  if (filters.source) {
    params.set('source', filters.source);
  }
  if (filters.fromDate) {
    params.set('fromDate', filters.fromDate);
  }
  if (filters.toDate) {
    params.set('toDate', filters.toDate);
  }
  params.set('page', String(filters.page ?? 1));
  params.set('pageSize', String(filters.pageSize ?? 20));

  return params.toString();
}

export function listVideosApi(filters: VideoSearchFilters): Promise<PagedVideosResponse> {
  const qs = buildVideosQueryString(filters);
  return apiRequest<PagedVideosResponse>(`/api/videos?${qs}`, { method: 'GET' });
}

export function getVideoDetailApi(recordingId: string): Promise<VideoDetailDto> {
  return apiRequest<VideoDetailDto>(`/api/videos/${recordingId}`, { method: 'GET' });
}

export function buildVideoStreamUrl(
  recordingId: string,
  variant: StreamVariantChoice = 'auto'
): string {
  return `/api/videos/${encodeURIComponent(recordingId)}/stream?variant=${encodeURIComponent(variant)}`;
}

export function buildVideoDownloadUrl(recordingId: string): string {
  return `/api/videos/${encodeURIComponent(recordingId)}/download`;
}

export function createVideoImportApi(
  payload: CreateVideoImportRequest
): Promise<CreateVideoImportResponse> {
  return apiRequest<CreateVideoImportResponse>('/api/videos/import', {
    method: 'POST',
    body: payload
  });
}

export function addVideoNoteApi(
  recordingId: string,
  content: string
): Promise<VideoNoteDto> {
  return apiRequest<VideoNoteDto>(`/api/videos/${recordingId}/notes`, {
    method: 'POST',
    body: { content }
  });
}

export function updateVideoHoldApi(
  recordingId: string,
  hold: boolean,
  reason?: string | null
): Promise<VideoHoldStateDto> {
  return apiRequest<VideoHoldStateDto>(`/api/videos/${recordingId}/hold`, {
    method: 'PUT',
    body: {
      hold,
      reason: reason ?? null
    }
  });
}

export function createDeletionRequestApi(
  recordingId: string,
  reason: string
): Promise<VideoDeletionRequestSummaryDto> {
  return apiRequest<VideoDeletionRequestSummaryDto>(
    `/api/videos/${recordingId}/deletion-requests`,
    {
      method: 'POST',
      body: { reason }
    }
  );
}

export function listDeletionRequestsApi(params: {
  status?: DeletionRequestStatusType | '';
  shopId?: string;
  warehouseId?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedList<DeletionRequestListItemDto>> {
  const qs = new URLSearchParams();
  if (params.status) {
    qs.set('status', params.status);
  }
  if (params.shopId) {
    qs.set('shopId', params.shopId);
  }
  if (params.warehouseId) {
    qs.set('warehouseId', params.warehouseId);
  }
  qs.set('page', String(params.page ?? 1));
  qs.set('pageSize', String(params.pageSize ?? 20));

  return apiRequest<PaginatedList<DeletionRequestListItemDto>>(
    `/api/deletion-requests?${qs.toString()}`,
    { method: 'GET' }
  );
}

export function approveDeletionRequestApi(
  requestId: string,
  reviewNote?: string | null
): Promise<VideoDeletionRequestSummaryDto> {
  return apiRequest<VideoDeletionRequestSummaryDto>(
    `/api/deletion-requests/${requestId}/approve`,
    {
      method: 'POST',
      body: { reviewNote: reviewNote ?? null }
    }
  );
}

export function rejectDeletionRequestApi(
  requestId: string,
  reviewNote?: string | null
): Promise<VideoDeletionRequestSummaryDto> {
  return apiRequest<VideoDeletionRequestSummaryDto>(
    `/api/deletion-requests/${requestId}/reject`,
    {
      method: 'POST',
      body: { reviewNote: reviewNote ?? null }
    }
  );
}
