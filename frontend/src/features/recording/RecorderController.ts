import {
  SerializedChunkWriter,
  type ChunkWriterSnapshot
} from '../upload-queue/db/serializedChunkWriter';
import type { LocalRecordingManifest } from '../upload-queue/db/packingProofIdb';
import {
  acquireRecordingMediaStream,
  negotiateSupportedMimeType,
  stopMediaStreamTracks,
  translateCameraError,
  type AcquiredRecordingStream,
  type RecordingOrientationMode,
  type RecordingQualityTier
} from './mediaCapabilities';
import {
  postRecordingEventApi,
  type RecordingDto,
  type RecordingRuntimeLimits
} from './recordingApi';

export type RecorderPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'finalizing'
  | 'completed'
  | 'interrupted'
  | 'error';

export interface RecorderStateSnapshot {
  phase: RecorderPhase;
  recordingId: string | null;
  trackingNumber: string | null;
  mimeType: string | null;
  resolutionTier: '1080p' | '720p' | 'fallback' | null;
  activeVideoDimensions?: { width: number; height: number } | null;
  encoderMode?: 'hardware' | 'multithread-software' | 'fallback' | null;
  landscapeHardwareHint?: boolean;
  audioActive: boolean;
  audioFallbackWarning: string | null;
  elapsedSeconds: number;
  committedChunks: number;
  committedBytes: number;
  limitWarningMessage: string | null;
  autoStopReason: string | null;
  interruptionCode: string | null;
  interruptionMessage: string | null;
  errorMessage: string | null;
  finalizedManifest: LocalRecordingManifest | null;
}

export interface RecorderControllerStartInput {
  session: RecordingDto;
  limits: RecordingRuntimeLimits;
  deviceId?: string;
  enableAudio?: boolean;
  preferredTier?: RecordingQualityTier;
  orientation?: RecordingOrientationMode;
}

export interface RecorderControllerDependencies {
  ensureScannerStopped: () => Promise<void>;
  onStateChange: (snapshot: RecorderStateSnapshot) => void;
  onStreamChange: (stream: MediaStream | null) => void;
  acquireStream?: (opts: {
    deviceId?: string;
    enableAudio?: boolean;
    preferredTier?: RecordingQualityTier;
    orientation?: RecordingOrientationMode;
    maxDimensions?: { width: number; height: number };
  }) => Promise<AcquiredRecordingStream>;
  postEvent?: typeof postRecordingEventApi;
  timesliceMs?: number;
  timerIntervalMs?: number;
  nowMs?: () => number;
}

const DEFAULT_SNAPSHOT: RecorderStateSnapshot = {
  phase: 'idle',
  recordingId: null,
  trackingNumber: null,
  mimeType: null,
  resolutionTier: null,
  activeVideoDimensions: null,
  encoderMode: null,
  landscapeHardwareHint: false,
  audioActive: false,
  audioFallbackWarning: null,
  elapsedSeconds: 0,
  committedChunks: 0,
  committedBytes: 0,
  limitWarningMessage: null,
  autoStopReason: null,
  interruptionCode: null,
  interruptionMessage: null,
  errorMessage: null,
  finalizedManifest: null
};

export class RecorderController {
  private readonly deps: RecorderControllerDependencies;
  private snapshot: RecorderStateSnapshot = { ...DEFAULT_SNAPSHOT };
  private activeSession: RecordingDto | null = null;
  private activeLimits: RecordingRuntimeLimits | null = null;
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private writer: SerializedChunkWriter | null = null;
  private dataPipeline: Promise<void> = Promise.resolve();
  private recorderStopPromise: Promise<void> | null = null;
  private resolveRecorderStop: (() => void) | null = null;
  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private startedAtMs = 0;
  private detachInterruptListeners: (() => void) | null = null;
  private terminalHandled = false;
  private autoStopping = false;

  constructor(deps: RecorderControllerDependencies) {
    this.deps = deps;
  }

  public getSnapshot(): RecorderStateSnapshot {
    return { ...this.snapshot };
  }

