import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  CloudUpload,
  Info,
  Keyboard,
  Loader2
} from 'lucide-react';
import { ApiRequestError } from '../../app/apiClient';
import { RECORDING_ACTIVE_UI_EVENT } from '../../app/AppLayout';
import { useAuth } from '../../app/authStore';
import { Permissions } from '../../app/types';
import {
  countPendingLocalRecordingsForUser,
  reconcileCrashedSessions,
  type LocalRecordingManifest
} from '../upload-queue/db/packingProofIdb';
import { SerializedChunkWriter } from '../upload-queue/db/serializedChunkWriter';
import { formatBytes } from '../upload-queue/db/storageQuota';
import { createVideoImportApi } from '../videos/videosApi';
import {
  checkRecordingPreFlight,
  checkTrackTorchCapability,
  playScanSuccessBeep,
  setTrackTorch,
  type AcquiredRecordingStream,
  type RecordingOrientationMode,
  type RecordingPreFlightReport,
  type RecordingQualityTier
} from './mediaCapabilities';
import {
  RecorderController,
  type RecorderStateSnapshot
} from './RecorderController';
import {
  createRecordingSessionApi,
  fetchAccessibleShops,
  getRecordingByIdApi,
  inspectTrackingCodeApi,
  postRecordingEventApi,
  type BarcodeFormatHint,
  type CreateRecordingRequest,
  type InspectTrackingCodeResponse,
  type RecordingDto,
  type RecordingRuntimeLimits,
  type ShopOption,
  type WarehouseOption
} from './recordingApi';
import {
  ScannerView,
  type ScannerAdapter,
  type ScannerDecodedEvent,
  type ScannerViewHandle
} from './ScannerView';
import { DuplicateScanDebouncer, parseTrackingCode } from './trackingParser';
import { CameraHudStage } from './components/CameraHudStage';
import { ManualTrackingModal } from './components/ManualTrackingModal';
import { RecordingContextBar } from './components/RecordingContextBar';
import { TrackingConfirmCard } from './components/TrackingConfirmCard';

export type RecordingOrientationChoice = RecordingOrientationMode;

export interface RecordingPageProps {
  scannerAdapter?: ScannerAdapter;
  acquireRecordingStreamOverride?: (opts: {
    deviceId?: string;
    enableAudio?: boolean;
    preferredTier?: RecordingQualityTier;
    orientation?: RecordingOrientationMode;
    maxDimensions?: { width: number; height: number };
  }) => Promise<AcquiredRecordingStream>;
  recorderTimesliceMs?: number;
  recorderTimerIntervalMs?: number;
}

