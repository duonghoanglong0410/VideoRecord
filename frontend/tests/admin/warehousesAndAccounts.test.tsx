import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../src/app/authStore';
import { AppRoutes } from '../../src/app/router';
import type { AuthMe } from '../../src/app/types';
import type { AdminShopWarehouseTreeDto } from '../../src/features/admin/adminApi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function buildShopAdminMe(): AuthMe {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    email: 'shopadmin@packingproof.vn',
    fullName: 'Lê Quản Lý Shop',
    approvalStatus: 'Active',
    twoFactorEnabled: false,
    forcePasswordReset: true,
    isSuperAdmin: false,
    defaultShopId: '10000000-0000-0000-0000-000000000001',
    defaultWarehouseId: '20000000-0000-0000-0000-000000000001',
    permissions: [
      'recording.create',
      'video.upload',
      'video.view',
      'user.manage',
      'role.manage',
      'audit.view'
    ],
    grants: [
      {
        id: '30000000-0000-0000-0000-000000000001',
        roleId: '40000000-0000-0000-0000-000000000001',
        roleName: 'Admin',
        scopeType: 'Shop',
        shopId: '10000000-0000-0000-0000-000000000001',
        shopName: 'TikTok Shop Thời Trang A',
        warehouseId: null,
        warehouseName: null
      }
    ],
    runtimeConfig: {
      storageMode: 'LocalDevelopment',
      maxRecordingSeconds: 600,
      maxUploadBytes: 536870912,
      maxLocalPendingRecordings: 3,
      uploadChunkBytes: 5242880,
      enableAudioRecording: false,
      smtpConfigured: false
    },
    csrfToken: 'csrf-shop-admin'
  };
}

