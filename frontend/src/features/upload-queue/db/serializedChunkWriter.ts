import {
  getChunkPayloadByteLength,
  LOCAL_QUEUE_UPDATED_EVENT,
  openPackingProofDb,
  putLocalRecordingManifest,
  QuotaExceededChunkError,
  readRecordingChunksForUser,
  RECORDING_CHUNKS_STORE,
  updateLocalRecordingForUser,
  type LocalRecordingChunk,
  type LocalRecordingManifest
} from './packingProofIdb';
import type {
  WorkerChunkWriterResponse,
  WorkerWriteChunkRequest
} from './chunkWriter.worker';
import { isQuotaExceededError } from './storageQuota';

interface PendingWorkerJob {
  resolve: (byteLength: number) => void;
  reject: (err: Error) => void;
}

let sharedChunkWorker: Worker | null = null;
let sharedChunkWorkerFailed = false;
let nextWorkerReqId = 1;
const pendingWorkerJobs = new Map<number, PendingWorkerJob>();

function getOrCreateChunkWriterWorker(): Worker | null {
  if (sharedChunkWorkerFailed || typeof Worker !== 'function') {
    return null;
  }

  if (sharedChunkWorker) {
    return sharedChunkWorker;
  }

  try {
    const worker = new Worker(
      new URL('./chunkWriter.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (event: MessageEvent<WorkerChunkWriterResponse>) => {
      const msg = event.data;
      if (!msg || typeof msg.id !== 'number') {
        return;
      }
      const pending = pendingWorkerJobs.get(msg.id);
      if (!pending) {
        return;
      }
      pendingWorkerJobs.delete(msg.id);

      if (msg.ok) {
        pending.resolve(msg.byteLength);
      } else if (msg.isQuotaError) {
        pending.reject(new QuotaExceededChunkError(msg.message));
      } else {
        pending.reject(new Error(msg.message));
      }
    };

    worker.onerror = () => {
      sharedChunkWorkerFailed = true;
      sharedChunkWorker = null;
      for (const [id, pending] of pendingWorkerJobs.entries()) {
        pendingWorkerJobs.delete(id);
        pending.reject(new Error('CHUNK_WORKER_RUNTIME_ERROR'));
      }
    };

    sharedChunkWorker = worker;
    return worker;
  } catch {
    sharedChunkWorkerFailed = true;
    return null;
  }
}

function writeChunkViaWorker(
  worker: Worker,
  recordingId: string,
  seq: number,
  ownerUserId: string,
  blob: Blob
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const id = nextWorkerReqId++;
    pendingWorkerJobs.set(id, { resolve, reject });
    const req: WorkerWriteChunkRequest = {
      type: 'write-chunk',
      id,
      recordingId,
      seq,
      ownerUserId,
      blob
    };
    try {
      worker.postMessage(req);
    } catch (err) {
      pendingWorkerJobs.delete(id);
      reject(
        err instanceof Error
          ? err
          : new Error('Không thể gửi chunk sang luồng Worker.')
      );
    }
  });
}

export interface ChunkWriterSnapshot {
  recordingId: string;
  committedChunks: number;
  committedBytes: number;
  isQuotaExceeded: boolean;
  isFinalized: boolean;
  lastError: string | null;
}

export interface SerializedChunkWriterOptions {
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
  onProgress?: (snapshot: ChunkWriterSnapshot) => void;
  onQuotaExceeded?: (snapshot: ChunkWriterSnapshot, error: QuotaExceededChunkError) => void;
  /**
   * Optional low-level hook used in unit tests to simulate mid-stream IndexedDB QuotaExceededError.
   */
  beforeChunkTransaction?: (seq: number, byteLength: number) => void | Promise<void>;
}

export interface FinalizeWriterOptions {
  durationSeconds: number;
  interruptionReason?: string;
  lastError?: string;
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Không thể đọc dữ liệu chunk video.'));
    reader.readAsArrayBuffer(blob);
  });
}

export class SerializedChunkWriter {
  private readonly options: SerializedChunkWriterOptions;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private finalized = false;
  private quotaExceeded = false;
  private committedChunks = 0;
  private committedBytes = 0;
  private lastError: string | null = null;

  constructor(options: SerializedChunkWriterOptions) {
    this.options = options;
  }

  public getSnapshot(): ChunkWriterSnapshot {
    return {
      recordingId: this.options.recordingId,
      committedChunks: this.committedChunks,
      committedBytes: this.committedBytes,
      isQuotaExceeded: this.quotaExceeded,
      isFinalized: this.finalized,
      lastError: this.lastError
    };
  }

