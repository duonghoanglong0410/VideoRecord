import {
  LOCAL_RECORDINGS_STORE,
  LocalStoreAccessDeniedError,
  openPackingProofDb,
  RECORDING_CHUNKS_STORE,
  type LocalRecordingChunk,
  type LocalRecordingManifest
} from './db/packingProofIdb';

export interface ChunkByteSpan {
  seq: number;
  byteLength: number;
  startOffset: number;
  endOffset: number;
}

export interface TusSliceResult {
  value: Blob;
  done: boolean;
}

/**
 * Memory-efficient sliceable reader backed by IndexedDB `recording_chunks`.
 * Keeps only lightweight byte-offset spans in memory and reads ONLY the overlapping
 * `[recordingId, firstSeq..lastSeq]` chunk range on each `slice(start, end)` call,
 * decoupling 5 MiB HTTP tus PATCH chunks from 1-second MediaRecorder chunks.
 */
export class IndexedDbTusFileSource {
  public readonly recordingId: string;
  public readonly ownerUserId: string;
  public readonly mimeType: string;
  public readonly size: number;
  private readonly spans: readonly ChunkByteSpan[];
  private closed = false;

  private constructor(
    recordingId: string,
    ownerUserId: string,
    mimeType: string,
    size: number,
    spans: ChunkByteSpan[]
  ) {
    this.recordingId = recordingId;
    this.ownerUserId = ownerUserId;
    this.mimeType = mimeType || 'video/webm';
    this.size = size;
    this.spans = spans;
  }

