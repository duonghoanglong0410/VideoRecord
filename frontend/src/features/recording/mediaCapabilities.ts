import { countPendingLocalRecordingsForUser } from '../upload-queue/db/packingProofIdb';
import {
  estimateStorageQuota,
  requestPersistentStorage,
  type StorageQuotaEstimate
} from '../upload-queue/db/storageQuota';

export const PREFERRED_VIDEO_MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm'
] as const;

export interface MimeNegotiationResult {
  mediaRecorderAvailable: boolean;
  supported: boolean;
  mimeType: string | null;
}

export interface RecordingPreFlightReport {
  canRecord: boolean;
  isSecureContext: boolean;
  hasMediaDevices: boolean;
  mimeNegotiation: MimeNegotiationResult;
  storageQuota: StorageQuotaEstimate;
  persistentStorageGranted: boolean;
  pendingLocalCount: number;
  maxLocalPendingRecordings: number;
  blockingError: string | null;
  warnings: string[];
}

export interface VideoInputDeviceOption {
  deviceId: string;
  label: string;
}

export interface AcquireRecordingStreamOptions {
  deviceId?: string;
  enableAudio?: boolean;
}

export interface AcquiredRecordingStream {
  stream: MediaStream;
  resolutionTier: '1080p' | '720p' | 'fallback';
  audioActive: boolean;
  audioFallbackWarning: string | null;
}

export function negotiateSupportedMimeType(): MimeNegotiationResult {
  if (typeof MediaRecorder === 'undefined') {
    return {
      mediaRecorderAvailable: false,
      supported: false,
      mimeType: null
    };
  }

  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    return {
      mediaRecorderAvailable: true,
      supported: true,
      mimeType: ''
    };
  }

  for (const candidate of PREFERRED_VIDEO_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) {
        return {
          mediaRecorderAvailable: true,
          supported: true,
          mimeType: candidate
        };
      }
    } catch {
      // Ignore unsupported candidate errors on older mobile browsers
    }
  }

  return {
    mediaRecorderAvailable: true,
    supported: false,
    mimeType: null
  };
}

export async function checkRecordingPreFlight(options: {
  userId: string;
  maxLocalPendingRecordings?: number;
}): Promise<RecordingPreFlightReport> {
  const maxPending = options.maxLocalPendingRecordings ?? 3;
  const warnings: string[] = [];

  const secure =
    typeof window !== 'undefined' ? Boolean(window.isSecureContext) : false;
  const hasMediaDevices =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices) &&
    typeof navigator.mediaDevices.getUserMedia === 'function';

  const mimeNegotiation = negotiateSupportedMimeType();
  const [storageQuota, persistRes, pendingLocalCount] = await Promise.all([
    estimateStorageQuota(),
    requestPersistentStorage(),
    countPendingLocalRecordingsForUser(options.userId)
  ]);

  if (storageQuota.warningMessage && !storageQuota.isCriticallyLow) {
    warnings.push(storageQuota.warningMessage);
  }

  let blockingError: string | null = null;

  if (!secure) {
    blockingError =
      'Trình duyệt hiện không chạy trên kết nối bảo mật HTTPS được tin cậy (window.isSecureContext = false). Camera trên điện thoại bắt buộc truy cập qua HTTPS hợp lệ.';
  } else if (!hasMediaDevices) {
    blockingError =
      'Trình duyệt này không hỗ trợ truy cập camera (MediaDevices.getUserMedia không khả dụng).';
  } else if (!mimeNegotiation.mediaRecorderAvailable || !mimeNegotiation.supported) {
    blockingError =
      'Trình duyệt không hỗ trợ định dạng ghi hình MediaRecorder tương thích (MP4/WebM). Vui lòng cập nhật Chrome trên Android hoặc Safari trên iPhone.';
  } else if (storageQuota.isCriticallyLow) {
    blockingError =
      storageQuota.warningMessage ??
      'Bộ nhớ lưu tạm của trình duyệt đã gần đầy, không đủ dung lượng an toàn để bắt đầu phiên quay mới.';
  } else if (pendingLocalCount >= maxPending) {
    blockingError = `Thiết bị đang có ${pendingLocalCount}/${maxPending} bản ghi video chờ tải lên và xác nhận lưu trữ. Vui lòng mở Hàng đợi tải lên để hoàn tất các bản ghi trước khi quay đơn mới.`;
  }

  return {
    canRecord: blockingError === null,
    isSecureContext: secure,
    hasMediaDevices,
    mimeNegotiation,
    storageQuota,
    persistentStorageGranted: persistRes.persisted,
    pendingLocalCount,
    maxLocalPendingRecordings: maxPending,
    blockingError,
    warnings
  };
}

export async function listVideoInputDevices(): Promise<VideoInputDeviceOption[]> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== 'function'
  ) {
    return [];
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === 'videoinput');
    return videoInputs.map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label?.trim() || `Camera ${idx + 1}`
    }));
  } catch {
    return [];
  }
}

