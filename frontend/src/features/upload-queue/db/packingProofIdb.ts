import { registerPendingUploadsCounter } from '../../../app/pendingUploadsBridge';
import { isQuotaExceededError } from './storageQuota';

export const PACKINGPROOF_IDB_NAME = 'packingproof_local_db';
export const PACKINGPROOF_IDB_VERSION = 1;
export const LOCAL_RECORDINGS_STORE = 'local_recordings';
export const RECORDING_CHUNKS_STORE = 'recording_chunks';
export const LOCAL_QUEUE_UPDATED_EVENT = 'packingproof:local-queue-updated';

export type LocalCaptureStatus =
  | 'Created'
  | 'Recording'
  | 'Captured'
  | 'Interrupted'
  | 'Cancelled';

export type LocalSyncState =
  | 'Recording'
  | 'ReadyToUpload'
  | 'Uploading'
  | 'UploadedWaitingStorage'
  | 'StoredConfirmed'
  | 'Failed'
  | 'Discarded';

export interface LocalRecordingManifest {
  recordingId: string;
  ownerUserId: string;
  shopId: string;
  warehouseId: string;
  shopName: string;
  warehouseName: string;
  trackingNumber: string;
  carrierCode?: string | null;
  tikTokOrderId?: string | null;
  mimeType: string;
  captureStatus: LocalCaptureStatus;
  localSyncState: LocalSyncState;
  chunkCount: number;
  totalBytes: number;
  durationSeconds: number;
  interruptionReason?: string;
  integrityCorrupted?: boolean;
  uploadSessionId?: string;
  tusUploadUrl?: string;
  uploadedBytes?: number;
  serverStorageStatus?: string;
  confirmedStorageMode?: 'LocalDevelopment' | 'SynologyMounted';
  isRetryableServerError?: boolean;
  chunksPurged?: boolean;
  storedAtUtc?: string | null;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalRecordingChunk {
  recordingId: string;
  seq: number;
  ownerUserId: string;
  data: ArrayBuffer;
  byteLength: number;
  createdAt: string;
}

export interface LocalRecordingIntegrityReport {
  recordingId: string;
  exists: boolean;
  isRecoverable: boolean;
  expectedChunks: number;
  actualChunks: number;
  expectedBytes: number;
  actualBytes: number;
  isContiguous: boolean;
  errorCode: string | null;
  userMessage: string | null;
}

export class LocalStoreAccessDeniedError extends Error {
  public readonly code = 'CROSS_USER_ACCESS_DENIED';

  constructor(
    message = 'Không được phép truy cập, tải lên hoặc xóa dữ liệu lưu tạm của tài khoản khác trên trình duyệt này.'
  ) {
    super(message);
    this.name = 'LocalStoreAccessDeniedError';
  }
}

export class QuotaExceededChunkError extends Error {
  public readonly code = 'QUOTA_EXCEEDED';

  constructor(
    message = 'Bộ nhớ lưu tạm IndexedDB đã đầy (QuotaExceededError). Phiên quay đã được dừng để tránh mất dữ liệu âm thầm.'
  ) {
    super(message);
    this.name = 'QuotaExceededChunkError';
  }
}

let cachedDbPromise: Promise<IDBDatabase> | null = null;
let activeDbInstance: IDBDatabase | null = null;

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

export function openPackingProofDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(
      new Error('Trình duyệt không hỗ trợ bộ nhớ lưu tạm IndexedDB.')
    );
  }

  if (cachedDbPromise) {
    return cachedDbPromise;
  }

  cachedDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PACKINGPROOF_IDB_NAME, PACKINGPROOF_IDB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(LOCAL_RECORDINGS_STORE)) {
        const recStore = db.createObjectStore(LOCAL_RECORDINGS_STORE, {
          keyPath: 'recordingId'
        });
        recStore.createIndex('by_owner', 'ownerUserId', { unique: false });
      }

      if (!db.objectStoreNames.contains(RECORDING_CHUNKS_STORE)) {
        const chunkStore = db.createObjectStore(RECORDING_CHUNKS_STORE, {
          keyPath: ['recordingId', 'seq']
        });
        chunkStore.createIndex('by_recording', 'recordingId', { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      activeDbInstance = db;

      db.onversionchange = () => {
        db.close();
        activeDbInstance = null;
        cachedDbPromise = null;
      };

      db.onclose = () => {
        activeDbInstance = null;
        cachedDbPromise = null;
      };

      resolve(db);
    };

    request.onerror = () => {
      cachedDbPromise = null;
      reject(request.error ?? new Error('Không thể mở cơ sở dữ liệu lưu tạm IndexedDB.'));
    };
  });

  return cachedDbPromise;
}

