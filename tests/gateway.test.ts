import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startInjectorGateway, type GatewayHandle } from '../src/engine/gateway.js';
import type { AntigravityRoute } from '../src/engine/types.js';

const handles: GatewayHandle[] = [];
const upstreams: http.Server[] = [];

afterEach(async () => {
  while (handles.length) await handles.pop()!.close();
  while (upstreams.length) {
    const server = upstreams.pop()!;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

function listen(handler: http.RequestListener): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer(handler);
  upstreams.push(server);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no port');
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

const route = (baseURL: string): AntigravityRoute => ({
  catalogId: 'agy-bridge__remote__gemini-3-pro',
  providerId: 'remote',
  providerName: 'Test GW',
  modelId: 'gemini-3-pro',
  upstreamModelId: 'gemini-3-pro',
  displayName: 'Gemini 3 Pro (Bridge)',
  modelFormat: 'gemini-native',
  npm: '@ai-sdk/google',
  apiKey: 'test-key',
  baseURL,
  contextWindow: 1048576,
});

describe('injector gateway', () => {
  it('injects models into fetchAvailableModels', async () => {
    const handle = await startInjectorGateway([route('http://127.0.0.1:9')]);
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await res.json() as { defaultAgentModelId: string; models: Record<string, { displayName: string }> };
    expect(res.status).toBe(200);
    expect(body.defaultAgentModelId).toBe('gemini-3.5-flash-low');
    expect(body.models['gemini-3.5-flash-low']?.displayName).toContain('Gemini 3 Pro');
  });

  it('forwards generateContent to the Gemini native upstream and wraps the response', async () => {
    const seen: { url: string; body: any; headers: http.IncomingHttpHeaders }[] = [];
    const upstream = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' }],
        }));
      });
    });

    const handle = await startInjectorGateway([route(upstream.url)]);
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.5-flash-low',
        request: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      }),
    });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.response.candidates[0].content.parts[0].text).toBe('pong');
    expect(seen[0]?.url).toContain('/v1beta/models/gemini-3-pro:generateContent');
    expect(seen[0]?.body.contents[0].parts[0].text).toBe('ping');
    expect(seen[0]?.headers.authorization).toBe('Bearer test-key');
  });
});
