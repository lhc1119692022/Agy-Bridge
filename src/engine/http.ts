import type { IncomingMessage } from 'node:http';
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

export class BodyTooLargeError extends Error {
  readonly code = 'BODY_TOO_LARGE';

  constructor(readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes} byte limit`);
    this.name = 'BodyTooLargeError';
  }
}

export function readBody(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', chunk => {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        req.pause();
        fail(new BodyTooLargeError(maxBytes));
        req.resume();
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', error => fail(error));
  });
}

export type UpstreamFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function createUpstreamFetch(proxyUrl?: string): UpstreamFetch {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return (url, init) => fetch(url, init);
  }
  const dispatcher: Dispatcher = new ProxyAgent(trimmed);
  return (url, init) => {
    if (isLoopbackUrl(url)) return fetch(url, init);
    return undiciFetch(url, { ...(init as any), dispatcher, signal: init?.signal }) as unknown as Promise<Response>;
  };
}
