import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_EXPIRED_EVENT, setCsrfToken } from '../../src/app/apiClient';
import { AuthProvider } from '../../src/app/authStore';
import type { AuthMe, StorageMode } from '../../src/app/types';
import {
  closeAndDeletePackingProofDbForTests,
  getLocalRecordingForUser,
  LocalStoreAccessDeniedError,
  readRecordingChunksForUser,
  updateLocalRecordingForUser,
  wirePendingUploadsBridge
} from '../../src/features/upload-queue/db/packingProofIdb';
import { SerializedChunkWriter } from '../../src/features/upload-queue/db/serializedChunkWriter';
import { IndexedDbTusFileSource } from '../../src/features/upload-queue/IndexedDbTusFileSource';
import { TusUploadCoordinator } from '../../src/features/upload-queue/TusUploadCoordinator';
import { UploadQueuePage } from '../../src/features/upload-queue/UploadQueuePage';

const USER_A_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_B_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const SHOP_ID = '22222222-2222-4222-8222-222222222222';
const WH_ID = '33333333-3333-4333-8333-333333333333';

function buildAuthMe(
  storageMode: StorageMode = 'LocalDevelopment',
  uploadChunkBytes = 350
): AuthMe {
  return {
    id: USER_A_ID,
    email: 'operator.tus@congty.vn',
    fullName: 'Trần Văn Tải Lên',
    approvalStatus: 'Active',
    twoFactorEnabled: false,
    forcePasswordReset: false,
    isSuperAdmin: false,
    defaultShopId: SHOP_ID,
    defaultWarehouseId: WH_ID,
    permissions: ['recording.create', 'video.upload', 'video.view'],
    grants: [
      {
        id: 'grant-op-1',
        roleId: 'role-op',
        roleName: 'Operator',
        scopeType: 'Own',
        shopId: SHOP_ID,
        shopName: 'Shop A',
        warehouseId: WH_ID,
        warehouseName: 'Kho TP.HCM 01'
      }
    ],
    runtimeConfig: {
      storageMode,
      maxRecordingSeconds: 600,
      maxUploadBytes: 536870912,
      maxLocalPendingRecordings: 3,
      uploadChunkBytes,
      enableAudioRecording: false,
      smtpConfigured: false
    },
    csrfToken: 'csrf-tus-valid-token'
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function seedFinalizedRecordingInIdb(
  recordingId: string,
  trackingNumber: string,
  chunkLengths: number[],
  ownerUserId = USER_A_ID
): Promise<Uint8Array> {
  const totalLength = chunkLengths.reduce((acc, n) => acc + n, 0);
  const fullPayload = new Uint8Array(totalLength);
  for (let i = 0; i < totalLength; i += 1) {
    fullPayload[i] = (i * 17 + 23) % 251;
  }

  const writer = new SerializedChunkWriter({
    recordingId,
    ownerUserId,
    shopId: SHOP_ID,
    warehouseId: WH_ID,
    shopName: 'Shop A',
    warehouseName: 'Kho TP.HCM 01',
    trackingNumber,
    mimeType: 'video/webm;codecs=vp8'
  });

  await writer.init();

  let cursor = 0;
  for (const len of chunkLengths) {
    const sub = fullPayload.slice(cursor, cursor + len);
    await writer.appendChunk(new Blob([sub], { type: 'video/webm;codecs=vp8' }));
    cursor += len;
  }

  await writer.finalize('Captured', { durationSeconds: 4.5 });
  return fullPayload;
}

describe('Phase 3 Resumable Tus Queue, Authoritative HEAD Offset, Post-Stored Cleanup & 401 Pause', () => {
  beforeEach(async () => {
    await closeAndDeletePackingProofDbForTests();
    wirePendingUploadsBridge();
    setCsrfToken('csrf-tus-valid-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('IndexedDbTusFileSource slices arbitrary byte ranges accurately across variable-size IndexedDB chunks and blocks cross-user reads', async () => {
    const recId = '10000000-0000-4000-8000-000000000001';
    const expectedBytes = await seedFinalizedRecordingInIdb(
      recId,
      '001122334455',
      [137, 512, 299, 411, 205] // 1,564 bytes across 5 chunks
    );
    expect(expectedBytes.byteLength).toBe(1564);

    // User B cannot open User A's local chunks
    await expect(
      IndexedDbTusFileSource.open(recId, USER_B_ID)
    ).rejects.toBeInstanceOf(LocalStoreAccessDeniedError);

    const source = await IndexedDbTusFileSource.open(recId, USER_A_ID);
    expect(source.size).toBe(1564);
    expect(source.getChunkCount()).toBe(5);

    // 1. Interior single-chunk slice inside chunk #1 (137..649)
    const interior = await source.slice(200, 450);
    expect(interior.done).toBe(false);
    expect(await blobToUint8Array(interior.value)).toEqual(expectedBytes.slice(200, 450));

    // 2. Cross-boundary slice spanning chunks #0, #1, #2, and #3 (100..1100)
    const crossBoundary = await source.slice(100, 1100);
    expect(crossBoundary.done).toBe(false);
    expect(await blobToUint8Array(crossBoundary.value)).toEqual(
      expectedBytes.slice(100, 1100)
    );

    // 3. Tail slice reaching exact EOF sets done === true
    const tail = await source.slice(1250, 2000);
    expect(tail.done).toBe(true);
    expect(await blobToUint8Array(tail.value)).toEqual(expectedBytes.slice(1250, 1564));

    source.close();
  });

  it('resumes after reload using authoritative server HEAD Upload-Offset rather than stale cached percentage', async () => {
    const recId = '20000000-0000-4000-8000-000000000002';
    const originalBytes = await seedFinalizedRecordingInIdb(
      recId,
      '002233445566',
      [250, 250, 250, 250] // 1,000 bytes
    );

    // Pre-populateserver received first 400 bytes before simulated browser reload,
    // while IndexedDB manifest has a STALE cached uploadedBytes = 900 (90%)!
    const serverBuffer = new Uint8Array(1000);
    serverBuffer.set(originalBytes.slice(0, 400), 0);
    let serverOffset = 400;

    await updateLocalRecordingForUser(recId, USER_A_ID, (curr) => ({
      ...curr,
      uploadSessionId: 'sess-resume-01',
      tusUploadUrl: '/api/uploads/tus-file-resume-01',
      uploadedBytes: 900, // Stale cached 90%! Server HEAD actually has 400 (40%).
      localSyncState: 'Uploading'
    }));

    const seenTusMethods: Array<{ method: string; url: string; offset?: string | null }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/auth/me')) {
        return jsonResponse(buildAuthMe('LocalDevelopment', 350));
      }
      if (url.endsWith('/api/auth/csrf')) {
        return jsonResponse({ token: 'csrf-tus-valid-token' });
      }
      if (url.endsWith(`/api/recordings/${recId}/upload-session`) && method === 'POST') {
        return jsonResponse({
          uploadSessionId: 'sess-resume-01',
          recordingId: recId,
          tusResourceId: 'tus-file-resume-01',
          tusUploadUrl: '/api/uploads/tus-file-resume-01',
          expectedBytes: 1000,
          receivedBytes: serverOffset,
          recommendedChunkBytes: 350,
          sessionStatus: 'Receiving',
          recordingStorageStatus: 'Uploading',
          expiresAtUtc: new Date(Date.now() + 3600_000).toISOString()
        });
      }
      if (url.includes('/api/uploads')) {
        const reqHeaders = new Headers(init?.headers);
        seenTusMethods.push({
          method,
          url,
          offset: reqHeaders.get('Upload-Offset')
        });

        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: {
              'Tus-Resumable': '1.0.0',
              'Upload-Length': '1000',
              'Upload-Offset': String(serverOffset)
            }
          });
        }

        if (method === 'PATCH') {
          expect(reqHeaders.get('X-CSRF-Token')).toBe('csrf-tus-valid-token');
          const clientOffset = Number(reqHeaders.get('Upload-Offset'));
          expect(clientOffset).toBe(serverOffset);

          const patchSlice = await blobToUint8Array(init?.body as Blob);
          serverBuffer.set(patchSlice, serverOffset);
          serverOffset += patchSlice.byteLength;

          return new Response(null, {
            status: 204,
            headers: {
              'Tus-Resumable': '1.0.0',
              'Upload-Offset': String(serverOffset)
            }
          });
        }
      }
      if (url.endsWith(`/api/recordings/${recId}`) && method === 'GET') {
        return jsonResponse({
          id: recId,
          trackingNumber: '002233445566',
          captureStatus: 'Captured',
          storageStatus: 'Stored',
          storageMode: 'LocalDevelopment',
          storedAtUtc: new Date().toISOString()
        });
      }

      return jsonResponse({}, 404);
    });

    render(
      <MemoryRouter initialEntries={['/uploads']}>
        <AuthProvider>
          <TusUploadCoordinator pollIntervalMs={40}>
            <UploadQueuePage />
          </TusUploadCoordinator>
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId(`storage-badge-${recId}`)).toHaveTextContent(
        'Đã lưu cục bộ (Local)'
      );
    });

    // Verify tus-js-client did NOT call POST /api/uploads, issued HEAD first,
    // and sent PATCH starting from true server HEAD offset 400 (NOT stale 900!), then 750 -> 1000!
    expect(seenTusMethods.map((m) => `${m.method}:${m.offset ?? '-'}`)).toEqual([
      'HEAD:-',
      'PATCH:400',
      'PATCH:750'
    ]);
    expect(serverOffset).toBe(1000);
    expect(serverBuffer).toEqual(originalBytes);
  });

  it('shows "Đã nhận trên máy chủ" at tus 100% while retaining IndexedDB chunks, purges chunks ONLY after Stored, and distinguishes LocalDevelopment vs SynologyMounted badges', async () => {
    const recLocalId = '30000000-0000-4000-8000-000000000003';
    const recNasId = '30000000-0000-4000-8000-000000000004';

    await seedFinalizedRecordingInIdb(recLocalId, '003311111111', [300, 300]); // 600 bytes
    await seedFinalizedRecordingInIdb(recNasId, '003322222222', [250, 250]); // 500 bytes

    // Hold server StorageStatus at 'Validating' initially so we can inspect UI & IndexedDB chunks at tus 100%!
    let allowServerCommitToStored = false;
    let activePatchConcurrency = 0;
    let maxObservedPatchConcurrency = 0;
    const tusOffsets: Record<string, number> = {};

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/auth/me')) {
        return jsonResponse(buildAuthMe('LocalDevelopment', 400));
      }
      if (url.endsWith('/api/auth/csrf')) {
        return jsonResponse({ token: 'csrf-tus-valid-token' });
      }
      if (url.includes('/upload-session') && method === 'POST') {
        const isFirst = url.includes(recLocalId);
        const id = isFirst ? recLocalId : recNasId;
        const expectedBytes = isFirst ? 600 : 500;
        return jsonResponse({
          uploadSessionId: `sess-${id}`,
          recordingId: id,
          tusResourceId: null,
          tusUploadUrl: null,
          expectedBytes,
          receivedBytes: 0,
          recommendedChunkBytes: 400,
          sessionStatus: 'Initiated',
          recordingStorageStatus: 'AwaitingUpload',
          expiresAtUtc: new Date(Date.now() + 3600_000).toISOString()
        });
      }
      if (url.endsWith('/api/uploads') && method === 'POST') {
        const reqHeaders = new Headers(init?.headers);
        expect(reqHeaders.get('X-CSRF-Token')).toBe('csrf-tus-valid-token');
        const metaHeader = reqHeaders.get('Upload-Metadata') ?? '';
        const isFirst = metaHeader.includes(btoa(recLocalId));
        const tusId = isFirst ? 'tus-local-01' : 'tus-nas-02';
        tusOffsets[tusId] = 0;
        return new Response(null, {
          status: 201,
          headers: {
            'Tus-Resumable': '1.0.0',
            Location: `/api/uploads/${tusId}`
          }
        });
      }
      if (url.includes('/api/uploads/tus-') && method === 'PATCH') {
        activePatchConcurrency += 1;
        maxObservedPatchConcurrency = Math.max(
          maxObservedPatchConcurrency,
          activePatchConcurrency
        );
        try {
          await new Promise((r) => setTimeout(r, 15));
          const tusId = url.split('/').pop()!;
          const slice = await blobToUint8Array(init?.body as Blob);
          tusOffsets[tusId] = (tusOffsets[tusId] ?? 0) + slice.byteLength;
          return new Response(null, {
            status: 204,
            headers: {
              'Tus-Resumable': '1.0.0',
              'Upload-Offset': String(tusOffsets[tusId])
            }
          });
        } finally {
          activePatchConcurrency -= 1;
        }
      }
      if (url.includes('/api/recordings/') && method === 'GET') {
        const isFirst = url.endsWith(recLocalId);
        const id = isFirst ? recLocalId : recNasId;
        if (!allowServerCommitToStored) {
          return jsonResponse({
            id,
            captureStatus: 'Captured',
            storageStatus: 'Validating',
            storageMode: isFirst ? 'LocalDevelopment' : 'SynologyMounted'
          });
        }
        return jsonResponse({
          id,
          captureStatus: 'Captured',
          storageStatus: 'Stored',
          storageMode: isFirst ? 'LocalDevelopment' : 'SynologyMounted',
          storedAtUtc: new Date().toISOString()
        });
      }

      return jsonResponse({}, 404);
    });

    render(
      <MemoryRouter initialEntries={['/uploads']}>
        <AuthProvider>
          <TusUploadCoordinator pollIntervalMs={45}>
            <UploadQueuePage />
          </TusUploadCoordinator>
        </AuthProvider>
      </MemoryRouter>
    );

    // Wait until BOTH tus transfers reach 100% on server while backend is still 'Validating'
    await waitFor(() => {
      expect(screen.getByTestId(`storage-badge-${recLocalId}`)).toHaveTextContent(
        'Đã nhận trên máy chủ — đang xác minh & lưu trữ'
      );
      expect(screen.getByTestId(`storage-badge-${recNasId}`)).toHaveTextContent(
        'Đã nhận trên máy chủ — đang xác minh & lưu trữ'
      );
    });

    // Queue enforced strictly 1 active upload at a time!
    expect(maxObservedPatchConcurrency).toBe(1);

    // CRITICAL: At tus 100% (before server Stored), ALL binary chunks MUST STILL EXIST in IndexedDB!
    const chunksBeforeStored1 = await readRecordingChunksForUser(recLocalId, USER_A_ID);
    const chunksBeforeStored2 = await readRecordingChunksForUser(recNasId, USER_A_ID);
    expect(chunksBeforeStored1).toHaveLength(2);
    expect(chunksBeforeStored2).toHaveLength(2);
    expect(screen.queryByText('Đã lưu NAS')).not.toBeInTheDocument();

    // Now allow server worker to finish ffprobe + storage commit -> 'Stored'
    allowServerCommitToStored = true;

    await waitFor(() => {
      expect(screen.getByTestId(`storage-badge-${recLocalId}`)).toHaveTextContent(
        'Đã lưu cục bộ (Local)'
      );
      expect(screen.getByTestId(`storage-badge-${recNasId}`)).toHaveTextContent(
        'Đã lưu NAS'
      );
    });

    // Double-check LocalDevelopment item NEVER shows "Đã lưu NAS"
    expect(screen.getByTestId(`storage-badge-${recLocalId}`).textContent).not.toContain(
      'NAS'
    );

    // CRITICAL: After server confirms Stored, binary chunks ARE purged from IndexedDB!
    const chunksAfterStored1 = await readRecordingChunksForUser(recLocalId, USER_A_ID);
    const chunksAfterStored2 = await readRecordingChunksForUser(recNasId, USER_A_ID);
    expect(chunksAfterStored1).toHaveLength(0);
    expect(chunksAfterStored2).toHaveLength(0);
  });

  it('pauses immediately on 401 mid-upload, dispatches session-expired notice, and preserves 100% of IndexedDB chunks & tusUploadUrl for resume after re-login', async () => {
    const recId = '40000000-0000-4000-8000-000000000005';
    await seedFinalizedRecordingInIdb(recId, '004455667788', [400, 400, 200]); // 1,000 bytes

    let serverOffset = 0;
    let sessionRevoked = false;
    let deleteWasCalled = false;
    let sessionExpiredEvents = 0;

    const onExpired = () => {
      sessionExpiredEvents += 1;
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);

    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();

        if (url.endsWith('/api/auth/me')) {
          return jsonResponse(buildAuthMe('SynologyMounted', 400));
        }
        if (url.endsWith('/api/auth/csrf')) {
          return jsonResponse({ token: 'csrf-tus-valid-token' });
        }
        if (url.endsWith(`/api/recordings/${recId}/upload-session`) && method === 'POST') {
          return jsonResponse({
            uploadSessionId: 'sess-401-test',
            recordingId: recId,
            tusResourceId: serverOffset > 0 ? 'tus-401-file' : null,
            tusUploadUrl: serverOffset > 0 ? '/api/uploads/tus-401-file' : null,
            expectedBytes: 1000,
            receivedBytes: serverOffset,
            recommendedChunkBytes: 400,
            sessionStatus: serverOffset > 0 ? 'Receiving' : 'Initiated',
            recordingStorageStatus: 'Uploading',
            expiresAtUtc: new Date(Date.now() + 3600_000).toISOString()
          });
        }
        if (url.endsWith('/api/uploads') && method === 'POST') {
          return new Response(null, {
            status: 201,
            headers: {
              'Tus-Resumable': '1.0.0',
              Location: '/api/uploads/tus-401-file'
            }
          });
        }
        if (url.includes('/api/uploads/tus-401-file')) {
          if (method === 'DELETE') {
            deleteWasCalled = true;
            return new Response(null, { status: 204 });
          }

          if (sessionRevoked) {
            return jsonResponse(
              {
                errorCode: 'UNAUTHORIZED',
                message: 'Phiên đăng nhập đã hết hạn hoặc bị thu hồi.'
              },
              401
            );
          }

          if (method === 'HEAD') {
            return new Response(null, {
              status: 200,
              headers: {
                'Tus-Resumable': '1.0.0',
                'Upload-Length': '1000',
                'Upload-Offset': String(serverOffset)
              }
            });
          }

          if (method === 'PATCH') {
            const slice = await blobToUint8Array(init?.body as Blob);
            serverOffset += slice.byteLength;
            if (serverOffset === 400) {
              // Revoke session right after first 400-byte PATCH succeeds!
              sessionRevoked = true;
            }
            return new Response(null, {
              status: 204,
              headers: {
                'Tus-Resumable': '1.0.0',
                'Upload-Offset': String(serverOffset)
              }
            });
          }
        }
        if (url.endsWith(`/api/recordings/${recId}`) && method === 'GET') {
          return jsonResponse({
            id: recId,
            captureStatus: 'Captured',
            storageStatus: 'Stored',
            storageMode: 'SynologyMounted',
            storedAtUtc: new Date().toISOString()
          });
        }

        return jsonResponse({}, 404);
      });

      const firstRender = render(
        <MemoryRouter initialEntries={['/uploads']}>
          <AuthProvider>
            <TusUploadCoordinator pollIntervalMs={40}>
              <UploadQueuePage />
            </TusUploadCoordinator>
          </AuthProvider>
        </MemoryRouter>
      );

      // Wait for 401 on the second PATCH (400..800) to pause the queue and fire SESSION_EXPIRED_EVENT
      await waitFor(() => {
        expect(sessionExpiredEvents).toBeGreaterThanOrEqual(1);
      });

      expect(deleteWasCalled).toBe(false);
      expect(serverOffset).toBe(400);

      // Verify 100% of IndexedDB chunks AND tusUploadUrl are preserved intact!
      const preservedChunks = await readRecordingChunksForUser(recId, USER_A_ID);
      expect(preservedChunks).toHaveLength(3);
      expect(
        preservedChunks.reduce((sum, c) => sum + c.byteLength, 0)
      ).toBe(1000);

      const preservedManifest = await getLocalRecordingForUser(recId, USER_A_ID);
      expect(preservedManifest?.tusUploadUrl).toBe('/api/uploads/tus-401-file');

      firstRender.unmount();

      // Simulate user logging back in (sessionRevoked = false) -> queue resumes from offset 400 to 1000 and confirms "Đã lưu NAS"!
      sessionRevoked = false;
      render(
        <MemoryRouter initialEntries={['/uploads']}>
          <AuthProvider>
            <TusUploadCoordinator pollIntervalMs={40}>
              <UploadQueuePage />
            </TusUploadCoordinator>
          </AuthProvider>
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByTestId(`storage-badge-${recId}`)).toHaveTextContent(
          'Đã lưu NAS'
        );
      });
      expect(serverOffset).toBe(1000);
      expect(await readRecordingChunksForUser(recId, USER_A_ID)).toHaveLength(0);
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    }
  });
});

