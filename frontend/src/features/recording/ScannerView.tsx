import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react';
import {
  AlertTriangle,
  Flashlight,
  FlashlightOff,
  Loader2,
  RefreshCw,
  ScanBarcode
} from 'lucide-react';
import {
  BarcodeFormat,
  BrowserCodeReader,
  BrowserMultiFormatReader,
  type IScannerControls
} from '@zxing/browser';
import { DecodeHintType } from '@zxing/library';
import {
  checkTrackTorchCapability,
  setTrackTorch,
  stopMediaStreamTracks,
  translateCameraError
} from './mediaCapabilities';
import type { BarcodeFormatHint } from './recordingApi';

export interface ScannerDecodedEvent {
  rawText: string;
  formatHint: BarcodeFormatHint;
}

export interface ScannerStartContext {
  videoElement: HTMLVideoElement;
  deviceId?: string;
  onDecoded: (event: ScannerDecodedEvent) => void;
  onError?: (error: unknown) => void;
}

export interface ActiveScannerHandle {
  stop: () => void | Promise<void>;
  stream?: MediaStream | null;
}

export interface ScannerAdapter {
  start: (ctx: ScannerStartContext) => Promise<ActiveScannerHandle>;
}

export interface ScannerViewHandle {
  stopScanner: () => Promise<void>;
  isActive: () => boolean;
}

export interface ScannerViewProps {
  enabled: boolean;
  selectedDeviceId: string;
  onSelectedDeviceIdChange: (deviceId: string) => void;
  onDecoded: (event: ScannerDecodedEvent) => void;
  scannerAdapter?: ScannerAdapter;
}

function mapZxingFormatHint(format: BarcodeFormat | undefined): BarcodeFormatHint {
  if (format === BarcodeFormat.QR_CODE) {
    return 'QrCode';
  }
  return 'OneDimensional';
}

interface DetectedBarcodeLike {
  rawValue?: string;
  format?: string;
}

interface NativeBarcodeDetectorLike {
  detect: (source: ImageBitmapSource) => Promise<DetectedBarcodeLike[]>;
}

interface NativeBarcodeDetectorCtor {
  new (options?: { formats?: string[] }): NativeBarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

const DESIRED_NATIVE_BARCODE_FORMATS = [
  'qr_code',
  'code_128',
  'code_39',
  'ean_13',
  'ean_8',
  'itf',
  'codabar',
  'upc_a',
  'upc_e'
] as const;

const SHIPPING_ZXING_FORMATS: BarcodeFormat[] = [
  BarcodeFormat.QR_CODE,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.ITF,
  BarcodeFormat.CODABAR,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E
];

async function openScannerCameraStream(deviceId?: string): Promise<MediaStream> {
  const baseDevice: MediaTrackConstraints = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: { ideal: 'environment' } };

  const constraintAttempts: MediaTrackConstraints[] = [
    {
      ...baseDevice,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 }
    },
    baseDevice
  ];

  let lastErr: unknown = null;
  for (const videoConstraint of constraintAttempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraint
      });
      return stream;
    } catch (err) {
      lastErr = err;
      const errName = (err as { name?: string })?.name;
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        break;
      }
    }
  }

  throw lastErr ?? new Error('Không thể khởi tạo camera quét mã vận đơn.');
}

async function tryCreateNativeBarcodeDetector(): Promise<NativeBarcodeDetectorLike | null> {
  const ctor = (
    globalThis as unknown as { BarcodeDetector?: NativeBarcodeDetectorCtor }
  ).BarcodeDetector;
  if (typeof ctor !== 'function') {
    return null;
  }

  try {
    if (typeof ctor.getSupportedFormats === 'function') {
      const supported = await ctor.getSupportedFormats();
      const usable = DESIRED_NATIVE_BARCODE_FORMATS.filter((f) =>
        supported.includes(f)
      );
      // Require both 1D Code128 and 2D QR support before choosing native detector
      if (!usable.includes('code_128') || !usable.includes('qr_code')) {
        return null;
      }
      return new ctor({ formats: usable });
    }
    return new ctor({ formats: [...DESIRED_NATIVE_BARCODE_FORMATS] });
  } catch {
    return null;
  }
}

