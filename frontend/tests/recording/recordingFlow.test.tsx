import 'fake-indexeddb/auto';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../src/app/authStore';
import type { AuthMe } from '../../src/app/types';
import { RecorderController } from '../../src/features/recording/RecorderController';
import { RecordingPage } from '../../src/features/recording/RecordingPage';
import type { ScannerAdapter, ScannerDecodedEvent } from '../../src/features/recording/ScannerView';
import {
  closeAndDeletePackingProofDbForTests,
  getLocalRecordingForUser,
  wirePendingUploadsBridge
} from '../../src/features/upload-queue/db/packingProofIdb';

const OPERATOR_ID = '11111111-1111-1111-1111-111111111111';
const SHOP_ID = '22222222-2222-2222-2222-222222222222';
const WH_ID = '33333333-3333-3333-3333-333333333333';

class FakeMediaStreamTrack extends EventTarget {
  public kind = 'video';
  public readyState: MediaStreamTrackState = 'live';
  public muted = false;
  public onended: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  public onmute: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
  private readonly torchSupported: boolean;

  constructor(torchSupported = false) {
    super();
    this.torchSupported = torchSupported;
  }

  public getCapabilities(): MediaTrackCapabilities & { torch?: boolean } {
    return this.torchSupported ? { torch: true } : {};
  }

  public async applyConstraints(): Promise<void> {}

  public stop(): void {
    this.readyState = 'ended';
  }

  public triggerUnexpectedEnded(): void {
    this.readyState = 'ended';
    const evt = new Event('ended');
    if (this.onended) {
      this.onended.call(this as unknown as MediaStreamTrack, evt);
    }
    this.dispatchEvent(evt);
  }
}

class FakeMediaStream {
  private readonly tracks: FakeMediaStreamTrack[];

  constructor(tracks: FakeMediaStreamTrack[]) {
    this.tracks = tracks;
  }

  public getTracks(): MediaStreamTrack[] {
    return this.tracks as unknown as MediaStreamTrack[];
  }

  public getVideoTracks(): MediaStreamTrack[] {
    return this.tracks as unknown as MediaStreamTrack[];
  }

  public getAudioTracks(): MediaStreamTrack[] {
    return [];
  }
}

class ControlledFakeMediaRecorder {
  public static instances: ControlledFakeMediaRecorder[] = [];
  public static autoFireOnStart = false;
  public static isTypeSupported = vi.fn((mime: string) =>
    mime.startsWith('video/webm')
  );

  public state: RecordingState = 'inactive';
  public mimeType: string;
  public onstart: (() => void) | null = null;
  public ondataavailable: ((ev: BlobEvent) => void) | null = null;
  public onerror: ((ev: Event) => void) | null = null;
  public onstop: (() => void) | null = null;
  public startCalledOrder = 0;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || 'video/webm;codecs=vp8';
    ControlledFakeMediaRecorder.instances.push(this);
  }

  public start(): void {
    this.state = 'recording';
    if (ControlledFakeMediaRecorder.autoFireOnStart) {
      this.fireStartNow();
    }
  }

  public fireStartNow(): void {
    this.state = 'recording';
    this.onstart?.();
  }

  public emitChunk(byteSize: number, fillByte = 0x42): void {
    const bytes = new Uint8Array(byteSize);
    bytes.fill(fillByte);
    const blob = new Blob([bytes], { type: this.mimeType });
    this.ondataavailable?.({ data: blob } as BlobEvent);
  }

  public stop(): void {
    if (this.state === 'inactive') {
      return;
    }
    this.emitChunk(512, 0x99);
    this.state = 'inactive';
    this.onstop?.();
  }
}