  public reset(): void {
    this.cleanupRuntimeResources();
    this.activeSession = null;
    this.activeLimits = null;
    this.terminalHandled = false;
    this.autoStopping = false;
    this.updateSnapshot({ ...DEFAULT_SNAPSHOT });
  }

  public async start(input: RecorderControllerStartInput): Promise<void> {
    if (!input.session || !input.session.id || !input.session.trackingNumber) {
      const msg =
        'Chưa có phiên quay hợp lệ (RecordingId) từ máy chủ. Không thể bắt đầu ghi hình.';
      this.updateSnapshot({
        ...DEFAULT_SNAPSHOT,
        phase: 'error',
        errorMessage: msg
      });
      throw new Error(msg);
    }

    if (
      this.snapshot.phase === 'starting' ||
      this.snapshot.phase === 'recording' ||
      this.snapshot.phase === 'finalizing'
    ) {
      throw new Error('Đã có một phiên quay đang hoạt động trên thiết bị này.');
    }

    this.cleanupRuntimeResources();
    this.terminalHandled = false;
    this.autoStopping = false;
    this.activeSession = input.session;
    this.activeLimits = input.limits;

    // 1. Always stop ZXing scanner and release its camera tracks BEFORE opening recording stream!
    await this.deps.ensureScannerStopped();

    // 2. Enter 'starting' phase (NEVER display 'Đang quay' before MediaRecorder.onstart fires!)
    this.updateSnapshot({
      ...DEFAULT_SNAPSHOT,
      phase: 'starting',
      recordingId: input.session.id,
      trackingNumber: input.session.trackingNumber
    });

    const acquireFn = this.deps.acquireStream ?? acquireRecordingMediaStream;
    let acquired: AcquiredRecordingStream;

    try {
      acquired = await acquireFn({
        deviceId: input.deviceId,
        enableAudio: Boolean(input.enableAudio && input.limits.enableAudioRecording),
        preferredTier: input.preferredTier,
        orientation: input.orientation
      });
    } catch (err) {
      const msg = translateCameraError(err);
      this.updateSnapshot({
        ...this.snapshot,
        phase: 'error',
        errorMessage: msg
      });
      throw new Error(msg, { cause: err });
    }

    this.stream = acquired.stream;
    this.deps.onStreamChange(acquired.stream);

    const targetVideoBitrate =
      acquired.resolutionTier === '1080p'
        ? 4_000_000
        : acquired.resolutionTier === '720p'
          ? 2_500_000
          : 2_000_000;

    const mimeResult = negotiateSupportedMimeType(acquired.audioActive);
    if (!mimeResult.mediaRecorderAvailable || !mimeResult.supported) {
      this.cleanupRuntimeResources();
      const msg =
        'Trình duyệt không hỗ trợ định dạng MediaRecorder tương thích để ghi hình.';
      this.updateSnapshot({
        ...this.snapshot,
        phase: 'error',
        errorMessage: msg
      });
      throw new Error(msg);
    }

    const finalVideoTrack = acquired.stream.getVideoTracks()[0];
    const finalTrackSettings =
      finalVideoTrack && typeof finalVideoTrack.getSettings === 'function'
        ? finalVideoTrack.getSettings()
        : undefined;
    const resolvedActiveDimensions =
      finalTrackSettings?.width && finalTrackSettings?.height
        ? {
            width: finalTrackSettings.width,
            height: finalTrackSettings.height
          }
        : null;

    const negotiatedMime = mimeResult.mimeType || '';

    let recorder: MediaRecorder;
    try {
      const preferredOptions: MediaRecorderOptions = {
        ...(negotiatedMime ? { mimeType: negotiatedMime } : {}),
        videoBitsPerSecond: targetVideoBitrate,
        ...(acquired.audioActive ? { audioBitsPerSecond: 96_000 } : {})
      };
      try {
        recorder = new MediaRecorder(acquired.stream, preferredOptions);
      } catch {
        recorder = negotiatedMime
          ? new MediaRecorder(acquired.stream, { mimeType: negotiatedMime })
          : new MediaRecorder(acquired.stream);
      }
    } catch (err) {
      this.cleanupRuntimeResources();
      const msg =
        err instanceof Error && err.message
          ? `Không thể khởi tạo bộ ghi hình: ${err.message}`
          : 'Không thể khởi tạo MediaRecorder trên thiết bị.';
      this.updateSnapshot({
        ...this.snapshot,
        phase: 'error',
        errorMessage: msg
      });
      throw new Error(msg, { cause: err });
    }

    const effectiveMime = recorder.mimeType || negotiatedMime || 'video/webm';
    this.mediaRecorder = recorder;

    const writer = new SerializedChunkWriter({
      recordingId: input.session.id,
      ownerUserId: input.session.ownerUserId,
      shopId: input.session.shopId,
      warehouseId: input.session.warehouseId,
      shopName: input.session.shopName,
      warehouseName: input.session.warehouseName,
      trackingNumber: input.session.trackingNumber,
      carrierCode: input.session.carrierCode,
      tikTokOrderId: input.session.tikTokOrderId,
      mimeType: effectiveMime,
      onProgress: (writerSnap) => this.handleChunkCommitted(writerSnap),
      onQuotaExceeded: (_writerSnap, quotaErr) => {
        void this.handleInterruption(
          'QUOTA_EXCEEDED',
          quotaErr.message ||
            'Bộ nhớ lưu tạm của trình duyệt đã đầy (QuotaExceededError). Hệ thống đã dừng quay và giữ lại các phần đã lưu.'
        );
      }
    });

    await writer.init();
    this.writer = writer;
    this.dataPipeline = Promise.resolve();

    this.recorderStopPromise = new Promise<void>((resolve) => {
      this.resolveRecorderStop = resolve;
    });

    recorder.ondataavailable = (event: BlobEvent) => {
      const chunk = event.data;
      if (!chunk || chunk.size <= 0 || !this.writer) {
        return;
      }

      const activeWriter = this.writer;
      this.dataPipeline = this.dataPipeline
        .then(async () => {
          await activeWriter.appendChunk(chunk);
        })
        .catch(() => {
          // Quota/write errors are routed through onQuotaExceeded or finalize()
        });
    };

    recorder.onerror = () => {
      void this.handleInterruption(
        'MEDIA_RECORDER_ERROR',
        'Bộ ghi hình MediaRecorder bị dừng bất thường trên trình duyệt.'
      );
    };

    recorder.onstop = () => {
      if (this.resolveRecorderStop) {
        const resolve = this.resolveRecorderStop;
        this.resolveRecorderStop = null;
        resolve();
      }
    };

    recorder.onstart = () => {
      if (this.terminalHandled) {
        return;
      }

      const nowFn = this.deps.nowMs ?? Date.now;
      this.startedAtMs = nowFn();

      this.attachRuntimeInterruptionWatchers();
      this.startDurationTimer();

      // ONLY AFTER MediaRecorder.onstart fires do we enter 'recording' ("Đang quay")!
      this.updateSnapshot({
        ...this.snapshot,
        phase: 'recording',
        mimeType: effectiveMime,
        resolutionTier: acquired.resolutionTier,
        activeVideoDimensions: resolvedActiveDimensions,
        audioActive: acquired.audioActive,
        audioFallbackWarning: acquired.audioFallbackWarning,
        elapsedSeconds: 0
      });

      const postFn = this.deps.postEvent ?? postRecordingEventApi;
      void postFn(input.session.id, {
        eventType: 'started',
        clientMimeType: effectiveMime
      }).catch(() => {
        // Offline tolerance during active session: local IndexedDB remains authoritative for chunks
      });
    };

    try {
      recorder.start(this.deps.timesliceMs ?? 3000);
    } catch (err) {
      this.cleanupRuntimeResources();
      const msg =
        err instanceof Error && err.message
          ? `Không thể bắt đầu ghi hình: ${err.message}`
          : 'Không thể bắt đầu MediaRecorder (thiếu tài nguyên phần cứng).';
      this.updateSnapshot({
        ...this.snapshot,
        phase: 'error',
        errorMessage: msg
      });
      throw new Error(msg, { cause: err });
    }
  }