export function RecordingPage({
  scannerAdapter,
  acquireRecordingStreamOverride,
  recorderTimesliceMs,
  recorderTimerIntervalMs
}: RecordingPageProps = {}) {
  const { user, runtimeConfig, hasPermission } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canCreateLiveRecording = hasPermission(Permissions.RecordingCreate);
  const canImportVideo = hasPermission(Permissions.VideoImport);
  const canManualCode = hasPermission(Permissions.RecordingManualCode);

  const defaultLimits: RecordingRuntimeLimits = useMemo(
    () => ({
      maxRecordingSeconds: runtimeConfig?.maxRecordingSeconds ?? 600,
      maxUploadBytes: runtimeConfig?.maxUploadBytes ?? 536_870_912,
      maxLocalPendingRecordings: runtimeConfig?.maxLocalPendingRecordings ?? 3,
      enableAudioRecording: runtimeConfig?.enableAudioRecording ?? false
    }),
    [runtimeConfig]
  );

  const scannerRef = useRef<ScannerViewHandle | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const activeRecordingStreamRef = useRef<MediaStream | null>(null);
  const debouncerRef = useRef<DuplicateScanDebouncer>(new DuplicateScanDebouncer(2500));
  const controllerRef = useRef<RecorderController | null>(null);

  const [recordingTorchSupported, setRecordingTorchSupported] = useState<boolean>(false);
  const [recordingTorchEnabled, setRecordingTorchEnabled] = useState<boolean>(false);

  const [preFlight, setPreFlight] = useState<RecordingPreFlightReport | null>(null);
  const [crashedSessionsNotice, setCrashedSessionsNotice] = useState<
    LocalRecordingManifest[]
  >([]);

  const [shops, setShops] = useState<ShopOption[]>([]);
  const [isLoadingShops, setIsLoadingShops] = useState<boolean>(true);
  const [shopsError, setShopsError] = useState<string | null>(null);

  const [selectedShopId, setSelectedShopId] = useState<string>('');
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>('');
  const [selectedCameraDeviceId, setSelectedCameraDeviceId] = useState<string>('');

  // Step 1: Recognized / Inspected Tracking Code
  const [inspectedCode, setInspectedCode] = useState<InspectTrackingCodeResponse | null>(
    null
  );
  const [lastRawCode, setLastRawCode] = useState<string>('');
  const [lastFormatHint, setLastFormatHint] = useState<BarcodeFormatHint>('Unknown');
  const [isInspecting, setIsInspecting] = useState<boolean>(false);
  const [scanFeedbackError, setScanFeedbackError] = useState<string | null>(null);

  // Optional relink when previous recording had wrong tracking code
  const [linkedFromRecording, setLinkedFromRecording] = useState<RecordingDto | null>(
    null
  );
  const [linkedFromReasonHint, setLinkedFromReasonHint] = useState<string | null>(
    null
  );

  // Optional Video Import state (ONLY used when user has video.import permission)
  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(null);
  const [isImportingFile, setIsImportingFile] = useState<boolean>(false);
  const [importProgressText, setImportProgressText] = useState<string | null>(null);
  const [importedManualReason, setImportedManualReason] = useState<string>('');
  const [enqueuedImportSummary, setEnqueuedImportSummary] = useState<{
    recordingId: string;
    trackingNumber: string;
    fileName: string;
    byteSize: number;
  } | null>(null);

  // Manual entry modal (only reachable when user has recording.manual_code)
  const [isManualModalOpen, setIsManualModalOpen] = useState<boolean>(false);
  const [manualCodeInput, setManualCodeInput] = useState<string>('');
  const [manualReasonInput, setManualReasonInput] = useState<string>('');
  const [manualFormError, setManualFormError] = useState<string | null>(null);

  // Step 2: Created Backend Session & Active Recorder State
  const [activeSession, setActiveSession] = useState<RecordingDto | null>(null);
  const [pendingCreateRequest, setPendingCreateRequest] =
    useState<CreateRecordingRequest | null>(null);
  const [sessionWarning, setSessionWarning] = useState<string | null>(null);
  const [activeLimits, setActiveLimits] =
    useState<RecordingRuntimeLimits>(defaultLimits);
  const [isCreatingSession, setIsCreatingSession] = useState<boolean>(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);

  const [orientation, setOrientation] =
    useState<RecordingOrientationChoice>('landscape');
  const [qualityTier, setQualityTier] = useState<RecordingQualityTier>('1080p');
  const [enableAudioOptIn, setEnableAudioOptIn] = useState<boolean>(false);

  const [recorderState, setRecorderState] = useState<RecorderStateSnapshot>({
    phase: 'idle',
    recordingId: null,
    trackingNumber: null,
    mimeType: null,
    resolutionTier: null,
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
  });

  const refreshPreFlight = useCallback(
    async (maxPendingOverride?: number) => {
      if (!user?.id) {
        return null;
      }
      const report = await checkRecordingPreFlight({
        userId: user.id,
        maxLocalPendingRecordings:
          maxPendingOverride ?? activeLimits.maxLocalPendingRecordings
      });
      setPreFlight(report);
      return report;
    },
    [activeLimits.maxLocalPendingRecordings, user?.id]
  );

  // Initialize RecorderController instance
  useEffect(() => {
    const controller = new RecorderController({
      ensureScannerStopped: async () => {
        if (scannerRef.current) {
          await scannerRef.current.stopScanner();
        }
      },
      onStateChange: (snap) => {
        setRecorderState(snap);
      },
      onStreamChange: (stream) => {
        activeRecordingStreamRef.current = stream;
        setRecordingTorchSupported(checkTrackTorchCapability(stream));
        setRecordingTorchEnabled(false);
        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = stream;
          if (
            !import.meta.env.VITEST &&
            typeof previewVideoRef.current.play === 'function'
          ) {
            try {
              const playRes = previewVideoRef.current.play();
              if (playRes && typeof playRes.catch === 'function') {
                playRes.catch(() => undefined);
              }
            } catch {
              // Ignore benign play() interruption when stream changes
            }
          }
        }
      },
      acquireStream: acquireRecordingStreamOverride,
      timesliceMs: recorderTimesliceMs,
      timerIntervalMs: recorderTimerIntervalMs
    });

    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [
    acquireRecordingStreamOverride,
    recorderTimerIntervalMs,
    recorderTimesliceMs
  ]);

  // Reconcile any crashed sessions for this user and run pre-flight check on mount
  useEffect(() => {
    if (!user?.id) {
      return;
    }

    let mounted = true;
    (async () => {
      try {
        const reconciled = await reconcileCrashedSessions(user.id);
        if (mounted && reconciled.length > 0) {
          setCrashedSessionsNotice(reconciled);
          for (const item of reconciled) {
            void postRecordingEventApi(item.recordingId, {
              eventType: 'interrupted',
              durationSeconds: item.durationSeconds,
              errorCode: 'CRASH_OR_RELOAD_RECOVERY',
              reason: item.interruptionReason
            }).catch(() => undefined);
          }
        }
      } catch {
        // Ignore IndexedDB reconciliation errors if browser blocks IDB
      }

      if (mounted) {
        await refreshPreFlight(defaultLimits.maxLocalPendingRecordings);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [defaultLimits.maxLocalPendingRecordings, refreshPreFlight, user?.id]);

  // Refresh pre-flight pending count whenever a recording completes or interrupts
  useEffect(() => {
    if (
      recorderState.phase === 'completed' ||
      recorderState.phase === 'interrupted'
    ) {
      void refreshPreFlight();
    }
  }, [recorderState.phase, refreshPreFlight]);

  // Load accessible shops & warehouses
  useEffect(() => {
    let active = true;
    (async () => {
      setIsLoadingShops(true);
      setShopsError(null);
      try {
        const res = await fetchAccessibleShops();
        if (!active) {
          return;
        }
        setShops(res.shops);

        if (res.shops.length > 0) {
          const preferredShop =
            res.shops.find((s) => s.id === user?.defaultShopId) ??
            (res.shops.length === 1 ? res.shops[0] : res.shops[0]);

          setSelectedShopId(preferredShop.id);

          const preferredWh =
            preferredShop.warehouses.find(
              (w) => w.id === user?.defaultWarehouseId
            ) ??
            (preferredShop.warehouses.length === 1
              ? preferredShop.warehouses[0]
              : preferredShop.warehouses[0]);

          setSelectedWarehouseId(preferredWh?.id ?? '');
        }
      } catch (err) {
        if (active) {
          setShopsError(
            err instanceof Error
              ? err.message
              : 'Không thể tải danh sách Shop và Kho được phân quyền.'
          );
        }
      } finally {
        if (active) {
          setIsLoadingShops(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [user?.defaultShopId, user?.defaultWarehouseId]);

  // Load linkedFrom recording when navigated from VideoDetailPage (?linkedFrom=<id>&reason=...)
  useEffect(() => {
    const linkedFromId = searchParams.get('linkedFrom')?.trim() ?? '';
    const reasonParam = searchParams.get('reason')?.trim() ?? '';
    if (!linkedFromId) {
      return;
    }

    let active = true;
    setLinkedFromReasonHint(reasonParam || null);

    (async () => {
      try {
        const dto = await getRecordingByIdApi(linkedFromId, {
          suppressSessionExpiredEvent: true
        });
        if (!active || !dto?.id) {
          return;
        }
        setLinkedFromRecording(dto);
        if (dto.shopId && shops.some((s) => s.id === dto.shopId)) {
          setSelectedShopId(dto.shopId);
          if (dto.warehouseId) {
            setSelectedWarehouseId(dto.warehouseId);
          }
        }
      } catch {
        // Ignore if linked recording is outside scope or not found
      }
    })();

    return () => {
      active = false;
    };
  }, [searchParams, shops]);

  const currentShop: ShopOption | undefined = useMemo(
    () => shops.find((s) => s.id === selectedShopId),
    [selectedShopId, shops]
  );

  const availableWarehouses: WarehouseOption[] = useMemo(
    () => currentShop?.warehouses ?? [],
    [currentShop]
  );

  const handleShopChange = useCallback(
    (nextShopId: string) => {
      setSelectedShopId(nextShopId);
      const nextShop = shops.find((s) => s.id === nextShopId);
      const firstWh = nextShop?.warehouses[0];
      setSelectedWarehouseId(firstWh?.id ?? '');
      setInspectedCode(null);
      setScanFeedbackError(null);
      debouncerRef.current.reset();
    },
    [shops]
  );

  const handleWarehouseChange = useCallback((nextWarehouseId: string) => {
    setSelectedWarehouseId(nextWarehouseId);
    setInspectedCode(null);
    setScanFeedbackError(null);
    debouncerRef.current.reset();
  }, []);

  const handleScannerDecoded = useCallback(
    async ({ rawText, formatHint }: ScannerDecodedEvent) => {
      if (activeSession || isCreatingSession) {
        return;
      }

      if (!debouncerRef.current.shouldProcess(rawText)) {
        return;
      }

      setScanFeedbackError(null);

      // Instant client-side validation (never guesses URLs or calls scanned URLs)
      const localParse = parseTrackingCode(rawText, formatHint);
      if (!localParse.isValid) {
        setInspectedCode(null);
        setScanFeedbackError(
          localParse.errorMessage ?? 'Mã quét không phải mã vận đơn hợp lệ.'
        );
        return;
      }

      if (!selectedShopId || !selectedWarehouseId) {
        setScanFeedbackError('Vui lòng chọn Shop và Kho trước khi quét mã.');
        return;
      }

      playScanSuccessBeep();
      setIsInspecting(true);
      try {
        const res = await inspectTrackingCodeApi({
          shopId: selectedShopId,
          warehouseId: selectedWarehouseId,
          rawCode: rawText,
          formatHint
        });

        if (!res.isValid || !res.trackingNumber) {
          setInspectedCode(null);
          setScanFeedbackError(
            res.errorMessage ?? 'Máy chủ từ chối định dạng mã vận đơn vừa quét.'
          );
          return;
        }

        setLastRawCode(rawText);
        setLastFormatHint(formatHint);
        setInspectedCode(res);
      } catch (err) {
        setScanFeedbackError(
          err instanceof Error
            ? err.message
            : 'Không thể kiểm tra mã vận đơn với máy chủ.'
        );
      } finally {
        setIsInspecting(false);
      }
    },
    [activeSession, isCreatingSession, selectedShopId, selectedWarehouseId]
  );

  const handleConfirmAndCreateSession = useCallback(async () => {
    if (!inspectedCode?.isValid || !inspectedCode.trackingNumber) {
      return;
    }

    if (!selectedShopId || !selectedWarehouseId) {
      setSessionActionError('Vui lòng chọn Shop và Kho đóng gói.');
      return;
    }

    setIsCreatingSession(true);
    setSessionActionError(null);

    try {
      const latestPreFlight = await refreshPreFlight();
      if (latestPreFlight && !latestPreFlight.canRecord) {
        setSessionActionError(latestPreFlight.blockingError);
        return;
      }

      // Stop ZXing scanner cleanly before entering pre-recording stage!
      if (scannerRef.current) {
        await scannerRef.current.stopScanner();
      }

      const selectedWh = availableWarehouses.find(
        (w) => w.id === selectedWarehouseId
      );
      const nowIso = new Date().toISOString();
      const draftSession: RecordingDto = {
        id: '',
        ownerUserId: user?.id ?? '',
        ownerEmail: user?.email ?? '',
        ownerFullName: user?.fullName ?? '',
        shopId: selectedShopId,
        shopName: currentShop?.name ?? '',
        warehouseId: selectedWarehouseId,
        warehouseName: selectedWh?.name ?? '',
        packingStationId: null,
        trackingNumber: inspectedCode.trackingNumber,
        safeTrackingSegment: inspectedCode.trackingNumber,
        carrierCode: inspectedCode.carrierCode,
        tikTokOrderId: inspectedCode.tikTokOrderId,
        source: 'RecordedInBrowser',
        manualEntryReason: null,
        linkedFromRecordingId: linkedFromRecording?.id ?? null,
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
        createdAtUtc: nowIso,
        updatedAtUtc: nowIso
      };

      setPendingCreateRequest({
        shopId: selectedShopId,
        warehouseId: selectedWarehouseId,
        rawCode: lastRawCode || inspectedCode.trackingNumber,
        formatHint: lastFormatHint,
        isManualEntry: false,
        linkedFromRecordingId: linkedFromRecording?.id ?? null
      });
      setActiveSession(draftSession);
      setSessionWarning(inspectedCode.warningMessage);
      setLinkedFromRecording(null);
      setLinkedFromReasonHint(null);
      if (searchParams.has('linkedFrom') || searchParams.has('reason')) {
        setSearchParams({}, { replace: true });
      }
    } catch (err) {
      setSessionActionError(
        err instanceof ApiRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Không thể chuẩn bị phiên quay.'
      );
    } finally {
      setIsCreatingSession(false);
    }
  }, [
    availableWarehouses,
    currentShop?.name,
    inspectedCode,
    lastFormatHint,
    lastRawCode,
    linkedFromRecording?.id,
    refreshPreFlight,
    searchParams,
    selectedShopId,
    selectedWarehouseId,
    setSearchParams,
    user?.email,
    user?.fullName,
    user?.id
  ]);

  const handleManualEntrySubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canManualCode) {
        return;
      }

      setManualFormError(null);

      const localParse = parseTrackingCode(manualCodeInput, 'ManualEntry');
      if (!localParse.isValid) {
        setManualFormError(
          localParse.errorMessage ?? 'Mã vận đơn nhập tay không hợp lệ.'
        );
        return;
      }

      const trimmedReason = manualReasonInput.trim();
      if (trimmedReason.length < 3) {
        setManualFormError(
          'Vui lòng nhập lý do nhập mã thủ công (tối thiểu 3 ký tự).'
        );
        return;
      }

      if (!selectedShopId || !selectedWarehouseId) {
        setManualFormError('Vui lòng chọn Shop và Kho đóng gói.');
        return;
      }

      setIsCreatingSession(true);
      try {
        const latestPreFlight = await refreshPreFlight();
        if (latestPreFlight && !latestPreFlight.canRecord) {
          setManualFormError(latestPreFlight.blockingError);
          return;
        }

        const inspected = await inspectTrackingCodeApi({
          shopId: selectedShopId,
          warehouseId: selectedWarehouseId,
          rawCode: manualCodeInput,
          formatHint: 'ManualEntry'
        });

        if (!inspected.isValid || !inspected.trackingNumber) {
          setManualFormError(
            inspected.errorMessage ?? 'Máy chủ từ chối định dạng mã vận đơn nhập tay.'
          );
          return;
        }

        if (scannerRef.current) {
          await scannerRef.current.stopScanner();
        }

        const selectedWh = availableWarehouses.find(
          (w) => w.id === selectedWarehouseId
        );
        const nowIso = new Date().toISOString();
        const draftSession: RecordingDto = {
          id: '',
          ownerUserId: user?.id ?? '',
          ownerEmail: user?.email ?? '',
          ownerFullName: user?.fullName ?? '',
          shopId: selectedShopId,
          shopName: currentShop?.name ?? '',
          warehouseId: selectedWarehouseId,
          warehouseName: selectedWh?.name ?? '',
          packingStationId: null,
          trackingNumber: inspected.trackingNumber,
          safeTrackingSegment: inspected.trackingNumber,
          carrierCode: inspected.carrierCode,
          tikTokOrderId: inspected.tikTokOrderId,
          source: 'RecordedInBrowser',
          manualEntryReason: trimmedReason,
          linkedFromRecordingId: linkedFromRecording?.id ?? null,
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
          createdAtUtc: nowIso,
          updatedAtUtc: nowIso
        };

        setIsManualModalOpen(false);
        setManualCodeInput('');
        setManualReasonInput('');
        setPendingCreateRequest({
          shopId: selectedShopId,
          warehouseId: selectedWarehouseId,
          rawCode: manualCodeInput,
          formatHint: 'ManualEntry',
          isManualEntry: true,
          manualEntryReason: trimmedReason,
          linkedFromRecordingId: linkedFromRecording?.id ?? null
        });
        setActiveSession(draftSession);
        setSessionWarning(inspected.warningMessage);
        setLinkedFromRecording(null);
        setLinkedFromReasonHint(null);
        if (searchParams.has('linkedFrom') || searchParams.has('reason')) {
          setSearchParams({}, { replace: true });
        }
      } catch (err) {
        setManualFormError(
          err instanceof Error
            ? err.message
            : 'Không thể chuẩn bị phiên quay bằng mã thủ công.'
        );
      } finally {
        setIsCreatingSession(false);
      }
    },
    [
      availableWarehouses,
      canManualCode,
      currentShop?.name,
      linkedFromRecording?.id,
      manualCodeInput,
      manualReasonInput,
      refreshPreFlight,
      searchParams,
      selectedShopId,
      selectedWarehouseId,
      setSearchParams,
      user?.email,
      user?.fullName,
      user?.id
    ]
  );

  const handleUseManualCodeForImport = useCallback(async () => {
    if (!canManualCode || !canImportVideo) {
      return;
    }

    setManualFormError(null);
    const localParse = parseTrackingCode(manualCodeInput, 'ManualEntry');
    if (!localParse.isValid) {
      setManualFormError(
        localParse.errorMessage ?? 'Mã vận đơn nhập tay không hợp lệ.'
      );
      return;
    }

    const trimmedReason = manualReasonInput.trim();
    if (trimmedReason.length < 3) {
      setManualFormError(
        'Vui lòng nhập lý do nhập mã thủ công (tối thiểu 3 ký tự).'
      );
      return;
    }

    if (!selectedShopId || !selectedWarehouseId) {
      setManualFormError('Vui lòng chọn Shop và Kho đóng gói.');
      return;
    }

    setIsInspecting(true);
    try {
      const res = await inspectTrackingCodeApi({
        shopId: selectedShopId,
        warehouseId: selectedWarehouseId,
        rawCode: manualCodeInput,
        formatHint: 'ManualEntry'
      });

      if (!res.isValid || !res.trackingNumber) {
        setManualFormError(
          res.errorMessage ?? 'Máy chủ từ chối định dạng mã vận đơn nhập tay.'
        );
        return;
      }

      setLastRawCode(manualCodeInput);
      setLastFormatHint('ManualEntry');
      setImportedManualReason(trimmedReason);
      setInspectedCode(res);
      setSelectedImportFile(null);
      setEnqueuedImportSummary(null);
      setIsManualModalOpen(false);
      setManualCodeInput('');
      setManualReasonInput('');
    } catch (err) {
      setManualFormError(
        err instanceof Error
          ? err.message
          : 'Không thể xác thực mã vận đơn thủ công.'
      );
    } finally {
      setIsInspecting(false);
    }
  }, [
    canImportVideo,
    canManualCode,
    manualCodeInput,
    manualReasonInput,
    selectedShopId,
    selectedWarehouseId
  ]);

  const handleSelectImportFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setSessionActionError(null);
      const file = e.target.files?.[0] ?? null;
      if (!file) {
        setSelectedImportFile(null);
        return;
      }

      if (file.size <= 0) {
        setSelectedImportFile(null);
        setSessionActionError('Tệp video được chọn đang rỗng (0 byte).');
        return;
      }

      if (file.size > activeLimits.maxUploadBytes) {
        setSelectedImportFile(null);
        setSessionActionError(
          `Dung lượng tệp vượt quá giới hạn tối đa cho phép (${formatBytes(activeLimits.maxUploadBytes)}).`
        );
        return;
      }

      setSelectedImportFile(file);
    },
    [activeLimits.maxUploadBytes]
  );

  const handleImportVideoSubmit = useCallback(async () => {
    if (
      !canImportVideo ||
      !user?.id ||
      !inspectedCode?.isValid ||
      !inspectedCode.trackingNumber ||
      !selectedImportFile
    ) {
      return;
    }

    if (!selectedShopId || !selectedWarehouseId) {
      setSessionActionError('Vui lòng chọn Shop và Kho trước khi nhập tệp video.');
      return;
    }

    setIsImportingFile(true);
    setSessionActionError(null);
    setImportProgressText('Đang khởi tạo phiên nhập tệp (Imported) trên máy chủ...');

    try {
      const pendingCount = await countPendingLocalRecordingsForUser(user.id);
      if (pendingCount >= activeLimits.maxLocalPendingRecordings) {
        setSessionActionError(
          `Thiết bị đang có ${pendingCount} bản ghi chờ tải lên (tối đa ${activeLimits.maxLocalPendingRecordings}). Vui lòng hoàn tất tải lên trước.`
        );
        return;
      }

      if (scannerRef.current) {
        await scannerRef.current.stopScanner();
      }

      const inferredMime = selectedImportFile.type || 'video/mp4';
      const created = await createVideoImportApi({
        shopId: selectedShopId,
        warehouseId: selectedWarehouseId,
        rawCode: lastRawCode || inspectedCode.trackingNumber,
        formatHint: lastFormatHint,
        isManualEntry: lastFormatHint === 'ManualEntry',
        manualEntryReason:
          lastFormatHint === 'ManualEntry' ? importedManualReason || null : null,
        linkedFromRecordingId: linkedFromRecording?.id ?? null,
        clientMimeType: inferredMime,
        expectedBytes: selectedImportFile.size
      });

      setActiveLimits(created.limits);

      const writer = new SerializedChunkWriter({
        recordingId: created.recording.id,
        ownerUserId: user.id,
        shopId: created.recording.shopId,
        warehouseId: created.recording.warehouseId,
        shopName: created.recording.shopName,
        warehouseName: created.recording.warehouseName,
        trackingNumber: created.recording.trackingNumber,
        carrierCode: created.recording.carrierCode,
        tikTokOrderId: created.recording.tikTokOrderId,
        mimeType: inferredMime
      });

      await writer.init();

      const sliceBytes = 2 * 1024 * 1024;
      let offset = 0;
      const totalBytes = selectedImportFile.size;
      while (offset < totalBytes) {
        const end = Math.min(offset + sliceBytes, totalBytes);
        const chunkBlob = selectedImportFile.slice(offset, end, inferredMime);
        await writer.appendChunk(chunkBlob);
        offset = end;
        setImportProgressText(
          `Đang chuẩn bị dữ liệu tải lên an toàn: ${formatBytes(offset)} / ${formatBytes(totalBytes)}...`
        );
      }

      await writer.finalize('Captured', { durationSeconds: 0 });

      setEnqueuedImportSummary({
        recordingId: created.recording.id,
        trackingNumber: created.recording.trackingNumber,
        fileName: selectedImportFile.name,
        byteSize: selectedImportFile.size
      });
      setSelectedImportFile(null);
      setInspectedCode(null);
      setImportedManualReason('');
      setLinkedFromRecording(null);
      setLinkedFromReasonHint(null);
      if (searchParams.has('linkedFrom') || searchParams.has('reason')) {
        setSearchParams({}, { replace: true });
      }
      debouncerRef.current.reset();
      await refreshPreFlight(created.limits.maxLocalPendingRecordings);
    } catch (err) {
      setSessionActionError(
        err instanceof ApiRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Không thể nhập tệp video có sẵn vào hàng đợi tải lên.'
      );
    } finally {
      setIsImportingFile(false);
      setImportProgressText(null);
    }
  }, [
    activeLimits.maxLocalPendingRecordings,
    canImportVideo,
    importedManualReason,
    inspectedCode,
    lastFormatHint,
    lastRawCode,
    linkedFromRecording?.id,
    refreshPreFlight,
    searchParams,
    selectedImportFile,
    selectedShopId,
    selectedWarehouseId,
    setSearchParams,
    user?.id
  ]);

  const handleCancelBeforeStart = useCallback(async () => {
    if (!activeSession || recorderState.phase !== 'idle') {
      return;
    }

    const sessionId = activeSession.id;
    if (sessionId) {
      try {
        await postRecordingEventApi(sessionId, {
          eventType: 'cancelled',
          reason: 'Người vận hành hủy phiên trước khi bắt đầu quay để quét mã khác.'
        });
      } catch {
        // Best-effort server cancellation before recording started
      }
    }

    controllerRef.current?.reset();
    setActiveSession(null);
    setPendingCreateRequest(null);
    setSessionWarning(null);
    setInspectedCode(null);
    setScanFeedbackError(null);
    debouncerRef.current.reset();
  }, [activeSession, recorderState.phase]);

  const handleStartRecording = useCallback(async () => {
    if (!activeSession || !controllerRef.current) {
      setSessionActionError(
        'Chưa có phiên quay hợp lệ. Vui lòng quét và xác nhận mã vận đơn trước.'
      );
      return;
    }

    setSessionActionError(null);
    setQualityTier('1080p');
    setOrientation('landscape');

    let sessionToStart = activeSession;
    let limitsToUse = activeLimits;

    if (!sessionToStart.id) {
      if (!pendingCreateRequest) {
        setSessionActionError(
          'Chưa có thông tin mã vận đơn để khởi tạo phiên quay. Vui lòng quét lại mã.'
        );
        return;
      }

      try {
        const created = await createRecordingSessionApi(pendingCreateRequest);
        sessionToStart = created.recording;
        limitsToUse = created.limits;
        setActiveSession(created.recording);
        setSessionWarning(created.warningMessage);
        setActiveLimits(created.limits);
      } catch (err) {
        setSessionActionError(
          err instanceof ApiRequestError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Không thể khởi tạo phiên quay trên máy chủ.'
        );
        return;
      }
    }

    try {
      await controllerRef.current.start({
        session: sessionToStart,
        limits: limitsToUse,
        deviceId: selectedCameraDeviceId || undefined,
        enableAudio: enableAudioOptIn && limitsToUse.enableAudioRecording,
        preferredTier: '1080p',
        orientation: 'landscape'
      });
    } catch (err) {
      if (sessionToStart.id) {
        void postRecordingEventApi(sessionToStart.id, {
          eventType: 'cancelled',
          reason: 'Không thể khởi động camera ghi hình.'
        }).catch(() => undefined);
        setActiveSession((prev) => (prev ? { ...prev, id: '' } : null));
      }
      setSessionActionError(
        err instanceof Error
          ? err.message
          : 'Không thể khởi động camera ghi hình.'
      );
    }
  }, [
    activeLimits,
    activeSession,
    enableAudioOptIn,
    pendingCreateRequest,
    selectedCameraDeviceId
  ]);

  const handleStopRecording = useCallback(async () => {
    if (!controllerRef.current) {
      return;
    }
    await controllerRef.current.stop();
  }, []);

  const handleToggleRecordingTorch = useCallback(async () => {
    const next = !recordingTorchEnabled;
    const applied = await setTrackTorch(activeRecordingStreamRef.current, next);
    setRecordingTorchEnabled(applied);
  }, [recordingTorchEnabled]);

  const handlePrepareNextOrder = useCallback(
    async (relinkWrongCodeSession?: RecordingDto | null) => {
      controllerRef.current?.reset();
      if (previewVideoRef.current) {
        previewVideoRef.current.srcObject = null;
      }

      setActiveSession(null);
      setPendingCreateRequest(null);
      setSessionWarning(null);
      setInspectedCode(null);
      setLastRawCode('');
      setScanFeedbackError(null);
      setSessionActionError(null);
      setLinkedFromRecording(relinkWrongCodeSession ?? null);
      debouncerRef.current.reset();

      if (user?.id) {
        const count = await countPendingLocalRecordingsForUser(user.id);
        await refreshPreFlight(
          Math.max(activeLimits.maxLocalPendingRecordings, count > 0 ? activeLimits.maxLocalPendingRecordings : 3)
        );
      }
    },
    [activeLimits.maxLocalPendingRecordings, refreshPreFlight, user?.id]
  );

  const isScannerEnabled =
    !activeSession &&
    !isManualModalOpen &&
    Boolean(selectedShopId && selectedWarehouseId) &&
    (preFlight?.canRecord ?? false);

  const canScanNextAfterFinish =
    (preFlight?.pendingLocalCount ?? 0) < activeLimits.maxLocalPendingRecordings;

  // Notify AppLayout so Mobile Bottom Navigation auto-hides while actively recording
  useEffect(() => {
    const isActivelyRecording =
      recorderState.phase === 'starting' ||
      recorderState.phase === 'recording' ||
      recorderState.phase === 'finalizing';
    window.dispatchEvent(
      new CustomEvent(RECORDING_ACTIVE_UI_EVENT, {
        detail: { active: isActivelyRecording }
      })
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent(RECORDING_ACTIVE_UI_EVENT, {
          detail: { active: false }
        })
      );
    };
  }, [recorderState.phase]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <RecordingContextBar
        preFlight={preFlight}
        activeLimits={activeLimits}
        crashedSessionsNotice={crashedSessionsNotice}
        activeSession={activeSession}
        shops={shops}
        availableWarehouses={availableWarehouses}
        selectedShopId={selectedShopId}
        selectedWarehouseId={selectedWarehouseId}
        isLoadingShops={isLoadingShops}
        shopsError={shopsError}
        onShopChange={handleShopChange}
        onWarehouseChange={handleWarehouseChange}
      />

      {/* STEP 1: SCAN TRACKING CODE & CONFIRM */}
      {!activeSession && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs sm:p-5">
          {linkedFromRecording && (
            <div
              className="mb-4 flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 p-3.5 text-sm text-blue-900"
              role="status"
              data-testid="linked-from-banner"
            >
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" aria-hidden="true" />
              <div>
                <div>
                  Đang tạo phiên quay mới để thay thế cho video nhầm mã trước đó (mã cũ vẫn giữ
                  nguyên: <strong className="font-mono">{linkedFromRecording.trackingNumber}</strong>
                  ).
                </div>
                {linkedFromReasonHint && (
                  <div className="mt-1 text-xs text-blue-800">
                    Ghi chú đối chiếu: <strong>{linkedFromReasonHint}</strong>
                  </div>
                )}
              </div>
            </div>
          )}

          {enqueuedImportSummary && (
            <div
              className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"
              role="status"
              data-testid="import-enqueued-banner"
            >
              <div className="flex items-start gap-2.5">
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                  aria-hidden="true"
                />
                <div>
                  <strong>Đã đưa tệp video có sẵn vào hàng đợi gửi lên hệ thống:</strong> Mã vận
                  đơn <strong className="mono-code">{enqueuedImportSummary.trackingNumber}</strong>{' '}
                  • Tệp: <strong>{enqueuedImportSummary.fileName}</strong> (
                  {formatBytes(enqueuedImportSummary.byteSize)}).
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  to="/uploads"
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white no-underline hover:bg-slate-800"
                >
                  <CloudUpload className="h-4 w-4" aria-hidden="true" />
                  <span>Theo dõi tiến trình tải lên</span>
                </Link>
                <button
                  type="button"
                  className="inline-flex min-h-10 cursor-pointer items-center rounded-xl border border-emerald-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-emerald-100/50"
                  onClick={() => setEnqueuedImportSummary(null)}
                >
                  Đóng thông báo
                </button>
              </div>
            </div>
          )}

          {preFlight?.canRecord && selectedShopId && selectedWarehouseId && (
            <ScannerView
              ref={scannerRef}
              enabled={isScannerEnabled}
              selectedDeviceId={selectedCameraDeviceId}
              onSelectedDeviceIdChange={setSelectedCameraDeviceId}
              onDecoded={(evt) => void handleScannerDecoded(evt)}
              scannerAdapter={scannerAdapter}
            />
          )}

          {isInspecting && (
            <div
              className="mt-3 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm font-medium text-blue-900"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin shrink-0 text-blue-600" aria-hidden="true" />
              <span>Đang kiểm tra mã vận đơn...</span>
            </div>
          )}

          {scanFeedbackError && (
            <div
              className="mt-3 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm font-medium text-red-900"
              role="alert"
              data-testid="scan-error-banner"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              <span>{scanFeedbackError}</span>
            </div>
          )}

          {inspectedCode?.isValid && inspectedCode.trackingNumber && (
            <TrackingConfirmCard
              inspectedCode={inspectedCode}
              canCreateLiveRecording={canCreateLiveRecording}
              canImportVideo={canImportVideo}
              canRecordPreFlight={preFlight?.canRecord ?? false}
              isCreatingSession={isCreatingSession}
              isImportingFile={isImportingFile}
              activeLimits={activeLimits}
              selectedImportFile={selectedImportFile}
              importProgressText={importProgressText}
              onConfirmAndCreateSession={() => void handleConfirmAndCreateSession()}
              onRescanOtherCode={() => {
                setInspectedCode(null);
                setSelectedImportFile(null);
                setImportedManualReason('');
                setScanFeedbackError(null);
                debouncerRef.current.reset();
              }}
              onSelectImportFile={handleSelectImportFile}
              onImportVideoSubmit={() => void handleImportVideoSubmit()}
            />
          )}

          {sessionActionError && (
            <div
              className="mt-3 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-900"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
              <span>{sessionActionError}</span>
            </div>
          )}

          {canManualCode && (
            <div className="mt-4">
              <button
                type="button"
                className="inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  setManualFormError(null);
                  setIsManualModalOpen(true);
                }}
                disabled={!(preFlight?.canRecord ?? false)}
              >
                <Keyboard className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                <span>Nhập mã vận đơn thủ công</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* STEP 2: LOCKED SESSION & DARK CAMERA HUD */}
      {activeSession && (
        <CameraHudStage
          activeSession={activeSession}
          activeLimits={activeLimits}
          recorderState={recorderState}
          sessionWarning={sessionWarning}
          sessionActionError={sessionActionError}
          orientation={orientation}
          qualityTier={qualityTier}
          enableAudioOptIn={enableAudioOptIn}
          recordingTorchSupported={recordingTorchSupported}
          recordingTorchEnabled={recordingTorchEnabled}
          canScanNextAfterFinish={canScanNextAfterFinish}
          previewVideoRef={previewVideoRef}
          onQualityTierChange={setQualityTier}
          onOrientationChange={setOrientation}
          onEnableAudioChange={setEnableAudioOptIn}
          onStartRecording={() => void handleStartRecording()}
          onStopRecording={() => void handleStopRecording()}
          onCancelBeforeStart={() => void handleCancelBeforeStart()}
          onToggleRecordingTorch={() => void handleToggleRecordingTorch()}
          onPrepareNextOrder={(relink) => void handlePrepareNextOrder(relink)}
        />
      )}

      {/* MANUAL TRACKING CODE ENTRY MODAL */}
      {canManualCode && isManualModalOpen && (
        <ManualTrackingModal
          manualCodeInput={manualCodeInput}
          manualReasonInput={manualReasonInput}
          manualFormError={manualFormError}
          canCreateLiveRecording={canCreateLiveRecording}
          canImportVideo={canImportVideo}
          isCreatingSession={isCreatingSession}
          isInspecting={isInspecting}
          onManualCodeChange={setManualCodeInput}
          onManualReasonChange={setManualReasonInput}
          onClose={() => setIsManualModalOpen(false)}
          onSubmitLiveSession={(e) => void handleManualEntrySubmit(e)}
          onUseForImport={() => void handleUseManualCodeForImport()}
        />
      )}
    </div>
  );
}

