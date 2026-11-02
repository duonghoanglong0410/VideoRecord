import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../src/app/authStore';
import type { AuthMe } from '../../src/app/types';
import { RecordingPage } from '../../src/features/recording/RecordingPage';
import type {
  ScannerAdapter,
  ScannerDecodedEvent
} from '../../src/features/recording/ScannerView';
import { VideoDetailPage } from '../../src/features/videos/VideoDetailPage';
import { VideoListPage } from '../../src/features/videos/VideoListPage';
import type {
  PagedVideosResponse,
  VideoDetailDto
} from '../../src/features/videos/videosApi';

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SHOP_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const WH_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const VIDEO_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function buildMe(permissions: string[]): AuthMe {
  return {
    id: USER_ID,
    email: 'tester@congty.vn',
    fullName: 'Trần Kiểm Định',
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
        roleId: 'role-1',
        roleName: 'Viewer',
        scopeType: 'Shop',
        shopId: SHOP_ID,
        shopName: 'Shop A',
        warehouseId: null,
        warehouseName: null
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
    csrfToken: 'csrf-phase4-1'
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function buildDetailFixture(overrides: Partial<VideoDetailDto> = {}): VideoDetailDto {
  return {
    id: VIDEO_ID,
    trackingNumber: '0012345678',
    carrierCode: 'SPX',
    tikTokOrderId: '577123456789012345',
    shopId: SHOP_ID,
    shopCode: 'ShopA',
    shopName: 'Shop A',
    warehouseId: WH_ID,
    warehouseCode: 'WH-01',
    warehouseName: 'Kho TP.HCM 01',
    packingStationName: 'Bàn đóng gói 01',
    ownerUserId: USER_ID,
    ownerEmail: 'operator@congty.vn',
    ownerFullName: 'Nguyễn Văn Đóng Gói',
    source: 'Imported',
    isManualCode: false,
    manualEntryReason: null,
    linkedFromRecordingId: null,
    linkedFromTrackingNumber: null,
    captureStatus: 'Interrupted',
    storageStatus: 'Stored',
    previewStatus: 'Ready',
    storageMode: 'LocalDevelopment',
    durationSeconds: 42,
    width: 1280,
    height: 720,
    actualMimeType: 'video/webm',
    actualContainer: 'matroska,webm',
    videoCodec: 'vp8',
    audioCodec: null,
    originalSizeBytes: 2_097_152,
    originalSha256:
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    hasOriginalAsset: true,
    hasPreviewAsset: true,
    previewSizeBytes: 1_572_864,
    startedAtUtc: '2026-10-29T03:00:00Z',
    endedAtUtc: '2026-10-29T03:00:42Z',
    serverReceivedAtUtc: '2026-10-29T03:01:00Z',
    storedAtUtc: '2026-10-29T03:01:05Z',
    createdAtUtc: '2026-10-29T03:00:00Z',
    lastErrorCode: 'CAMERA_TRACK_ENDED',
    userSafeErrorMessage: 'Luồng camera bị ngắt giữa chừng khi đang quay.',
    isRetryable: false,
    hold: false,
    holdReason: null,
    holdUpdatedByUserId: null,
    holdUpdatedAtUtc: null,
    notes: [],
    deletionRequests: [],
    canDownload: false,
    canNote: false,
    canHold: false,
    canRequestDelete: false,
    canApproveDelete: false,
    canReRecordWithCorrectCode: false,
    ...overrides
  };
}

describe('Phase 4 Video Library Search, Detail Permissions, Hold Protection & Import Gating', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves leading-zero tracking codes in exact & partial search queries and renders honest LocalDevelopment / Imported badges', async () => {
    const user = userEvent.setup();
    const requestedVideoUrls: string[] = [];

    const pagedPayload: PagedVideosResponse = {
      items: [
        {
          id: VIDEO_ID,
          trackingNumber: '0012345678',
          carrierCode: 'SPX',
          tikTokOrderId: '577123456789012345',
          shopId: SHOP_ID,
          shopName: 'Shop A',
          warehouseId: WH_ID,
          warehouseName: 'Kho TP.HCM 01',
          ownerUserId: USER_ID,
          ownerEmail: 'operator@congty.vn',
          ownerFullName: 'Nguyễn Văn Đóng Gói',
          source: 'Imported',
          isManualCode: false,
          captureStatus: 'Captured',
          storageStatus: 'Stored',
          previewStatus: 'NotRequired',
          storageMode: 'LocalDevelopment',
          durationSeconds: 65,
          width: 1280,
          height: 720,
          actualMimeType: 'video/mp4',
          originalSizeBytes: 4_194_304,
          hasPreviewAsset: false,
          hold: true,
          holdReason: 'Khách khiếu nại đơn hàng',
          noteCount: 2,
          hasPendingDeletionRequest: false,
          startedAtUtc: '2026-10-29T02:00:00Z',
          endedAtUtc: '2026-10-29T02:01:05Z',
          storedAtUtc: '2026-10-29T02:01:12Z',
          createdAtUtc: '2026-10-29T02:00:00Z',
          lastErrorCode: null,
          userSafeErrorMessage: null
        }
      ],
      page: 1,
      pageSize: 20,
      totalCount: 1,
      totalPages: 1
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/me')) {
        return jsonRes(buildMe(['video.view']));
      }
      if (url.endsWith('/api/shops')) {
        return jsonRes({
          shops: [
            {
              id: SHOP_ID,
              code: 'ShopA',
              slug: 'shop-a',
              name: 'Shop A',
              warehouses: [
                {
                  id: WH_ID,
                  code: 'WH-01',
                  name: 'Kho TP.HCM 01',
                  packingStations: []
                }
              ]
            }
          ]
        });
      }
      if (url.includes('/api/videos?')) {
        requestedVideoUrls.push(url);
        return jsonRes(pagedPayload);
      }
      return jsonRes({}, 404);
    });

    render(
      <MemoryRouter initialEntries={['/videos']}>
        <AuthProvider>
          <Routes>
            <Route path="/videos" element={<VideoListPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(requestedVideoUrls.length).toBeGreaterThanOrEqual(1);
    });

    // Leading-zero tracking code is rendered intact with simplified status badge
    expect(screen.getAllByText('0012345678').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Thành công').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Đã lưu NAS/i)).not.toBeInTheDocument();

    // Search with leading zeros + "Video của tôi"
    const searchInput = screen.getByLabelText(/Tìm theo mã vận đơn/i);
    await user.clear(searchInput);
    await user.type(searchInput, '0012345678');

    await user.click(screen.getByRole('button', { name: 'Tìm kiếm' }));

    await waitFor(() => {
      expect(
        requestedVideoUrls.some((u) => u.includes('trackingNumber=0012345678'))
      ).toBe(true);
    });
  });

  it('hides Download button for Viewer (canDownload=false), renders Interrupted warning + Thất bại badge, and contains zero fake share/export buttons', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/me')) {
        return jsonRes(buildMe(['video.view']));
      }
      if (url.endsWith(`/api/videos/${VIDEO_ID}`)) {
        return jsonRes(buildDetailFixture({ canDownload: false }));
      }
      if (url.includes(`/api/videos/${VIDEO_ID}/stream`) && init?.method === 'HEAD') {
        return new Response(null, { status: 503 });
      }
      return jsonRes({}, 404);
    });

    render(
      <MemoryRouter initialEntries={[`/videos/${VIDEO_ID}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/videos/:id" element={<VideoDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    expect(
      await screen.findByTestId('detail-tracking-number')
    ).toHaveTextContent('0012345678');

    // Prominent Interrupted warning banner + Thất bại badge
    expect(screen.getByTestId('detail-interrupted-banner')).toHaveTextContent(
      /Phiên ghi hình bị gián đoạn/i
    );
    expect(screen.getByTestId('detail-status-badge')).toHaveTextContent(
      'Thất bại'
    );

    // Viewer lacks video.download -> Download button MUST NOT exist
    expect(
      screen.queryByTestId('download-original-btn')
    ).not.toBeInTheDocument();

    // Authenticated stream player uses /api/videos/:id/stream
    const player = screen.getByTestId(
      'authenticated-video-player'
    ) as HTMLVideoElement;
    expect(player.getAttribute('src')).toContain(
      `/api/videos/${VIDEO_ID}/stream?variant=auto`
    );

    // Simulate NAS/storage 503 failure on <video> -> clear Vietnamese 503 notice without staging fallback
    fireEvent.error(player);
    expect(
      await screen.findByTestId('video-playback-error')
    ).toHaveTextContent(/HTTP 503/i);

    // Zero fake/non-functional placeholder buttons (no share link, no export to TikTok)
    expect(
      screen.queryByRole('button', { name: /Chia sẻ|Share|Xuất sang TikTok/i })
    ).not.toBeInTheDocument();
  });

  it('shows Download link and Thành công badge when canDownload=true and video is Captured & Stored', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/me')) {
        return jsonRes(
          buildMe([
            'video.view',
            'video.download',
            'video.hold',
            'video.delete.request'
          ])
        );
      }
      if (url.endsWith(`/api/videos/${VIDEO_ID}`)) {
        return jsonRes(
          buildDetailFixture({
            captureStatus: 'Captured',
            storageMode: 'SynologyMounted',
            hold: true,
            holdReason: 'Đang giải quyết khiếu nại thiếu hàng trên TikTok Shop',
            canDownload: true,
            canHold: true,
            canRequestDelete: true,
            canReRecordWithCorrectCode: true
          })
        );
      }
      return jsonRes({}, 404);
    });

    render(
      <MemoryRouter initialEntries={[`/videos/${VIDEO_ID}`]}>
        <AuthProvider>
          <Routes>
            <Route path="/videos/:id" element={<VideoDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    const downloadLink = await screen.findByTestId('download-original-btn');
    expect(downloadLink).toHaveAttribute(
      'href',
      `/api/videos/${VIDEO_ID}/download`
    );

    expect(screen.getByTestId('detail-status-badge')).toHaveTextContent(
      'Thành công'
    );
  });

  it('renders video.import file panel ONLY when user has video.import permission, displays immutable linkedFrom banner, and imports file via POST /api/videos/import + IndexedDB queue', async () => {
    const user = userEvent.setup();
    const scanHolder: { emit: ((evt: ScannerDecodedEvent) => void) | null } = {
      emit: null
    };
    let importPostPayload: Record<string, unknown> | null = null;

    const origIsSecureContext = window.isSecureContext;
    const origMediaDevices = navigator.mediaDevices;
    const origMediaRecorder = globalThis.MediaRecorder;

    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
        enumerateDevices: vi.fn(async () => [
          { kind: 'videoinput', deviceId: 'cam-1', label: 'Camera Sau' }
        ])
      }
    });
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = {
      isTypeSupported: (mime: string) => mime.startsWith('video/webm')
    };

    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/auth/me')) {
          return jsonRes(buildMe(['recording.create', 'video.import']));
        }
        if (url.endsWith('/api/auth/csrf')) {
          return jsonRes({ token: 'csrf-import-1' });
        }
        if (url.endsWith('/api/shops')) {
          return jsonRes({
            shops: [
              {
                id: SHOP_ID,
                code: 'ShopA',
                slug: 'shop-a',
                name: 'Shop A',
                warehouses: [
                  {
                    id: WH_ID,
                    code: 'WH-01',
                    name: 'Kho TP.HCM 01',
                    packingStations: []
                  }
                ]
              }
            ]
          });
        }
        if (url.endsWith(`/api/recordings/${VIDEO_ID}`)) {
          return jsonRes({
            id: VIDEO_ID,
            shopId: SHOP_ID,
            warehouseId: WH_ID,
            trackingNumber: '0099998888'
          });
        }
        if (url.endsWith('/api/recordings/inspect-code')) {
          return jsonRes({
            isValid: true,
            trackingNumber: '0012345678',
            carrierCode: 'SPX',
            tikTokOrderId: null,
            matchedRule: 'PlainCarrierCode',
            existingRecordingCount: 0,
            warningMessage: null
          });
        }
        if (url.endsWith('/api/videos/import') && init?.method === 'POST') {
          importPostPayload = JSON.parse(String(init.body ?? '{}')) as Record<
            string,
            unknown
          >;
          return jsonRes(
            {
              recording: {
                id: 'imported-rec-uuid-01',
                ownerUserId: USER_ID,
                ownerEmail: 'tester@congty.vn',
                ownerFullName: 'Trần Kiểm Định',
                shopId: SHOP_ID,
                shopName: 'Shop A',
                warehouseId: WH_ID,
                warehouseName: 'Kho TP.HCM 01',
                packingStationId: null,
                trackingNumber: '0012345678',
                safeTrackingSegment: '0012345678',
                carrierCode: 'SPX',
                tikTokOrderId: null,
                source: 'Imported',
                manualEntryReason: null,
                linkedFromRecordingId: VIDEO_ID,
                captureStatus: 'Captured',
                storageStatus: 'AwaitingUpload',
                previewStatus: 'NotRequired',
                clientMimeType: 'video/mp4',
                durationSeconds: null,
                startedAtUtc: '2026-10-29T04:00:00Z',
                endedAtUtc: '2026-10-29T04:00:00Z',
                storedAtUtc: null,
                hold: false,
                lastErrorCode: null,
                userSafeErrorMessage: null,
                createdAtUtc: '2026-10-29T04:00:00Z',
                updatedAtUtc: '2026-10-29T04:00:00Z'
              },
              uploadSession: null,
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
        return jsonRes({ token: 'csrf-1' });
      });

      const scannerAdapter: ScannerAdapter = {
        start: async ({ onDecoded }) => {
          scanHolder.emit = onDecoded;
          return {
            stream: {
              getTracks: () => [],
              getVideoTracks: () => []
            } as unknown as MediaStream,
            stop: vi.fn()
          };
        }
      };

      render(
        <MemoryRouter
          initialEntries={[
            `/record?linkedFrom=${VIDEO_ID}&reason=Quay%20nham%20tem%20don`
          ]}
        >
          <AuthProvider>
            <Routes>
              <Route
                path="/record"
                element={<RecordingPage scannerAdapter={scannerAdapter} />}
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      );

      // Immutable previous tracking code relink banner appears
      expect(await screen.findByTestId('linked-from-banner')).toHaveTextContent(
        '0099998888'
      );

      await screen.findByTestId('scanner-view');
      await waitFor(() => {
        expect(scanHolder.emit).not.toBeNull();
      });

      await act(async () => {
        scanHolder.emit?.({
          rawText: '0012345678',
          formatHint: 'OneDimensional'
        });
      });

      const importPanel = await screen.findByTestId('video-import-panel');
      expect(importPanel).toHaveTextContent(/Nhập tệp video có sẵn/i);

      // Select a video file and import it into IndexedDB ReadyToUpload queue
      const fileInput = screen.getByLabelText(
        /Chọn tệp video đóng gói/i
      ) as HTMLInputElement;
      const sampleFile = new File(
        [new Uint8Array(4096).fill(0x55)],
        'goi-hang-0012345678.mp4',
        { type: 'video/mp4' }
      );
      await user.upload(fileInput, sampleFile);

      await user.click(
        screen.getByRole('button', {
          name: /Xác nhận mã & Nhập tệp video có sẵn/i
        })
      );

      const enqueuedBanner = await screen.findByTestId('import-enqueued-banner');
      expect(enqueuedBanner).toHaveTextContent('0012345678');
      expect(enqueuedBanner).toHaveTextContent('goi-hang-0012345678.mp4');
      expect(importPostPayload).toMatchObject({
        shopId: SHOP_ID,
        warehouseId: WH_ID,
        rawCode: '0012345678',
        linkedFromRecordingId: VIDEO_ID
      });
    } finally {
      Object.defineProperty(window, 'isSecureContext', {
        configurable: true,
        value: origIsSecureContext
      });
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: origMediaDevices
      });
      (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
        origMediaRecorder;
    }
  });
});
