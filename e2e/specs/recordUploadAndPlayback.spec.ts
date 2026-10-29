import { test, expect } from '../support/e2eFixture';
import { ensureApprovedUserInShopA } from '../support/apiHelpers';
import {
  encodeQrBooleanMatrix,
  installControllableQrAndFakeCamera,
  setActiveQrMatrix
} from '../support/qrStreamHelper';

test.describe('Luồng Quay đóng gói trên Mobile, tus Upload, FFmpeg Preview & Phát HTTP Range', () => {
  test('Từ chối QR URL, bảo toàn số 0 đầu mã vận đơn 00849201923, quay camera giả -> tus upload -> ffprobe/FFmpeg -> tìm kiếm 008492 & phát video Range 206', async ({
    browser,
    e2eServer
  }) => {
    const operatorEmail = 'operator.mobile@packingproof.e2e';
    const operatorPassword = 'OperatorPass#2026!';
    const trackingNumber = '00849201923';

    await ensureApprovedUserInShopA(e2eServer, {
      fullName: 'Nhân viên Đóng gói Mobile',
      email: operatorEmail,
      password: operatorPassword,
      roleName: 'Operator',
      scopeType: 'Shop'
    });

    const urlQrMatrix = encodeQrBooleanMatrix('https://shop.tiktok.com/order/00849201923');
    const validQrMatrix = encodeQrBooleanMatrix(trackingNumber);

    const mobileCtx = await browser.newContext({
      baseURL: e2eServer.baseUrl,
      viewport: { width: 390, height: 844 },
      permissions: ['camera', 'microphone']
    });
    const page = await mobileCtx.newPage();
    await installControllableQrAndFakeCamera(page);

    // 1. Operator đăng nhập trên khung nhìn điện thoại 390x844
    await page.goto('/login');
    await page.locator('#login-email').fill(operatorEmail);
    await page.locator('#login-password').fill(operatorPassword);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();

    await expect(page.getByTestId('storage-mode-banner')).toContainText(
      'Chế độ thử nghiệm — lưu local'
    );

    // 2. Đưa QR chứa đường dẫn URL vào ống kính -> phải từ chối rõ bằng tiếng Việt, không tự đoán mã
    await setActiveQrMatrix(page, urlQrMatrix);
    await page.goto('/record');

    const scanErrorBanner = page.getByTestId('scan-error-banner');
    await expect(scanErrorBanner).toBeVisible({ timeout: 20_000 });
    await expect(scanErrorBanner).toContainText(/URL|không phải mã vận đơn|quét đúng/i);
    await expect(
      page.getByRole('button', { name: 'Xác nhận mã & Tạo phiên quay' })
    ).toHaveCount(0);

    // 3. Đưa mã vận đơn có chữ số 0 ở đầu "00849201923" vào ống kính -> nhận diện và bảo toàn nguyên vẹn số 0
    await setActiveQrMatrix(page, validQrMatrix);

    const recognizedBanner = page.getByTestId('recognized-tracking-banner');
    await expect(recognizedBanner).toBeVisible({ timeout: 20_000 });
    await expect(recognizedBanner).toContainText(trackingNumber);

    await page.getByRole('button', { name: 'Xác nhận mã & Tạo phiên quay' }).click();
    await expect(page.getByTestId('locked-tracking-number')).toHaveText(trackingNumber);

    // 4. Chuyển sang luồng camera giả gốc của Chromium để MediaRecorder ghi video WebM thật
    await setActiveQrMatrix(page, null);
    await page.getByRole('button', { name: 'Bắt đầu quay đóng gói' }).click();

    // Chỉ hiện "Đang quay" khi MediaRecorder thực sự bắt đầu + nhắc giữ màn hình đang mở
    await expect(page.getByTestId('recording-active-badge')).toContainText('Đang quay');
    await expect(page.getByText(/Giữ trang này đang mở trong khi quay/i)).toBeVisible();

    // Ghi hình khoảng 2.5 giây để sinh nhiều chunks tuần tự vào IndexedDB
    await page.waitForTimeout(2500);

    // 5. Bấm Kết thúc -> chốt chunk cuối vào IndexedDB -> tus resumable upload -> worker ffprobe + FFmpeg preview
    await page.getByRole('button', { name: 'Kết thúc & Lưu video' }).click();

    await expect(page.getByTestId('recording-completed-banner')).toBeVisible({
      timeout: 20_000
    });

    await page.getByRole('link', { name: 'Xem Hàng đợi tải lên' }).click();
    await expect(page).toHaveURL(/\/uploads$/);

    // Chờ tus upload hoàn tất + worker kiểm định ffprobe & lưu trữ thành công (hiển thị đúng Local, không giả NAS)
    await expect(
      page.locator('[data-testid^="storage-badge-"]', {
        hasText: 'Đã lưu cục bộ (Local)'
      })
    ).toBeVisible({ timeout: 45_000 });

    // 6. Mở Thư viện video (/videos) -> tìm theo phần mã "008492" -> mở Chi tiết video
    await page.goto('/videos');
    await page.locator('#video-search-tracking').fill('008492');
    await page.getByRole('button', { name: 'Tìm kiếm' }).click();

    await expect(
      page.locator('.mobile-card-list .mono-code', { hasText: trackingNumber })
    ).toBeVisible();
    await page.getByRole('link', { name: 'Xem chi tiết' }).first().click();

    await expect(page).toHaveURL(/\/videos\/[0-9a-f-]+$/i);
    await expect(page.getByTestId('detail-tracking-number')).toHaveText(trackingNumber);
    await expect(page.getByTestId('detail-storage-badge')).toContainText(
      'Đã lưu cục bộ (Local)'
    );

    // Đợi worker FFmpeg hoàn tất bản xem MP4 H.264 độc lập (nếu video gốc là WebM)
    const videoId = page.url().split('/videos/')[1].split('?')[0];
    await expect
      .poll(
        async () => {
          const detail = await page.evaluate(async (id) => {
            const res = await fetch(`/api/videos/${id}`, { credentials: 'same-origin' });
            if (!res.ok) return null;
            return (await res.json()) as {
              storageStatus: string;
              previewStatus: string;
              hasPreviewAsset: boolean;
            };
          }, videoId);
          return detail?.previewStatus;
        },
        { timeout: 35_000 }
      )
      .toMatch(/^(Ready|NotRequired)$/);

    // Tải lại chi tiết để đảm bảo trình phát nhận diện bản xem MP4 mới nhất và phát qua HTTP Range 206
    await page.reload();
    const videoPlayer = page.getByTestId('authenticated-video-player');
    await expect(videoPlayer).toBeVisible();

    const playbackResult = await page.evaluate(async (id) => {
      const detailRes = await fetch(`/api/videos/${id}`, { credentials: 'same-origin' });
      const detailJson = (await detailRes.json()) as { hasPreviewAsset?: boolean };
      const variant = detailJson.hasPreviewAsset ? 'preview' : 'auto';

      // Kiểm chứng endpoint stream hỗ trợ HTTP 206 Partial Content thực tế
      const rangeRes = await fetch(`/api/videos/${id}/stream?variant=${variant}`, {
        credentials: 'same-origin',
        headers: { Range: 'bytes=0-1023' }
      });

      const videoEl = document.querySelector(
        '[data-testid="authenticated-video-player"]'
      ) as HTMLVideoElement | null;
      if (!videoEl) {
        return { rangeStatus: rangeRes.status, readyState: 0, duration: 0 };
      }

      videoEl.muted = true;
      if (videoEl.readyState < 2) {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error('Video loadeddata timeout')),
            12_000
          );
          videoEl.addEventListener(
            'loadeddata',
            () => {
              window.clearTimeout(timer);
              resolve();
            },
            { once: true }
          );
          videoEl.load();
        });
      }

      await videoEl.play().catch(() => undefined);
      await new Promise((r) => window.setTimeout(r, 250));
      videoEl.pause();

      return {
        rangeStatus: rangeRes.status,
        contentRange: rangeRes.headers.get('content-range'),
        readyState: videoEl.readyState,
        duration: videoEl.duration
      };
    }, videoId);

    expect(playbackResult.rangeStatus).toBe(206);
    expect(playbackResult.contentRange).toMatch(/^bytes 0-/);
    expect(playbackResult.readyState).toBeGreaterThanOrEqual(2);
    expect(playbackResult.duration).toBeGreaterThan(0);

    await mobileCtx.close();
  });
});
