import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../src/app/authStore';
import { getPendingLocalRecordingsCount } from '../../src/app/pendingUploadsBridge';
import { AppRoutes } from '../../src/app/router';
import type { AuthMe } from '../../src/app/types';
import {
  closeAndDeletePackingProofDbForTests,
  deleteLocalRecordingForUser,
  getLocalRecordingForUser,
  listLocalRecordingsForUser,
  LocalStoreAccessDeniedError,
  openPackingProofDb,
  QuotaExceededChunkError,
  readRecordingChunksForUser,
  reconcileCrashedSessions,
  RECORDING_CHUNKS_STORE,
  updateLocalRecordingForUser,
  verifyLocalRecordingIntegrity,
  wirePendingUploadsBridge
} from '../../src/features/upload-queue/db/packingProofIdb';
import { SerializedChunkWriter } from '../../src/features/upload-queue/db/serializedChunkWriter';

const USER_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const USER_B = 'bbbbbbbb-2222-2222-2222-222222222222';
const SHOP_A = '22222222-2222-2222-2222-222222222222';
const WH_A = '33333333-3333-3333-3333-333333333333';

function makeChunkBlob(byteSize: number, fillValue: number): Blob {
  const bytes = new Uint8Array(byteSize);
  bytes.fill(fillValue & 0xff);
  return new Blob([bytes], { type: 'video/webm' });
}