function buildVideoConstraint(
  tier: '1080p' | '720p' | 'fallback',
  deviceId?: string
): MediaTrackConstraints {
  const baseDevice: MediaTrackConstraints = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: { ideal: 'environment' } };

  if (tier === '1080p') {
    return {
      ...baseDevice,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 }
    };
  }

  if (tier === '720p') {
    return {
      ...baseDevice,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    };
  }

  return deviceId ? { deviceId: { ideal: deviceId } } : { facingMode: 'environment' };
}

async function tryGetVideoStreamWithTierFallback(
  audio: boolean,
  deviceId?: string
): Promise<{ stream: MediaStream; tier: '1080p' | '720p' | 'fallback' }> {
  const tiers: Array<'1080p' | '720p' | 'fallback'> = ['1080p', '720p', 'fallback'];
  let lastError: unknown = null;

  for (const tier of tiers) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: buildVideoConstraint(tier, deviceId),
        audio
      });
      return { stream, tier };
    } catch (err) {
      lastError = err;
      const errName = (err as { name?: string })?.name;
      // Permission denial should fail fast if silent video itself was denied
      if (
        !audio &&
        (errName === 'NotAllowedError' || errName === 'PermissionDeniedError')
      ) {
        break;
      }
    }
  }

  throw lastError ?? new Error('Không thể khởi tạo luồng hình ảnh từ camera.');
}

/**
 * Acquires the recording MediaStream preferring 1080p@30fps -> 720p@30fps -> fallback.
 * Audio is OFF by default; if audio opt-in is enabled and microphone permission fails,
 * gracefully falls back to video-only so missing mic permission never breaks silent recording.
 */
export async function acquireRecordingMediaStream(
  options: AcquireRecordingStreamOptions = {}
): Promise<AcquiredRecordingStream> {
  const wantAudio = Boolean(options.enableAudio);

  if (wantAudio) {
    try {
      const { stream, tier } = await tryGetVideoStreamWithTierFallback(
        true,
        options.deviceId
      );
      return {
        stream,
        resolutionTier: tier,
        audioActive: stream.getAudioTracks().length > 0,
        audioFallbackWarning: null
      };
    } catch {
      // Fall back cleanly to silent video-only stream
      const { stream, tier } = await tryGetVideoStreamWithTierFallback(
        false,
        options.deviceId
      );
      return {
        stream,
        resolutionTier: tier,
        audioActive: false,
        audioFallbackWarning:
          'Không thể mở micro (chưa cấp quyền hoặc thiết bị không có micro). Hệ thống đã tự động chuyển sang chế độ quay không thu âm.'
      };
    }
  }

  const { stream, tier } = await tryGetVideoStreamWithTierFallback(
    false,
    options.deviceId
  );

  return {
    stream,
    resolutionTier: tier,
    audioActive: false,
    audioFallbackWarning: null
  };
}

export function stopMediaStreamTracks(stream: MediaStream | null | undefined): void {
  if (!stream) {
    return;
  }
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore already-stopped track errors
    }
  }
}

export function checkTrackTorchCapability(
  stream: MediaStream | null | undefined
): boolean {
  if (!stream) {
    return false;
  }

  const [videoTrack] = stream.getVideoTracks();
  if (!videoTrack || typeof videoTrack.getCapabilities !== 'function') {
    return false;
  }

  try {
    const caps = videoTrack.getCapabilities() as MediaTrackCapabilities & {
      torch?: boolean;
    };
    return caps?.torch === true;
  } catch {
    return false;
  }
}

export async function setTrackTorch(
  stream: MediaStream | null | undefined,
  enabled: boolean
): Promise<boolean> {
  if (!stream) {
    return false;
  }

  const [videoTrack] = stream.getVideoTracks();
  if (!videoTrack || typeof videoTrack.applyConstraints !== 'function') {
    return false;
  }

  try {
    await videoTrack.applyConstraints({
      advanced: [{ torch: enabled } as MediaTrackConstraintSet]
    });
    return enabled;
  } catch {
    return false;
  }
}

export function translateCameraError(error: unknown): string {
  const errName = (error as { name?: string })?.name ?? '';

  switch (errName) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Quyền truy cập camera đã bị từ chối. Vui lòng mở cài đặt trình duyệt cho trang web này, cấp quyền Camera rồi thử lại.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Không tìm thấy thiết bị camera trên máy này.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Camera đang được sử dụng bởi ứng dụng khác hoặc gặp lỗi phần cứng. Vui lòng đóng các ứng dụng chụp ảnh/gọi video khác rồi thử lại.';
    case 'OverconstrainedError':
      return 'Camera hiện tại không đáp ứng được cấu hình hình ảnh yêu cầu. Vui lòng thử chọn camera khác.';
    default:
      return error instanceof Error && error.message
        ? error.message
        : 'Không thể khởi động camera trên thiết bị.';
  }
}