  public async init(): Promise<LocalRecordingManifest> {
    if (this.initialized) {
      throw new Error('SerializedChunkWriter đã được khởi tạo trước đó.');
    }

    const nowIso = new Date().toISOString();
    const initialManifest: LocalRecordingManifest = {
      recordingId: this.options.recordingId,
      ownerUserId: this.options.ownerUserId,
      shopId: this.options.shopId,
      warehouseId: this.options.warehouseId,
      shopName: this.options.shopName,
      warehouseName: this.options.warehouseName,
      trackingNumber: this.options.trackingNumber,
      carrierCode: this.options.carrierCode ?? null,
      tikTokOrderId: this.options.tikTokOrderId ?? null,
      mimeType: this.options.mimeType,
      captureStatus: 'Recording',
      localSyncState: 'Recording',
      chunkCount: 0,
      totalBytes: 0,
      durationSeconds: 0,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    const saved = await putLocalRecordingManifest(initialManifest, this.options.ownerUserId);
    this.initialized = true;
    return saved;
  }

  /**
   * Queues a chunk write sequentially and resolves ONLY after the IndexedDB transaction `oncomplete` fires.
   */
  public appendChunk(blob: Blob): Promise<ChunkWriterSnapshot> {
    if (!this.initialized) {
      return Promise.reject(new Error('Chưa khởi tạo phiên lưu tạm IndexedDB trước khi ghi chunk.'));
    }

    if (this.finalized) {
      return Promise.reject(new Error('Phiên lưu tạm đã kết thúc, không thể ghi thêm chunk mới.'));
    }

    if (this.quotaExceeded) {
      return Promise.reject(new QuotaExceededChunkError(this.lastError ?? undefined));
    }

    if (!blob || blob.size === 0) {
      return this.writeQueue.then(() => this.getSnapshot());
    }

    const task = this.writeQueue.then(async () => {
      if (this.quotaExceeded) {
        throw new QuotaExceededChunkError(this.lastError ?? undefined);
      }

      if (this.finalized) {
        throw new Error('Phiên lưu tạm đã chốt manifest.');
      }

      const nextSeq = this.committedChunks;

      try {
        const worker = !this.options.beforeChunkTransaction
          ? getOrCreateChunkWriterWorker()
          : null;

        let committedLen = 0;

        if (worker) {
          try {
            committedLen = await writeChunkViaWorker(
              worker,
              this.options.recordingId,
              nextSeq,
              this.options.ownerUserId,
              blob
            );
          } catch (workerErr) {
            if (
              workerErr instanceof QuotaExceededChunkError ||
              isQuotaExceededError(workerErr)
            ) {
              throw workerErr;
            }
            // Fall back transparently to main-thread IDB transaction if Worker failed
            const fallbackBuf = await blobToArrayBuffer(blob);
            if (fallbackBuf.byteLength === 0) {
              return;
            }
            await this.commitChunkTransaction(nextSeq, fallbackBuf);
            committedLen = fallbackBuf.byteLength;
          }
        } else {
          const buffer = await blobToArrayBuffer(blob);
          if (buffer.byteLength === 0) {
            return;
          }
          if (this.options.beforeChunkTransaction) {
            await this.options.beforeChunkTransaction(nextSeq, buffer.byteLength);
          }
          await this.commitChunkTransaction(nextSeq, buffer);
          committedLen = buffer.byteLength;
        }

        if (committedLen === 0) {
          return;
        }

        this.committedChunks = nextSeq + 1;
        this.committedBytes += committedLen;
        this.options.onProgress?.(this.getSnapshot());
      } catch (err) {
        if (err instanceof QuotaExceededChunkError || isQuotaExceededError(err)) {
          const quotaErr =
            err instanceof QuotaExceededChunkError
              ? err
              : new QuotaExceededChunkError();

          this.quotaExceeded = true;
          this.lastError = quotaErr.message;
          this.options.onQuotaExceeded?.(this.getSnapshot(), quotaErr);
          throw quotaErr;
        }

        const msg =
          err instanceof Error
            ? err.message
            : 'Lỗi ghi dữ liệu video tạm vào IndexedDB.';
        this.lastError = msg;
        throw err;
      }
    });

    // Keep internal queue chain alive even if one task rejects, so finalize() can drain cleanly
    this.writeQueue = task.catch(() => undefined);

    return task.then(() => this.getSnapshot());
  }

  /**
   * Drains all pending chunk transactions, computes true `totalBytes` & `chunkCount` from
   * committed chunks in IndexedDB, and atomically updates the manifest.
   */
  public async finalize(
    status: 'Captured' | 'Interrupted',
    opts: FinalizeWriterOptions
  ): Promise<LocalRecordingManifest> {
    if (!this.initialized) {
      throw new Error('SerializedChunkWriter chưa được khởi tạo.');
    }

    await this.writeQueue;

    let contiguousCount = 0;
    let actualTotalBytes = 0;

    const intactFast = await this.verifyCommittedChunkKeysFast();
    if (intactFast) {
      contiguousCount = this.committedChunks;
      actualTotalBytes = this.committedBytes;
    } else {
      const committedList = await readRecordingChunksForUser(
        this.options.recordingId,
        this.options.ownerUserId
      );

      for (let i = 0; i < committedList.length; i += 1) {
        if (committedList[i].seq !== i) {
          break;
        }
        const len = getChunkPayloadByteLength(committedList[i]);
        if (len <= 0) {
          break;
        }
        contiguousCount += 1;
        actualTotalBytes += len;
      }
    }

    this.committedChunks = contiguousCount;
    this.committedBytes = actualTotalBytes;

    // Never mark a recording Captured if QuotaExceededError occurred or 0 bytes were committed!
    let effectiveCaptureStatus: 'Captured' | 'Interrupted' = status;
    let interruptionReason = opts.interruptionReason;
    let lastError = opts.lastError ?? this.lastError ?? undefined;

    if (this.quotaExceeded) {
      effectiveCaptureStatus = 'Interrupted';
      interruptionReason =
        interruptionReason ??
        'Bộ nhớ trình duyệt đã đầy (QuotaExceededError) trong khi đang quay. Chỉ phần dữ liệu trước thời điểm đầy bộ nhớ được giữ lại.';
      lastError =
        lastError ??
        'Bộ nhớ lưu tạm IndexedDB đã hết dung lượng trong khi quay.';
    } else if (effectiveCaptureStatus === 'Captured' && (contiguousCount === 0 || actualTotalBytes === 0)) {
      effectiveCaptureStatus = 'Interrupted';
      interruptionReason =
        interruptionReason ??
        'Không thu nhận được dữ liệu video hợp lệ từ thiết bị trước khi kết thúc.';
      lastError =
        lastError ??
        'Không có byte dữ liệu video nào được ghi nhận vào bộ nhớ thiết bị.';
    }

    const hasRecoverableBytes = contiguousCount > 0 && actualTotalBytes > 0;
    const nextSyncState = hasRecoverableBytes ? 'ReadyToUpload' : 'Failed';
    const normalizedDuration =
      Number.isFinite(opts.durationSeconds) && opts.durationSeconds >= 0
        ? Math.round(opts.durationSeconds * 100) / 100
        : 0;

    const finalizedManifest = await updateLocalRecordingForUser(
      this.options.recordingId,
      this.options.ownerUserId,
      (curr) => ({
        ...curr,
        captureStatus: effectiveCaptureStatus,
        localSyncState: nextSyncState,
        chunkCount: contiguousCount,
        totalBytes: actualTotalBytes,
        durationSeconds: normalizedDuration,
        interruptionReason,
        integrityCorrupted: !hasRecoverableBytes,
        lastError: hasRecoverableBytes ? lastError : (lastError ?? interruptionReason),
        updatedAt: new Date().toISOString()
      })
    );

    this.finalized = true;
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent(LOCAL_QUEUE_UPDATED_EVENT, {
          detail: {
            recordingId: this.options.recordingId,
            ownerUserId: this.options.ownerUserId,
            localSyncState: finalizedManifest.localSyncState
          }
        })
      );
    }
    return finalizedManifest;
  }

  private async verifyCommittedChunkKeysFast(): Promise<boolean> {
    try {
      const db = await openPackingProofDb();
      return await new Promise<boolean>((resolve) => {
        const tx = db.transaction([RECORDING_CHUNKS_STORE], 'readonly');
        const chunkStore = tx.objectStore(RECORDING_CHUNKS_STORE);
        if (typeof chunkStore.getAllKeys !== 'function') {
          resolve(false);
          return;
        }

        const range = IDBKeyRange.bound(
          [this.options.recordingId, 0],
          [this.options.recordingId, Number.MAX_SAFE_INTEGER]
        );
        const req = chunkStore.getAllKeys(range);
        req.onsuccess = () => {
          const keys = req.result ?? [];
          if (keys.length !== this.committedChunks) {
            resolve(false);
            return;
          }
          for (let i = 0; i < keys.length; i += 1) {
            const key = keys[i];
            if (
              !Array.isArray(key) ||
              key[0] !== this.options.recordingId ||
              key[1] !== i
            ) {
              resolve(false);
              return;
            }
          }
          resolve(true);
        };
        req.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  private async commitChunkTransaction(seq: number, buffer: ArrayBuffer): Promise<void> {
    const db = await openPackingProofDb();
    const nowIso = new Date().toISOString();

    const chunkRecord: LocalRecordingChunk = {
      recordingId: this.options.recordingId,
      seq,
      ownerUserId: this.options.ownerUserId,
      data: buffer,
      byteLength: buffer.byteLength,
      createdAt: nowIso
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([RECORDING_CHUNKS_STORE], 'readwrite');
      const chunkStore = tx.objectStore(RECORDING_CHUNKS_STORE);

      const addReq = chunkStore.put(chunkRecord);
      addReq.onerror = () => {
        if (isQuotaExceededError(addReq.error)) {
          reject(new QuotaExceededChunkError());
        } else {
          reject(addReq.error ?? new Error('Không thể ghi chunk video vào IndexedDB.'));
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        if (isQuotaExceededError(tx.error)) {
          reject(new QuotaExceededChunkError());
        } else if (tx.error) {
          reject(tx.error);
        }
      };
      tx.onabort = () => {
        if (isQuotaExceededError(tx.error)) {
          reject(new QuotaExceededChunkError());
        } else {
          reject(tx.error ?? new Error('Giao dịch lưu chunk IndexedDB đã bị hủy.'));
        }
      };
    });
  }
}

