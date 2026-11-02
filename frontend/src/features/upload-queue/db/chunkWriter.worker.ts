/// <reference lib="webworker" />

const PACKINGPROOF_IDB_NAME = 'packingproof_local_db';
const PACKINGPROOF_IDB_VERSION = 1;
const LOCAL_RECORDINGS_STORE = 'local_recordings';
const RECORDING_CHUNKS_STORE = 'recording_chunks';

export interface WorkerWriteChunkRequest {
  type: 'write-chunk';
  id: number;
  recordingId: string;
  seq: number;
  ownerUserId: string;
  blob: Blob;
}

export type WorkerChunkWriterResponse =
  | {
      id: number;
      ok: true;
      byteLength: number;
    }
  | {
      id: number;
      ok: false;
      isQuotaError: boolean;
      message: string;
    };

let cachedWorkerDbPromise: Promise<IDBDatabase> | null = null;

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const maybeDom = error as { name?: string; code?: number; message?: string };
  if (
    maybeDom.name === 'QuotaExceededError' ||
    maybeDom.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    maybeDom.code === 22 ||
    maybeDom.code === 1014
  ) {
    return true;
  }
  if (typeof maybeDom.message === 'string') {
    return /quota|disk full|storage full/i.test(maybeDom.message);
  }
  return false;
}

function openWorkerDb(): Promise<IDBDatabase> {
  if (cachedWorkerDbPromise) {
    return cachedWorkerDbPromise;
  }

  cachedWorkerDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
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
      db.onversionchange = () => {
        db.close();
        cachedWorkerDbPromise = null;
      };
      db.onclose = () => {
        cachedWorkerDbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      cachedWorkerDbPromise = null;
      reject(
        request.error ??
          new Error('Worker không thể mở cơ sở dữ liệu lưu tạm IndexedDB.')
      );
    };
  });

  return cachedWorkerDbPromise;
}

async function putChunkRecordInDb(
  db: IDBDatabase,
  record: {
    recordingId: string;
    seq: number;
    ownerUserId: string;
    blob?: Blob;
    data?: ArrayBuffer;
    byteLength: number;
    createdAt: string;
  }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([RECORDING_CHUNKS_STORE], 'readwrite');
    const chunkStore = tx.objectStore(RECORDING_CHUNKS_STORE);

    const putReq = chunkStore.put(record);

    putReq.onerror = () => {
      reject(putReq.error ?? new Error('Không thể ghi chunk video vào IndexedDB.'));
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      if (tx.error) {
        reject(tx.error);
      }
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('Giao dịch lưu chunk IndexedDB đã bị hủy.'));
    };
  });
}

async function writeBlobChunkToIdb(req: WorkerWriteChunkRequest): Promise<number> {
  const byteLength = req.blob?.size ?? 0;
  if (byteLength <= 0) {
    return 0;
  }

  const db = await openWorkerDb();
  const createdAt = new Date().toISOString();

  try {
    // Store native Blob directly so Chromium IndexedDB links the existing BlobStorageContext file
    // with ZERO V8 ArrayBuffer read, ZERO StructuredClone copy, and ZERO LevelDB SSTable compaction!
    await putChunkRecordInDb(db, {
      recordingId: req.recordingId,
      seq: req.seq,
      ownerUserId: req.ownerUserId,
      blob: req.blob,
      byteLength,
      createdAt
    });
    return byteLength;
  } catch (err) {
    if (isQuotaError(err)) {
      throw err;
    }
    // Seamless fallback for older WebKit Worker IndexedDB engines that reject Blob structured clone
    const fallbackBuffer = await req.blob.arrayBuffer();
    if (fallbackBuffer.byteLength <= 0) {
      return 0;
    }
    await putChunkRecordInDb(db, {
      recordingId: req.recordingId,
      seq: req.seq,
      ownerUserId: req.ownerUserId,
      data: fallbackBuffer,
      byteLength: fallbackBuffer.byteLength,
      createdAt
    });
    return fallbackBuffer.byteLength;
  }
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<WorkerWriteChunkRequest>) => {
  const payload = event.data;
  if (!payload || payload.type !== 'write-chunk') {
    return;
  }

  void (async () => {
    try {
      const byteLength = await writeBlobChunkToIdb(payload);
      const res: WorkerChunkWriterResponse = {
        id: payload.id,
        ok: true,
        byteLength
      };
      workerScope.postMessage(res);
    } catch (err) {
      const quota = isQuotaError(err);
      const res: WorkerChunkWriterResponse = {
        id: payload.id,
        ok: false,
        isQuotaError: quota,
        message:
          err instanceof Error && err.message
            ? err.message
            : 'Lỗi ghi chunk video vào IndexedDB trên luồng nền.'
      };
      workerScope.postMessage(res);
    }
  })();
};

