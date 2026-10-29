import type { HttpRequest, HttpResponse, HttpStack } from 'tus-js-client';

class FetchTusHttpResponse implements HttpResponse {
  private readonly status: number;
  private readonly headers: Headers;
  private readonly bodyText: string;
  private readonly rawResponse: Response;

  constructor(status: number, headers: Headers, bodyText: string, rawResponse: Response) {
    this.status = status;
    this.headers = headers;
    this.bodyText = bodyText;
    this.rawResponse = rawResponse;
  }

  public getStatus(): number {
    return this.status;
  }

  public getHeader(header: string): string | undefined {
    const val = this.headers.get(header);
    return val === null ? undefined : val;
  }

  public getBody(): string {
    return this.bodyText;
  }

  public getUnderlyingObject(): Response {
    return this.rawResponse;
  }
}

function getBodyByteLength(body: unknown): number {
  if (!body) {
    return 0;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.size;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  if (typeof body === 'string') {
    return new TextEncoder().encode(body).byteLength;
  }
  return 0;
}

class FetchTusHttpRequest implements HttpRequest {
  private readonly method: string;
  private readonly url: string;
  private readonly headers = new Map<string, { originalName: string; value: string }>();
  private readonly abortController = new AbortController();
  private progressHandler: ((bytesSent: number) => void) | null = null;

  constructor(method: string, url: string) {
    this.method = method.toUpperCase();
    this.url = url;
  }

  public getMethod(): string {
    return this.method;
  }

  public getURL(): string {
    return this.url;
  }

  public setHeader(header: string, value: string): void {
    this.headers.set(header.toLowerCase(), {
      originalName: header,
      value
    });
  }

  public getHeader(header: string): string | undefined {
    return this.headers.get(header.toLowerCase())?.value;
  }

  public setProgressHandler(handler: (bytesSent: number) => void): void {
    this.progressHandler = handler;
  }

  public async send(body: BodyInit | null | undefined = null): Promise<HttpResponse> {
    const headerRecord: Record<string, string> = {};
    for (const entry of this.headers.values()) {
      headerRecord[entry.originalName] = entry.value;
    }

    const totalBodyBytes = getBodyByteLength(body);
    if (totalBodyBytes > 0 && this.progressHandler) {
      this.progressHandler(0);
    }

    const canHaveBody = this.method !== 'GET' && this.method !== 'HEAD';
    const response = await fetch(this.url, {
      method: this.method,
      credentials: 'same-origin',
      headers: headerRecord,
      body: canHaveBody && body != null ? body : undefined,
      signal: this.abortController.signal
    });

    if (response.ok && totalBodyBytes > 0 && this.progressHandler) {
      this.progressHandler(totalBodyBytes);
    }

    const bodyText =
      this.method === 'HEAD' ? '' : await response.text().catch(() => '');

    return new FetchTusHttpResponse(
      response.status,
      response.headers,
      bodyText,
      response
    );
  }

  public abort(): Promise<void> {
    this.abortController.abort();
    return Promise.resolve();
  }

  public getUnderlyingObject(): AbortController {
    return this.abortController;
  }
}

/**
 * Custom `tus-js-client` HttpStack backed by `globalThis.fetch` with `credentials: 'same-origin'`,
 * `AbortController` cancellation, and case-insensitive header resolution.
 */
export class FetchTusHttpStack implements HttpStack {
  public createRequest(method: string, url: string): HttpRequest {
    return new FetchTusHttpRequest(method, url);
  }

  public getName(): string {
    return 'PackingProofFetchHttpStack';
  }
}

