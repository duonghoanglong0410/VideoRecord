import * as tus from 'tus-js-client';
import {
  ApiRequestError,
  ensureCsrfToken,
  fetchCsrfToken,
  SESSION_EXPIRED_EVENT
} from '../../app/apiClient';
import type { StorageMode } from '../../app/types';
import {
  createOrGetUploadSessionApi,
  getRecordingByIdApi,
  postRecordingEventApi,
  retryRecordingStorageApi
} from '../recording/recordingApi';
import {
  getLocalRecordingForUser,
  listLocalRecordingsForUser,
  purgeConfirmedRecordingChunksForUser,
  reconcileCrashedSessions,
  updateLocalRecordingForUser,
  verifyLocalRecordingIntegrity,
  type LocalRecordingManifest
} from './db/packingProofIdb';
import { FetchTusHttpStack } from './FetchTusHttpStack';
import { IndexedDbTusFileReader } from './IndexedDbTusFileSource';

export interface LiveUploadProgress {
  recordingId: string;
  bytesSent: number;
  bytesTotal: number;
  percentage: number;
}

export interface TusQueueSnapshot {
  items: LocalRecordingManifest[];
  activeRecordingId: string | null;
  liveProgressById: Record<string, LiveUploadProgress>;
  isPausedForAuth: boolean;
  isLoading: boolean;
  queueError: string | null;
}

export interface TusQueueManagerOptions {
  userId: string;
  defaultChunkBytes?: number;
  fallbackStorageMode?: StorageMode;
  pollIntervalMs?: number;
  tusRetryDelays?: number[];
}

function normalizeTusPath(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseTusErrorDetails(error: unknown): {
  status: number;
  errorCode: string | null;
  message: string;
} {
  if (error instanceof ApiRequestError) {
    return {
      status: error.status,
      errorCode: error.errorCode,
      message: error.message
    };
  }

  const detailed = error as tus.DetailedError | undefined;
  const response = detailed?.originalResponse ?? null;
  const status = response ? response.getStatus() : 0;
  const rawBody = response ? response.getBody() : '';

  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as { errorCode?: string; message?: string };
      if (parsed && (parsed.message || parsed.errorCode)) {
        return {
          status,
          errorCode: parsed.errorCode ?? null,
          message:
            parsed.message ??
            'Quá trình tải video lên máy chủ bị gián đoạn. Dữ liệu tạm vẫn an toàn trên thiết bị.'
        };
      }
    } catch {
      const plain = rawBody.trim();
      if (plain.length > 0 && plain.length < 300 && !plain.startsWith('<')) {
        return {
          status,
          errorCode: null,
          message: plain
        };
      }
    }
  }

  if (status === 401) {
    return {
      status: 401,
      errorCode: 'UNAUTHORIZED',
      message:
        'Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Hàng đợi tải lên đã tạm dừng an toàn — vui lòng đăng nhập lại để tiếp tục.'
    };
  }

  if (status === 403) {
    return {
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Tài khoản không có quyền thực hiện thao tác tải lên này hoặc thiếu mã bảo mật CSRF.'
    };
  }

  if (status === 413) {
    return {
      status: 413,
      errorCode: 'UPLOAD_SIZE_EXCEEDED',
      message: 'Dung lượng tệp video vượt quá giới hạn tối đa máy chủ cho phép.'
    };
  }

  if (status === 507) {
    return {
      status: 507,
      errorCode: 'STAGING_CAPACITY_EXCEEDED',
      message:
        'Vùng lưu đệm trên máy chủ hiện đã đầy. Bản ghi vẫn được giữ nguyên trên thiết bị để thử lại.'
    };
  }

  return {
    status,
    errorCode: null,
    message:
      'Kết nối mạng bị gián đoạn trong khi tải video lên. Dữ liệu tạm vẫn an toàn trên thiết bị để tiếp tục từ vị trí dở dang.'
  };
}

export class TusQueueManager {
  private readonly userId: string;
  private defaultChunkBytes: number;
  private fallbackStorageMode: StorageMode;
  private readonly pollIntervalMs: number;
  private readonly tusRetryDelays: number[];

  private readonly listeners = new Set<(snapshot: TusQueueSnapshot) => void>();
  private readonly httpStack = new FetchTusHttpStack();
  private readonly activePolls = new Map<string, ReturnType<typeof setTimeout>>();

