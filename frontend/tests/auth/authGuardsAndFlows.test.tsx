import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { apiRequest, SESSION_EXPIRED_EVENT } from '../../src/app/apiClient';
import { AuthProvider } from '../../src/app/authStore';
import { AppRoutes } from '../../src/app/router';
import { StorageModeBanner } from '../../src/app/StorageModeBanner';
import type { AuthMe, RuntimeConfig } from '../../src/app/types';

function buildRuntimeConfig(
  storageMode: 'LocalDevelopment' | 'SynologyMounted' = 'LocalDevelopment'
): RuntimeConfig {
  return {
    storageMode,
    maxRecordingSeconds: 600,
    maxUploadBytes: 536870912,
    maxLocalPendingRecordings: 3,
    uploadChunkBytes: 5242880,
    enableAudioRecording: false,
    smtpConfigured: false
  };
}

function buildAuthMe(overrides: Partial<AuthMe> = {}): AuthMe {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'operator@congty.vn',
    fullName: 'Trần Văn Kho',
    approvalStatus: 'Active',
    twoFactorEnabled: false,
    forcePasswordReset: false,
    isSuperAdmin: false,
    defaultShopId: '22222222-2222-2222-2222-222222222222',
    defaultWarehouseId: '33333333-3333-3333-3333-333333333333',
    permissions: ['recording.create', 'video.upload', 'video.view'],
    grants: [
      {
        id: '44444444-4444-4444-4444-444444444444',
        roleId: '55555555-5555-5555-5555-555555555555',
        roleName: 'Operator',
        scopeType: 'Warehouse',
        shopId: '22222222-2222-2222-2222-222222222222',
        shopName: 'Shop A',
        warehouseId: '33333333-3333-3333-3333-333333333333',
        warehouseName: 'Kho TP.HCM 01'
      }
    ],
    runtimeConfig: buildRuntimeConfig('LocalDevelopment'),
    csrfToken: 'csrf-token-initial',
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('Phase 1 Frontend Auth, Storage Mode Banner & Logout Safeguards', () => {
  it('redirects PendingApproval user away from business routes to PendingApprovalPage', async () => {
    const pendingUser = buildAuthMe({
      approvalStatus: 'PendingApproval',
      permissions: [],
      grants: []
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse(pendingUser, 200);
      }
      return jsonResponse({ token: 'csrf-1' }, 200);
    });

    render(
      <MemoryRouter initialEntries={['/record']}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', { name: /Tài khoản đang chờ phê duyệt/i })
    ).toBeInTheDocument();

    expect(screen.getByText(/Trần Văn Kho/i)).toBeInTheDocument();
    expect(screen.queryByText(/Bảng điều khiển vận hành/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Quay đóng gói đơn hàng/i)).not.toBeInTheDocument();
  });

  it('renders LocalDevelopment storage banner accurately and never claims NAS', async () => {
    const { rerender } = render(<StorageModeBanner storageMode="LocalDevelopment" />);

    const banner = screen.getByTestId('storage-mode-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Chế độ thử nghiệm — lưu local');
    expect(banner.textContent).not.toMatch(/NAS/i);

    rerender(<StorageModeBanner storageMode="SynologyMounted" />);
    expect(screen.queryByTestId('storage-mode-banner')).not.toBeInTheDocument();
  });

  it('handles 2FA login challenge step with TOTP and recovery code toggle', async () => {
    const user = userEvent.setup();
    const activeAdmin = buildAuthMe({
      email: 'admin@congty.vn',
      fullName: 'Quản trị Shop A',
      twoFactorEnabled: true
    });

    const login2FaBodies: unknown[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ errorCode: 'UNAUTHORIZED', message: 'Chưa đăng nhập' }, 401);
      }

      if (url.endsWith('/api/auth/csrf')) {
        return jsonResponse({ token: 'csrf-test-token' }, 200);
      }

      if (url.endsWith('/api/auth/login')) {
        return jsonResponse({ requiresTwoFactor: true, user: null }, 200);
      }

      if (url.endsWith('/api/auth/login-2fa')) {
        login2FaBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonResponse(
          {
            requiresTwoFactor: false,
            user: activeAdmin,
            csrfToken: 'csrf-after-2fa'
          },
          200
        );
      }

      return jsonResponse({}, 404);
    });

    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>
    );

    const emailInput = await screen.findByLabelText(/Địa chỉ Email/i);
    const passwordInput = screen.getByLabelText(/^Mật khẩu$/i);

    await user.type(emailInput, 'admin@congty.vn');
    await user.type(passwordInput, 'StrongPass123!');
    await user.click(screen.getByRole('button', { name: /^Đăng nhập$/i }));

    // Step 2: 2FA Challenge screen appears
    expect(
      await screen.findByRole('heading', { name: /Xác thực hai lớp \(2FA\)/i })
    ).toBeInTheDocument();

    // Toggle to Recovery Code mode and verify submission payload
    await user.click(screen.getByRole('button', { name: /Dùng mã khôi phục dự phòng/i }));
    const codeInput = screen.getByLabelText(/Mã khôi phục dự phòng một lần/i);
    await user.type(codeInput, 'RECOV-9988');
    await user.click(screen.getByRole('button', { name: /Xác minh mã 2FA/i }));

    expect(
      await screen.findByRole('heading', { name: /Bảng điều khiển vận hành/i })
    ).toBeInTheDocument();

    expect(login2FaBodies).toHaveLength(1);
    expect(login2FaBodies[0]).toMatchObject({
      code: 'RECOV-9988',
      useRecoveryCode: true
    });
  });

  it('shows warning modal on logout when pending local recordings exist and only logs out on confirmation', async () => {
    const user = userEvent.setup();
    const activeOperator = buildAuthMe();
    let logoutApiCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse(activeOperator, 200);
      }
      if (url.endsWith('/api/auth/csrf')) {
        return jsonResponse({ token: 'csrf-token' }, 200);
      }
      if (url.endsWith('/api/auth/logout')) {
        logoutApiCalls += 1;
        return jsonResponse({ message: 'Đã đăng xuất' }, 200);
      }
      return jsonResponse({}, 404);
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <AppRoutes checkPendingRecordingsCount={async () => 2} />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', { name: /Bảng điều khiển vận hành/i })
    ).toBeInTheDocument();

    // Click Logout button -> warning dialog should open without calling /api/auth/logout yet
    await user.click(screen.getByRole('button', { name: /^Đăng xuất$/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Cảnh báo còn video chờ tải lên/i);
    expect(dialog).toHaveTextContent(/2 bản ghi video/i);
    expect(logoutApiCalls).toBe(0);

    // Cancel logout -> stays on dashboard, still 0 logout calls
    await user.click(screen.getByRole('button', { name: /Ở lại trang/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(logoutApiCalls).toBe(0);

    // Click Logout again and confirm -> calls /api/auth/logout and redirects to /login
    await user.click(screen.getByRole('button', { name: /^Đăng xuất$/i }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /Vẫn đăng xuất/i }));

    await waitFor(() => {
      expect(logoutApiCalls).toBe(1);
    });
    expect(
      await screen.findByRole('heading', { name: /Đăng nhập hệ thống/i })
    ).toBeInTheDocument();
  });

  it('dispatches session-expired event on 401 from authenticated business endpoint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ errorCode: 'UNAUTHORIZED', message: 'Phiên hết hạn' }, 401)
    );

    const listener = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);

    await expect(apiRequest('/api/shops')).rejects.toThrow(/Phiên hết hạn/);
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
  });
});