export async function closeAndDeletePackingProofDbForTests(): Promise<void> {
  if (activeDbInstance) {
    activeDbInstance.close();
    activeDbInstance = null;
  }
  cachedDbPromise = null;

  if (!isIndexedDbAvailable()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(PACKINGPROOF_IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function assertValidUserId(userId: string): void {
  if (!userId || !userId.trim()) {
    throw new Error('Yêu cầu định danh người dùng hợp lệ để truy cập dữ liệu cục bộ.');
  }
}

/**
 * Sanitizes manifest fields so passwords, cookies, or CSRF/auth tokens can NEVER be persisted in IndexedDB.
 */
function sanitizeManifestForPersistence(manifest: LocalRecordingManifest): LocalRecordingManifest {
  assertValidUserId(manifest.ownerUserId);

  return {
    recordingId: manifest.recordingId,
    ownerUserId: manifest.ownerUserId,
    shopId: manifest.shopId,
    warehouseId: manifest.warehouseId,
    shopName: manifest.shopName,
    warehouseName: manifest.warehouseName,
    trackingNumber: manifest.trackingNumber,
    carrierCode: manifest.carrierCode ?? null,
    tikTokOrderId: manifest.tikTokOrderId ?? null,
    mimeType: manifest.mimeType,
    captureStatus: manifest.captureStatus,
    localSyncState: manifest.localSyncState,
    chunkCount: manifest.chunkCount,
    totalBytes: manifest.totalBytes,
    durationSeconds: manifest.durationSeconds,
    interruptionReason: manifest.interruptionReason,
    integrityCorrupted: manifest.integrityCorrupted,
    uploadSessionId: manifest.uploadSessionId,
    tusUploadUrl: manifest.tusUploadUrl,
    uploadedBytes: manifest.uploadedBytes,
    serverStorageStatus: manifest.serverStorageStatus,
    confirmedStorageMode: manifest.confirmedStorageMode,
    isRetryableServerError: manifest.isRetryableServerError,
    chunksPurged: manifest.chunksPurged,
    storedAtUtc: manifest.storedAtUtc ?? null,
    lastError: manifest.lastError,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt
  };
}

export async function putLocalRecordingManifest(
  manifest: LocalRecordingManifest,
  currentUserId: string
): Promise<LocalRecordingManifest> {
  assertValidUserId(currentUserId);
  if (manifest.ownerUserId !== currentUserId) {
    throw new LocalStoreAccessDeniedError();
  }

  const sanitized = sanitizeManifestForPersistence(manifest);
  const db = await openPackingProofDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([LOCAL_RECORDINGS_STORE], 'readwrite');
    const store = tx.objectStore(LOCAL_RECORDINGS_STORE);

    const existingReq = store.get(sanitized.recordingId);
    existingReq.onsuccess = () => {
      const existing = existingReq.result as LocalRecordingManifest | undefined;
      if (existing && existing.ownerUserId !== currentUserId) {
        tx.abort();
        reject(new LocalStoreAccessDeniedError());
        return;
      }

      const putReq = store.put(sanitized);
      putReq.onerror = () => {
        if (isQuotaExceededError(putReq.error)) {
          reject(new QuotaExceededChunkError());
        } else {
          reject(putReq.error ?? new Error('Không thể lưu thông tin phiên quay cục bộ.'));
        }
      };
    };

    existingReq.onerror = () => {
      reject(existingReq.error ?? new Error('Không thể đọc thông tin phiên quay cục bộ.'));
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      if (isQuotaExceededError(tx.error)) {
        reject(new QuotaExceededChunkError());
      } else if (tx.error) {
        reject(tx.error);
      }
    };
  });

  return sanitized;
}

export async function listLocalRecordingsForUser(
  currentUserId: string
): Promise<LocalRecordingManifest[]> {
  assertValidUserId(currentUserId);
  if (!isIndexedDbAvailable()) {
    return [];
  }

  const db = await openPackingProofDb();

  return new Promise<LocalRecordingManifest[]>((resolve, reject) => {
    const tx = db.transaction([LOCAL_RECORDINGS_STORE], 'readonly');
    const store = tx.objectStore(LOCAL_RECORDINGS_STORE);
    const index = store.index('by_owner');
    const req = index.getAll(IDBKeyRange.only(currentUserId));

    req.onsuccess = () => {
      const raw = (req.result as LocalRecordingManifest[]) ?? [];
      const isolated = raw
        .filter((item) => item.ownerUserId === currentUserId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      resolve(isolated);
    };

    req.onerror = () => {
      reject(req.error ?? new Error('Không thể truy vấn danh sách bản ghi lưu tạm.'));
    };
  });
}

export async function getLocalRecordingForUser(
  recordingId: string,
  currentUserId: string
): Promise<LocalRecordingManifest | null> {
  assertValidUserId(currentUserId);
  const db = await openPackingProofDb();

  return new Promise<LocalRecordingManifest | null>((resolve, reject) => {
    const tx = db.transaction([LOCAL_RECORDINGS_STORE], 'readonly');
    const store = tx.objectStore(LOCAL_RECORDINGS_STORE);
    const req = store.get(recordingId);

    req.onsuccess = () => {
      const item = req.result as LocalRecordingManifest | undefined;
      if (!item || item.ownerUserId !== currentUserId) {
        resolve(null);
        return;
      }
      resolve(item);
    };

    req.onerror = () => {
      reject(req.error ?? new Error('Không thể đọc bản ghi lưu tạm.'));
    };
  });
}

export async function readRecordingChunksForUser(
  recordingId: string,
  currentUserId: string
): Promise<LocalRecordingChunk[]> {
  assertValidUserId(currentUserId);
  const db = await openPackingProofDb();

  return new Promise<LocalRecordingChunk[]>((resolve, reject) => {
    const tx = db.transaction([LOCAL_RECORDINGS_STORE, RECORDING_CHUNKS_STORE], 'readonly');
    const recStore = tx.objectStore(LOCAL_RECORDINGS_STORE);
    const chunkStore = tx.objectStore(RECORDING_CHUNKS_STORE);

    const recReq = recStore.get(recordingId);
    recReq.onsuccess = () => {
      const manifest = recReq.result as LocalRecordingManifest | undefined;
      if (!manifest) {
        resolve([]);
        return;
      }

      if (manifest.ownerUserId !== currentUserId) {
        reject(new LocalStoreAccessDeniedError());
        return;
      }

      const idx = chunkStore.index('by_recording');
      const chunksReq = idx.getAll(IDBKeyRange.only(recordingId));
      chunksReq.onsuccess = () => {
        const all = ((chunksReq.result as LocalRecordingChunk[]) ?? [])
          .filter((c) => c.ownerUserId === currentUserId)
          .sort((a, b) => a.seq - b.seq);
        resolve(all);
      };
      chunksReq.onerror = () => {
        reject(chunksReq.error ?? new Error('Không thể đọc dữ liệu chunk video từ IndexedDB.'));
      };
    };

    recReq.onerror = () => {
      reject(recReq.error ?? new Error('Không thể kiểm tra quyền sở hữu bản ghi cục bộ.'));
    };
  });
}

export async function updateLocalRecordingForUser(
  recordingId: string,
  currentUserId: string,
  updater: (current: LocalRecordingManifest) => LocalRecordingManifest
): Promise<LocalRecordingManifest> {
  assertValidUserId(currentUserId);
  const db = await openPackingProofDb();

  return new Promise<LocalRecordingManifest>((resolve, reject) => {
    const tx = db.transaction([LOCAL_RECORDINGS_STORE], 'readwrite');
    const store = tx.objectStore(LOCAL_RECORDINGS_STORE);
    let updatedManifest: LocalRecordingManifest | null = null;

    const getReq = store.get(recordingId);
    getReq.onsuccess = () => {
      const existing = getReq.result as LocalRecordingManifest | undefined;
      if (!existing) {
        tx.abort();
        reject(new Error('Không tìm thấy bản ghi video trong bộ nhớ thiết bị.'));
        return;
      }

      if (existing.ownerUserId !== currentUserId) {
        tx.abort();
        reject(new LocalStoreAccessDeniedError());
        return;
      }

      const next = sanitizeManifestForPersistence({
        ...updater(existing),
        recordingId: existing.recordingId,
        ownerUserId: existing.ownerUserId
      });
      updatedManifest = next;
      store.put(next);
    };

    getReq.onerror = () => {
      reject(getReq.error ?? new Error('Không thể cập nhật bản ghi cục bộ.'));
    };

    tx.oncomplete = () => {
      if (updatedManifest) {
        resolve(updatedManifest);
      }
    };

    tx.onerror = () => {
      if (tx.error) {
        reject(tx.error);
      }
    };
  });
}

export async function deleteLocalRecordingForUser(
  recordingId: string,
  currentUserId: string,
  options: { allowUnconfirmedDelete?: boolean } = {}
): Promise<void> {
  assertValidUserId(currentUserId);
  const db = await openPackingProofDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([LOCAL_RECORDINGS_STORE, RECORDING_CHUNKS_STORE], 'readwrite');
    const recStore = tx.objectStore(LOCAL_RECORDINGS_STORE);
    const chunkStore = tx.objectStore(RECORDING_CHUNKS_STORE);

    const getReq = recStore.get(recordingId);
    getReq.onsuccess = () => {
      const existing = getReq.result as LocalRecordingManifest | undefined;
      if (!existing) {
        tx.abort();
        reject(new Error('Không tìm thấy bản ghi cục bộ để xóa.'));
        return;
      }

      if (existing.ownerUserId !== currentUserId) {
        tx.abort();
        reject(new LocalStoreAccessDeniedError());
        return;
      }

      const canSafelyRemove =
        options.allowUnconfirmedDelete === true ||
        existing.localSyncState === 'StoredConfirmed' ||
        existing.localSyncState === 'Discarded' ||
        existing.integrityCorrupted === true;

      if (!canSafelyRemove) {
        tx.abort();
        reject(
          new Error(
            'Chỉ được dọn dẹp dữ liệu tạm sau khi máy chủ đã xác nhận lưu trữ (Stored) hoặc khi người dùng hủy bản ghi lỗi.'
          )
        );
        return;
      }

      const idx = chunkStore.index('by_recording');
      const cursorReq = idx.openCursor(IDBKeyRange.only(recordingId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          recStore.delete(recordingId);
        }
      };
      cursorReq.onerror = () => {
        reject(cursorReq.error ?? new Error('Không thể xóa các chunk video cục bộ.'));
      };
    };

    getReq.onerror = () => {
      reject(getReq.error ?? new Error('Không thể kiểm tra bản ghi cục bộ trước khi xóa.'));
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      if (tx.error) {
        reject(tx.error);
      }
    };
  });
}

