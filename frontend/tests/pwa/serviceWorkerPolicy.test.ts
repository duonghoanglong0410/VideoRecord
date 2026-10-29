// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface SimulatedSwHarness {
  dispatchFetch: (request: Request) => {
    intercepted: boolean;
    responsePromise: Promise<Response> | null;
  };
  dispatchInstall: () => Promise<void>;
  getCachedUrls: () => string[];
  fetchSpy: ReturnType<typeof vi.fn>;
  cachePutSpy: ReturnType<typeof vi.fn>;
}

function createServiceWorkerHarness(
  origin = 'https://packing.example.vn',
  networkHandler?: (req: Request) => Promise<Response>
): SimulatedSwHarness {
  const swPath = resolve(__dirname, '../../public/sw.js');
  const swSource = readFileSync(swPath, 'utf8');

  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const storedEntries = new Map<string, Response>();

  const cachePutSpy = vi.fn(async (req: Request | string, res: Response) => {
    const key = typeof req === 'string' ? new URL(req, origin).href : req.url;
    storedEntries.set(key, res);
  });

  const cacheObject = {
    match: vi.fn(async (req: Request | string) => {
      const key = typeof req === 'string' ? new URL(req, origin).href : req.url;
      const found = storedEntries.get(key);
      return found ? found.clone() : undefined;
    }),
    put: cachePutSpy,
    addAll: vi.fn(async (urls: string[]) => {
      for (const rel of urls) {
        const fullUrl = new URL(rel, origin).href;
        storedEntries.set(
          fullUrl,
          new Response(`precached:${rel}`, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' }
          })
        );
      }
    })
  };

  const cachesMock = {
    open: vi.fn(async () => cacheObject),
    keys: vi.fn(async () => ['packingproof-app-shell-v1']),
    delete: vi.fn(async () => true)
  };

  const defaultNetworkHandler = async (req: Request): Promise<Response> =>
    new Response(`network:${req.url}`, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'public, max-age=31536000'
      }
    });

  const fetchSpy = vi.fn(networkHandler ?? defaultNetworkHandler);

  const selfMock = {
    location: new URL(origin),
    caches: cachesMock,
    fetch: fetchSpy,
    skipWaiting: vi.fn(async () => undefined),
    clients: {
      claim: vi.fn(async () => undefined)
    },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const existing = listeners.get(type) ?? [];
      existing.push(handler);
      listeners.set(type, existing);
    }
  };

  const context = vm.createContext({
    self: selfMock,
    caches: cachesMock,
    fetch: fetchSpy,
    URL,
    Request,
    Response,
    Headers
  });

  vm.runInContext(swSource, context, { filename: 'sw.js' });

  return {
    fetchSpy,
    cachePutSpy,
    getCachedUrls: () => Array.from(storedEntries.keys()),
    async dispatchInstall() {
      const pending: Array<Promise<unknown>> = [];
      for (const handler of listeners.get('install') ?? []) {
        handler({
          waitUntil: (p: Promise<unknown>) => {
            pending.push(p);
          }
        });
      }
      await Promise.all(pending);
    },
    dispatchFetch(request: Request) {
      let intercepted = false;
      let responsePromise: Promise<Response> | null = null;

      for (const handler of listeners.get('fetch') ?? []) {
        handler({
          request,
          respondWith: (p: Promise<Response>) => {
            intercepted = true;
            responsePromise = p;
          }
        });
      }

      return { intercepted, responsePromise };
    }
  };
}

