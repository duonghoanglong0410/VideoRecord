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
import { ApiRequestError } from '../../app/apiClient';
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
  type AcquiredRecordingStream,
  type RecordingPreFlightReport
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
import { useWakeLock } from './useWakeLock';

export type RecordingOrientationChoice = 'portrait' | 'landscape';

export interface RecordingPageProps {
  scannerAdapter?: ScannerAdapter;
  acquireRecordingStreamOverride?: (opts: {
    deviceId?: string;
    enableAudio?: boolean;
  }) => Promise<AcquiredRecordingStream>;
  recorderTimesliceMs?: number;
  recorderTimerIntervalMs?: number;
}

function formatDurationClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
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
  const debouncerRef = useRef<DuplicateScanDebouncer>(new DuplicateScanDebouncer(2500));
  const controllerRef = useRef<RecorderController | null>(null);

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
  const [sessionWarning, setSessionWarning] = useState<string | null>(null);
  const [activeLimits, setActiveLimits] =
    useState<RecordingRuntimeLimits>(defaultLimits);
  const [isCreatingSession, setIsCreatingSession] = useState<boolean>(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);

  const [orientation, setOrientation] =
    useState<RecordingOrientationChoice>('portrait');
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

  const wakeLock = useWakeLock(recorderState.phase === 'recording');

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
        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = stream;
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

      // Stop ZXing scanner cleanly before creating & entering recording session!
      if (scannerRef.current) {
        await scannerRef.current.stopScanner();
      }

      const created = await createRecordingSessionApi({
        shopId: selectedShopId,
        warehouseId: selectedWarehouseId,
        rawCode: lastRawCode || inspectedCode.trackingNumber,
        formatHint: lastFormatHint,
        isManualEntry: false,
        linkedFromRecordingId: linkedFromRecording?.id ?? null
      });

      setActiveSession(created.recording);
      setSessionWarning(created.warningMessage);
      setActiveLimits(created.limits);
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
            : 'Không thể tạo phiên quay mới trên máy chủ.'
      );
    } finally {
      setIsCreatingSession(false);
    }
  }, [
    inspectedCode,
    lastFormatHint,
    lastRawCode,
    linkedFromRecording?.id,
    refreshPreFlight,
    searchParams,
    selectedShopId,
    selectedWarehouseId,
    setSearchParams
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

        if (scannerRef.current) {
          await scannerRef.current.stopScanner();
        }

        const created = await createRecordingSessionApi({
          shopId: selectedShopId,
          warehouseId: selectedWarehouseId,
          rawCode: manualCodeInput,
          formatHint: 'ManualEntry',
          isManualEntry: true,
          manualEntryReason: trimmedReason,
          linkedFromRecordingId: linkedFromRecording?.id ?? null
        });

        setIsManualModalOpen(false);
        setManualCodeInput('');
        setManualReasonInput('');
        setActiveSession(created.recording);
        setSessionWarning(created.warningMessage);
        setActiveLimits(created.limits);
        setLinkedFromRecording(null);
        setLinkedFromReasonHint(null);
        if (searchParams.has('linkedFrom') || searchParams.has('reason')) {
          setSearchParams({}, { replace: true });
        }
      } catch (err) {
        setManualFormError(
          err instanceof Error
            ? err.message
            : 'Không thể tạo phiên quay bằng mã thủ công.'
        );
      } finally {
        setIsCreatingSession(false);
      }
    },
    [
      canManualCode,
      linkedFromRecording?.id,
      manualCodeInput,
      manualReasonInput,
      refreshPreFlight,
      searchParams,
      selectedShopId,
      selectedWarehouseId,
      setSearchParams
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
    try {
      await postRecordingEventApi(sessionId, {
        eventType: 'cancelled',
        reason: 'Người vận hành hủy phiên trước khi bắt đầu quay để quét mã khác.'
      });
    } catch {
      // Best-effort server cancellation before recording started
    }

    controllerRef.current?.reset();
    setActiveSession(null);
    setSessionWarning(null);
    setInspectedCode(null);
    setScanFeedbackError(null);
    debouncerRef.current.reset();
  }, [activeSession, recorderState.phase]);

  const handleStartRecording = useCallback(async () => {
    if (!activeSession?.id || !controllerRef.current) {
      setSessionActionError(
        'Chưa có phiên quay hợp lệ từ máy chủ. Vui lòng quét và xác nhận mã vận đơn trước.'
      );
      return;
    }

    setSessionActionError(null);
    try {
      await controllerRef.current.start({
        session: activeSession,
        limits: activeLimits,
        deviceId: selectedCameraDeviceId || undefined,
        enableAudio: enableAudioOptIn && activeLimits.enableAudioRecording
      });
    } catch (err) {
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
    selectedCameraDeviceId
  ]);

  const handleStopRecording = useCallback(async () => {
    if (!controllerRef.current) {
      return;
    }
    await controllerRef.current.stop();
  }, []);

  const handlePrepareNextOrder = useCallback(
    async (relinkWrongCodeSession?: RecordingDto | null) => {
      controllerRef.current?.reset();
      if (previewVideoRef.current) {
        previewVideoRef.current.srcObject = null;
      }

      setActiveSession(null);
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

  return (
    <div className="recording-page">
      <div className="surface-card">
        <div className="recording-header-row">
          <div>
            <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Quay đóng gói đơn hàng</h1>
            <p
              style={{
                margin: '4px 0 0',
                fontSize: '0.9rem',
                color: 'var(--color-text-muted)'
              }}
            >
              Quét mã vận đơn trên tem đơn TikTok, xác nhận phiên và ghi hình quá trình đóng gói.
            </p>
          </div>

          <Link to="/uploads" className="btn btn-outline">
            Hàng đợi ({preFlight?.pendingLocalCount ?? 0}/
            {activeLimits.maxLocalPendingRecordings})
          </Link>
        </div>

        {crashedSessionsNotice.length > 0 && (
          <div
            className="alert alert-warning"
            role="alert"
            style={{ marginTop: 14, marginBottom: 0 }}
          >
            <strong>Phát hiện phiên quay trước bị dừng đột ngột:</strong> Hệ thống đã chuyển{' '}
            {crashedSessionsNotice.length} phiên đang dở dang (mã:{' '}
            <strong>
              {crashedSessionsNotice.map((s) => s.trackingNumber).join(', ')}
            </strong>
            ) sang trạng thái <strong>Bị gián đoạn</strong>. Không thể đảm bảo video hoàn chỉnh
            cho đến khi kiểm tra lại — vui lòng xem tại{' '}
            <Link to="/uploads" style={{ fontWeight: 700, color: 'inherit' }}>
              Hàng đợi tải lên
            </Link>
            .
          </div>
        )}

        {preFlight && !preFlight.canRecord && !activeSession && (
          <div
            className="alert alert-error"
            role="alert"
            data-testid="preflight-blocking-error"
            style={{ marginTop: 14, marginBottom: 0 }}
          >
            <div>
              <strong>Không thể bắt đầu phiên quay mới:</strong> {preFlight.blockingError}
            </div>
            {preFlight.pendingLocalCount >= preFlight.maxLocalPendingRecordings && (
              <div style={{ marginTop: 10 }}>
                <Link to="/uploads" className="btn btn-navy">
                  Mở Hàng đợi tải lên ({preFlight.pendingLocalCount})
                </Link>
              </div>
            )}
          </div>
        )}

        {preFlight &&
          preFlight.warnings.map((w, idx) => (
            <div
              key={idx}
              className="alert alert-warning"
              style={{ marginTop: 12, marginBottom: 0 }}
            >
              {w}
            </div>
          ))}
      </div>

      {/* STEP 1: SELECT SHOP/WAREHOUSE & SCAN TRACKING CODE */}
      {!activeSession && (
        <div className="surface-card">
          <div className="shop-warehouse-grid">
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="recording-shop-select" className="form-label">
                Shop vận hành
              </label>
              <select
                id="recording-shop-select"
                className="form-input"
                value={selectedShopId}
                disabled={isLoadingShops || shops.length === 0}
                onChange={(e) => handleShopChange(e.target.value)}
              >
                {shops.length === 0 && <option value="">Chưa có Shop khả dụng</option>}
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="recording-warehouse-select" className="form-label">
                Kho đóng gói
              </label>
              <select
                id="recording-warehouse-select"
                className="form-input"
                value={selectedWarehouseId}
                disabled={isLoadingShops || availableWarehouses.length === 0}
                onChange={(e) => handleWarehouseChange(e.target.value)}
              >
                {availableWarehouses.length === 0 && (
                  <option value="">Chưa có Kho khả dụng</option>
                )}
                {availableWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.code})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {shopsError && (
            <div className="alert alert-error" role="alert" style={{ marginTop: 12 }}>
              {shopsError}
            </div>
          )}

          {linkedFromRecording && (
            <div
              className="alert alert-info"
              role="status"
              data-testid="linked-from-banner"
              style={{ marginTop: 14, marginBottom: 0 }}
            >
              <div>
                Đang tạo phiên quay mới để thay thế cho phiên nhầm mã trước đó (mã cũ vẫn giữ bất
                biến: <strong>{linkedFromRecording.trackingNumber}</strong>).
              </div>
              {linkedFromReasonHint && (
                <div style={{ marginTop: 4, fontSize: '0.86rem' }}>
                  Ghi chú đối chiếu: <strong>{linkedFromReasonHint}</strong>
                </div>
              )}
            </div>
          )}

          {enqueuedImportSummary && (
            <div
              className="alert alert-success"
              role="status"
              data-testid="import-enqueued-banner"
              style={{ marginTop: 14, marginBottom: 0 }}
            >
              <div>
                <strong>Đã tạo phiên nhập tệp (Imported) &amp; đưa vào hàng đợi tải lên (tus):</strong>{' '}
                Mã vận đơn <strong className="mono-code">{enqueuedImportSummary.trackingNumber}</strong>{' '}
                • Tệp: <strong>{enqueuedImportSummary.fileName}</strong> (
                {formatBytes(enqueuedImportSummary.byteSize)}).
              </div>
              <div className="quick-actions-row" style={{ marginTop: 10 }}>
                <Link to="/uploads" className="btn btn-navy">
                  Theo dõi tiến trình tải lên
                </Link>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setEnqueuedImportSummary(null)}
                >
                  Đóng thông báo
                </button>
              </div>
            </div>
          )}

          {preFlight?.canRecord && selectedShopId && selectedWarehouseId && (
            <div style={{ marginTop: 16 }}>
              <ScannerView
                ref={scannerRef}
                enabled={isScannerEnabled}
                selectedDeviceId={selectedCameraDeviceId}
                onSelectedDeviceIdChange={setSelectedCameraDeviceId}
                onDecoded={(evt) => void handleScannerDecoded(evt)}
                scannerAdapter={scannerAdapter}
              />
            </div>
          )}

          {isInspecting && (
            <div className="alert alert-info" role="status" style={{ marginTop: 12 }}>
              Đang kiểm tra mã vận đơn với máy chủ...
            </div>
          )}

          {scanFeedbackError && (
            <div
              className="alert alert-error"
              role="alert"
              data-testid="scan-error-banner"
              style={{ marginTop: 12 }}
            >
              {scanFeedbackError}
            </div>
          )}

          {inspectedCode?.isValid && inspectedCode.trackingNumber && (
            <div
              className="tracking-confirm-banner"
              data-testid="recognized-tracking-banner"
            >
              <div className="tracking-confirm-label">Mã vận đơn đã nhận diện</div>
              <div className="tracking-confirm-value">
                {inspectedCode.trackingNumber}
              </div>

              {(inspectedCode.carrierCode || inspectedCode.tikTokOrderId) && (
                <div className="tracking-meta-chips">
                  {inspectedCode.carrierCode && (
                    <span className="meta-chip">
                      ĐVVC: {inspectedCode.carrierCode}
                    </span>
                  )}
                  {inspectedCode.tikTokOrderId && (
                    <span className="meta-chip">
                      Mã đơn TikTok (tách biệt): {inspectedCode.tikTokOrderId}
                    </span>
                  )}
                </div>
              )}

              {inspectedCode.existingRecordingCount > 0 && (
                <div
                  className="alert alert-warning"
                  role="status"
                  data-testid="duplicate-recording-warning"
                  style={{ marginTop: 12, marginBottom: 0 }}
                >
                  <strong>Đã có {inspectedCode.existingRecordingCount} phiên quay trước đó:</strong>{' '}
                  {inspectedCode.warningMessage}
                </div>
              )}

              <div className="tracking-confirm-actions">
                {canCreateLiveRecording && (
                  <button
                    type="button"
                    className="btn btn-primary btn-full"
                    onClick={() => void handleConfirmAndCreateSession()}
                    disabled={
                      isCreatingSession ||
                      isImportingFile ||
                      !(preFlight?.canRecord ?? false)
                    }
                  >
                    {isCreatingSession
                      ? 'Đang tạo phiên quay...'
                      : 'Xác nhận mã & Tạo phiên quay'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-outline btn-full"
                  onClick={() => {
                    setInspectedCode(null);
                    setSelectedImportFile(null);
                    setImportedManualReason('');
                    setScanFeedbackError(null);
                    debouncerRef.current.reset();
                  }}
                  disabled={isCreatingSession || isImportingFile}
                >
                  Quét lại mã khác
                </button>
              </div>

              {canImportVideo && (
                <div className="import-panel-box" data-testid="video-import-panel">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      flexWrap: 'wrap',
                      marginBottom: 8
                    }}
                  >
                    <strong style={{ color: 'var(--color-navy)' }}>
                      Nhập tệp video có sẵn
                    </strong>
                    <span className="status-pill status-pill-starting">
                      Nguồn: Tải tệp có sẵn (Imported)
                    </span>
                  </div>
                  <p
                    style={{
                      margin: '0 0 10px',
                      fontSize: '0.86rem',
                      color: 'var(--color-text-muted)'
                    }}
                  >
                    Dành cho tệp video đóng gói được quay dự phòng bên ngoài trình duyệt. Video sẽ
                    được gắn nhãn <strong>Imported</strong> rõ ràng trong thư viện &amp; nhật ký
                    kiểm toán, kiểm tra codec bằng máy chủ và tải lên qua giao thức tus (tối đa{' '}
                    {formatBytes(activeLimits.maxUploadBytes)}).
                  </p>

                  <div className="form-group" style={{ marginBottom: 10 }}>
                    <label htmlFor="video-import-file-input" className="form-label">
                      Chọn tệp video đóng gói (.mp4, .webm, .mov)
                    </label>
                    <input
                      id="video-import-file-input"
                      type="file"
                      className="form-input"
                      accept="video/mp4,video/webm,video/quicktime,video/*"
                      onChange={handleSelectImportFile}
                      disabled={isImportingFile || isCreatingSession}
                    />
                  </div>

                  {selectedImportFile && (
                    <div
                      style={{
                        fontSize: '0.86rem',
                        marginBottom: 10,
                        color: 'var(--color-navy)'
                      }}
                    >
                      Tệp đã chọn: <strong>{selectedImportFile.name}</strong> (
                      {formatBytes(selectedImportFile.size)})
                    </div>
                  )}

                  {importProgressText && (
                    <div className="alert alert-info" role="status" style={{ marginBottom: 10 }}>
                      {importProgressText}
                    </div>
                  )}

                  <button
                    type="button"
                    className="btn btn-navy btn-full"
                    onClick={() => void handleImportVideoSubmit()}
                    disabled={
                      !selectedImportFile || isImportingFile || isCreatingSession
                    }
                  >
                    {isImportingFile
                      ? 'Đang đưa tệp vào hàng đợi tải lên...'
                      : 'Xác nhận mã & Nhập tệp video có sẵn'}
                  </button>
                </div>
              )}
            </div>
          )}

          {sessionActionError && (
            <div className="alert alert-error" role="alert" style={{ marginTop: 12 }}>
              {sessionActionError}
            </div>
          )}

          {canManualCode && (
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-outline btn-full"
                onClick={() => {
                  setManualFormError(null);
                  setIsManualModalOpen(true);
                }}
                disabled={!(preFlight?.canRecord ?? false)}
              >
                Nhập mã vận đơn thủ công (Có ghi nhật ký)
              </button>
            </div>
          )}
        </div>
      )}

      {/* STEP 2: LOCKED SESSION & RECORDING VIEWPORT */}
      {activeSession && (
        <div
          className={`surface-card recording-stage recording-stage-${orientation}`}
          data-testid="recording-session-stage"
        >
          <div className="locked-tracking-bar">
            <div>
              <span className="locked-tracking-caption">
                Mã vận đơn đã khóa cho phiên quay
              </span>
              <div
                className="locked-tracking-code"
                data-testid="locked-tracking-number"
              >
                {activeSession.trackingNumber}
              </div>
              <div className="locked-tracking-sub">
                {activeSession.shopName} • {activeSession.warehouseName}
              </div>
            </div>

            <div>
              {recorderState.phase === 'idle' && (
                <span className="status-pill status-pill-ready">Sẵn sàng quay</span>
              )}
              {recorderState.phase === 'starting' && (
                <span className="status-pill status-pill-starting">
                  Đang mở máy quay...
                </span>
              )}
              {recorderState.phase === 'recording' && (
                <span
                  className="status-pill status-pill-recording"
                  data-testid="recording-active-badge"
                >
                  <span className="recording-pulse-dot" aria-hidden="true" />
                  Đang quay
                </span>
              )}
              {recorderState.phase === 'finalizing' && (
                <span className="status-pill status-pill-starting">
                  Đang lưu dữ liệu cuối...
                </span>
              )}
              {recorderState.phase === 'completed' && (
                <span className="status-pill status-pill-completed">
                  Đã lưu tạm hoàn tất
                </span>
              )}
              {recorderState.phase === 'interrupted' && (
                <span className="status-pill status-pill-interrupted">
                  Bị gián đoạn
                </span>
              )}
            </div>
          </div>

          {sessionWarning && recorderState.phase === 'idle' && (
            <div className="alert alert-warning" style={{ marginTop: 12 }}>
              {sessionWarning}
            </div>
          )}

          {/* Orientation & Optional Audio Pre-Recording Controls */}
          {recorderState.phase === 'idle' && (
            <div className="pre-record-options">
              <div>
                <div className="form-label">Chọn hướng khung hình trước khi quay</div>
                <div className="orientation-toggle-group" role="group" aria-label="Chọn hướng quay">
                  <button
                    type="button"
                    className={`btn ${
                      orientation === 'portrait' ? 'btn-navy' : 'btn-outline'
                    }`}
                    onClick={() => setOrientation('portrait')}
                    aria-pressed={orientation === 'portrait'}
                  >
                    Khung dọc (Điện thoại đứng)
                  </button>
                  <button
                    type="button"
                    className={`btn ${
                      orientation === 'landscape' ? 'btn-navy' : 'btn-outline'
                    }`}
                    onClick={() => setOrientation('landscape')}
                    aria-pressed={orientation === 'landscape'}
                  >
                    Khung ngang (Góc bàn rộng)
                  </button>
                </div>
                <p
                  style={{
                    margin: '6px 0 0',
                    fontSize: '0.84rem',
                    color: 'var(--color-text-muted)'
                  }}
                >
                  Cố định hướng điện thoại trước khi bấm Bắt đầu quay để khung hình video ổn định.
                </p>
              </div>

              {activeLimits.enableAudioRecording && (
                <label className="audio-optin-row">
                  <input
                    type="checkbox"
                    checked={enableAudioOptIn}
                    onChange={(e) => setEnableAudioOptIn(e.target.checked)}
                  />
                  <span>
                    Thu kèm âm thanh microphone (nếu thiếu quyền mic sẽ tự động quay không tiếng)
                  </span>
                </label>
              )}
            </div>
          )}

          {/* Live Recording Video Viewport (shown while starting, recording, finalizing, or idle) */}
          {(recorderState.phase === 'idle' ||
            recorderState.phase === 'starting' ||
            recorderState.phase === 'recording' ||
            recorderState.phase === 'finalizing' ||
            recorderState.phase === 'error') && (
            <div
              className={`camera-viewport camera-viewport-${orientation}`}
              style={{ marginTop: 12 }}
            >
              <video
                ref={previewVideoRef}
                className="camera-video"
                muted
                playsInline
                autoPlay
                aria-label="Khung hình ghi video đóng gói"
              />

              {recorderState.phase === 'idle' && (
                <div className="camera-overlay-msg">
                  Phiên đã tạo sẵn sàng. Bấm &ldquo;Bắt đầu quay&rdquo; để mở camera ghi hình.
                </div>
              )}

              {recorderState.phase === 'starting' && (
                <div className="camera-overlay-msg" role="status">
                  Đang khởi động luồng camera và bộ ghi hình...
                </div>
              )}

              {recorderState.phase === 'recording' && (
                <div className="recording-hud">
                  <div className="recording-hud-metrics">
                    <span data-testid="recording-timer">
                      Thời lượng: {formatDurationClock(recorderState.elapsedSeconds)} /{' '}
                      {formatDurationClock(activeLimits.maxRecordingSeconds)}
                    </span>
                    <span data-testid="recording-bytes">
                      Đã lưu tạm: {formatBytes(recorderState.committedBytes)}
                    </span>
                  </div>
                  <div className="recording-keep-open-reminder">
                    Giữ trang này đang mở trong khi quay
                  </div>
                </div>
              )}
            </div>
          )}

          {recorderState.phase === 'recording' && (
            <div className="wakelock-status-bar" data-testid="wakelock-status">
              {wakeLock.statusLabel}
            </div>
          )}

          {recorderState.audioFallbackWarning && (
            <div className="alert alert-warning" style={{ marginTop: 12 }}>
              {recorderState.audioFallbackWarning}
            </div>
          )}

          {recorderState.limitWarningMessage &&
            recorderState.phase === 'recording' && (
              <div className="alert alert-warning" role="alert" style={{ marginTop: 12 }}>
                {recorderState.limitWarningMessage}
              </div>
            )}

          {sessionActionError && (
            <div className="alert alert-error" role="alert" style={{ marginTop: 12 }}>
              {sessionActionError}
            </div>
          )}

          {/* Action Controls per State */}
          {recorderState.phase === 'idle' || recorderState.phase === 'error' ? (
            <div className="recording-primary-controls">
              <button
                type="button"
                className="btn btn-primary btn-record-start"
                onClick={() => void handleStartRecording()}
              >
                Bắt đầu quay đóng gói
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => void handleCancelBeforeStart()}
              >
                Hủy phiên & Quét mã khác
              </button>
            </div>
          ) : null}

          {recorderState.phase === 'recording' && (
            <div className="recording-primary-controls">
              <button
                type="button"
                className="btn btn-danger btn-record-stop"
                onClick={() => void handleStopRecording()}
              >
                Kết thúc & Lưu video
              </button>
            </div>
          )}

          {recorderState.phase === 'finalizing' && (
            <div className="alert alert-info" role="status" style={{ marginTop: 14, marginBottom: 0 }}>
              Đang chờ ghi hoàn tất chunk cuối cùng vào bộ nhớ thiết bị (IndexedDB)...
            </div>
          )}

          {/* Interrupted Outcome */}
          {recorderState.phase === 'interrupted' && (
            <div
              className="alert alert-error"
              role="alert"
              data-testid="recording-interrupted-banner"
              style={{ marginTop: 14, marginBottom: 0 }}
            >
              <h2 style={{ margin: '0 0 6px', fontSize: '1.08rem' }}>
                Phiên quay đã bị gián đoạn
              </h2>
              <p style={{ margin: '0 0 8px' }}>
                {recorderState.interruptionMessage ??
                  'Quá trình ghi hình bị dừng bất thường. Hệ thống không gắn nhãn video hoàn chỉnh cho phiên bị gián đoạn.'}
              </p>
              <div style={{ fontSize: '0.88rem' }}>
                Thời điểm dừng: <strong>{formatDurationClock(recorderState.elapsedSeconds)}</strong>{' '}
                • Dữ liệu kịp lưu tạm:{' '}
                <strong>
                  {formatBytes(recorderState.committedBytes)} ({recorderState.committedChunks}{' '}
                  phần)
                </strong>
              </div>

              <div className="recording-summary-actions">
                {canScanNextAfterFinish && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handlePrepareNextOrder(null)}
                  >
                    Quay lại kiện hàng mới
                  </button>
                )}
                <Link to="/uploads" className="btn btn-navy">
                  Kiểm tra Hàng đợi tải lên
                </Link>
              </div>
            </div>
          )}

          {/* Normal Completed Outcome */}
          {recorderState.phase === 'completed' && (
            <div
              className="alert alert-success"
              role="status"
              data-testid="recording-completed-banner"
              style={{ marginTop: 14, marginBottom: 0 }}
            >
              <h2 style={{ margin: '0 0 6px', fontSize: '1.08rem' }}>
                Đã lưu tạm video vào thiết bị — Sẵn sàng tải lên
              </h2>
              {recorderState.autoStopReason && (
                <p style={{ margin: '0 0 8px', fontWeight: 600 }}>
                  {recorderState.autoStopReason}
                </p>
              )}
              <div style={{ fontSize: '0.9rem' }}>
                Mã vận đơn: <strong>{activeSession.trackingNumber}</strong> • Thời lượng:{' '}
                <strong>{formatDurationClock(recorderState.elapsedSeconds)}</strong> • Dung lượng
                thực tế:{' '}
                <strong>
                  {formatBytes(recorderState.committedBytes)} ({recorderState.committedChunks}{' '}
                  chunks)
                </strong>
              </div>
              <p style={{ margin: '8px 0 0', fontSize: '0.85rem' }}>
                Dữ liệu gốc được giữ an toàn trong IndexedDB của tài khoản{' '}
                <strong>{user?.email}</strong> và chỉ tự động dọn sau khi máy chủ xác nhận đã lưu
                vào vùng lưu trữ.
              </p>

              <div className="recording-summary-actions">
                {canScanNextAfterFinish ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handlePrepareNextOrder(null)}
                  >
                    Quét & Quay đơn tiếp theo
                  </button>
                ) : (
                  <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                    Đã đạt giới hạn {activeLimits.maxLocalPendingRecordings} bản ghi chờ trên thiết
                    bị — vui lòng hoàn tất tải lên trước khi quay tiếp.
                  </span>
                )}

                {canScanNextAfterFinish && (
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => void handlePrepareNextOrder(activeSession)}
                  >
                    Quay lại do nhầm mã vận đơn
                  </button>
                )}

                <Link to="/uploads" className="btn btn-navy">
                  Xem Hàng đợi tải lên
                </Link>
              </div>
            </div>
          )}
        </div>
      )}

      {/* MANUAL TRACKING CODE ENTRY MODAL (ONLY WHEN USER HAS recording.manual_code) */}
      {canManualCode && isManualModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-code-modal-title"
          >
            <h2
              id="manual-code-modal-title"
              style={{ marginTop: 0, fontSize: '1.16rem' }}
            >
              Nhập mã vận đơn thủ công
            </h2>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.88rem' }}>
              Chỉ sử dụng khi tem nhiệt bị rách/mờ không thể quét bằng camera. Thao tác này sẽ lưu
              vào nhật ký kiểm toán (Audit Log).
            </p>

            <form onSubmit={(e) => void handleManualEntrySubmit(e)}>
              <div className="form-group">
                <label htmlFor="manual-tracking-input" className="form-label">
                  Mã vận đơn (giữ nguyên số 0 ở đầu và chữ hoa/thường)
                </label>
                <input
                  id="manual-tracking-input"
                  type="text"
                  className="form-input"
                  value={manualCodeInput}
                  onChange={(e) => setManualCodeInput(e.target.value)}
                  maxLength={128}
                  autoComplete="off"
                  placeholder="Ví dụ: 00123456789 hoặc SPXVN048192"
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="manual-reason-input" className="form-label">
                  Lý do nhập mã thủ công (bắt buộc)
                </label>
                <textarea
                  id="manual-reason-input"
                  className="form-input"
                  rows={3}
                  value={manualReasonInput}
                  onChange={(e) => setManualReasonInput(e.target.value)}
                  maxLength={500}
                  placeholder="Ví dụ: Tem in nhiệt bị mờ vạch giữa, không quét được camera"
                  required
                />
              </div>

              {manualFormError && (
                <div className="alert alert-error" role="alert">
                  {manualFormError}
                </div>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setIsManualModalOpen(false)}
                  disabled={isCreatingSession || isInspecting}
                >
                  Đóng
                </button>
                {canImportVideo && (
                  <button
                    type="button"
                    className="btn btn-navy"
                    onClick={() => void handleUseManualCodeForImport()}
                    disabled={isCreatingSession || isInspecting}
                  >
                    Dùng mã này để nhập tệp có sẵn
                  </button>
                )}
                {canCreateLiveRecording && (
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={isCreatingSession || isInspecting}
                  >
                    {isCreatingSession
                      ? 'Đang tạo phiên...'
                      : 'Xác nhận & Tạo phiên quay'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

