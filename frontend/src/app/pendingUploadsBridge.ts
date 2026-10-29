export type PendingRecordingsCounter = (userId: string) => Promise<number> | number;

let defaultRegisteredCounter: PendingRecordingsCounter | null = null;
let overrideCounter: PendingRecordingsCounter | null = null;

/**
 * Registers the live IndexedDB pending recordings counter for the active user.
 */
export function registerPendingUploadsCounter(counter: PendingRecordingsCounter | null): void {
  defaultRegisteredCounter = counter;
}

/**
 * Sets or clears an explicit override counter (used by unit/component tests).
 * Passing null restores the registered live IndexedDB counter.
 */
export function setPendingRecordingsCounter(counter: PendingRecordingsCounter | null): void {
  overrideCounter = counter;
}

export async function getPendingLocalRecordingsCount(userId: string): Promise<number> {
  if (!userId) {
    return 0;
  }

  const activeCounter = overrideCounter ?? defaultRegisteredCounter;
  if (activeCounter) {
    return await activeCounter(userId);
  }

  return 0;
}