export interface ConfirmStoredOptions {
  confirmedStorageMode: 'LocalDevelopment' | 'SynologyMounted';
  storedAtUtc?: string | null;
}

/**
 * Atomically marks a recording as `StoredConfirmed` and deletes ONLY its binary `recording_chunks`
 * from IndexedDB AFTER the backend has confirmed `StorageStatus === 'Stored'`.
 */
export async function purgeConfirmedRecordingChunksForUser(
  recordingId: string,
  currentUserId: string,
  options: ConfirmStoredOptions
): Promise<LocalRecordingManifest> {
  assertValidUserId(currentUserId);
  const db = await openPackingProofDb();

  return new Promise<LocalRecordingManifest>((resolve, reject) => {
    const tx = db.transaction([LOCAL_RECORDINGS_STORE, RECORDING_CHUNKS_STORE], 'readwrite');
    const recStore = tx.objectStore(LOCAL_RECORDINGS_STORE);
    const chunkStore = tx.objectStore(RECORDING_CHUNKS_STORE);
    let updatedManifest: LocalRecordingManifest | null = null;

    const getReq = recStore.get(recordingId);
    getReq.onsuccess = () => {
      const existing = getReq.result as LocalRecordingManifest | undefined;
      if (!existing) {
        tx.abort();
        reject(new Error('Không tìm thấy bản ghi cục bộ để xác nhận lưu trữ.'));
        return;
      }

      if (existing.ownerUserId !== currentUserId) {
        tx.abort();
        reject(new LocalStoreAccessDeniedError());
        return;
      }

      const nowIso = new Date().toISOString();
      const idx = chunkStore.index('by_recording');
      const cursorReq = idx.openCursor(IDBKeyRange.only(recordingId));

      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          const next = sanitizeManifestForPersistence({
            ...existing,
            localSyncState: 'StoredConfirmed',
            uploadedBytes: existing.totalBytes,
            serverStorageStatus: 'Stored',
            confirmedStorageMode: options.confirmedStorageMode,
            storedAtUtc: options.storedAtUtc ?? nowIso,
            isRetryableServerError: false,
            chunksPurged: true,
            lastError: undefined,
            updatedAt: nowIso
          });
          updatedManifest = next;
          recStore.put(next);
        }
      };

      cursorReq.onerror = () => {
        reject(cursorReq.error ?? new Error('Không thể giải phóng các chunk video đã lưu trữ.'));
      };
    };

    getReq.onerror = () => {
      reject(getReq.error ?? new Error('Không thể đọc bản ghi cục bộ khi xác nhận lưu trữ.'));
    };

    tx.oncomplete = () => {
      if (updatedManifest) {
        resolve(updatedManifest);
      }
    };

    tx.onerror = () => {
      if (tx.error) {
        reject(tx.error);
      }
    };
  });
}

