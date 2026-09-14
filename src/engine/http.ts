import type { IncomingMessage } from 'node:http';
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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
    return undiciFetch(url, { ...(init as any), dispatcher }) as unknown as Promise<Response>;
  };
}
