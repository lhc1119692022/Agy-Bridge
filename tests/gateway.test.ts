import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startInjectorGateway, type GatewayAuditEvent, type GatewayHandle } from '../src/engine/gateway.js';
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
  it('can bind a fixed injector port', async () => {
    const handle = await startInjectorGateway([route('http://127.0.0.1:9')], { port: 0 });
    handles.push(handle);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
  });

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
    expect(body.defaultAgentModelId).toBe('gemini-3.8-flash-high');
    expect(body.models['gemini-3.8-flash-high']?.displayName).toContain('Gemini 3 Pro');
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
        model: 'gemini-3.8-flash-high',
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

  it('advertises video and audio MIME types to Antigravity', async () => {
    const handle = await startInjectorGateway([route('http://127.0.0.1:9')]);
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await res.json() as {
      models: Record<string, { supportsVideo?: boolean; supportedMimeTypes?: Record<string, boolean> }>;
      audioTranscriptionModelIds?: string[];
    };
    const slot = body.models['gemini-3.8-flash-high'];
    expect(slot?.supportsVideo).toBe(true);
    expect(slot?.supportedMimeTypes?.['video/mp4']).toBe(true);
    expect(slot?.supportedMimeTypes?.['audio/mpeg']).toBe(true);
    expect(body.audioTranscriptionModelIds).toContain('models/proactive-observer-v10');
  });

  it('forwards video and remapped audio parts to the Gemini native upstream', async () => {
    const seen: { body: any }[] = [];
    const upstream = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        seen.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'seen' }] }, finishReason: 'STOP' }],
        }));
      });
    });

    const handle = await startInjectorGateway([route(upstream.url)]);
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-high',
        request: {
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'video/mp4', data: 'AAAA' } },
              { inlineData: { mimeType: 'video/audio/wav', data: 'BBBB' } },
            ],
          }],
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(seen[0]?.body.contents[0].parts).toEqual([
      { inlineData: { mimeType: 'video/mp4', data: 'AAAA' } },
      { inlineData: { mimeType: 'audio/wav', data: 'BBBB' } },
    ]);
  });

  it('routes Cloud Code audio transcription models through the launch route', async () => {
    const seen: { url: string }[] = [];
    const upstream = await listen((req, res) => {
      seen.push({ url: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      }));
    });

    const handle = await startInjectorGateway([route(upstream.url)]);
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'models/proactive-observer-v10',
        request: { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AA' } }] }] },
      }),
    });
    expect(res.status).toBe(200);
    expect(seen[0]?.url).toContain('/v1beta/models/gemini-3-pro:generateContent');
  });

  it('hot-updates catalog without changing the listen port', async () => {
    const handle = await startInjectorGateway([route('http://127.0.0.1:9')]);
    handles.push(handle);
    const port = handle.port;
    const before = await fetch(`${handle.url}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(res => res.json()) as { models: Record<string, { displayName: string }> };
    expect(before.models['gemini-3.8-flash-high']?.displayName).toContain('Gemini 3 Pro');

    handle.update([{ ...route('http://127.0.0.1:9'), displayName: 'Flash Hot (Bridge)', upstreamModelId: 'gemini-3.8-flash-high' }]);
    const after = await fetch(`${handle.url}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(res => res.json()) as { models: Record<string, { displayName: string }> };
    expect(handle.port).toBe(port);
    expect(after.models['gemini-3.8-flash-high']?.displayName).toContain('Flash Hot');
  });

  it('times out a hung unary upstream', async () => {
    const upstream = await listen(() => { /* never respond */ });
    const handle = await startInjectorGateway([route(upstream.url)], { unaryTimeoutMs: 80 });
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-high',
        request: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      }),
    });
    const body = await res.json() as { error?: { code?: number; message?: string } };
    expect(res.status).toBe(504);
    expect(body.error?.message).toMatch(/timed out/i);
  });

  it('aborts the upstream when the Antigravity client disconnects', async () => {
    let upstreamClosed = false;
    const upstream = await listen(req => {
      req.on('close', () => { upstreamClosed = true; });
    });
    const handle = await startInjectorGateway([route(upstream.url)], { unaryTimeoutMs: 5_000 });
    handles.push(handle);
    const ac = new AbortController();
    const pending = fetch(`${handle.url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-high',
        request: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      }),
      signal: ac.signal,
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    ac.abort();
    await pending.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(upstreamClosed).toBe(true);
  });

  it('wraps streamGenerateContent SSE as Cloud Code events', async () => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}\n\n');
      res.end();
    });
    const handle = await startInjectorGateway([route(upstream.url)]);
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:streamGenerateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-high',
        request: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('hi');
    expect(text).toContain('agy-bridge');
  });

  it('replays an empty stream as one SSE event from a unary retry', async () => {
    const seenUrls: string[] = [];
    const upstream = await listen((req, res) => {
      seenUrls.push(req.url ?? '');
      if (req.url?.includes('streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'replayed' }] } }],
      }));
    });

    const handle = await startInjectorGateway([route(upstream.url)]);
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:streamGenerateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-high',
        request: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toMatch(/^data: /);
    expect(text).toContain('replayed');
    expect(seenUrls).toHaveLength(2);
    expect(seenUrls[0]).toContain('streamGenerateContent');
    expect(seenUrls[1]).toContain('generateContent');
    expect(seenUrls[1]).not.toContain('streamGenerateContent');
  });

  it('rejects oversized request bodies before contacting the upstream', async () => {
    let upstreamCalls = 0;
    const upstream = await listen((_req, res) => {
      upstreamCalls += 1;
      res.writeHead(500);
      res.end();
    });
    const handle = await startInjectorGateway([route(upstream.url)], { maxBodyBytes: 64 });
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-high',
        request: { contents: [{ role: 'user', parts: [{ text: 'x'.repeat(200) }] }] },
      }),
    });
    const body = await res.json() as { error?: { message?: string } };
    expect(res.status).toBe(413);
    expect(body.error?.message).toMatch(/64 byte limit/);
    expect(upstreamCalls).toBe(0);
  });

  it('emits an audit event with the catalog and upstream route', async () => {
    const events: GatewayAuditEvent[] = [];
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [] }));
    });
    const handle = await startInjectorGateway([route(upstream.url)], {
      auditFn: event => events.push(event),
    });
    handles.push(handle);
    await fetch(`${handle.url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'agent/test-audit',
        model: 'gemini-3.8-flash-high',
        request: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      }),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      requestId: 'agent/test-audit',
      catalogModel: 'gemini-3.8-flash-high',
      upstreamModel: 'gemini-3-pro',
      status: 200,
      streamed: false,
      retryCount: 0,
    });
    expect(events[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('retries one transient upstream failure', async () => {
    let calls = 0;
    const upstream = await listen((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('temporarily unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [] }));
    });
    const events: GatewayAuditEvent[] = [];
    const handle = await startInjectorGateway([route(upstream.url)], { auditFn: event => events.push(event) });
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-high',
        request: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      }),
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(events[0]).toMatchObject({ status: 200, retryCount: 1 });
  });

  it('does not retry an authentication or parameter error', async () => {
    let calls = 0;
    const upstream = await listen((_req, res) => {
      calls += 1;
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('invalid api key');
    });
    const events: GatewayAuditEvent[] = [];
    const handle = await startInjectorGateway([route(upstream.url)], { auditFn: event => events.push(event) });
    handles.push(handle);
    const res = await fetch(`${handle.url}/v1internal:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-high',
        request: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      }),
    });
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
    expect(events[0]).toMatchObject({ status: 401, retryCount: 0, errorKind: 'protocol' });
  });
});