  public async stop(autoStopNote?: string): Promise<LocalRecordingManifest | null> {
    if (this.terminalHandled) {
      return this.snapshot.finalizedManifest;
    }

    if (this.snapshot.phase !== 'recording' && this.snapshot.phase !== 'starting') {
      return this.snapshot.finalizedManifest;
    }

    this.terminalHandled = true;
    const frozenDuration = this.freezeTimerAndGetElapsedSeconds();
    this.detachRuntimeInterruptionWatchers();

    this.updateSnapshot({
      ...this.snapshot,
      phase: 'finalizing',
      elapsedSeconds: frozenDuration,
      autoStopReason: autoStopNote ?? this.snapshot.autoStopReason
    });

    const recorder = this.mediaRecorder;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        this.resolveRecorderStop?.();
      }
      if (this.recorderStopPromise) {
        await this.recorderStopPromise;
      }
    }

    this.releaseStreamOnly();
    await this.dataPipeline;

    const session = this.activeSession;
    const writer = this.writer;
    if (!writer || !session) {
      return null;
    }

    const manifest = await writer.finalize('Captured', {
      durationSeconds: frozenDuration
    });

    const postFn = this.deps.postEvent ?? postRecordingEventApi;

    if (manifest.captureStatus === 'Captured') {
      void postFn(session.id, {
        eventType: 'captured',
        durationSeconds: frozenDuration
      }).catch(() => {
        // Offline tolerance: local manifest is safely committed as ReadyToUpload
      });

      this.updateSnapshot({
        ...this.snapshot,
        phase: 'completed',
        elapsedSeconds: frozenDuration,
        committedChunks: manifest.chunkCount,
        committedBytes: manifest.totalBytes,
        finalizedManifest: manifest
      });
    } else {
      const reason =
        manifest.interruptionReason ??
        'Phiên quay không lưu đủ dữ liệu hoàn chỉnh nên được đánh dấu gián đoạn.';
      void postFn(session.id, {
        eventType: 'interrupted',
        durationSeconds: frozenDuration,
        errorCode: 'CAPTURE_INCOMPLETE',
        reason
      }).catch(() => undefined);

      this.updateSnapshot({
        ...this.snapshot,
        phase: 'interrupted',
        elapsedSeconds: frozenDuration,
        committedChunks: manifest.chunkCount,
        committedBytes: manifest.totalBytes,
        interruptionCode: 'CAPTURE_INCOMPLETE',
        interruptionMessage: reason,
        finalizedManifest: manifest
      });
    }

    return manifest;
  }

  public async handleInterruption(
    errorCode: string,
    reason: string
  ): Promise<LocalRecordingManifest | null> {
    if (this.terminalHandled) {
      return this.snapshot.finalizedManifest;
    }

    this.terminalHandled = true;
    const frozenDuration = this.freezeTimerAndGetElapsedSeconds();
    this.detachRuntimeInterruptionWatchers();

    // Immediately reflect Interrupted state & frozen timer so UI never continues counting!
    this.updateSnapshot({
      ...this.snapshot,
      phase: 'interrupted',
      elapsedSeconds: frozenDuration,
      interruptionCode: errorCode,
      interruptionMessage: reason
    });

    const recorder = this.mediaRecorder;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        this.resolveRecorderStop?.();
      }
      if (this.recorderStopPromise) {
        await Promise.race([
          this.recorderStopPromise,
          new Promise<void>((r) => setTimeout(r, 800))
        ]);
      }
    }

    this.releaseStreamOnly();
    await this.dataPipeline;

    const session = this.activeSession;
    const writer = this.writer;
    let finalizedManifest: LocalRecordingManifest | null = null;

    if (writer) {
      finalizedManifest = await writer.finalize('Interrupted', {
        durationSeconds: frozenDuration,
        interruptionReason: reason,
        lastError: reason
      });
    }

    if (session) {
      const postFn = this.deps.postEvent ?? postRecordingEventApi;
      void postFn(session.id, {
        eventType: 'interrupted',
        durationSeconds: frozenDuration,
        errorCode,
        reason
      }).catch(() => undefined);
    }

    this.updateSnapshot({
      ...this.snapshot,
      phase: 'interrupted',
      elapsedSeconds: frozenDuration,
      committedChunks: finalizedManifest?.chunkCount ?? this.snapshot.committedChunks,
      committedBytes: finalizedManifest?.totalBytes ?? this.snapshot.committedBytes,
      interruptionCode: errorCode,
      interruptionMessage: reason,
      finalizedManifest
    });

    return finalizedManifest;
  }

  public dispose(): void {
    if (
      !this.terminalHandled &&
      (this.snapshot.phase === 'recording' || this.snapshot.phase === 'starting')
    ) {
      void this.handleInterruption(
        'COMPONENT_UNMOUNTED',
        'Bạn đã rời khỏi màn hình quay khi phiên quay chưa kết thúc. Phiên đã được đánh dấu gián đoạn.'
      );
      return;
    }
    this.cleanupRuntimeResources();
  }

  private handleChunkCommitted(writerSnap: ChunkWriterSnapshot): void {
    if (this.terminalHandled) {
      return;
    }

    const limits = this.activeLimits;
    let limitWarning = this.snapshot.limitWarningMessage;

    if (limits && limits.maxUploadBytes > 0) {
      const ratio = writerSnap.committedBytes / limits.maxUploadBytes;
      if (ratio >= 0.98 && !this.autoStopping) {
        this.autoStopping = true;
        void this.stop(
          'Đã chạm ngưỡng dung lượng tệp tối đa cho phép. Hệ thống tự động kết thúc phiên quay có kiểm soát để bảo toàn dữ liệu.'
        );
        return;
      }

      if (ratio >= 0.85) {
        limitWarning =
          'Dung lượng video đã đạt trên 85% giới hạn cho phép. Hệ thống sẽ tự động kết thúc và lưu phiên khi chạm ngưỡng tối đa.';
      }
    }

    this.updateSnapshot({
      ...this.snapshot,
      committedChunks: writerSnap.committedChunks,
      committedBytes: writerSnap.committedBytes,
      limitWarningMessage: limitWarning
    });
  }

  private startDurationTimer(): void {
    this.stopDurationTimer();
    const intervalMs = this.deps.timerIntervalMs ?? 1000;
    const nowFn = this.deps.nowMs ?? Date.now;

    this.timerHandle = setInterval(() => {
      if (this.terminalHandled || this.snapshot.phase !== 'recording') {
        this.stopDurationTimer();
        return;
      }

      const elapsed = Math.max(0, (nowFn() - this.startedAtMs) / 1000);
      const limits = this.activeLimits;
      let limitWarning = this.snapshot.limitWarningMessage;

      if (limits && limits.maxRecordingSeconds > 0) {
        if (elapsed >= limits.maxRecordingSeconds && !this.autoStopping) {
          this.autoStopping = true;
          void this.stop(
            `Đã đạt thời lượng quay tối đa (${Math.round(limits.maxRecordingSeconds / 60)} phút). Hệ thống tự động kết thúc và lưu phiên quay có kiểm soát.`
          );
          return;
        }

        const remaining = limits.maxRecordingSeconds - elapsed;
        if (
          remaining <= Math.min(60, limits.maxRecordingSeconds * 0.15) &&
          remaining > 0
        ) {
          limitWarning = `Còn khoảng ${Math.ceil(remaining)} giây là đạt giới hạn thời lượng phiên quay.`;
        }
      }

      if (
        Math.floor(elapsed) !== Math.floor(this.snapshot.elapsedSeconds) ||
        limitWarning !== this.snapshot.limitWarningMessage
      ) {
        this.updateSnapshot({
          ...this.snapshot,
          elapsedSeconds: elapsed,
          limitWarningMessage: limitWarning
        });
      }
    }, intervalMs);
  }

  private freezeTimerAndGetElapsedSeconds(): number {
    this.stopDurationTimer();
    if (this.startedAtMs <= 0) {
      return 0;
    }
    const nowFn = this.deps.nowMs ?? Date.now;
    const raw = Math.max(0, (nowFn() - this.startedAtMs) / 1000);
    return Math.round(raw * 100) / 100;
  }

  private stopDurationTimer(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private attachRuntimeInterruptionWatchers(): void {
    this.detachRuntimeInterruptionWatchers();

    const stream = this.stream;
    const videoTracks = stream ? stream.getVideoTracks() : [];
    const primaryTrack = videoTracks[0] as
      | (MediaStreamTrack & {
          onended: ((this: MediaStreamTrack, ev: Event) => unknown) | null;
          onmute: ((this: MediaStreamTrack, ev: Event) => unknown) | null;
        })
      | undefined;

    const onTrackEnded = () => {
      void this.handleInterruption(
        'CAMERA_TRACK_ENDED',
        'Luồng camera đã bị ngắt đột ngột (cuộc gọi đến, khóa màn hình, chuyển ứng dụng hoặc mất kết nối camera). Phiên quay đã dừng và đánh dấu Bị gián đoạn.'
      );
    };

    const onTrackMute = () => {
      void this.handleInterruption(
        'CAMERA_TRACK_MUTED',
        'Tín hiệu hình ảnh từ camera bị hệ điều hành tạm ngắt (chuyển ứng dụng ra nền hoặc có cuộc gọi). Phiên quay đã dừng và đánh dấu Bị gián đoạn.'
      );
    };

    const onPageHide = () => {
      void this.handleInterruption(
        'PAGE_HIDDEN_OR_CLOSED',
        'Trang quay bị đóng hoặc tải lại khi đang ghi hình. Đã lưu lại các phần dữ liệu kịp hoàn tất dưới trạng thái Bị gián đoạn.'
      );
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') {
        return;
      }

      const rec = this.mediaRecorder;
      const trackHalted =
        !primaryTrack ||
        primaryTrack.readyState === 'ended' ||
        primaryTrack.muted === true;
      const recorderHalted = !rec || rec.state !== 'recording';

      if (trackHalted || recorderHalted) {
        void this.handleInterruption(
          'BACKGROUND_RECORDING_HALTED',
          'Trình duyệt đã ngắt ghi hình khi trang chuyển ra nền. Phiên quay được đánh dấu Bị gián đoạn.'
        );
      }
    };

    let prevOnEnded: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;
    let prevOnMute: ((this: MediaStreamTrack, ev: Event) => unknown) | null = null;

    if (primaryTrack) {
      prevOnEnded = primaryTrack.onended ?? null;
      prevOnMute = primaryTrack.onmute ?? null;
      primaryTrack.onended = onTrackEnded;
      primaryTrack.onmute = onTrackMute;

      if (typeof primaryTrack.addEventListener === 'function') {
        primaryTrack.addEventListener('ended', onTrackEnded);
        primaryTrack.addEventListener('mute', onTrackMute);
      }
    }

    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    this.detachInterruptListeners = () => {
      if (primaryTrack) {
        if (primaryTrack.onended === onTrackEnded) {
          primaryTrack.onended = prevOnEnded;
        }
        if (primaryTrack.onmute === onTrackMute) {
          primaryTrack.onmute = prevOnMute;
        }
        if (typeof primaryTrack.removeEventListener === 'function') {
          primaryTrack.removeEventListener('ended', onTrackEnded);
          primaryTrack.removeEventListener('mute', onTrackMute);
        }
      }

      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }

  private detachRuntimeInterruptionWatchers(): void {
    if (this.detachInterruptListeners) {
      const fn = this.detachInterruptListeners;
      this.detachInterruptListeners = null;
      fn();
    }
  }

  private releaseStreamOnly(): void {
    if (this.stream) {
      const s = this.stream;
      this.stream = null;
      stopMediaStreamTracks(s);
      this.deps.onStreamChange(null);
    }
  }

  private cleanupRuntimeResources(): void {
    this.stopDurationTimer();
    this.detachRuntimeInterruptionWatchers();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // Ignore
      }
    }
    this.mediaRecorder = null;
    this.releaseStreamOnly();
  }

  private updateSnapshot(next: RecorderStateSnapshot): void {
    this.snapshot = next;
    this.deps.onStateChange({ ...next });
  }
}