  public static async open(
    recordingId: string,
    ownerUserId: string,
    mimeType = 'video/webm'
  ): Promise<IndexedDbTusFileSource> {
    if (!ownerUserId || !ownerUserId.trim()) {
      throw new LocalStoreAccessDeniedError();
    }

    const db = await openPackingProofDb();

    const { resolvedMime, rawMeta } = await new Promise<{
      resolvedMime: string;
      rawMeta: Array<{ seq: number; byteLength: number }>;
    }>((resolve, reject) => {
      const tx = db.transaction([LOCAL_RECORDINGS_STORE, RECORDING_CHUNKS_STORE], 'readonly');
      const recStore = tx.objectStore(LOCAL_RECORDINGS_STORE);
      const chunkStore = tx.objectStore(RECORDING_CHUNKS_STORE);

      const recReq = recStore.get(recordingId);
      recReq.onsuccess = () => {
        const manifest = recReq.result as LocalRecordingManifest | undefined;
        if (!manifest) {
          reject(new Error('Không tìm thấy bản ghi video tạm trong IndexedDB để tải lên.'));
          return;
        }

        if (manifest.ownerUserId !== ownerUserId) {
          reject(new LocalStoreAccessDeniedError());
          return;
        }

        const collected: Array<{ seq: number; byteLength: number }> = [];
        const index = chunkStore.index('by_recording');
        const cursorReq = index.openCursor(IDBKeyRange.only(recordingId));

        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const record = cursor.value as LocalRecordingChunk;
            if (record.ownerUserId === ownerUserId) {
              const actualLen = record.data?.byteLength ?? 0;
              if (actualLen <= 0 || actualLen !== record.byteLength) {
                reject(
                  new Error(
                    `Chunk dữ liệu tạm #${record.seq} bị hỏng hoặc thiếu byte trên trình duyệt.`
                  )
                );
                return;
              }
              collected.push({ seq: record.seq, byteLength: actualLen });
            }
            cursor.continue();
          } else {
            resolve({
              resolvedMime: manifest.mimeType || mimeType || 'video/webm',
              rawMeta: collected
            });
          }
        };

        cursorReq.onerror = () => {
          reject(cursorReq.error ?? new Error('Không thể quét danh mục chunk video từ IndexedDB.'));
        };
      };

      recReq.onerror = () => {
        reject(recReq.error ?? new Error('Không thể đọc thông tin phiên quay cục bộ.'));
      };
    });

    rawMeta.sort((a, b) => a.seq - b.seq);
    if (rawMeta.length === 0) {
      throw new Error('Không còn chunk dữ liệu video nào trong IndexedDB để tải lên.');
    }

    const spans: ChunkByteSpan[] = [];
    let runningOffset = 0;

    for (let i = 0; i < rawMeta.length; i += 1) {
      const item = rawMeta[i];
      if (item.seq !== i) {
        throw new Error(
          `Chuỗi dữ liệu video cục bộ không liên tục tại chunk #${i} (tìm thấy #${item.seq}).`
        );
      }

      const startOffset = runningOffset;
      const endOffset = startOffset + item.byteLength;
      spans.push({
        seq: item.seq,
        byteLength: item.byteLength,
        startOffset,
        endOffset
      });
      runningOffset = endOffset;
    }

    if (runningOffset <= 0) {
      throw new Error('Tổng dung lượng video lưu tạm bằng 0 byte.');
    }

    return new IndexedDbTusFileSource(
      recordingId,
      ownerUserId,
      resolvedMime,
      runningOffset,
      spans
    );
  }

  public getChunkCount(): number {
    return this.spans.length;
  }

  public async slice(start: number, end: number): Promise<TusSliceResult> {
    if (this.closed) {
      throw new Error('Nguồn đọc dữ liệu IndexedDbTusFileSource đã đóng.');
    }

    const safeStart = Math.max(0, Math.min(Math.floor(start), this.size));
    const safeEnd = Math.max(safeStart, Math.min(Math.floor(end), this.size));

    if (safeStart >= safeEnd) {
      return {
        value: new Blob([], { type: this.mimeType }),
        done: safeEnd >= this.size
      };
    }

    const overlapping = this.spans.filter(
      (span) => span.endOffset > safeStart && span.startOffset < safeEnd
    );

    if (overlapping.length === 0) {
      return {
        value: new Blob([], { type: this.mimeType }),
        done: safeEnd >= this.size
      };
    }

    const firstSeq = overlapping[0].seq;
    const lastSeq = overlapping[overlapping.length - 1].seq;

    const db = await openPackingProofDb();
    const records = await new Promise<LocalRecordingChunk[]>((resolve, reject) => {
      const tx = db.transaction([RECORDING_CHUNKS_STORE], 'readonly');
      const chunkStore = tx.objectStore(RECORDING_CHUNKS_STORE);
      const range = IDBKeyRange.bound(
        [this.recordingId, firstSeq],
        [this.recordingId, lastSeq]
      );
      const req = chunkStore.getAll(range);

      req.onsuccess = () => {
        const list = ((req.result as LocalRecordingChunk[]) ?? []).sort(
          (a, b) => a.seq - b.seq
        );
        resolve(list);
      };

      req.onerror = () => {
        reject(req.error ?? new Error('Không thể đọc lát cắt dữ liệu chunk từ IndexedDB.'));
      };
    });

    if (records.length !== overlapping.length) {
      throw new Error(
        `Thiếu dữ liệu chunk trong quá trình cắt luồng tải lên (cần ${overlapping.length} chunk, đọc được ${records.length}).`
      );
    }

    const blobParts: ArrayBuffer[] = [];

    for (let i = 0; i < overlapping.length; i += 1) {
      const span = overlapping[i];
      const record = records[i];

      if (record.ownerUserId !== this.ownerUserId) {
        throw new LocalStoreAccessDeniedError();
      }

      if (record.seq !== span.seq || !record.data || record.data.byteLength !== span.byteLength) {
        throw new Error(`Dữ liệu chunk #${span.seq} không khớp kích thước dự kiến.`);
      }

      const localStart = Math.max(0, safeStart - span.startOffset);
      const localEnd = Math.min(span.byteLength, safeEnd - span.startOffset);

      if (localStart === 0 && localEnd === span.byteLength) {
        blobParts.push(record.data);
      } else if (localEnd > localStart) {
        blobParts.push(record.data.slice(localStart, localEnd));
      }
    }

    const sliceBlob = new Blob(blobParts, { type: this.mimeType });
    if (sliceBlob.size !== safeEnd - safeStart) {
      throw new Error(
        `Kích thước lát cắt tạo ra (${sliceBlob.size} byte) không khớp yêu cầu (${safeEnd - safeStart} byte).`
      );
    }

    return {
      value: sliceBlob,
      done: safeEnd >= this.size
    };
  }

  public close(): void {
    this.closed = true;
  }
}

export class IndexedDbTusFileReader {
  private readonly recordingId: string;
  private readonly ownerUserId: string;
  private readonly mimeType: string;

  constructor(recordingId: string, ownerUserId: string, mimeType: string) {
    this.recordingId = recordingId;
    this.ownerUserId = ownerUserId;
    this.mimeType = mimeType;
  }

  public openFile(_input: unknown, _chunkSize: number): Promise<IndexedDbTusFileSource> {
    return IndexedDbTusFileSource.open(this.recordingId, this.ownerUserId, this.mimeType);
  }
}

