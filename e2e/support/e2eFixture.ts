import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const repoRoot = path.resolve(__dirname, '..', '..');

export interface E2eServerContext {
  baseUrl: string;
  dbName: string;
  tempRoot: string;
  superAdminEmail: string;
  superAdminPassword: string;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        srv.close(() => reject(new Error('Failed to allocate dynamic TCP port.')));
        return;
      }
      const port = address.port;
      srv.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForServerReady(
  baseUrl: string,
  proc: ChildProcess,
  getLogs: () => string,
  timeoutMs = 45_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `PackingProof.Api exited prematurely with code ${proc.exitCode}.\nLogs:\n${getLogs()}`
      );
    }

    try {
      const res = await fetch(`${baseUrl}/health/ready`);
      if (res.ok) {
        const indexRes = await fetch(`${baseUrl}/`);
        if (indexRes.ok) {
          return;
        }
      }
    } catch {
      // Server still booting / migrating DB
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  throw new Error(
    `Timed out waiting for PackingProof.Api at ${baseUrl}/health/ready.\nLogs:\n${getLogs()}`
  );
}

async function dropTemporaryDatabase(dbName: string): Promise<void> {
  const client = new pg.Client({
    host: 'localhost',
    port: 5432,
    database: 'postgres',
    user: 'postgres'
  });

  try {
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE);`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export const test = base.extend<object, { e2eServer: E2eServerContext }>({
  e2eServer: [
    async ({}, use) => {
      const frontendDistDir = path.join(repoRoot, 'frontend', 'dist');
      const frontendIndex = path.join(frontendDistDir, 'index.html');
      if (!fs.existsSync(frontendIndex)) {
        throw new Error(
          `Frontend production build not found at ${frontendIndex}. Run "npm --prefix frontend run build" first.`
        );
      }

      const apiDll = path.join(
        repoRoot,
        'backend',
        'src',
        'PackingProof.Api',
        'bin',
        'Debug',
        'net10.0',
        'PackingProof.Api.dll'
      );
      if (!fs.existsSync(apiDll)) {
        throw new Error(
          `Backend build artifact not found at ${apiDll}. Run "dotnet build backend/PackingProof.slnx" first.`
        );
      }

      const port = await getFreePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const runId = randomUUID().replace(/-/g, '').slice(0, 16);
      const dbName = `packingproof_e2e_${runId}`;
      const tempRoot = path.join(os.tmpdir(), dbName);

      const nasRootPath = path.join(tempRoot, 'storage');
      const stagingRootPath = path.join(tempRoot, 'staging');
      const dpKeysPath = path.join(tempRoot, 'dp-keys');

      fs.mkdirSync(nasRootPath, { recursive: true });
      fs.mkdirSync(stagingRootPath, { recursive: true });
      fs.mkdirSync(dpKeysPath, { recursive: true });

      const superAdminEmail = 'superadmin@packingproof.e2e';
      const superAdminPassword = 'SuperAdminPass#2026!';

      const logChunks: string[] = [];
      const proc = spawn('dotnet', [apiDll, '--urls', baseUrl], {
        cwd: path.join(repoRoot, 'backend', 'src', 'PackingProof.Api'),
        env: {
          ...process.env,
          ASPNETCORE_ENVIRONMENT: 'Development',
          APP_PUBLIC_ORIGIN: baseUrl,
          FRONTEND_DIST_PATH: frontendDistDir,
          DATABASE_CONNECTION: `Host=localhost;Port=5432;Database=${dbName};Username=postgres;Pooling=false`,
          AUTH_COOKIE_NAME: 'PackingProof.E2EAuth',
          STORAGE_MODE: 'LocalDevelopment',
          NAS_ROOT_PATH: nasRootPath,
          STORAGE_ID: `e2e-storage-${runId}`,
          STAGING_ROOT_PATH: stagingRootPath,
          DATA_PROTECTION_KEYS_PATH: dpKeysPath,
          INITIAL_ADMIN_EMAIL: superAdminEmail,
          INITIAL_ADMIN_PASSWORD: superAdminPassword,
          PROCESSING_CONCURRENCY: '2',
          AUTO_MIGRATE_ON_STARTUP: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      proc.stdout?.on('data', (chunk: Buffer) => {
        logChunks.push(chunk.toString('utf8'));
        if (logChunks.length > 150) {
          logChunks.shift();
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        logChunks.push(chunk.toString('utf8'));
        if (logChunks.length > 150) {
          logChunks.shift();
        }
      });

      try {
        await waitForServerReady(baseUrl, proc, () => logChunks.join(''));

        await use({
          baseUrl,
          dbName,
          tempRoot,
          superAdminEmail,
          superAdminPassword
        });
      } finally {
        if (proc.exitCode === null) {
          await new Promise<void>((resolve) => {
            const forceKillTimer = setTimeout(() => {
              try {
                proc.kill('SIGKILL');
              } catch {
                // Ignore
              }
              resolve();
            }, 5_000);

            proc.once('exit', () => {
              clearTimeout(forceKillTimer);
              resolve();
            });

            try {
              proc.kill('SIGTERM');
            } catch {
              clearTimeout(forceKillTimer);
              resolve();
            }
          });
        }

        await dropTemporaryDatabase(dbName);
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    { scope: 'worker', auto: true }
  ],

  baseURL: async ({ e2eServer }, use) => {
    await use(e2eServer.baseUrl);
  }
});

export { expect };
