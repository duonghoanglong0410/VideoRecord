import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react';
import {
  BarcodeFormat,
  BrowserCodeReader,
  BrowserMultiFormatReader,
  type IScannerControls
} from '@zxing/browser';
import {
  checkTrackTorchCapability,
  listVideoInputDevices,
  setTrackTorch,
  stopMediaStreamTracks,
  translateCameraError,
  type VideoInputDeviceOption
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

export function createDefaultZxingScannerAdapter(): ScannerAdapter {
  return {
    async start({ videoElement, deviceId, onDecoded }) {
      const reader = new BrowserMultiFormatReader();
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: deviceId
          ? {
              deviceId: { exact: deviceId },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
          : {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            }
      };

      const controls: IScannerControls = await reader.decodeFromConstraints(
        constraints,
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

      const attachedStream =
        videoElement.srcObject instanceof MediaStream
          ? videoElement.srcObject
          : null;

      return {
        stream: attachedStream,
        stop: () => {
          try {
            controls.stop();
          } catch {
            // Ignore scanner stop race
          }
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
      onSelectedDeviceIdChange,
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

    const [devices, setDevices] = useState<VideoInputDeviceOption[]>([]);
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

          const availableDevices = await listVideoInputDevices();
          if (!cancelled) {
            setDevices(availableDevices);
          }
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
      <div className="scanner-panel" data-testid="scanner-view">
        <div className="scanner-toolbar">
          {devices.length > 1 && (
            <div className="scanner-camera-select">
              <label htmlFor="scanner-camera-dropdown" className="form-label" style={{ marginBottom: 4 }}>
                Chọn camera
              </label>
              <select
                id="scanner-camera-dropdown"
                className="form-input"
                value={selectedDeviceId}
                onChange={(e) => onSelectedDeviceIdChange(e.target.value)}
              >
                <option value="">Camera sau (Tự động ưu tiên)</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {torchSupported && (
            <button
              type="button"
              className={`btn ${torchEnabled ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => void handleToggleTorch()}
              aria-pressed={torchEnabled}
            >
              {torchEnabled ? 'Tắt đèn Flash' : 'Bật đèn Flash'}
            </button>
          )}
        </div>

        <div className="camera-viewport">
          <video
            ref={videoRef}
            className="camera-video"
            muted
            playsInline
            autoPlay
            aria-label="Khung ngắm quét mã vận đơn"
          />

          {scannerRunning && (
            <div className="scanner-reticle" aria-hidden="true">
              <div className="scanner-reticle-box" />
              <span className="scanner-reticle-hint">
                Đưa mã vạch (1D) hoặc mã QR trên tem đơn vào khung ngắm
              </span>
            </div>
          )}

          {isStarting && (
            <div className="camera-overlay-msg" role="status">
              Đang mở camera quét mã...
            </div>
          )}
        </div>

        {cameraError && (
          <div className="alert alert-error" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
            <div>{cameraError}</div>
            <button
              type="button"
              className="btn btn-outline"
              style={{ marginTop: 10 }}
              onClick={() => setRestartNonce((n) => n + 1)}
            >
              Thử mở lại camera
            </button>
          </div>
        )}
      </div>
    );
  }
);