  private items: LocalRecordingManifest[] = [];
  private activeRecordingId: string | null = null;
  private activeTusUpload: tus.Upload | null = null;
  private liveProgressById: Record<string, LiveUploadProgress> = {};
  private isPausedForAuth = false;
  private isLoading = true;
  private queueError: string | null = null;

  private disposed = false;
  private processingLoopActive = false;
  private wakePending = false;
  private reconciledCrashesOnce = false;

  constructor(options: TusQueueManagerOptions) {
    this.userId = options.userId;
    this.defaultChunkBytes = options.defaultChunkBytes ?? 5 * 1024 * 1024;
    this.fallbackStorageMode = options.fallbackStorageMode ?? 'LocalDevelopment';
    this.pollIntervalMs = options.pollIntervalMs ?? 700;
    this.tusRetryDelays = options.tusRetryDelays ?? [400, 1200];
  }

  public updateRuntimeDefaults(chunkBytes?: number, storageMode?: StorageMode): void {
    if (chunkBytes && chunkBytes > 0) {
      this.defaultChunkBytes = chunkBytes;
    }
    if (storageMode) {
      this.fallbackStorageMode = storageMode;
    }
  }

  public getSnapshot(): TusQueueSnapshot {
    return {
      items: this.items,
      activeRecordingId: this.activeRecordingId,
      liveProgressById: { ...this.liveProgressById },
      isPausedForAuth: this.isPausedForAuth,
      isLoading: this.isLoading,
      queueError: this.queueError
    };
  }

  public subscribe(listener: (snapshot: TusQueueSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async start(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.refreshFromIndexedDb(true);
    this.kickQueue();
  }

  public async refreshFromIndexedDb(verifyIntegrity = false): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      if (!this.reconciledCrashesOnce) {
        this.reconciledCrashesOnce = true;
        await reconcileCrashedSessions(this.userId);
      }

      let currentItems = await listLocalRecordingsForUser(this.userId);

      // Zero-HTTP fast path when user has no local recordings in IndexedDB
      if (currentItems.length === 0) {
        this.items = [];
        this.isLoading = false;
        this.emit();
        return;
      }

      if (verifyIntegrity) {
        let changed = false;
        for (const rec of currentItems) {
          if (
            rec.localSyncState !== 'Recording' &&
            rec.localSyncState !== 'StoredConfirmed' &&
            rec.localSyncState !== 'Discarded' &&
            !rec.chunksPurged &&
            !rec.integrityCorrupted
          ) {
            const report = await verifyLocalRecordingIntegrity(rec.recordingId, this.userId);
            if (!report.isRecoverable) {
              changed = true;
            }
          }
        }
        if (changed) {
          currentItems = await listLocalRecordingsForUser(this.userId);
        }
      }

      this.items = currentItems;
      this.isLoading = false;
      this.emit();

      // Ensure background status polling is active for any item already in UploadedWaitingStorage
      if (!this.isPausedForAuth) {
        for (const rec of currentItems) {
          if (rec.localSyncState === 'UploadedWaitingStorage') {
            this.scheduleStorageStatusPoll(rec.recordingId, 0);
          }
        }
      }
    } catch (err) {
      this.isLoading = false;
      this.queueError =
        err instanceof Error
          ? err.message
          : 'Không thể đọc dữ liệu hàng đợi tải lên từ bộ nhớ trình duyệt.';
      this.emit();
    }
  }

  public kickQueue(): void {
    if (this.disposed || this.isPausedForAuth) {
      return;
    }

    if (this.processingLoopActive) {
      this.wakePending = true;
      return;
    }

    void this.runSingleUploadLoop();
  }

  public async retryRecording(recordingId: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.queueError = null;
    this.isPausedForAuth = false;

    const manifest = await getLocalRecordingForUser(recordingId, this.userId);
    if (!manifest) {
      await this.refreshFromIndexedDb(false);
      return;
    }

    if (manifest.integrityCorrupted) {
      return;
    }

    // Case 1: Server already received 100% bytes via tus, and storage commit failed retryably (e.g. NAS offline)
    const shouldTryServerStorageRetry =
      manifest.isRetryableServerError === true &&
      (manifest.uploadedBytes ?? 0) >= manifest.totalBytes &&
      manifest.totalBytes > 0;

    if (shouldTryServerStorageRetry) {
      try {
        const dto = await retryRecordingStorageApi(recordingId, {
          suppressSessionExpiredEvent: true
        });

        if (dto.storageStatus === 'Stored') {
          await purgeConfirmedRecordingChunksForUser(recordingId, this.userId, {
            confirmedStorageMode: dto.storageMode ?? this.fallbackStorageMode,
            storedAtUtc: dto.storedAtUtc
          });
          await this.refreshFromIndexedDb(false);
          return;
        }

        await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
          ...curr,
          localSyncState: 'UploadedWaitingStorage',
          serverStorageStatus: dto.storageStatus,
          lastError: undefined,
          updatedAt: new Date().toISOString()
        }));