export function createDefaultZxingScannerAdapter(): ScannerAdapter {
  return {
    async start({ videoElement, deviceId, onDecoded }) {
      // 1. Fast-Path for Android Chrome (`Chrome/83+`): Native C++ off-main-thread `BarcodeDetector`
      //    (Google Play Services ML Kit). Runs directly on the GPU `HTMLVideoElement` with ZERO
      //    `<canvas>` allocation, ZERO `getImageData` GPU->CPU stall, and 0% JS main-thread lag!
      const nativeDetector = await tryCreateNativeBarcodeDetector();
      if (nativeDetector) {
        const stream = await openScannerCameraStream(deviceId);
        videoElement.srcObject = stream;
        await videoElement.play().catch(() => undefined);

        let stopped = false;
        let timerId: ReturnType<typeof setTimeout> | null = null;

        const scheduleNext = (delayMs: number) => {
          if (stopped) {
            return;
          }
          timerId = setTimeout(() => {
            void runNativeScanTick();
          }, delayMs);
        };

        const runNativeScanTick = async () => {
          if (stopped) {
            return;
          }
          try {
            if (
              videoElement.readyState >= 2 &&
              videoElement.videoWidth > 0 &&
              videoElement.videoHeight > 0
            ) {
              const results = await nativeDetector.detect(videoElement);
              if (!stopped && Array.isArray(results) && results.length > 0) {
                for (const hit of results) {
                  const rawText = hit.rawValue?.trim() ?? '';
                  if (rawText) {
                    const fmt = (hit.format ?? '').toLowerCase();
                    onDecoded({
                      rawText,
                      formatHint: fmt === 'qr_code' ? 'QrCode' : 'OneDimensional'
                    });
                    scheduleNext(450);
                    return;
                  }
                }
              }
            }
          } catch {
            // Transient frame-not-ready error; retry cleanly on next interval
          }
          scheduleNext(200);
        };

        scheduleNext(120);

        return {
          stream,
          stop: () => {
            stopped = true;
            if (timerId !== null) {
              clearTimeout(timerId);
              timerId = null;
            }
            stopMediaStreamTracks(stream);
            if (videoElement.srcObject instanceof MediaStream) {
              stopMediaStreamTracks(videoElement.srcObject);
            }
            videoElement.srcObject = null;
          }
        };
      }

      // 2. Optimized Fallback (iOS Safari / Desktop Firefox):
      //    Restrict ZXing strictly to 1D shipping barcodes + QR (skipping heavy Aztec/PDF417/MaxiCode/DataMatrix)
      //    and explicitly clear `BrowserCodeReader.releaseAllStreams()` on stop so `streamTracker` never leaks!
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, SHIPPING_ZXING_FORMATS);
      const reader = new BrowserMultiFormatReader(hints, {
        delayBetweenScanAttempts: 400,
        delayBetweenScanSuccess: 500
      });
      const stream = await openScannerCameraStream(deviceId);

      let controls: IScannerControls;
      try {
        controls = await reader.decodeFromStream(
          stream,
          videoElement,
          (result) => {
            if (result) {
              const rawText = result.getText();
              const format = result.getBarcodeFormat();
              onDecoded({
                rawText,
                formatHint: mapZxingFormatHint(format)
              });
            }
          }
        );
      } catch (err) {
        stopMediaStreamTracks(stream);
        try {
          BrowserCodeReader.releaseAllStreams();
        } catch {
          // Ignore static cleanup error
        }
        throw err;
      }

      const attachedStream =
        videoElement.srcObject instanceof MediaStream
          ? videoElement.srcObject
          : stream;

      return {
        stream: attachedStream,
        stop: () => {
          try {
            controls.stop();
          } catch {
            // Ignore scanner stop race
          }
          try {
            BrowserCodeReader.releaseAllStreams();
          } catch {
            // Ignore static tracker cleanup error
          }
          stopMediaStreamTracks(stream);
          stopMediaStreamTracks(attachedStream);
          if (videoElement.srcObject instanceof MediaStream) {
            stopMediaStreamTracks(videoElement.srcObject);
          }
          try {
            BrowserCodeReader.cleanVideoSource(videoElement);
          } catch {
            videoElement.srcObject = null;
          }
        }
      };
    }
  };
}