describe('PackingProof PWA Service Worker strict cache policy (sw.js)', () => {
  const origin = 'https://packing.example.vn';

  it('strictly bypasses all /api/*, /health/*, /openapi/*, video stream/download, Range, and non-GET tus requests', () => {
    const harness = createServiceWorkerHarness(origin);

    const forbiddenRequests: Request[] = [
      new Request(`${origin}/api/auth/me`, { method: 'GET' }),
      new Request(`${origin}/api/videos?page=1`, { method: 'GET' }),
      new Request(`${origin}/api/videos/550e8400-e29b-41d4-a716-446655440000/stream`, {
        method: 'GET'
      }),
      new Request(`${origin}/api/videos/550e8400-e29b-41d4-a716-446655440000/download`, {
        method: 'GET'
      }),
      new Request(`${origin}/api/recordings`, {
        method: 'POST',
        body: JSON.stringify({ trackingNumber: '001234' })
      }),
      new Request(`${origin}/api/uploads`, { method: 'POST' }),
      new Request(`${origin}/api/uploads/tus-file-123`, {
        method: 'PATCH',
        body: new Uint8Array([1, 2, 3])
      }),
      new Request(`${origin}/api/uploads/tus-file-123`, { method: 'HEAD' }),
      new Request(`${origin}/health/live`, { method: 'GET' }),
      new Request(`${origin}/health/ready`, { method: 'GET' }),
      new Request(`${origin}/openapi/v1.json`, { method: 'GET' }),
      // Any request carrying an HTTP Range header (even outside /api) MUST be bypassed
      new Request(`${origin}/assets/index-abc123.js`, {
        method: 'GET',
        headers: { Range: 'bytes=0-1023' }
      }),
      // Any direct video file extension MUST be bypassed
      new Request(`${origin}/media/sample_preview.mp4`, { method: 'GET' }),
      // Cross-origin static assets MUST be bypassed
      new Request('https://cdn.other-domain.example/assets/app.js', { method: 'GET' })
    ];

    for (const req of forbiddenRequests) {
      const outcome = harness.dispatchFetch(req);
      expect(
        outcome.intercepted,
        `Expected sw.js NOT to intercept ${req.method} ${req.url}`
      ).toBe(false);
    }

    expect(harness.cachePutSpy).not.toHaveBeenCalled();
    expect(harness.getCachedUrls()).toHaveLength(0);
  });

  it('intercepts and caches only same-origin static App Shell assets and refuses private/no-store or 206 responses', async () => {
    const harness = createServiceWorkerHarness(origin, async (req) => {
      if (req.url.endsWith('private-shell.js')) {
        return new Response('console.log("private");', {
          status: 200,
          headers: { 'Cache-Control': 'private, no-store' }
        });
      }
      if (req.url.endsWith('partial.js')) {
        return new Response('partial', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-6/100' }
        });
      }
      return new Response(`asset:${req.url}`, {
        status: 200,
        headers: { 'Cache-Control': 'public, max-age=31536000' }
      });
    });

    await harness.dispatchInstall();
    expect(harness.getCachedUrls()).toContain(`${origin}/index.html`);
    expect(harness.getCachedUrls()).toContain(`${origin}/manifest.webmanifest`);
    expect(harness.getCachedUrls()).toContain(`${origin}/icons/icon-192.svg`);

    const bundleReq = new Request(`${origin}/assets/index-9f8e7d.js`, { method: 'GET' });
    const bundleOutcome = harness.dispatchFetch(bundleReq);
    expect(bundleOutcome.intercepted).toBe(true);
    const bundleRes = await bundleOutcome.responsePromise!;
    expect(bundleRes.status).toBe(200);
    expect(harness.getCachedUrls()).toContain(`${origin}/assets/index-9f8e7d.js`);

    const cssReq = new Request(`${origin}/assets/index-1a2b3c.css`, { method: 'GET' });
    const cssOutcome = harness.dispatchFetch(cssReq);
    expect(cssOutcome.intercepted).toBe(true);
    await cssOutcome.responsePromise!;
    expect(harness.getCachedUrls()).toContain(`${origin}/assets/index-1a2b3c.css`);

    // Defense-in-depth: even on /assets/*.js, responses marked private/no-store or 206 are NEVER cached
    const privateAssetOutcome = harness.dispatchFetch(
      new Request(`${origin}/assets/private-shell.js`, { method: 'GET' })
    );
    expect(privateAssetOutcome.intercepted).toBe(true);
    await privateAssetOutcome.responsePromise!;
    expect(harness.getCachedUrls()).not.toContain(`${origin}/assets/private-shell.js`);

    const partialAssetOutcome = harness.dispatchFetch(
      new Request(`${origin}/assets/partial.js`, { method: 'GET' })
    );
    expect(partialAssetOutcome.intercepted).toBe(true);
    await partialAssetOutcome.responsePromise!;
    expect(harness.getCachedUrls()).not.toContain(`${origin}/assets/partial.js`);
  });
});
