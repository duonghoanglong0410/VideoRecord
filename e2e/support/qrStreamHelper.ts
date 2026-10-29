import { BarcodeFormat, QRCodeWriter } from '@zxing/library';
import type { Page } from '@playwright/test';

export function encodeQrBooleanMatrix(contents: string): boolean[][] {
  const writer = new QRCodeWriter();
  // Passing 1x1 produces the exact canonical 1-cell-per-module BitMatrix without fractional distortion
  const bitMatrix = writer.encode(contents, BarcodeFormat.QR_CODE, 1, 1, new Map());
  const width = bitMatrix.getWidth();
  const height = bitMatrix.getHeight();
  const rows: boolean[][] = [];

  for (let y = 0; y < height; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < width; x += 1) {
      row.push(Boolean(bitMatrix.get(x, y)));
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Installs a controllable QR canvas camera stream wrapper BEFORE app scripts load.
 * Persists active QR matrix in `sessionStorage` so `page.goto('/record')` navigations
 * preserve the active QR frame, while clearing it to `null` delegates directly to
 * Chromium's native fake camera (`--use-fake-device-for-media-stream`) for `MediaRecorder`.
 */
export async function installControllableQrAndFakeCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const STORAGE_KEY = '__e2e_active_qr_matrix';

    const readMatrix = (): boolean[][] | null => {
      try {
        const raw = window.sessionStorage.getItem(STORAGE_KEY);
        if (!raw) {
          return null;
        }
        return JSON.parse(raw) as boolean[][];
      } catch {
        return null;
      }
    };

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return;
    }

    const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const initialMatrix = readMatrix();
      if (!initialMatrix) {
        return nativeGetUserMedia(constraints);
      }

      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 640;
      const ctx = canvas.getContext('2d');

      const drawFrame = () => {
        if (!ctx) {
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const matrix = readMatrix();
        if (!matrix || matrix.length === 0) {
          return;
        }

        const rows = matrix.length;
        const cols = matrix[0].length;
        const cellSize = Math.max(4, Math.floor((canvas.width - 128) / Math.max(rows, cols)));
        const qrWidth = cols * cellSize;
        const qrHeight = rows * cellSize;
        const offsetX = Math.floor((canvas.width - qrWidth) / 2);
        const offsetY = Math.floor((canvas.height - qrHeight) / 2);

        ctx.fillStyle = '#000000';
        for (let r = 0; r < rows; r += 1) {
          for (let c = 0; c < cols; c += 1) {
            if (matrix[r][c]) {
              ctx.fillRect(
                offsetX + c * cellSize,
                offsetY + r * cellSize,
                cellSize,
                cellSize
              );
            }
          }
        }
      };

      drawFrame();
      const timerId = window.setInterval(drawFrame, 80);

      const stream = canvas.captureStream(15);
      for (const track of stream.getTracks()) {
        const origStop = track.stop.bind(track);
        track.stop = () => {
          window.clearInterval(timerId);
          origStop();
        };
      }

      return stream;
    };
  });
}

export async function setActiveQrMatrix(
  page: Page,
  matrix: boolean[][] | null
): Promise<void> {
  await page.evaluate((nextMatrix) => {
    const STORAGE_KEY = '__e2e_active_qr_matrix';
    if (!nextMatrix) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(nextMatrix));
    }
  }, matrix);
}
