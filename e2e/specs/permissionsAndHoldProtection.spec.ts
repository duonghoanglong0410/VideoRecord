import { test, expect } from '../support/e2eFixture';
import {
  ensureApprovedUserInShopA,
  seedStoredWebmVideoViaTus
} from '../support/apiHelpers';

test.describe('Phân quyền Backend thực chất, Giữ bằng chứng (Hold) & Hạn chế vai trò Viewer', () => {
  test('Bật Hold chặn mọi yêu cầu xóa; Viewer xem được video nhưng ẩn nút Tải/Xóa và bị chặn 403 khi gọi API trực tiếp', async ({
    browser,
    e2eServer
  }) => {
    const operatorEmail = 'operator.hold@packingproof.e2e';
    const operatorPassword = 'OperatorPass#2026!';
    const viewerEmail = 'viewer.hold@packingproof.e2e';
    const viewerPassword = 'ViewerPass#2026!';
    const trackingNumber = '00991122334';

    const shopInfo = await ensureApprovedUserInShopA(e2eServer, {
      fullName: 'Nhân viên Đóng gói HoldTest',
      email: operatorEmail,
      password: operatorPassword,
      roleName: 'Operator',
      scopeType: 'Shop'
    });

    await ensureApprovedUserInShopA(e2eServer, {
      fullName: 'Nhân viên Tra cứu Viewer HoldTest',
      email: viewerEmail,
      password: viewerPassword,
      roleName: 'Viewer',
      scopeType: 'Shop'
    });

    const videoId = await seedStoredWebmVideoViaTus(
      e2eServer,
      operatorEmail,
      operatorPassword,
      shopInfo,
      trackingNumber
    );

    // 1. Quản trị viên (SuperAdmin) thêm ghi chú đối chiếu và bật chế độ Giữ bằng chứng (Hold)
    const adminCtx = await browser.newContext({ baseURL: e2eServer.baseUrl });
    const adminPage = await adminCtx.newPage();

    await adminPage.goto('/login');
    await adminPage.locator('#login-email').fill(e2eServer.superAdminEmail);
    await adminPage.locator('#login-password').fill(e2eServer.superAdminPassword);
    await adminPage.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(adminPage.getByTestId('storage-mode-banner')).toBeVisible();

    await adminPage.goto(`/videos/${videoId}`);
    await expect(adminPage.getByTestId('detail-tracking-number')).toHaveText(trackingNumber);

    // Thêm ghi chú đối chiếu nội bộ
    const noteText = 'Khách khiếu nại thiếu phụ kiện đơn TikTok — khóa video làm bằng chứng.';
    await adminPage.locator('#video-note-input').fill(noteText);
    await adminPage.getByRole('button', { name: 'Lưu ghi chú' }).click();
    await expect(adminPage.locator('.note-item', { hasText: noteText })).toBeVisible();

    // Bật Hold trên video
    await adminPage.getByRole('button', { name: 'Giữ bằng chứng (Bật Hold)' }).click();
    const holdDialog = adminPage.getByRole('dialog');
    await expect(holdDialog).toBeVisible();
    await holdDialog
      .locator('#hold-reason-textarea')
      .fill('Tranh chấp khiếu nại đơn hàng 00991122334 đang chờ sàn xử lý');
    await holdDialog.getByRole('button', { name: 'Xác nhận bật Hold' }).click();

    // Xác minh trạng thái Hold khóa nút Yêu cầu xóa trên UI và chặn cả request xóa trực tiếp (409 VIDEO_ON_HOLD)
    await expect(adminPage.getByTestId('detail-hold-banner')).toBeVisible();
    await expect(adminPage.getByTestId('request-delete-btn')).toBeDisabled();
    await expect(adminPage.getByTestId('delete-blocked-by-hold-notice')).toBeVisible();

    const adminDeleteOnHoldCheck = await adminPage.evaluate(async (id) => {
      const csrfRes = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
      const { token } = (await csrfRes.json()) as { token: string };
      const delRes = await fetch(`/api/videos/${id}/deletion-requests`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token
        },
        body: JSON.stringify({ reason: 'Thử gửi yêu cầu xóa khi đang bật Hold' })
      });
      const payload = (await delRes.json().catch(() => null)) as { errorCode?: string } | null;
      return { status: delRes.status, errorCode: payload?.errorCode ?? null };
    }, videoId);

    expect(adminDeleteOnHoldCheck.status).toBe(409);
    expect(adminDeleteOnHoldCheck.errorCode).toBe('VIDEO_ON_HOLD');
    await adminCtx.close();

    // 2. Viewer đăng nhập -> tìm kiếm và phát video được, KHÔNG thấy nút Download/Delete,
    //    và gọi API trực tiếp (có kèm CSRF hợp lệ) đều bị backend chặn 403 Forbidden!
    const viewerCtx = await browser.newContext({ baseURL: e2eServer.baseUrl });
    const viewerPage = await viewerCtx.newPage();

    await viewerPage.goto('/login');
    await viewerPage.locator('#login-email').fill(viewerEmail);
    await viewerPage.locator('#login-password').fill(viewerPassword);
    await viewerPage.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(viewerPage.getByTestId('storage-mode-banner')).toBeVisible();

    await viewerPage.goto('/videos');
    await viewerPage.locator('#video-search-tracking').fill('009911');
    await viewerPage.getByRole('button', { name: 'Tìm kiếm' }).click();
    await expect(
      viewerPage.locator('.mono-code', { hasText: trackingNumber }).first()
    ).toBeVisible();

    await viewerPage.getByRole('link', { name: 'Xem chi tiết' }).first().click();
    await expect(viewerPage).toHaveURL(new RegExp(`/videos/${videoId}$`, 'i'));
    await expect(viewerPage.getByTestId('detail-tracking-number')).toHaveText(trackingNumber);
    await expect(viewerPage.locator('.note-item', { hasText: noteText })).toBeVisible();

    // Không hiển thị nút Tải tệp gốc hoặc nút Yêu cầu xóa
    await expect(viewerPage.getByTestId('download-original-btn')).toHaveCount(0);
    await expect(viewerPage.getByTestId('request-delete-btn')).toHaveCount(0);

    // Viewer vẫn phát được bản xem MP4 H.264 (do FFmpeg chuyển mã từ WebM) qua trình phát HTTP Range 206
    const viewerPlayback = await viewerPage.evaluate(async (id) => {
      const previewRangeRes = await fetch(`/api/videos/${id}/stream?variant=preview`, {
        credentials: 'same-origin',
        headers: { Range: 'bytes=0-1023' }
      });

      const videoEl = document.querySelector(
        '[data-testid="authenticated-video-player"]'
      ) as HTMLVideoElement | null;
      if (!videoEl) {
        return { previewRangeStatus: previewRangeRes.status, readyState: 0, duration: 0 };
      }
      videoEl.muted = true;
      if (videoEl.readyState < 2) {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error('Viewer video loadeddata timeout')),
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
      return {
        previewRangeStatus: previewRangeRes.status,
        readyState: videoEl.readyState,
        duration: videoEl.duration
      };
    }, videoId);
    expect(viewerPlayback.previewRangeStatus).toBe(206);
    expect(viewerPlayback.readyState).toBeGreaterThanOrEqual(2);
    expect(viewerPlayback.duration).toBeGreaterThan(0);

    // Gọi trực tiếp 3 API bị cấm đối với Viewer từ ngay trong phiên trình duyệt đã đăng nhập (kèm CSRF hợp lệ)
    const directForbiddenChecks = await viewerPage.evaluate(
      async ({ id, shopId, warehouseId }) => {
        const csrfRes = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
        const { token } = (await csrfRes.json()) as { token: string };

        const createRecRes = await fetch('/api/recordings', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': token
          },
          body: JSON.stringify({
            shopId,
            warehouseId,
            rawCode: '00112233445',
            formatHint: 'QrCode',
            isManualEntry: false
          })
        });
        const createBody = (await createRecRes.json().catch(() => null)) as {
          errorCode?: string;
        } | null;

        const downloadRes = await fetch(`/api/videos/${id}/download`, {
          method: 'GET',
          credentials: 'same-origin'
        });

        const deleteReqRes = await fetch(`/api/videos/${id}/deletion-requests`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': token
          },
          body: JSON.stringify({ reason: 'Viewer cố gọi API xóa trực tiếp' })
        });
        const deleteBody = (await deleteReqRes.json().catch(() => null)) as {
          errorCode?: string;
        } | null;

        return {
          createStatus: createRecRes.status,
          createErrorCode: createBody?.errorCode ?? null,
          downloadStatus: downloadRes.status,
          deleteStatus: deleteReqRes.status,
          deleteErrorCode: deleteBody?.errorCode ?? null
        };
      },
      {
        id: videoId,
        shopId: shopInfo.shopId,
        warehouseId: shopInfo.warehouseId
      }
    );

    expect(directForbiddenChecks.createStatus).toBe(403);
    expect(directForbiddenChecks.createErrorCode).not.toBe('CSRF_TOKEN_INVALID');
    expect(directForbiddenChecks.downloadStatus).toBe(403);
    expect(directForbiddenChecks.deleteStatus).toBe(403);
    expect(directForbiddenChecks.deleteErrorCode).not.toBe('CSRF_TOKEN_INVALID');

    await viewerCtx.close();
  });
});