        await this.refreshFromIndexedDb(false);
        this.scheduleStorageStatusPoll(recordingId, 50);
        return;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) {
          await this.handleUnauthorizedPause();
          return;
        }

        // If staging file was lost on server, fall back to re-uploading from intact IndexedDB chunks!
        if (err instanceof ApiRequestError && err.errorCode === 'STAGING_FILE_MISSING') {
          await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
            ...curr,
            localSyncState: 'ReadyToUpload',
            tusUploadUrl: undefined,
            uploadSessionId: undefined,
            uploadedBytes: 0,
            isRetryableServerError: false,
            serverStorageStatus: 'AwaitingUpload',
            lastError: undefined,
            updatedAt: new Date().toISOString()
          }));
          await this.refreshFromIndexedDb(false);
          this.kickQueue();
          return;
        }

        const parsed = parseTusErrorDetails(err);
        await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
          ...curr,
          lastError: parsed.message,
          updatedAt: new Date().toISOString()
        }));
        await this.refreshFromIndexedDb(false);
        return;
      }
    }

    // Case 2: Resume/restart tus upload (keeping tusUploadUrl so tus-js-client resumes via HEAD offset!)
    const report = await verifyLocalRecordingIntegrity(recordingId, this.userId);
    if (!report.isRecoverable) {
      await this.refreshFromIndexedDb(false);
      return;
    }

    await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
      ...curr,
      localSyncState: 'ReadyToUpload',
      lastError: undefined,
      updatedAt: new Date().toISOString()
    }));

    await this.refreshFromIndexedDb(false);
    this.kickQueue();
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.activePolls.values()) {
      clearTimeout(timer);
    }
    this.activePolls.clear();

    if (this.activeTusUpload) {
      const upload = this.activeTusUpload;
      this.activeTusUpload = null;
      await upload.abort(false).catch(() => undefined);
    }

    this.listeners.clear();
  }

  private emit(): void {
    if (this.disposed) {
      return;
    }
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private async runSingleUploadLoop(): Promise<void> {
    if (this.processingLoopActive || this.disposed || this.isPausedForAuth) {
      return;
    }

    this.processingLoopActive = true;
    try {
      while (!this.disposed && !this.isPausedForAuth) {
        this.wakePending = false;

        const all = await listLocalRecordingsForUser(this.userId);
        this.items = all;
        this.isLoading = false;
        this.emit();

        if (all.length === 0) {
          break;
        }

        // Start polling for any items already waiting on server validation/NAS commit
        for (const item of all) {
          if (item.localSyncState === 'UploadedWaitingStorage') {
            this.scheduleStorageStatusPoll(item.recordingId, 0);
          }
        }

        // Pick oldest eligible item (FIFO) so max 1 active tus upload runs at a time
        const candidates = all
          .filter(
            (item) =>
              (item.localSyncState === 'Uploading' || item.localSyncState === 'ReadyToUpload') &&
              item.captureStatus !== 'Recording' &&
              item.captureStatus !== 'Cancelled' &&
              !item.integrityCorrupted &&
              item.totalBytes > 0
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        if (candidates.length === 0) {
          break;
        }

        const target = candidates[0];
        await this.processSingleUploadCandidate(target);

        if (!this.wakePending) {
          // Loop once more to pick up remaining candidates in queue
          continue;
        }
      }
    } finally {
      this.processingLoopActive = false;
      if (this.wakePending && !this.disposed && !this.isPausedForAuth) {
        this.wakePending = false;
        void this.runSingleUploadLoop();
      }
    }
  }

  private async processSingleUploadCandidate(candidate: LocalRecordingManifest): Promise<void> {
    const { recordingId } = candidate;

    // 1. Verify local IndexedDB chunks are intact before opening tus stream
    const integrity = await verifyLocalRecordingIntegrity(recordingId, this.userId);
    if (!integrity.isRecoverable) {
      await this.refreshFromIndexedDb(false);
      return;
    }

    this.activeRecordingId = recordingId;
    this.emit();

    try {
      // 2. Request or recover idempotent UploadSession from backend
      const session = await this.ensureServerUploadSession(candidate);
      if (!session || this.disposed || this.isPausedForAuth) {
        return;
      }

      // Fast path: if backend already confirmed Stored (e.g. page reloaded right after commit)
      if (session.recordingStorageStatus === 'Stored') {
        const dto = await getRecordingByIdApi(recordingId, { suppressSessionExpiredEvent: true });
        await purgeConfirmedRecordingChunksForUser(recordingId, this.userId, {
          confirmedStorageMode: dto.storageMode ?? this.fallbackStorageMode,
          storedAtUtc: dto.storedAtUtc
        });
        await this.refreshFromIndexedDb(false);
        return;
      }

      // Fast path: if backend tus session already received 100% of bytes and is Validating/WaitingForStorage
      if (
        session.sessionStatus === 'Completed' &&
        session.receivedBytes >= candidate.totalBytes &&
        (session.recordingStorageStatus === 'Validating' ||
          session.recordingStorageStatus === 'WaitingForStorage' ||
          session.recordingStorageStatus === 'CopyingToStorage')
      ) {
        await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
          ...curr,
          uploadSessionId: session.uploadSessionId,
          tusUploadUrl: session.tusUploadUrl ?? curr.tusUploadUrl,
          uploadedBytes: candidate.totalBytes,
          localSyncState: 'UploadedWaitingStorage',
          serverStorageStatus: session.recordingStorageStatus,
          lastError: undefined,
          updatedAt: new Date().toISOString()
        }));
        await this.refreshFromIndexedDb(false);
        this.scheduleStorageStatusPoll(recordingId, 0);
        return;
      }

      const freshBeforeTus = await getLocalRecordingForUser(recordingId, this.userId);
      const effectiveTusUrl = session.tusUploadUrl ?? freshBeforeTus?.tusUploadUrl ?? null;
      const chunkBytes =
        this.defaultChunkBytes > 0
          ? this.defaultChunkBytes
          : session.recommendedChunkBytes || 5 * 1024 * 1024;

      await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
        ...curr,
        uploadSessionId: session.uploadSessionId,
        tusUploadUrl: effectiveTusUrl ?? undefined,
        localSyncState: 'Uploading',
        serverStorageStatus: session.recordingStorageStatus,
        lastError: undefined,
        updatedAt: new Date().toISOString()
      }));
      await this.refreshFromIndexedDb(false);

      // 3. Execute real tus upload (resuming via HEAD if effectiveTusUrl exists; retrying once if 404/410 or stale CSRF)
      const outcome = await this.executeTusTransfer(
        recordingId,
        session.uploadSessionId,
        candidate.totalBytes,
        candidate.mimeType || 'video/webm',
        chunkBytes,
        effectiveTusUrl
      );

      if (outcome === 'expired_tus_resource' && !this.disposed && !this.isPausedForAuth) {
        // Previous tus staging resource expired on server; clear stale URL and create fresh tus resource
        await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
          ...curr,
          tusUploadUrl: undefined,
          uploadedBytes: 0,
          updatedAt: new Date().toISOString()
        }));
        const refreshedSession = await this.ensureServerUploadSession({
          ...candidate,
          tusUploadUrl: undefined
        });
        if (refreshedSession && !this.disposed && !this.isPausedForAuth) {
          await this.executeTusTransfer(
            recordingId,
            refreshedSession.uploadSessionId,
            candidate.totalBytes,
            candidate.mimeType || 'video/webm',
            chunkBytes,
            null
          );
        }
      }
    } finally {
      this.activeRecordingId = null;
      this.activeTusUpload = null;
      delete this.liveProgressById[recordingId];
      await this.refreshFromIndexedDb(false);
    }
  }

  private async ensureServerUploadSession(manifest: LocalRecordingManifest) {
    try {
      return await createOrGetUploadSessionApi(manifest.recordingId, manifest.totalBytes, {
        suppressSessionExpiredEvent: true
      });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.status === 401) {
          await this.handleUnauthorizedPause();
          return null;
        }

        // Reconcile capture lifecycle event if recording stopped offline while server was still Created/Recording
        if (err.status === 409 && err.errorCode === 'INVALID_RECORDING_STATE_FOR_UPLOAD') {
          const reconciled = await this.tryReconcileOfflineCaptureState(manifest);
          if (reconciled) {
            return await createOrGetUploadSessionApi(manifest.recordingId, manifest.totalBytes, {
              suppressSessionExpiredEvent: true
            });
          }
        }
      }

      const parsed = parseTusErrorDetails(err);
      await updateLocalRecordingForUser(manifest.recordingId, this.userId, (curr) => ({
        ...curr,
        localSyncState: 'Failed',
        isRetryableServerError: false,
        lastError: parsed.message,
        updatedAt: new Date().toISOString()
      }));
      return null;
    }
  }

  private async tryReconcileOfflineCaptureState(
    manifest: LocalRecordingManifest
  ): Promise<boolean> {
    try {
      const serverDto = await getRecordingByIdApi(manifest.recordingId, {
        suppressSessionExpiredEvent: true
      });

      if (serverDto.storageStatus === 'Stored') {
        return true;
      }

      if (serverDto.captureStatus === 'Cancelled') {
        return false;
      }

      if (serverDto.captureStatus === 'Created') {
        await postRecordingEventApi(
          manifest.recordingId,
          {
            eventType: 'started',
            clientMimeType: manifest.mimeType || 'video/webm'
          },
          { suppressSessionExpiredEvent: true }
        );
      }

      if (serverDto.captureStatus === 'Created' || serverDto.captureStatus === 'Recording') {
        const targetEvent =
          manifest.captureStatus === 'Captured' ? 'captured' : 'interrupted';
        await postRecordingEventApi(
          manifest.recordingId,
          {
            eventType: targetEvent,
            durationSeconds: manifest.durationSeconds,
            reason: manifest.interruptionReason
          },
          { suppressSessionExpiredEvent: true }
        );
      }

      return true;
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.status === 401) {
          await this.handleUnauthorizedPause();
          return false;
        }
        if (err.status === 409) {
          const refreshed = await getRecordingByIdApi(manifest.recordingId, {
            suppressSessionExpiredEvent: true
          }).catch(() => null);
          if (
            refreshed &&
            (refreshed.captureStatus === 'Captured' ||
              refreshed.captureStatus === 'Interrupted' ||
              refreshed.storageStatus === 'Stored')
          ) {
            return true;
          }
        }
      }
      return false;
    }
  }

  private async executeTusTransfer(
    recordingId: string,
    uploadSessionId: string,
    totalBytes: number,
    mimeType: string,
    chunkBytes: number,
    existingTusUploadUrl: string | null,
    csrfRetried = false
  ): Promise<'completed' | 'paused_auth' | 'expired_tus_resource' | 'failed'> {
    const fileReader = new IndexedDbTusFileReader(recordingId, this.userId, mimeType);
    const sentinelBlob = new Blob([], { type: mimeType });

    return new Promise((resolve) => {
      let csrfMismatchDetected = false;
      let unauthorizedDetected = false;
      let notFoundOnResumeDetected = false;

      const upload = new tus.Upload(sentinelBlob, {
        // CRITICAL: When resuming an existing tus URL, set endpoint: null so tus-js-client
        // issues HEAD against uploadUrl and NEVER falls back to POST /api/uploads on 401/403!
        endpoint: existingTusUploadUrl ? null : '/api/uploads',
        uploadUrl: existingTusUploadUrl ? normalizeTusPath(existingTusUploadUrl) : null,
        uploadSize: totalBytes,
        chunkSize: chunkBytes,
        retryDelays: this.tusRetryDelays,
        uploadDataDuringCreation: false,
        storeFingerprintForResuming: false,
        removeFingerprintOnSuccess: false,
        fingerprint: async () => `packingproof:${this.userId}:${recordingId}`,
        fileReader,
        httpStack: this.httpStack,
        metadata: {
          recordingId,
          uploadSessionId
        },
        onBeforeRequest: async (req) => {
          const method = req.getMethod().toUpperCase();
          if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
            const csrfToken = await ensureCsrfToken();
            req.setHeader('X-CSRF-Token', csrfToken);
          }
        },
        onAfterResponse: async (req, res) => {
          const method = req.getMethod().toUpperCase();
          const status = res.getStatus();

          // Persist newly created tus URL immediately after POST 201 Created
          if (method === 'POST' && status === 201) {
            const locationHeader = res.getHeader('Location');
            if (locationHeader) {
              const normalizedUrl = normalizeTusPath(locationHeader);
              await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
                ...curr,
                tusUploadUrl: normalizedUrl,
                uploadedBytes: 0,
                updatedAt: new Date().toISOString()
              })).catch(() => undefined);
            }
          }

          // Reconcile progress strictly from server's authoritative HEAD / PATCH Upload-Offset header!
          if ((method === 'HEAD' || method === 'PATCH') && status >= 200 && status < 300) {
            const offsetHeader = res.getHeader('Upload-Offset');
            if (offsetHeader !== undefined) {
              const serverOffset = Number(offsetHeader);
              if (Number.isFinite(serverOffset) && serverOffset >= 0) {
                this.updateLiveProgress(recordingId, serverOffset, totalBytes);
                await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
                  ...curr,
                  uploadedBytes: serverOffset,
                  updatedAt: new Date().toISOString()
                })).catch(() => undefined);
              }
            }
          }
        },
        onUploadUrlAvailable: () => {
          if (upload.url) {
            const normalized = normalizeTusPath(upload.url);
            void updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
              ...curr,
              tusUploadUrl: normalized,
              updatedAt: new Date().toISOString()
            })).catch(() => undefined);
          }
        },
        onProgress: (bytesSent, bytesTotal) => {
          this.updateLiveProgress(recordingId, bytesSent, bytesTotal);
        },
        onShouldRetry: (err) => {
          const status = err.originalResponse ? err.originalResponse.getStatus() : 0;

          if (status === 401) {
            unauthorizedDetected = true;
            return false;
          }

          if (status === 403) {
            const body = err.originalResponse?.getBody() ?? '';
            if (body.includes('CSRF_TOKEN_INVALID')) {
              csrfMismatchDetected = true;
            }
            return false;
          }

          if (existingTusUploadUrl && (status === 404 || status === 410)) {
            notFoundOnResumeDetected = true;
            return false;
          }

          // Never auto-retry 4xx validation/conflict/quota errors inside tus-js-client
          if (status >= 400 && status < 500 && status !== 429) {
            return false;
          }

          if (status === 507) {
            return false;
          }

          return true;
        },
        onSuccess: () => {
          void (async () => {
            // IMPORTANT: tus 100% means server staging received all bytes — NOT yet Stored on NAS!
            // Keep ALL recording_chunks in IndexedDB until GET /api/recordings/{id} confirms Stored!
            this.updateLiveProgress(recordingId, totalBytes, totalBytes);
            await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
              ...curr,
              tusUploadUrl: upload.url ? normalizeTusPath(upload.url) : curr.tusUploadUrl,
              uploadedBytes: totalBytes,
              localSyncState: 'UploadedWaitingStorage',
              serverStorageStatus: 'Validating',
              isRetryableServerError: false,
              lastError: undefined,
              updatedAt: new Date().toISOString()
            })).catch(() => undefined);

            await this.refreshFromIndexedDb(false);
            this.scheduleStorageStatusPoll(recordingId, 0);
            resolve('completed');
          })();
        },
        onError: (err) => {
          void (async () => {
            const parsed = parseTusErrorDetails(err);

            if (unauthorizedDetected || parsed.status === 401) {
              await this.handleUnauthorizedPause();
              resolve('paused_auth');
              return;
            }

            if (csrfMismatchDetected && !csrfRetried) {
              try {
                await fetchCsrfToken();
                const retryUrl = upload.url
                  ? normalizeTusPath(upload.url)
                  : existingTusUploadUrl;
                const retryOutcome = await this.executeTusTransfer(
                  recordingId,
                  uploadSessionId,
                  totalBytes,
                  mimeType,
                  chunkBytes,
                  retryUrl,
                  true
                );
                resolve(retryOutcome);
                return;
              } catch {
                // Fall through to normal error handling if CSRF refresh fails
              }
            }

            if (notFoundOnResumeDetected) {
              resolve('expired_tus_resource');
              return;
            }

            await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
              ...curr,
              tusUploadUrl: upload.url ? normalizeTusPath(upload.url) : curr.tusUploadUrl,
              localSyncState: 'Failed',
              isRetryableServerError: false,
              lastError: parsed.message,
              updatedAt: new Date().toISOString()
            })).catch(() => undefined);

            resolve('failed');
          })();
        }
      });

      this.activeTusUpload = upload;
      upload.start();
    });
  }

  private updateLiveProgress(recordingId: string, bytesSent: number, bytesTotal: number): void {
    const clampedTotal = Math.max(1, bytesTotal);
    const clampedSent = Math.max(0, Math.min(bytesSent, clampedTotal));
    const percentage = Math.min(100, Math.round((clampedSent / clampedTotal) * 100));

    this.liveProgressById[recordingId] = {
      recordingId,
      bytesSent: clampedSent,
      bytesTotal: clampedTotal,
      percentage
    };
    this.emit();
  }

  private scheduleStorageStatusPoll(recordingId: string, delayMs: number): void {
    if (this.disposed || this.isPausedForAuth || this.activePolls.has(recordingId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.activePolls.delete(recordingId);
      void this.pollRecordingStorageStatus(recordingId);
    }, Math.max(0, delayMs));

    this.activePolls.set(recordingId, timer);
  }

  private async pollRecordingStorageStatus(recordingId: string): Promise<void> {
    if (this.disposed || this.isPausedForAuth) {
      return;
    }

    const local = await getLocalRecordingForUser(recordingId, this.userId).catch(() => null);
    if (!local || local.localSyncState !== 'UploadedWaitingStorage') {
      return;
    }

    try {
      const dto = await getRecordingByIdApi(recordingId, {
        suppressSessionExpiredEvent: true
      });

      if (this.disposed) {
        return;
      }

      if (dto.storageStatus === 'Stored') {
        const confirmedMode: StorageMode = dto.storageMode ?? this.fallbackStorageMode;
        await purgeConfirmedRecordingChunksForUser(recordingId, this.userId, {
          confirmedStorageMode: confirmedMode,
          storedAtUtc: dto.storedAtUtc
        });
        await this.refreshFromIndexedDb(false);
        return;
      }

      if (dto.storageStatus === 'Failed') {
        await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
          ...curr,
          localSyncState: 'Failed',
          serverStorageStatus: 'Failed',
          isRetryableServerError: Boolean(dto.isRetryable),
          lastError:
            dto.userSafeErrorMessage ??
            'Máy chủ xác minh hoặc lưu trữ tệp video không thành công.',
          updatedAt: new Date().toISOString()
        }));
        await this.refreshFromIndexedDb(false);
        return;
      }

      if (dto.storageStatus === 'WaitingForStorage') {
        await updateLocalRecordingForUser(recordingId, this.userId, (curr) => ({
          ...curr,
          serverStorageStatus: 'WaitingForStorage',
          isRetryableServerError: dto.isRetryable ?? true,
          lastError:
            dto.userSafeErrorMessage ??
            'Đã nhận video trên máy chủ — đang chờ kết nối kho lưu trữ NAS để hoàn tất lưu trữ.',
          updatedAt: new Date().toISOString()
        }));
        await this.refreshFromIndexedDb(false);
        this.scheduleStorageStatusPoll(recordingId, this.pollIntervalMs * 2);
        return;
      }

      // Still Validating / CopyingToStorage -> poll again
      this.scheduleStorageStatusPoll(recordingId, this.pollIntervalMs);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        await this.handleUnauthorizedPause();
        return;
      }

      // Transient network error during polling: retry quietly while keeping chunks in IndexedDB
      this.scheduleStorageStatusPoll(recordingId, this.pollIntervalMs * 2);
    }
  }

  private async handleUnauthorizedPause(): Promise<void> {
    if (this.isPausedForAuth) {
      return;
    }

    this.isPausedForAuth = true;

    for (const timer of this.activePolls.values()) {
      clearTimeout(timer);
    }
    this.activePolls.clear();

    if (this.activeTusUpload) {
      const upload = this.activeTusUpload;
      this.activeTusUpload = null;
      // shouldTerminate = false -> NEVER send DELETE; preserve server partial offset & local chunks!
      await upload.abort(false).catch(() => undefined);
    }

    if (this.activeRecordingId) {
      const pausedId = this.activeRecordingId;
      await updateLocalRecordingForUser(pausedId, this.userId, (curr) => ({
        ...curr,
        lastError:
          'Phiên đăng nhập đã hết hạn. Dữ liệu video tạm vẫn được giữ nguyên trên thiết bị — vui lòng đăng nhập lại để tiếp tục tải lên.',
        updatedAt: new Date().toISOString()
      })).catch(() => undefined);
    }

    this.emit();

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent(SESSION_EXPIRED_EVENT, {
          detail: { path: '/api/uploads', timestamp: Date.now() }
        })
      );
    }
  }
}
