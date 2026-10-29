import { test, expect } from '../support/e2eFixture';

test.describe('Xác thực, Chờ phê duyệt, Cờ lưu trữ Local & Duyệt quyền tài khoản', () => {
  test('Đăng ký công khai bị khóa ở màn hình Chờ phê duyệt; SuperAdmin thấy rõ chế độ lưu local và duyệt Operator + Viewer cho ShopA', async ({
    browser,
    e2eServer
  }) => {
    const operatorEmail = 'operator.gov@packingproof.e2e';
    const operatorPassword = 'OperatorPass#2026!';
    const viewerEmail = 'viewer.gov@packingproof.e2e';
    const viewerPassword = 'ViewerPass#2026!';

    // 1. Nhân viên tự đăng ký công khai -> rơi vào trạng thái Chờ phê duyệt (PendingApproval)
    const pendingCtx = await browser.newContext({ baseURL: e2eServer.baseUrl });
    const pendingPage = await pendingCtx.newPage();

    await pendingPage.goto('/register');
    await pendingPage.locator('#reg-name').fill('Nhân viên Đóng gói ShopA');
    await pendingPage.locator('#reg-email').fill(operatorEmail);
    await pendingPage.locator('#reg-password').fill(operatorPassword);
    await pendingPage.locator('#reg-confirm').fill(operatorPassword);
    await pendingPage.getByRole('button', { name: 'Tạo tài khoản chờ duyệt' }).click();

    await expect(pendingPage).toHaveURL(/\/pending-approval$/);
    await expect(
      pendingPage.getByRole('heading', { name: 'Tài khoản đang chờ phê duyệt' })
    ).toBeVisible();
    await expect(
      pendingPage.locator('.brand-badge', { hasText: 'Chờ phê duyệt' })
    ).toBeVisible();

    // Không thể mở /record hoặc /videos khi chưa được duyệt (cả UI route guard lẫn API backend)
    await pendingPage.goto('/record');
    await expect(pendingPage).toHaveURL(/\/pending-approval$/);

    await pendingPage.goto('/videos');
    await expect(pendingPage).toHaveURL(/\/pending-approval$/);

    const directApiStatuses = await pendingPage.evaluate(async () => {
      const recRes = await fetch('/api/recordings', { credentials: 'same-origin' });
      const vidRes = await fetch('/api/videos', { credentials: 'same-origin' });
      return { recStatus: recRes.status, vidStatus: vidRes.status };
    });
    expect(directApiStatuses.recStatus).toBe(403);
    expect(directApiStatuses.vidStatus).toBe(403);

    // 2. Tạo thêm tài khoản thứ hai để SuperAdmin cấp vai trò Viewer cho ShopA
    const viewerRegCtx = await browser.newContext({ baseURL: e2eServer.baseUrl });
    const viewerRegPage = await viewerRegCtx.newPage();
    await viewerRegPage.goto('/register');
    await viewerRegPage.locator('#reg-name').fill('Nhân viên Đối chiếu Viewer');
    await viewerRegPage.locator('#reg-email').fill(viewerEmail);
    await viewerRegPage.locator('#reg-password').fill(viewerPassword);
    await viewerRegPage.locator('#reg-confirm').fill(viewerPassword);
    await viewerRegPage.getByRole('button', { name: 'Tạo tài khoản chờ duyệt' }).click();
    await expect(viewerRegPage).toHaveURL(/\/pending-approval$/);
    await viewerRegCtx.close();

    // 3. SuperAdmin (được bootstrap qua biến môi trường) đăng nhập
    const adminCtx = await browser.newContext({ baseURL: e2eServer.baseUrl });
    const adminPage = await adminCtx.newPage();

    await adminPage.goto('/login');
    await adminPage.locator('#login-email').fill(e2eServer.superAdminEmail);
    await adminPage.locator('#login-password').fill(e2eServer.superAdminPassword);
    await adminPage.getByRole('button', { name: 'Đăng nhập' }).click();

    // Xác minh banner bắt buộc "Chế độ thử nghiệm — lưu local", tuyệt đối không giả danh NAS thật
    const storageBanner = adminPage.getByTestId('storage-mode-banner');
    await expect(storageBanner).toBeVisible();
    await expect(storageBanner).toContainText('Chế độ thử nghiệm — lưu local');
    await expect(storageBanner).not.toContainText('Đã lưu NAS');

    // 4. Mở Quản trị người dùng -> Duyệt Operator cho ShopA và Viewer cho ShopA
    await adminPage.goto('/admin/users');
    await expect(
      adminPage.getByRole('heading', { name: /Quản trị người dùng/i })
    ).toBeVisible();

    // Duyệt Operator trong ShopA
    const operatorRow = adminPage
      .locator('.desktop-table-wrap tbody tr')
      .filter({ hasText: operatorEmail });
    await expect(operatorRow).toBeVisible();
    await operatorRow.getByRole('button', { name: 'Duyệt & Gán quyền' }).click();

    const approveDialog = adminPage.getByRole('dialog');
    await expect(approveDialog).toBeVisible();
    await approveDialog.locator('select').nth(0).selectOption({ label: 'Operator (Hệ thống)' });
    await approveDialog.locator('select').nth(1).selectOption('Shop');
    await approveDialog.locator('select').nth(2).selectOption({ label: 'Shop A (ShopA)' });
    await approveDialog.getByRole('button', { name: 'Phê duyệt & Lưu quyền' }).click();

    await expect(approveDialog).toBeHidden();
    await expect(operatorRow).toContainText('Đang hoạt động');
    await expect(operatorRow).toContainText('Operator');
    await expect(operatorRow).toContainText('Shop A');

    // Duyệt Viewer trong ShopA
    const viewerRow = adminPage
      .locator('.desktop-table-wrap tbody tr')
      .filter({ hasText: viewerEmail });
    await expect(viewerRow).toBeVisible();
    await viewerRow.getByRole('button', { name: 'Duyệt & Gán quyền' }).click();

    await expect(approveDialog).toBeVisible();
    await approveDialog.locator('select').nth(0).selectOption({ label: 'Viewer (Hệ thống)' });
    await approveDialog.locator('select').nth(1).selectOption('Shop');
    await approveDialog.locator('select').nth(2).selectOption({ label: 'Shop A (ShopA)' });
    await approveDialog.getByRole('button', { name: 'Phê duyệt & Lưu quyền' }).click();

    await expect(approveDialog).toBeHidden();
    await expect(viewerRow).toContainText('Đang hoạt động');
    await expect(viewerRow).toContainText('Viewer');
    await expect(viewerRow).toContainText('Shop A');

    // 5. Khi được duyệt & thay đổi quyền, SecurityStamp xoay vòng làm thu hồi phiên chờ duyệt cũ tức thì;
    //    Operator đăng nhập lại và truy cập ngay được màn hình nghiệp vụ (/videos, /record)
    await pendingPage.goto('/videos');
    await expect(pendingPage).toHaveURL(/\/login/);
    await pendingPage.locator('#login-email').fill(operatorEmail);
    await pendingPage.locator('#login-password').fill(operatorPassword);
    await pendingPage.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(pendingPage).not.toHaveURL(/\/login/);

    await pendingPage.goto('/videos');
    await expect(pendingPage).toHaveURL(/\/videos$/);
    await expect(
      pendingPage.getByRole('heading', { name: 'Thư viện video bằng chứng đóng gói' })
    ).toBeVisible();

    await pendingCtx.close();
    await adminCtx.close();
  });
});
