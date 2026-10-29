import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { useAuth } from '../../app/authStore';
import { LOCAL_QUEUE_UPDATED_EVENT } from './db/packingProofIdb';
import {
  TusQueueManager,
  type TusQueueSnapshot
} from './tusQueueManager';

export interface TusUploadQueueContextValue extends TusQueueSnapshot {
  refreshQueue: (verifyIntegrity?: boolean) => Promise<void>;
  retryRecording: (recordingId: string) => Promise<void>;
}

const DEFAULT_SNAPSHOT: TusQueueSnapshot = {
  items: [],
  activeRecordingId: null,
  liveProgressById: {},
  isPausedForAuth: false,
  isLoading: false,
  queueError: null
};

const TusUploadQueueContext = createContext<TusUploadQueueContextValue | null>(null);

export interface TusUploadCoordinatorProps {
  children: ReactNode;
  pollIntervalMs?: number;
  tusRetryDelays?: number[];
}

export function TusUploadCoordinator({
  children,
  pollIntervalMs,
  tusRetryDelays
}: TusUploadCoordinatorProps) {
  const { user, runtimeConfig } = useAuth();
  const managerRef = useRef<TusQueueManager | null>(null);
  const [snapshot, setSnapshot] = useState<TusQueueSnapshot>(DEFAULT_SNAPSHOT);

  const userId = user?.id ?? null;
  const uploadChunkBytes = runtimeConfig?.uploadChunkBytes;
  const storageMode = runtimeConfig?.storageMode;
  const runtimeDefaultsRef = useRef({ uploadChunkBytes, storageMode });

  useEffect(() => {
    runtimeDefaultsRef.current = { uploadChunkBytes, storageMode };
    managerRef.current?.updateRuntimeDefaults(uploadChunkBytes, storageMode);
  }, [uploadChunkBytes, storageMode]);

  useEffect(() => {
    if (!userId) {
      setSnapshot(DEFAULT_SNAPSHOT);
      return undefined;
    }

    const manager = new TusQueueManager({
      userId,
      defaultChunkBytes: runtimeDefaultsRef.current.uploadChunkBytes,
      fallbackStorageMode: runtimeDefaultsRef.current.storageMode,
      pollIntervalMs,
      tusRetryDelays
    });
    managerRef.current = manager;

    const unsubscribe = manager.subscribe((next) => {
      setSnapshot(next);
    });

    void manager.start();

    const handleLocalQueueUpdated = (event: Event) => {
      const custom = event as CustomEvent<{ ownerUserId?: string }>;
      if (!custom.detail?.ownerUserId || custom.detail.ownerUserId === userId) {
        void manager.refreshFromIndexedDb(false).then(() => {
          manager.kickQueue();
        });
      }
    };

    const handleOnline = () => {
      manager.kickQueue();
    };

    window.addEventListener(LOCAL_QUEUE_UPDATED_EVENT, handleLocalQueueUpdated);
    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener(LOCAL_QUEUE_UPDATED_EVENT, handleLocalQueueUpdated);
      window.removeEventListener('online', handleOnline);
      unsubscribe();
      managerRef.current = null;
      void manager.dispose();
    };
  }, [userId, pollIntervalMs, tusRetryDelays]);

  const refreshQueue = useCallback(async (verifyIntegrity = true) => {
    if (!managerRef.current) {
      return;
    }
    await managerRef.current.refreshFromIndexedDb(verifyIntegrity);
    managerRef.current.kickQueue();
  }, []);

  const retryRecording = useCallback(async (recordingId: string) => {
    if (!managerRef.current) {
      return;
    }
    await managerRef.current.retryRecording(recordingId);
  }, []);

  const contextValue = useMemo<TusUploadQueueContextValue>(
    () => ({
      ...snapshot,
      refreshQueue,
      retryRecording
    }),
    [snapshot, refreshQueue, retryRecording]
  );

  return (
    <TusUploadQueueContext.Provider value={contextValue}>
      {children}
    </TusUploadQueueContext.Provider>
  );
}

export function useTusUploadQueue(): TusUploadQueueContextValue | null {
  return useContext(TusUploadQueueContext);
}