export const ScannerView = forwardRef<ScannerViewHandle, ScannerViewProps>(
  function ScannerView(
    {
      enabled,
      selectedDeviceId,
      onDecoded,
      scannerAdapter
    },
    ref
  ) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const activeHandleRef = useRef<ActiveScannerHandle | null>(null);
    const activeStreamRef = useRef<MediaStream | null>(null);
    const onDecodedRef = useRef(onDecoded);
    onDecodedRef.current = onDecoded;

    const [isStarting, setIsStarting] = useState<boolean>(false);
    const [scannerRunning, setScannerRunning] = useState<boolean>(false);
    const [cameraError, setCameraError] = useState<string | null>(null);
    const [torchSupported, setTorchSupported] = useState<boolean>(false);
    const [torchEnabled, setTorchEnabled] = useState<boolean>(false);
    const [restartNonce, setRestartNonce] = useState<number>(0);

    const stopScanner = useCallback(async () => {
      const handle = activeHandleRef.current;
      activeHandleRef.current = null;

      const stream = activeStreamRef.current;
      activeStreamRef.current = null;

      setTorchEnabled(false);
      setTorchSupported(false);
      setScannerRunning(false);

      if (handle) {
        await Promise.resolve(handle.stop()).catch(() => undefined);
      }

      stopMediaStreamTracks(stream);

      const videoEl = videoRef.current;
      if (videoEl) {
        if (
          typeof MediaStream !== 'undefined' &&
          videoEl.srcObject instanceof MediaStream
        ) {
          stopMediaStreamTracks(videoEl.srcObject);
        }
        videoEl.srcObject = null;
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        stopScanner,
        isActive: () => activeHandleRef.current !== null
      }),
      [stopScanner]
    );

    useEffect(() => {
      if (!enabled) {
        void stopScanner();
        return;
      }

      let cancelled = false;
      const adapter = scannerAdapter ?? createDefaultZxingScannerAdapter();

      (async () => {
        await stopScanner();
        if (cancelled || !videoRef.current) {
          return;
        }

        setIsStarting(true);
        setCameraError(null);

        try {
          const handle = await adapter.start({
            videoElement: videoRef.current,
            deviceId: selectedDeviceId || undefined,
            onDecoded: (evt) => {
              if (!cancelled) {
                onDecodedRef.current(evt);
              }
            }
          });

          if (cancelled) {
            await Promise.resolve(handle.stop()).catch(() => undefined);
            stopMediaStreamTracks(handle.stream);
            return;
          }

          activeHandleRef.current = handle;
          const resolvedStream =
            handle.stream ??
            (typeof MediaStream !== 'undefined' &&
            videoRef.current?.srcObject instanceof MediaStream
              ? videoRef.current.srcObject
              : null);
          activeStreamRef.current = resolvedStream;

          setScannerRunning(true);
          setTorchSupported(checkTrackTorchCapability(resolvedStream));
          setTorchEnabled(false);
        } catch (err) {
          if (!cancelled) {
            setScannerRunning(false);
            setCameraError(translateCameraError(err));
          }
        } finally {
          if (!cancelled) {
            setIsStarting(false);
          }
        }
      })();

      return () => {
        cancelled = true;
        void stopScanner();
      };
    }, [enabled, restartNonce, scannerAdapter, selectedDeviceId, stopScanner]);

    const handleToggleTorch = useCallback(async () => {
      const next = !torchEnabled;
      const applied = await setTrackTorch(activeStreamRef.current, next);
      setTorchEnabled(applied);
    }, [torchEnabled]);

    return (
      <div
        className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 text-zinc-100 shadow-lg sm:p-4"
        data-testid="scanner-view"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-300 uppercase">
            <ScanBarcode className="h-4 w-4 text-blue-400" aria-hidden="true" />
            <span>Quét tem vận đơn</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {torchSupported && (
              <button
                type="button"
                className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-colors ${
                  torchEnabled
                    ? 'border-amber-400/60 bg-amber-400 text-zinc-950 hover:bg-amber-300'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800'
                }`}
                onClick={() => void handleToggleTorch()}
                aria-pressed={torchEnabled}
              >
                {torchEnabled ? (
                  <FlashlightOff className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Flashlight className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span>{torchEnabled ? 'Tắt đèn Flash' : 'Bật đèn Flash'}</span>
              </button>
            )}
          </div>
        </div>

        <div className="camera-viewport">
          <video
            ref={videoRef}
            className="camera-video"
            muted
            playsInline
            autoPlay
            disablePictureInPicture
            disableRemotePlayback
            aria-label="Khung ngắm quét mã vận đơn"
          />

          {scannerRunning && (
            <div className="scanner-reticle" aria-hidden="true">
              <div className="scanner-reticle-box" />
              <span className="scanner-reticle-hint">
                Đưa mã vạch hoặc mã QR trên tem đơn vào khung ngắm
              </span>
            </div>
          )}

          {isStarting && (
            <div className="camera-overlay-msg" role="status">
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Đang mở camera quét mã...</span>
              </span>
            </div>
          )}
        </div>

        {cameraError && (
          <div
            className="mt-3 rounded-xl border border-red-500/40 bg-red-950/70 p-3.5 text-sm text-red-100"
            role="alert"
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
              <div className="flex-1">{cameraError}</div>
            </div>
            <button
              type="button"
              className="mt-3 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-red-400/40 bg-red-900/50 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-900/80"
              onClick={() => setRestartNonce((n) => n + 1)}
            >
              <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Thử mở lại camera</span>
            </button>
          </div>
        )}
      </div>
    );
  }
);

