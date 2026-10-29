import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { E2eServerContext } from './e2eFixture';

const execFileAsync = promisify(execFile);

export interface ProvisionedShopInfo {
  shopId: string;
  shopCode: string;
  warehouseId: string;
  warehouseCode: string;
}

async function getCsrfToken(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.get('/api/auth/csrf');
  if (!res.ok()) {
    throw new Error(`Failed to fetch CSRF token: ${res.status()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

export async function createAuthenticatedApiContext(
  baseUrl: string,
  email: string,
  password: string
): Promise<{ ctx: APIRequestContext; csrfToken: string }> {
  const ctx = await pwRequest.newContext({ baseURL: baseUrl });
  const initialCsrf = await getCsrfToken(ctx);

  const loginRes = await ctx.post('/api/auth/login', {
    headers: { 'X-CSRF-Token': initialCsrf },
    data: { email, password }
  });

  if (!loginRes.ok()) {
    const errText = await loginRes.text();
    await ctx.dispose();
    throw new Error(`API login failed for ${email}: ${loginRes.status()} ${errText}`);
  }

  const nextCsrf = await getCsrfToken(ctx);
  return { ctx, csrfToken: nextCsrf };
}

export async function ensureApprovedUserInShopA(
  server: E2eServerContext,
  input: {
    fullName: string;
    email: string;
    password: string;
    roleName: 'Operator' | 'Viewer' | 'Manager' | 'Admin';
    scopeType: 'Own' | 'Warehouse' | 'Shop';
  }
): Promise<ProvisionedShopInfo> {
  // 1. Register user if not already registered
  const anonCtx = await pwRequest.newContext({ baseURL: server.baseUrl });
  try {
    const anonCsrf = await getCsrfToken(anonCtx);
    await anonCtx.post('/api/auth/register', {
      headers: { 'X-CSRF-Token': anonCsrf },
      data: {
        name: input.fullName,
        email: input.email,
        password: input.password,
        confirmPassword: input.password
      }
    });
  } finally {
    await anonCtx.dispose();
  }

  // 2. Log in as SuperAdmin to locate ShopA, roleId, and approve/grant user
  const { ctx: adminCtx, csrfToken } = await createAuthenticatedApiContext(
    server.baseUrl,
    server.superAdminEmail,
    server.superAdminPassword
  );

  try {
    const shopsRes = await adminCtx.get('/api/shops');
    if (!shopsRes.ok()) {
      throw new Error(`GET /api/shops failed: ${shopsRes.status()} ${await shopsRes.text()}`);
    }
    const shopsPayload = (await shopsRes.json()) as {
      shops: Array<{
        id: string;
        code: string;
        warehouses: Array<{ id: string; code: string }>;
      }>;
    };
    const shopA = shopsPayload.shops.find((s) => s.code === 'ShopA') ?? shopsPayload.shops[0];
    const whA1 = shopA.warehouses[0];

    const rolesRes = await adminCtx.get('/api/admin/roles');
    if (!rolesRes.ok()) {
      throw new Error(`GET /api/admin/roles failed: ${rolesRes.status()} ${await rolesRes.text()}`);
    }
    const rolesList = (await rolesRes.json()) as Array<{ id: string; name: string }>;
    const targetRole = rolesList.find((r) => r.name === input.roleName);
    if (!targetRole) {
      throw new Error(`Role ${input.roleName} not found.`);
    }

    const usersRes = await adminCtx.get(
      `/api/admin/users?q=${encodeURIComponent(input.email)}`
    );
    if (!usersRes.ok()) {
      throw new Error(`GET /api/admin/users failed: ${usersRes.status()} ${await usersRes.text()}`);
    }
    const usersPayload = (await usersRes.json()) as {
      items: Array<{ id: string; email: string; approvalStatus: string }>;
    };
    const targetUser = usersPayload.items.find(
      (u) => u.email.toLowerCase() === input.email.toLowerCase()
    );
    if (!targetUser) {
      throw new Error(`User ${input.email} not found in admin list.`);
    }

    const grantPayload = {
      grants: [
        {
          roleId: targetRole.id,
          scopeType: input.scopeType,
          shopId: shopA.id,
          warehouseId: input.scopeType === 'Warehouse' ? whA1.id : null
        }
      ],
      defaultShopId: shopA.id,
      defaultWarehouseId: whA1.id
    };

    if (targetUser.approvalStatus === 'PendingApproval') {
      const approveRes = await adminCtx.post(`/api/admin/users/${targetUser.id}/approve`, {
        headers: { 'X-CSRF-Token': csrfToken },
        data: grantPayload
      });
      if (!approveRes.ok()) {
        throw new Error(`Approve failed: ${approveRes.status()} ${await approveRes.text()}`);
      }
    } else {
      const updateRes = await adminCtx.put(`/api/admin/users/${targetUser.id}/grants`, {
        headers: { 'X-CSRF-Token': csrfToken },
        data: grantPayload
      });
      if (!updateRes.ok()) {
        throw new Error(`Grant update failed: ${updateRes.status()} ${await updateRes.text()}`);
      }
    }

    return {
      shopId: shopA.id,
      shopCode: shopA.code,
      warehouseId: whA1.id,
      warehouseCode: whA1.code
    };
  } finally {
    await adminCtx.dispose();
  }
}

export async function seedStoredWebmVideoViaTus(
  server: E2eServerContext,
  operatorEmail: string,
  operatorPassword: string,
  shopInfo: ProvisionedShopInfo,
  trackingNumber: string
): Promise<string> {
  const sampleWebmPath = path.join(server.tempRoot, `seed-${Date.now()}.webm`);
  await execFileAsync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1.5:size=320x240:rate=15',
    '-c:v',
    'libvpx',
    '-b:v',
    '200k',
    '-an',
    sampleWebmPath
  ]);

  const webmBytes = fs.readFileSync(sampleWebmPath);

  const { ctx, csrfToken } = await createAuthenticatedApiContext(
    server.baseUrl,
    operatorEmail,
    operatorPassword
  );

  try {
    const createRes = await ctx.post('/api/recordings', {
      headers: { 'X-CSRF-Token': csrfToken },
      data: {
        shopId: shopInfo.shopId,
        warehouseId: shopInfo.warehouseId,
        rawCode: trackingNumber,
        formatHint: 'QrCode',
        isManualEntry: false,
        clientMimeType: 'video/webm'
      }
    });
    if (!createRes.ok()) {
      throw new Error(`Create recording failed: ${createRes.status()} ${await createRes.text()}`);
    }
    const created = (await createRes.json()) as { recording: { id: string } };
    const recordingId = created.recording.id;

    await ctx.post(`/api/recordings/${recordingId}/events`, {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { eventType: 'started', clientMimeType: 'video/webm' }
    });
    await ctx.post(`/api/recordings/${recordingId}/events`, {
      headers: { 'X-CSRF-Token': csrfToken },
      data: { eventType: 'captured', durationSeconds: 1.5 }
    });

    const uploadSessionRes = await ctx.post(`/api/recordings/${recordingId}/upload-session`, {
      headers: { 'X-CSRF-Token': csrfToken },
      data: {
        expectedBytes: webmBytes.byteLength
      }
    });
    if (!uploadSessionRes.ok()) {
      throw new Error(
        `Create upload session failed: ${uploadSessionRes.status()} ${await uploadSessionRes.text()}`
      );
    }
    const uploadSession = (await uploadSessionRes.json()) as { uploadSessionId: string };

    const metadataHeader = [
      `recordingId ${Buffer.from(recordingId, 'utf8').toString('base64')}`,
      `uploadSessionId ${Buffer.from(uploadSession.uploadSessionId, 'utf8').toString('base64')}`
    ].join(',');

    const tusCreateRes = await ctx.post('/api/uploads', {
      headers: {
        'X-CSRF-Token': csrfToken,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(webmBytes.byteLength),
        'Upload-Metadata': metadataHeader
      }
    });
    if (tusCreateRes.status() !== 201) {
      throw new Error(`tus create failed: ${tusCreateRes.status()} ${await tusCreateRes.text()}`);
    }

    const location = tusCreateRes.headers()['location'];
    if (!location) {
      throw new Error('tus response missing Location header.');
    }

    const tusPatchRes = await ctx.patch(location, {
      headers: {
        'X-CSRF-Token': csrfToken,
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream'
      },
      data: webmBytes
    });
    if (tusPatchRes.status() !== 204) {
      throw new Error(`tus PATCH failed: ${tusPatchRes.status()} ${await tusPatchRes.text()}`);
    }

    // Poll until background worker stores original & prepares preview
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const detailRes = await ctx.get(`/api/videos/${recordingId}`);
      if (detailRes.ok()) {
        const detail = (await detailRes.json()) as {
          storageStatus: string;
          previewStatus: string;
        };
        if (
          detail.storageStatus === 'Stored' &&
          (detail.previewStatus === 'Ready' || detail.previewStatus === 'NotRequired')
        ) {
          return recordingId;
        }
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    throw new Error(`Timed out waiting for recording ${recordingId} to reach Stored + Preview Ready.`);
  } finally {
    await ctx.dispose();
  }
}