function isArrayBufferLike(value: unknown): value is ArrayBuffer {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  );
}

/**
 * Verifies whether all expected chunks and bytes of a local recording still exist in IndexedDB.
 * Never claims unrecoverable bytes exist if browser data was partially or completely wiped.
 */
export async function verifyLocalRecordingIntegrity(
  recordingId: string,
  currentUserId: string
): Promise<LocalRecordingIntegrityReport> {
  assertValidUserId(currentUserId);
  const manifest = await getLocalRecordingForUser(recordingId, currentUserId);
  if (!manifest) {
    return {
      recordingId,
      exists: false,
      isRecoverable: false,
      expectedChunks: 0,
      actualChunks: 0,
      expectedBytes: 0,
      actualBytes: 0,
      isContiguous: false,
      errorCode: 'MANIFEST_NOT_FOUND',
      userMessage:
        'Không còn tìm thấy dữ liệu bản ghi tạm trên trình duyệt (dữ liệu có thể đã bị xóa). Không thể khôi phục video từ thiết bị này.'
    };
  }

  if (manifest.localSyncState === 'StoredConfirmed' || manifest.chunksPurged === true) {
    return {
      recordingId,
      exists: true,
      isRecoverable: true,
      expectedChunks: manifest.chunkCount,
      actualChunks: 0,
      expectedBytes: manifest.totalBytes,
      actualBytes: manifest.totalBytes,
      isContiguous: true,
      errorCode: null,
      userMessage: null
    };
  }

  const chunks = await readRecordingChunksForUser(recordingId, currentUserId);
  let actualBytes = 0;
  let isContiguous = true;

  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i].seq !== i || !isArrayBufferLike(chunks[i].data)) {
      isContiguous = false;
    }
    const len = chunks[i].data?.byteLength ?? 0;
    if (len !== chunks[i].byteLength) {
      isContiguous = false;
    }
    actualBytes += len;
  }

  const missingData =
    chunks.length === 0 ||
    !isContiguous ||
    chunks.length !== manifest.chunkCount ||
    actualBytes !== manifest.totalBytes ||
    actualBytes === 0;

  if (missingData) {
    const honestMessage =
      chunks.length === 0 || actualBytes === 0
        ? 'Dữ liệu byte video trên trình duyệt đã bị xóa hoặc thu hồi hoàn toàn. Hệ thống không thể khôi phục video khi dữ liệu gốc không còn — vui lòng quay lại kiện hàng.'
        : `Dữ liệu video lưu tạm bị thiếu hoặc hỏng chunk (còn ${chunks.length}/${manifest.chunkCount} phần, ${actualBytes}/${manifest.totalBytes} byte). Không thể khôi phục thành video nguyên vẹn.`;

    await updateLocalRecordingForUser(recordingId, currentUserId, (curr) => ({
      ...curr,
      localSyncState: 'Failed',
      integrityCorrupted: true,
      lastError: honestMessage,
      updatedAt: new Date().toISOString()
    }));

    return {
      recordingId,
      exists: true,
      isRecoverable: false,
      expectedChunks: manifest.chunkCount,
      actualChunks: chunks.length,
      expectedBytes: manifest.totalBytes,
      actualBytes,
      isContiguous,
      errorCode: 'MISSING_OR_CORRUPTED_CHUNKS',
      userMessage: honestMessage
    };
  }

  return {
    recordingId,
    exists: true,
    isRecoverable: true,
    expectedChunks: manifest.chunkCount,
    actualChunks: chunks.length,
    expectedBytes: manifest.totalBytes,
    actualBytes,
    isContiguous: true,
    errorCode: null,
    userMessage: null
  };
}