describe('Phase 2 IndexedDB SerializedChunkWriter, Crash Recovery & Multi-User Isolation', () => {
  beforeEach(async () => {
    await closeAndDeletePackingProofDbForTests();
    wirePendingUploadsBridge();
  });

  it('commits sequential chunks in strict order 0..N-1 and produces exact byte count on finalize', async () => {
    const recId = 'rec-seq-001';
    const writer = new SerializedChunkWriter({
      recordingId: recId,
      ownerUserId: USER_A,
      shopId: SHOP_A,
      warehouseId: WH_A,
      shopName: 'Shop A',
      warehouseName: 'Kho TP.HCM 01',
      trackingNumber: '00123456789',
      mimeType: 'video/webm;codecs=vp8'
    });

    await writer.init();

    const sizes = [1024, 2048, 512, 4096, 1536, 777, 3000, 128];
    const expectedTotal = sizes.reduce((acc, s) => acc + s, 0);

    // Fire all appendChunk calls concurrently without awaiting between them to verify serialization
    const promises = sizes.map((sz, idx) =>
      writer.appendChunk(makeChunkBlob(sz, idx + 1))
    );
    await Promise.all(promises);

    const manifest = await writer.finalize('Captured', { durationSeconds: 8.45 });

    expect(manifest.captureStatus).toBe('Captured');
    expect(manifest.localSyncState).toBe('ReadyToUpload');
    expect(manifest.chunkCount).toBe(sizes.length);
    expect(manifest.totalBytes).toBe(expectedTotal);
    expect(manifest.trackingNumber).toBe('00123456789');

    const storedChunks = await readRecordingChunksForUser(recId, USER_A);
    expect(storedChunks).toHaveLength(sizes.length);

    for (let i = 0; i < sizes.length; i += 1) {
      expect(storedChunks[i].seq).toBe(i);
      expect(storedChunks[i].byteLength).toBe(sizes[i]);
      const rawBuffer = storedChunks[i].blob
        ? await storedChunks[i].blob!.arrayBuffer()
        : storedChunks[i].data!;
      const view = new Uint8Array(rawBuffer);
      expect(view[0]).toBe(i + 1);
      expect(view[view.length - 1]).toBe(i + 1);
    }

    const integrity = await verifyLocalRecordingIntegrity(recId, USER_A);
    expect(integrity.isRecoverable).toBe(true);
    expect(integrity.actualBytes).toBe(expectedTotal);
  });

  it('handles QuotaExceededError honestly without silent chunk loss or false Captured status', async () => {
    const recId = 'rec-quota-001';
    const onQuotaExceeded = vi.fn();

    const writer = new SerializedChunkWriter({
      recordingId: recId,
      ownerUserId: USER_A,
      shopId: SHOP_A,
      warehouseId: WH_A,
      shopName: 'Shop A',
      warehouseName: 'Kho TP.HCM 01',
      trackingNumber: '00555666777',
      mimeType: 'video/webm',
      onQuotaExceeded,
      beforeChunkTransaction: (seq) => {
        if (seq === 2) {
          const domQuotaErr = new DOMException(
            'The quota has been exceeded.',
            'QuotaExceededError'
          );
          throw domQuotaErr;
        }
      }
    });

    await writer.init();
    await writer.appendChunk(makeChunkBlob(1000, 0xaa));
    await writer.appendChunk(makeChunkBlob(1500, 0xbb));

    await expect(
      writer.appendChunk(makeChunkBlob(2000, 0xcc))
    ).rejects.toBeInstanceOf(QuotaExceededChunkError);

    expect(onQuotaExceeded).toHaveBeenCalledTimes(1);

    // Subsequent chunks while in quota-exceeded state also reject explicitly
    await expect(
      writer.appendChunk(makeChunkBlob(500, 0xdd))
    ).rejects.toBeInstanceOf(QuotaExceededChunkError);

    // Even if caller asks for 'Captured', writer forces 'Interrupted' because chunks were lost to quota!
    const finalized = await writer.finalize('Captured', { durationSeconds: 3.2 });
    expect(finalized.captureStatus).toBe('Interrupted');
    expect(finalized.chunkCount).toBe(2);
    expect(finalized.totalBytes).toBe(2500);
    expect(finalized.interruptionReason).toMatch(/QuotaExceededError|đầy/i);
  });

  it('reports honest unrecoverable error state when IndexedDB chunks are wiped/missing', async () => {
    const recId = 'rec-wiped-001';
    const writer = new SerializedChunkWriter({
      recordingId: recId,
      ownerUserId: USER_A,
      shopId: SHOP_A,
      warehouseId: WH_A,
      shopName: 'Shop A',
      warehouseName: 'Kho TP.HCM 01',
      trackingNumber: '00888999000',
      mimeType: 'video/webm'
    });

    await writer.init();
    await writer.appendChunk(makeChunkBlob(1200, 1));
    await writer.appendChunk(makeChunkBlob(1800, 2));
    await writer.finalize('Captured', { durationSeconds: 2.0 });

    // Simulate browser eviction / partial deletion of chunk seq=1 in IndexedDB
    const db = await openPackingProofDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([RECORDING_CHUNKS_STORE], 'readwrite');
      tx.objectStore(RECORDING_CHUNKS_STORE).delete([recId, 1]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const report = await verifyLocalRecordingIntegrity(recId, USER_A);
    expect(report.isRecoverable).toBe(false);
    expect(report.errorCode).toBe('MISSING_OR_CORRUPTED_CHUNKS');
    expect(report.expectedChunks).toBe(2);
    expect(report.actualChunks).toBe(1);
    expect(report.userMessage).toMatch(/không thể khôi phục/i);

    const updatedManifest = await getLocalRecordingForUser(recId, USER_A);
    expect(updatedManifest?.localSyncState).toBe('Failed');
    expect(updatedManifest?.integrityCorrupted).toBe(true);
  });

  it('reconciles crashed Recording sessions on reload strictly to Interrupted (never Captured)', async () => {
    const recWithBytes = 'rec-crash-partial';
    const writer1 = new SerializedChunkWriter({
      recordingId: recWithBytes,
      ownerUserId: USER_A,
      shopId: SHOP_A,
      warehouseId: WH_A,
      shopName: 'Shop A',
      warehouseName: 'Kho TP.HCM 01',
      trackingNumber: '00111222333',
      mimeType: 'video/webm'
    });
    await writer1.init();
    await writer1.appendChunk(makeChunkBlob(2048, 7));
    // Simulate tab crash: writer1.finalize() is NEVER called!

    const recZeroBytes = 'rec-crash-empty';
    const writer2 = new SerializedChunkWriter({
      recordingId: recZeroBytes,
      ownerUserId: USER_A,
      shopId: SHOP_A,
      warehouseId: WH_A,
      shopName: 'Shop A',
      warehouseName: 'Kho TP.HCM 01',
      trackingNumber: '00444555666',
      mimeType: 'video/webm'
    });
    await writer2.init();
    // Simulate crash before first chunk arrived!

    const reconciled = await reconcileCrashedSessions(USER_A);
    expect(reconciled).toHaveLength(2);

    const partial = await getLocalRecordingForUser(recWithBytes, USER_A);
    expect(partial?.captureStatus).toBe('Interrupted');
    expect(partial?.captureStatus).not.toBe('Captured');
    expect(partial?.totalBytes).toBe(2048);
    expect(partial?.interruptionReason).toMatch(/không thể đảm bảo video hoàn chỉnh/i);

    const empty = await getLocalRecordingForUser(recZeroBytes, USER_A);
    expect(empty?.captureStatus).toBe('Interrupted');
    expect(empty?.localSyncState).toBe('Failed');
    expect(empty?.totalBytes).toBe(0);
  });

  it('enforces strict multi-account isolation on the same browser and drives live logout pending count', async () => {
    // User A records 2 pending items
    for (const [id, code] of [
      ['rec-user-a-1', '0010000001'],
      ['rec-user-a-2', '0010000002']
    ]) {
      const w = new SerializedChunkWriter({
        recordingId: id,
        ownerUserId: USER_A,
        shopId: SHOP_A,
        warehouseId: WH_A,
        shopName: 'Shop A',
        warehouseName: 'Kho TP.HCM 01',
        trackingNumber: code,
        mimeType: 'video/webm'
      });
      await w.init();
      await w.appendChunk(makeChunkBlob(1024, 9));
      await w.finalize('Captured', { durationSeconds: 4.0 });
    }

    // User B cannot list, inspect, read bytes, update, or delete User A's recordings
    expect(await listLocalRecordingsForUser(USER_B)).toHaveLength(0);
    expect(await getLocalRecordingForUser('rec-user-a-1', USER_B)).toBeNull();

    await expect(
      readRecordingChunksForUser('rec-user-a-1', USER_B)
    ).rejects.toBeInstanceOf(LocalStoreAccessDeniedError);

    await expect(
      updateLocalRecordingForUser('rec-user-a-1', USER_B, (c) => ({
        ...c,
        localSyncState: 'Discarded'
      }))
    ).rejects.toBeInstanceOf(LocalStoreAccessDeniedError);

    await expect(
      deleteLocalRecordingForUser('rec-user-a-1', USER_B, {
        allowUnconfirmedDelete: true
      })
    ).rejects.toBeInstanceOf(LocalStoreAccessDeniedError);

    // Live pending count bridge isolates counts per account
    expect(await getPendingLocalRecordingsCount(USER_A)).toBe(2);
    expect(await getPendingLocalRecordingsCount(USER_B)).toBe(0);

    // Verify Phase 1 AppLayout logout warning dialog reads live IndexedDB count automatically!
    const userAMe: AuthMe = {
      id: USER_A,
      email: 'user.a@congty.vn',
      fullName: 'Nhân viên Kho A',
      approvalStatus: 'Active',
      twoFactorEnabled: false,
      forcePasswordReset: false,
      isSuperAdmin: false,
      defaultShopId: SHOP_A,
      defaultWarehouseId: WH_A,
      permissions: ['recording.create', 'video.upload', 'video.view'],
      grants: [],
      runtimeConfig: {
        storageMode: 'LocalDevelopment',
        maxRecordingSeconds: 600,
        maxUploadBytes: 536870912,
        maxLocalPendingRecordings: 3,
        uploadChunkBytes: 5242880,
        enableAudioRecording: false,
        smtpConfigured: false
      },
      csrfToken: 'csrf-a'
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/me')) {
        return new Response(JSON.stringify(userAMe), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ token: 'csrf-a' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const userEvt = userEvent.setup();
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(AuthProvider, null, createElement(AppRoutes))
      )
    );

    await screen.findByRole('heading', { name: /Bảng điều khiển vận hành/i });
    await userEvt.click(screen.getByRole('button', { name: /^Đăng xuất$/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/2 bản ghi video/i);
    expect(dialog).toHaveTextContent(/user\.a@congty\.vn/i);

    vi.restoreAllMocks();
  });
});