describe('Warehouse Management, Direct Account Creation & My Account Profile', () => {
  it('allows Shop Admin (Admin role) to access /admin/warehouses and create a warehouse', async () => {
    const user = userEvent.setup();
    const shopAdmin = buildShopAdminMe();
    const createdWarehouses: unknown[] = [];

    let warehousesState = [
      {
        id: '20000000-0000-0000-0000-000000000001',
        shopId: '10000000-0000-0000-0000-000000000001',
        code: 'WH-HCM-01',
        name: 'Kho Tân Bình 01',
        isActive: true,
        assignedUserCount: 4,
        recordingCount: 128,
        createdAtUtc: '2026-10-30T08:00:00Z',
        packingStations: [
          {
            id: '50000000-0000-0000-0000-000000000001',
            warehouseId: '20000000-0000-0000-0000-000000000001',
            code: 'ST-01',
            name: 'Bàn đóng gói 01',
            isActive: true,
            createdAtUtc: '2026-10-30T08:00:00Z'
          }
        ]
      }
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/auth/me')) {
        return jsonResponse(shopAdmin, 200);
      }
      if (url.endsWith('/api/auth/csrf')) {
        return jsonResponse({ token: 'csrf-shop-admin' }, 200);
      }
      if (url.endsWith('/api/admin/warehouses/overview') && method === 'GET') {
        return jsonResponse(
          {
            canManageShops: false,
            shops: [
              {
                id: '10000000-0000-0000-0000-000000000001',
                code: 'ShopA',
                slug: 'shop-a',
                name: 'TikTok Shop Thời Trang A',
                allowedStorageSubdir: 'shop-a',
                isActive: true,
                assignedUserCount: 5,
                recordingCount: 128,
                createdAtUtc: '2026-10-30T08:00:00Z',
                warehouses: warehousesState
              }
            ]
          },
          200
        );
      }
      if (
        url.includes('/api/admin/warehouses/shops/10000000-0000-0000-0000-000000000001') &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          code: string;
          name: string;
        };
        createdWarehouses.push(body);
        const newWh = {
          id: '20000000-0000-0000-0000-000000000002',
          shopId: '10000000-0000-0000-0000-000000000001',
          code: body.code,
          name: body.name,
          isActive: true,
          assignedUserCount: 0,
          recordingCount: 0,
          createdAtUtc: '2026-10-31T08:00:00Z',
          packingStations: [
            {
              id: '50000000-0000-0000-0000-000000000002',
              warehouseId: '20000000-0000-0000-0000-000000000002',
              code: 'ST-01',
              name: 'Bàn đóng gói 01',
              isActive: true,
              createdAtUtc: '2026-10-31T08:00:00Z'
            }
          ]
        };
        warehousesState = [...warehousesState, newWh];
        return jsonResponse(newWh, 201);
      }
      return jsonResponse({}, 404);
    });

    render(
      <MemoryRouter initialEntries={['/admin/warehouses']}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', {
        name: /Quản lý Shop & Kho đóng gói/i
      })
    ).toBeInTheDocument();

    expect(await screen.findByText('Kho Tân Bình 01')).toBeInTheDocument();
    // Shop Admin does NOT see SuperAdmin-only "+ Thêm Shop mới" button
    expect(
      screen.queryByRole('button', { name: /Thêm Shop mới/i })
    ).not.toBeInTheDocument();

    // Add a new warehouse inside ShopA
    await user.click(screen.getByRole('button', { name: /Thêm Kho mới/i }));
    await user.type(
      screen.getByLabelText(/Tên Kho đóng gói/i),
      'Kho Quận 12'
    );
    await user.click(screen.getByRole('button', { name: /^Thêm Kho$/i }));

    await waitFor(() => {
      expect(createdWarehouses).toHaveLength(1);
    });
    expect(await screen.findByText('Kho Quận 12')).toBeInTheDocument();
  });

  it('supports direct staff account creation on /admin/users and personal password change on /account', async () => {
    const user = userEvent.setup();
    const shopAdmin = buildShopAdminMe();
    const createdUsers: unknown[] = [];
    const changedPasswords: unknown[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/auth/me')) {
        return jsonResponse(shopAdmin, 200);
      }
      if (url.endsWith('/api/auth/csrf')) {
        return jsonResponse({ token: 'csrf-shop-admin' }, 200);
      }
      if (url.endsWith('/api/admin/roles')) {
        return jsonResponse([
          {
            id: 'role-operator-id',
            name: 'Operator',
            description: 'Nhân viên đóng gói',
            isSystemRole: true,
            createdAtUtc: '2026-10-30T00:00:00Z',
            permissions: ['recording.create', 'video.upload', 'video.view']
          }
        ]);
      }
      if (url.endsWith('/api/shops')) {
        return jsonResponse({
          shops: [
            {
              id: '10000000-0000-0000-0000-000000000001',
              code: 'ShopA',
              slug: 'shop-a',
              name: 'TikTok Shop Thời Trang A',
              warehouses: [
                {
                  id: '20000000-0000-0000-0000-000000000001',
                  code: 'WH-HCM-01',
                  name: 'Kho Tân Bình 01',
                  packingStations: []
                }
              ]
            }
          ]
        });
      }
      if (url.includes('/api/admin/users') && method === 'GET') {
        return jsonResponse({
          items: [],
          totalCount: 0,
          page: 1,
          pageSize: 20
        });
      }
      if (url.endsWith('/api/admin/users') && method === 'POST') {
        const payload = JSON.parse(String(init?.body ?? '{}'));
        createdUsers.push(payload);
        return jsonResponse(
          {
            id: 'new-user-id',
            email: payload.email,
            fullName: payload.fullName,
            approvalStatus: 'Active',
            twoFactorEnabled: false,
            isLockedOut: false,
            forcePasswordReset: false,
            defaultShopId: payload.defaultShopId,
            defaultWarehouseId: payload.defaultWarehouseId,
            createdAtUtc: '2026-10-31T09:00:00Z',
            approvedAtUtc: '2026-10-31T09:00:00Z',
            grants: []
          },
          201
        );
      }
      if (url.endsWith('/api/auth/change-password') && method === 'POST') {
        const payload = JSON.parse(String(init?.body ?? '{}'));
        changedPasswords.push(payload);
        return jsonResponse({
          message: 'Đổi mật khẩu thành công.',
          csrfToken: 'csrf-rotated'
        });
      }
      return jsonResponse({}, 404);
    });

    render(
      <MemoryRouter initialEntries={['/admin/users']}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', { name: /Quản trị người dùng/i })
    ).toBeInTheDocument();

    // Direct create account
    await user.click(screen.getByRole('button', { name: /Tạo tài khoản mới/i }));
    await user.type(
      screen.getByLabelText(/Họ và tên nhân viên/i),
      'Phạm Minh Đóng Gói'
    );
    await user.type(
      screen.getByLabelText(/Email đăng nhập/i),
      'minh.pham@shop.vn'
    );
    await user.type(
      screen.getByLabelText(/Mật khẩu khởi tạo/i),
      'NhanVien@2026!'
    );
    await user.click(
      screen.getByRole('button', { name: /Tạo & Kích hoạt ngay/i })
    );

    await waitFor(() => {
      expect(createdUsers).toHaveLength(1);
    });
    expect(createdUsers[0]).toMatchObject({
      fullName: 'Phạm Minh Đóng Gói',
      email: 'minh.pham@shop.vn',
      defaultShopId: '10000000-0000-0000-0000-000000000001',
      defaultWarehouseId: '20000000-0000-0000-0000-000000000001'
    });

    // Navigate to My Account (/account) via Sidebar link and change password
    await user.click(screen.getByRole('link', { name: /^Tài khoản của tôi$/i }));

    expect(
      await screen.findByRole('heading', { name: /^Tài khoản của tôi$/i })
    ).toBeInTheDocument();

    await user.type(
      screen.getByLabelText(/Mật khẩu hiện tại/i),
      'OldPass@2026!'
    );
    await user.type(screen.getByLabelText(/^Mật khẩu mới/i), 'NewPass@2026!');
    await user.type(
      screen.getByLabelText(/Nhập lại mật khẩu mới/i),
      'NewPass@2026!'
    );
    await user.click(
      screen.getByRole('button', { name: /Cập nhật mật khẩu mới/i })
    );

    await waitFor(() => {
      expect(changedPasswords).toHaveLength(1);
    });
    expect(await screen.findByText(/Đổi mật khẩu thành công/i)).toBeInTheDocument();
  });

  it('allows SuperAdmin full Shop CRUD (create with default warehouse, edit code/name/subdir, and delete empty shop)', async () => {
    const user = userEvent.setup();
    const superAdmin: AuthMe = {
      ...buildShopAdminMe(),
      isSuperAdmin: true,
      permissions: ['recording.create', 'video.upload', 'video.view', 'user.manage', 'role.manage', 'storage.manage', 'audit.view']
    };

    const createdShops: unknown[] = [];
    const updatedShops: unknown[] = [];
    const deletedShopIds: string[] = [];

    let shopsState: AdminShopWarehouseTreeDto[] = [
      {
        id: '10000000-0000-0000-0000-000000000001',
        code: 'ShopA',
        slug: 'shop-a',
        name: 'TikTok Shop Thời Trang A',
        allowedStorageSubdir: 'shop-a',
        isActive: true,
        assignedUserCount: 0,
        recordingCount: 0,
        createdAtUtc: '2026-10-30T08:00:00Z',
        warehouses: []
      }
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/auth/me')) {
        return jsonResponse(superAdmin, 200);
      }
      if (url.endsWith('/api/auth/csrf')) {
        return jsonResponse({ token: 'csrf-super-admin' }, 200);
      }
      if (url.endsWith('/api/admin/warehouses/overview') && method === 'GET') {
        return jsonResponse({
          canManageShops: true,
          shops: shopsState
        });
      }
      if (url.endsWith('/api/admin/shops') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        createdShops.push(body);
        const newShop = {
          id: '10000000-0000-0000-0000-000000000002',
          code: body.code,
          slug: body.code.toLowerCase(),
          name: body.name,
          allowedStorageSubdir: body.allowedStorageSubdir || body.code.toLowerCase(),
          isActive: true,
          assignedUserCount: 0,
          recordingCount: 0,
          createdAtUtc: '2026-10-31T10:00:00Z',
          warehouses: body.createDefaultWarehouse
            ? [
                {
                  id: '20000000-0000-0000-0000-000000000099',
                  shopId: '10000000-0000-0000-0000-000000000002',
                  code: 'WH-SHOPB-01',
                  name: body.defaultWarehouseName || 'Kho chính 01',
                  isActive: true,
                  assignedUserCount: 0,
                  recordingCount: 0,
                  createdAtUtc: '2026-10-31T10:00:00Z',
                  packingStations: []
                }
              ]
            : []
        };
        shopsState = [...shopsState, newShop];
        return jsonResponse(newShop, 201);
      }
      if (url.includes('/api/admin/warehouses/shops/') && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        updatedShops.push(body);
        shopsState = shopsState.map((s) =>
          url.endsWith(s.id)
            ? {
                ...s,
                code: body.code ?? s.code,
                name: body.name ?? s.name,
                allowedStorageSubdir: body.allowedStorageSubdir ?? s.allowedStorageSubdir,
                isActive: body.isActive ?? s.isActive
              }
            : s
        );
        return jsonResponse({ message: 'Đã cập nhật thông tin Shop thành công.' }, 200);
      }
      if (url.includes('/api/admin/warehouses/shops/') && method === 'DELETE') {
        const id = url.split('/').pop()!;
        deletedShopIds.push(id);
        shopsState = shopsState.filter((s) => s.id !== id);
        return jsonResponse({ message: 'Đã xóa Shop thành công.' }, 200);
      }
      return jsonResponse({}, 404);
    });

    render(
      <MemoryRouter initialEntries={['/admin/warehouses']}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('heading', {
        name: /Quản lý Shop & Kho đóng gói/i
      })
    ).toBeInTheDocument();

    // 1. Create Shop B with auto-default warehouse
    await user.click(
      await screen.findByRole('button', { name: /Thêm Shop mới/i })
    );
    await user.type(
      screen.getByLabelText(/Tên hiển thị của Shop/i),
      'TikTok Shop Mỹ Phẩm B'
    );
    await user.type(screen.getByLabelText(/Mã viết tắt của Shop/i), 'ShopB');
    await user.click(screen.getByRole('button', { name: /^Tạo Shop$/i }));

    await waitFor(() => {
      expect(createdShops).toHaveLength(1);
    });
    expect(createdShops[0]).toMatchObject({
      code: 'ShopB',
      name: 'TikTok Shop Mỹ Phẩm B',
      createDefaultWarehouse: true
    });

    // 2. Edit Shop A
    await user.click(screen.getAllByRole('button', { name: /^Sửa Shop$/i })[0]);
    const nameInput = screen.getByLabelText(/Tên hiển thị của Shop/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'TikTok Shop Thời Trang A (Mới)');
    await user.click(screen.getByRole('button', { name: /^Lưu thay đổi$/i }));

    await waitFor(() => {
      expect(updatedShops).toHaveLength(1);
    });

    // 3. Delete empty Shop A
    await user.click(screen.getAllByRole('button', { name: /^Xóa Shop$/i })[0]);
    await user.click(screen.getByRole('button', { name: /^Xác nhận xóa Shop$/i }));

    await waitFor(() => {
      expect(deletedShopIds).toContain('10000000-0000-0000-0000-000000000001');
    });
  });
});