/**
 * On mount/login, detects any local recording for `ownerUserId` stuck in `Recording`
 * (from tab close, reload, or browser crash) and marks it `Interrupted` (NEVER `Captured`).
 */
export async function reconcileCrashedSessions(
  ownerUserId: string
): Promise<LocalRecordingManifest[]> {
  assertValidUserId(ownerUserId);
  if (!isIndexedDbAvailable()) {
    return [];
  }

  const userRecordings = await listLocalRecordingsForUser(ownerUserId);
  const stuckSessions = userRecordings.filter(
    (r) => r.captureStatus === 'Recording' || r.localSyncState === 'Recording'
  );

  if (stuckSessions.length === 0) {
    return [];
  }

  const reconciled: LocalRecordingManifest[] = [];

  for (const session of stuckSessions) {
    const chunks = await readRecordingChunksForUser(session.recordingId, ownerUserId);

    // Count only contiguous prefix 0..k-1 so trailing half-written gaps cannot corrupt stream assembly
    let validPrefixCount = 0;
    let validBytes = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      if (chunks[i].seq !== i) {
        break;
      }
      const len = chunks[i].data?.byteLength ?? 0;
      if (len <= 0) {
        break;
      }
      validPrefixCount += 1;
      validBytes += len;
    }

    const nowIso = new Date().toISOString();
    const hasPartialBytes = validPrefixCount > 0 && validBytes > 0;
    const crashNote = hasPartialBytes
      ? 'Phiên quay trước bị dừng đột ngột (đóng thẻ, tải lại trang hoặc trình duyệt gặp sự cố). Đã giữ lại phần dữ liệu tạm nhưng không thể đảm bảo video hoàn chỉnh cho đến khi được kiểm tra.'
      : 'Phiên quay trước bị dừng đột ngột trước khi có dữ liệu video được lưu vào thiết bị. Không có dữ liệu video để khôi phục.';

    const updated = await updateLocalRecordingForUser(
      session.recordingId,
      ownerUserId,
      (curr) => ({
        ...curr,
        captureStatus: 'Interrupted',
        localSyncState: hasPartialBytes ? 'ReadyToUpload' : 'Failed',
        chunkCount: validPrefixCount,
        totalBytes: validBytes,
        interruptionReason: crashNote,
        integrityCorrupted: !hasPartialBytes,
        lastError: hasPartialBytes ? undefined : crashNote,
        updatedAt: nowIso
      })
    );

    reconciled.push(updated);
  }

  return reconciled;
}

/**
 * Counts active/pending local recordings for `ownerUserId` that have not yet been confirmed `Stored`
 * or explicitly discarded. Used by the logout warning bridge and maxLocalPendingRecordings check.
 */
export async function countPendingLocalRecordingsForUser(
  ownerUserId: string
): Promise<number> {
  if (!ownerUserId || !ownerUserId.trim() || !isIndexedDbAvailable()) {
    return 0;
  }

  try {
    const list = await listLocalRecordingsForUser(ownerUserId);
    return list.filter(
      (item) =>
        item.captureStatus !== 'Cancelled' &&
        item.localSyncState !== 'StoredConfirmed' &&
        item.localSyncState !== 'Discarded'
    ).length;
  } catch {
    return 0;
  }
}

export function wirePendingUploadsBridge(): void {
  registerPendingUploadsCounter(countPendingLocalRecordingsForUser);
}

// Automatically wire the pending uploads counter bridge on load
wirePendingUploadsBridge();