function buildOperatorMe(permissions: string[] = ['recording.create', 'video.upload', 'video.view']): AuthMe {
  return {
    id: OPERATOR_ID,
    email: 'operator@congty.vn',
    fullName: 'Nguyễn Văn Đóng Gói',
    approvalStatus: 'Active',
    twoFactorEnabled: false,
    forcePasswordReset: false,
    isSuperAdmin: false,
    defaultShopId: SHOP_ID,
    defaultWarehouseId: WH_ID,
    permissions,
    grants: [
      {
        id: 'grant-1',
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
      storageMode: 'LocalDevelopment',
      maxRecordingSeconds: 600,
      maxUploadBytes: 536870912,
      maxLocalPendingRecordings: 3,
      uploadChunkBytes: 5242880,
      enableAudioRecording: false,
      smtpConfigured: false
    },
    csrfToken: 'csrf-rec-1'
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('Phase 2 Single-Owner Camera Lifecycle, MediaRecorder Gate & Interruption Flow', () => {
  const origIsSecureContext = window.isSecureContext;
  const origMediaDevices = navigator.mediaDevices;
  const origMediaRecorder = globalThis.MediaRecorder;
  const origMediaStream = globalThis.MediaStream;

  beforeEach(async () => {
    await closeAndDeletePackingProofDbForTests();
    wirePendingUploadsBridge();

    ControlledFakeMediaRecorder.instances = [];
    ControlledFakeMediaRecorder.autoFireOnStart = false;

    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true
    });

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
        enumerateDevices: vi.fn(async () => [
          { kind: 'videoinput', deviceId: 'cam-back', label: 'Camera Sau' }
        ])
      }
    });

    (globalThis as unknown as { MediaStream: unknown }).MediaStream = FakeMediaStream;
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      ControlledFakeMediaRecorder;
  });

  afterEach(() => {
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: origIsSecureContext
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: origMediaDevices
    });
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = origMediaRecorder;
    (globalThis as unknown as { MediaStream: unknown }).MediaStream = origMediaStream;
    vi.restoreAllMocks();
  });

  it('blocks starting RecorderController without a valid backend RecordingId and hides manual code UI without permission', async () => {
    const controller = new RecorderController({
      ensureScannerStopped: async () => {},
      onStateChange: () => {},
      onStreamChange: () => {}
    });

    await expect(
      controller.start({
        // @ts-expect-error Intentionally missing backend session id
        session: { id: '', trackingNumber: '00123456' },
        limits: {
          maxRecordingSeconds: 600,
          maxUploadBytes: 536870912,
          maxLocalPendingRecordings: 3,
          enableAudioRecording: false
        }
      })
    ).rejects.toThrow(/RecordingId/i);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/me')) {
        return jsonRes(buildOperatorMe()); // Lacks recording.manual_code
      }
      if (url.endsWith('/api/shops')) {
        return jsonRes({
          shops: [
            {
              id: SHOP_ID,
              code: 'ShopA',
              slug: 'shop-a',
              name: 'Shop A',
              warehouses: [{ id: WH_ID, code: 'WH-01', name: 'Kho TP.HCM 01', packingStations: [] }]
            }
          ]
        });
      }
      return jsonRes({ token: 'csrf-1' });
    });

    const scannerAdapter: ScannerAdapter = {
      start: async () => ({
        stream: new FakeMediaStream([new FakeMediaStreamTrack(false)]) as unknown as MediaStream,
        stop: vi.fn()
      })
    };

    render(
      <MemoryRouter initialEntries={['/record']}>
        <AuthProvider>
          <RecordingPage scannerAdapter={scannerAdapter} />
        </AuthProvider>
      </MemoryRouter>
    );

    await screen.findByTestId('scanner-view');

    // Cannot start recording before scanning & creating backend RecordingId
    expect(
      screen.queryByRole('button', { name: /Bắt đầu quay đóng gói/i })
    ).not.toBeInTheDocument();

    // Default Operator lacks recording.manual_code -> manual button is NOT rendered
    expect(
      screen.queryByRole('button', { name: /Nhập mã vận đơn thủ công/i })
    ).not.toBeInTheDocument();

    // Torch capability is false -> Flash toggle is NOT rendered
    expect(
      screen.queryByRole('button', { name: /đèn Flash/i })
    ).not.toBeInTheDocument();
  });

  it('stops ZXing scanner BEFORE MediaRecorder starts, shows "Đang quay" ONLY after onstart, and stops timer immediately on track.onended', async () => {
    const user = userEvent.setup();
    const callTimeline: string[] = [];
    const postedEvents: Array<{ eventType: string; errorCode?: string }> = [];
    let emitScanCallback: ((evt: ScannerDecodedEvent) => void) | null = null;

    const recordingTrack = new FakeMediaStreamTrack(false);
    const recordingStream = new FakeMediaStream([recordingTrack]) as unknown as MediaStream;

    let fakeNowMs = 100_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNowMs);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/me')) {
        return jsonRes(buildOperatorMe());
      }
      if (url.endsWith('/api/auth/csrf')) {
        return jsonRes({ token: 'csrf-rec-1' });
      }
      if (url.endsWith('/api/shops')) {
        return jsonRes({
          shops: [
            {
              id: SHOP_ID,
              code: 'ShopA',
              slug: 'shop-a',
              name: 'Shop A',
              warehouses: [{ id: WH_ID, code: 'WH-01', name: 'Kho TP.HCM 01', packingStations: [] }]
            }
          ]
        });
      }
      if (url.endsWith('/api/recordings/inspect-code')) {
        return jsonRes({
          isValid: true,
          trackingNumber: '0012345678',
          carrierCode: 'SPX',
          tikTokOrderId: null,
          matchedRule: 'PlainCarrierCode',
          existingRecordingCount: 1,
          warningMessage: 'Mã vận đơn 0012345678 đã có 1 phiên quay trước đó tại shop này.'
        });
      }
      if (url.endsWith('/api/recordings') && init?.method === 'POST') {
        return jsonRes(
          {
            recording: {
              id: 'rec-backend-uuid-001',
              ownerUserId: OPERATOR_ID,
              ownerEmail: 'operator@congty.vn',
              ownerFullName: 'Nguyễn Văn Đóng Gói',
              shopId: SHOP_ID,
              shopName: 'Shop A',
              warehouseId: WH_ID,
              warehouseName: 'Kho TP.HCM 01',
              packingStationId: null,
              trackingNumber: '0012345678',
              safeTrackingSegment: '0012345678',
              carrierCode: 'SPX',
              tikTokOrderId: null,
              source: 'RecordedInBrowser',
              manualEntryReason: null,
              linkedFromRecordingId: null,
              captureStatus: 'Created',
              storageStatus: 'AwaitingUpload',
              previewStatus: 'NotRequired',
              clientMimeType: null,
              durationSeconds: null,
              startedAtUtc: null,
              endedAtUtc: null,
              storedAtUtc: null,
              hold: false,
              lastErrorCode: null,
              userSafeErrorMessage: null,
              createdAtUtc: new Date().toISOString(),
              updatedAtUtc: new Date().toISOString()
            },
            existingRecordingCount: 1,
            warningMessage: 'Mã vận đơn 0012345678 đã có 1 phiên quay trước đó tại shop này.',
            limits: {
              maxRecordingSeconds: 600,
              maxUploadBytes: 536870912,
              maxLocalPendingRecordings: 3,
              enableAudioRecording: false
            }
          },
          201
        );
      }
      if (url.includes('/api/recordings/rec-backend-uuid-001/events')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          eventType: string;
          errorCode?: string;
        };
        postedEvents.push(body);
        return jsonRes({ id: 'rec-backend-uuid-001', captureStatus: 'Interrupted' });
      }
      return jsonRes({}, 404);
    });

    const scannerStopSpy = vi.fn(() => {
      callTimeline.push('scanner.stop');
    });

    const scannerAdapter: ScannerAdapter = {
      start: async ({ onDecoded }) => {
        callTimeline.push('scanner.start');
        emitScanCallback = onDecoded;
        return {
          stream: new FakeMediaStream([new FakeMediaStreamTrack(true)]) as unknown as MediaStream,
          stop: scannerStopSpy
        };
      }
    };

    const acquireRecordingStreamOverride = vi.fn(async () => {
      callTimeline.push('recorder.acquireStream');
      return {
        stream: recordingStream,
        resolutionTier: '1080p' as const,
        audioActive: false,
        audioFallbackWarning: null
      };
    });

    render(
      <MemoryRouter initialEntries={['/record']}>
        <AuthProvider>
          <RecordingPage
            scannerAdapter={scannerAdapter}
            acquireRecordingStreamOverride={acquireRecordingStreamOverride}
            recorderTimerIntervalMs={80}
          />
        </AuthProvider>
      </MemoryRouter>
    );

    await screen.findByTestId('scanner-view');

    // Torch IS supported on scanner track -> Flash toggle button appears
    expect(
      await screen.findByRole('button', { name: /Bật đèn Flash/i })
    ).toBeInTheDocument();

    // Simulate ZXing decoding barcode "0012345678"
    await act(async () => {
      emitScanCallback?.({ rawText: '0012345678', formatHint: 'OneDimensional' });
    });

    const trackingBanner = await screen.findByTestId('recognized-tracking-banner');
    expect(trackingBanner).toHaveTextContent('0012345678');
    expect(screen.getByTestId('duplicate-recording-warning')).toHaveTextContent(
      /Đã có 1 phiên quay trước đó/i
    );

    // Confirm code & create backend session -> ZXing scanner stops BEFORE recording stage
    await user.click(
      screen.getByRole('button', { name: /Xác nhận mã & Tạo phiên quay/i })
    );

    await screen.findByTestId('recording-session-stage');
    expect(scannerStopSpy).toHaveBeenCalled();

    // Click "Bắt đầu quay đóng gói" -> ControlledFakeMediaRecorder.autoFireOnStart is false!
    await user.click(
      screen.getByRole('button', { name: /Bắt đầu quay đóng gói/i })
    );

    await waitFor(() => {
      expect(ControlledFakeMediaRecorder.instances).toHaveLength(1);
    });

    // Verify ZXing scanner stopped strictly BEFORE recording stream acquisition!
    const stopIdx = callTimeline.indexOf('scanner.stop');
    const acquireIdx = callTimeline.indexOf('recorder.acquireStream');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(acquireIdx).toBeGreaterThan(stopIdx);

    // BEFORE MediaRecorder.onstart fires: "Đang quay" MUST NOT appear!
    expect(screen.queryByTestId('recording-active-badge')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Kết thúc & Lưu video/i })
    ).not.toBeInTheDocument();

    // Now fire MediaRecorder.onstart -> "Đang quay" appears, reminder appears, NO pause button!
    const recorder = ControlledFakeMediaRecorder.instances[0];
    await act(async () => {
      recorder.fireStartNow();
      recorder.emitChunk(2048, 0x33);
      await new Promise((r) => setTimeout(r, 25));
    });

    expect(await screen.findByTestId('recording-active-badge')).toHaveTextContent(
      'Đang quay'
    );
    expect(screen.getByTestId('recording-bytes')).toHaveTextContent('2.0 KiB');
    expect(
      screen.getByText(/Giữ trang này đang mở trong khi quay/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Kết thúc & Lưu video/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Tạm dừng|Pause/i })
    ).not.toBeInTheDocument();

    // Advance simulated clock by 7 seconds while recording
    await act(async () => {
      fakeNowMs += 7_000;
      await new Promise((r) => setTimeout(r, 110));
    });
    expect(screen.getByTestId('recording-timer')).toHaveTextContent('00:07');

    // Trigger sudden camera interruption (track.onended)
    await act(async () => {
      recordingTrack.triggerUnexpectedEnded();
      await new Promise((r) => setTimeout(r, 25));
    });

    const interruptedBanner = await screen.findByTestId(
      'recording-interrupted-banner'
    );
    expect(interruptedBanner).toHaveTextContent(/Phiên quay đã bị gián đoạn/i);
    expect(interruptedBanner).toHaveTextContent('00:07');
    expect(screen.queryByTestId('recording-active-badge')).not.toBeInTheDocument();

    // Advance clock another 25 seconds -> frozen timer MUST remain 00:07 (never keeps counting!)
    await act(async () => {
      fakeNowMs += 25_000;
      await new Promise((r) => setTimeout(r, 110));
    });
    expect(screen.getByTestId('recording-interrupted-banner')).toHaveTextContent(
      '00:07'
    );

    // Verify backend received 'started' and 'interrupted' events, and IndexedDB manifest is Interrupted
    await waitFor(() => {
      expect(postedEvents.some((e) => e.eventType === 'started')).toBe(true);
      expect(
        postedEvents.some(
          (e) =>
            e.eventType === 'interrupted' && e.errorCode === 'CAMERA_TRACK_ENDED'
        )
      ).toBe(true);
    });

    const storedLocal = await getLocalRecordingForUser(
      'rec-backend-uuid-001',
      OPERATOR_ID
    );
    expect(storedLocal?.captureStatus).toBe('Interrupted');
    expect(storedLocal?.totalBytes).toBeGreaterThan(0);

    dateNowSpy.mockRestore();
  });

  it('completes normal recording cleanly on "Kết thúc & Lưu video", commits final chunk, and enqueues ReadyToUpload', async () => {
    const user = userEvent.setup();
    let emitScanCallback: ((evt: ScannerDecodedEvent) => void) | null = null;
    const postedEvents: Array<{ eventType: string }> = [];

    ControlledFakeMediaRecorder.autoFireOnStart = true;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/me')) {
        return jsonRes(buildOperatorMe());
      }
      if (url.endsWith('/api/auth/csrf')) {
        return jsonRes({ token: 'csrf-rec-2' });
      }
      if (url.endsWith('/api/shops')) {
        return jsonRes({
          shops: [
            {
              id: SHOP_ID,
              code: 'ShopA',
              slug: 'shop-a',
              name: 'Shop A',
              warehouses: [{ id: WH_ID, code: 'WH-01', name: 'Kho TP.HCM 01', packingStations: [] }]
            }
          ]
        });
      }
      if (url.endsWith('/api/recordings/inspect-code')) {
        return jsonRes({
          isValid: true,
          trackingNumber: '00987654321',
          carrierCode: null,
          tikTokOrderId: null,
          matchedRule: 'PlainCarrierCode',
          existingRecordingCount: 0,
          warningMessage: null
        });
      }
      if (url.endsWith('/api/recordings') && init?.method === 'POST') {
        return jsonRes(
          {
            recording: {
              id: 'rec-backend-uuid-normal',
              ownerUserId: OPERATOR_ID,
              ownerEmail: 'operator@congty.vn',
              ownerFullName: 'Nguyễn Văn Đóng Gói',
              shopId: SHOP_ID,
              shopName: 'Shop A',
              warehouseId: WH_ID,
              warehouseName: 'Kho TP.HCM 01',
              packingStationId: null,
              trackingNumber: '00987654321',
              safeTrackingSegment: '00987654321',
              carrierCode: null,
              tikTokOrderId: null,
              source: 'RecordedInBrowser',
              manualEntryReason: null,
              linkedFromRecordingId: null,
              captureStatus: 'Created',
              storageStatus: 'AwaitingUpload',
              previewStatus: 'NotRequired',
              clientMimeType: null,
              durationSeconds: null,
              startedAtUtc: null,
              endedAtUtc: null,
              storedAtUtc: null,
              hold: false,
              lastErrorCode: null,
              userSafeErrorMessage: null,
              createdAtUtc: new Date().toISOString(),
              updatedAtUtc: new Date().toISOString()
            },
            existingRecordingCount: 0,
            warningMessage: null,
            limits: {
              maxRecordingSeconds: 600,
              maxUploadBytes: 536870912,
              maxLocalPendingRecordings: 3,
              enableAudioRecording: false
            }
          },
          201
        );
      }
      if (url.includes('/api/recordings/rec-backend-uuid-normal/events')) {
        postedEvents.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonRes({ id: 'rec-backend-uuid-normal', captureStatus: 'Captured' });
      }
      return jsonRes({}, 404);
    });

    const scannerAdapter: ScannerAdapter = {
      start: async ({ onDecoded }) => {
        emitScanCallback = onDecoded;
        return {
          stream: new FakeMediaStream([new FakeMediaStreamTrack(false)]) as unknown as MediaStream,
          stop: vi.fn()
        };
      }
    };

    render(
      <MemoryRouter initialEntries={['/record']}>
        <AuthProvider>
          <RecordingPage
            scannerAdapter={scannerAdapter}
            acquireRecordingStreamOverride={async () => ({
              stream: new FakeMediaStream([new FakeMediaStreamTrack(false)]) as unknown as MediaStream,
              resolutionTier: '1080p',
              audioActive: false,
              audioFallbackWarning: null
            })}
          />
        </AuthProvider>
      </MemoryRouter>
    );

    await screen.findByTestId('scanner-view');
    await act(async () => {
      emitScanCallback?.({ rawText: '00987654321', formatHint: 'OneDimensional' });
    });

    await screen.findByTestId('recognized-tracking-banner');
    await user.click(
      screen.getByRole('button', { name: /Xác nhận mã & Tạo phiên quay/i })
    );
    await screen.findByTestId('recording-session-stage');

    await user.click(
      screen.getByRole('button', { name: /Bắt đầu quay đóng gói/i })
    );
    await screen.findByTestId('recording-active-badge');

    const recorder = ControlledFakeMediaRecorder.instances[0];
    await act(async () => {
      recorder.emitChunk(1024, 0x11);
      recorder.emitChunk(2048, 0x22);
    });

    // Click normal stop -> ControlledFakeMediaRecorder.stop() also emits a final 512-byte chunk!
    await user.click(
      screen.getByRole('button', { name: /Kết thúc & Lưu video/i })
    );

    const completedBanner = await screen.findByTestId(
      'recording-completed-banner'
    );
    expect(completedBanner).toHaveTextContent(/Sẵn sàng tải lên/i);
    expect(completedBanner).toHaveTextContent('00987654321');

    const saved = await getLocalRecordingForUser(
      'rec-backend-uuid-normal',
      OPERATOR_ID
    );
    expect(saved?.captureStatus).toBe('Captured');
    expect(saved?.localSyncState).toBe('ReadyToUpload');
    expect(saved?.chunkCount).toBe(3); // 1024 + 2048 + 512 (final chunk on stop)
    expect(saved?.totalBytes).toBe(3584);

    expect(postedEvents.some((e) => e.eventType === 'captured')).toBe(true);
    expect(
      screen.getByRole('button', { name: /Quét & Quay đơn tiếp theo/i })
    ).toBeInTheDocument();
  });
});
