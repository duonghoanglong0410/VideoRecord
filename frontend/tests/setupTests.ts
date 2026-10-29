import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { clearCsrfToken } from '../src/app/apiClient';
import { setPendingRecordingsCounter } from '../src/app/pendingUploadsBridge';

afterEach(() => {
  cleanup();
  clearCsrfToken();
  setPendingRecordingsCounter(null);
});

