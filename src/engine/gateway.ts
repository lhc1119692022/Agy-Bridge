import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AntigravityRoute, CatalogFixture } from './types.js';
import {
  injectRelayModels,
  resolveRelayCatalogSlots,
  buildListModelConfigsResponse,
  buildListExperimentsResponse,
} from './catalog.js';
import { BodyTooLargeError, readBody, type UpstreamFetch } from './http.js';
import {
  cloudCodeToGeminiBody,
  geminiGenerateUrl,
  geminiUpstreamHeaders,
  wrapGeminiAsCloudCode,
  wrapSseLine,
  sanitizeGeminiPayload,
} from './gemini-native.js';
import loadCodeAssistFixture from './fixtures/loadCodeAssist.json' with { type: 'json' };
import catalogFixtureRaw from './fixtures/fetchAvailableModels.json' with { type: 'json' };

export interface GatewayHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
  update: (routes: AntigravityRoute[]) => void;
}

export interface GatewayAuditEvent {
  requestId: string;
  catalogModel: string;
  upstreamModel: string;
  status: number;
  latencyMs: number;
  streamed: boolean;
  retryCount: number;
  errorKind?: 'timeout' | 'network' | 'protocol' | 'upstream' | 'request';
}

export interface GatewayOptions {
  templateKey?: string;
  logFn?: (msg: string) => void;
  fetchImpl?: UpstreamFetch;
  /** Bind this port. 0 (default) lets the OS pick an ephemeral port. */
  port?: number;
  unaryTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxBodyBytes?: number;
  maxTransientRetries?: number;
  auditFn?: (event: GatewayAuditEvent) => void;
}

export const DEFAULT_UNARY_TIMEOUT_MS = 300_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_TRANSIENT_RETRIES = 1;

const HELPER_ROUTE_POLICIES = new Map<string, 'launch' | 'launch-or-active'>([
  ['gemini-2.5-flash', 'launch-or-active'],
  ['gemini-2.5-flash-lite', 'launch'],
  ['gemini-3-flash-agent', 'launch'],
  ['gemini-3.1-flash-lite', 'launch'],
  ['gemini-3.5-flash-lite', 'launch'],
  ['models/proactive-observer', 'launch-or-active'],
  ['models/proactive-observer-v10', 'launch-or-active'],
  ['proactive-observer', 'launch-or-active'],
  ['proactive-observer-v10', 'launch-or-active'],
]);

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(json)),
    'grpc-status': '0',
  });
  res.end(json);
}

function respondCloudCodeError(res: http.ServerResponse, status: number, message: string): void {
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  respondJson(res, status, {
    error: {
      code: status,
      message,
      status: status >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT',
    },
  });
}

function abortReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return 'aborted';
}

function isUserTurnRequest(parsed: Record<string, unknown> | undefined): boolean {
  return typeof parsed?.requestId === 'string' && parsed.requestId.startsWith('agent/');
}

interface ForwardTimeouts {
  unaryMs: number;
  streamIdleMs: number;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function armAbortOnClientGone(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  abort: (reason: string) => void,
): () => void {
  const onGone = () => {
    if (!res.writableEnded) abort('client-disconnect');
  };
  req.on('close', onGone);
  res.on('close', onGone);
  return () => {
    req.off('close', onGone);
    res.off('close', onGone);
  };
}

async function forwardGeminiNative(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: AntigravityRoute,
  parsed: Record<string, unknown>,
  stream: boolean,
  fetchImpl: UpstreamFetch,
  log: (msg: string) => void,
  timeouts: ForwardTimeouts,
  auditFn: GatewayOptions['auditFn'],
  maxTransientRetries: number,
): Promise<void> {
  const started = Date.now();
  const kind = stream ? 'stream' : 'unary';
  const catalogModel = typeof parsed.model === 'string' ? parsed.model : 'unknown';
  const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : randomUUID();
  let status = 500;
  let retryCount = 0;
  let errorKind: GatewayAuditEvent['errorKind'];
  const baseURL = route.baseURL;
  if (!baseURL) {
    errorKind = 'request';
    respondCloudCodeError(res, 500, 'Upstream base URL is missing');
    auditFn?.({
      requestId,
      catalogModel,
      upstreamModel: route.upstreamModelId,
      status,
      latencyMs: Date.now() - started,
      streamed: stream,
      retryCount,
      errorKind,
    });
    return;
  }

  const url = geminiGenerateUrl(baseURL, route.upstreamModelId, stream);
  const body = cloudCodeToGeminiBody(parsed);
  const ac = new AbortController();
  const abort = (reason: string) => {
    if (!ac.signal.aborted) ac.abort(reason);
  };
  const detachClient = armAbortOnClientGone(req, res, abort);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abort('timeout'),
      stream ? timeouts.streamIdleMs : timeouts.unaryMs,
    );
  };
  armIdle();

  const elapsed = () => `${Date.now() - started}ms`;
  const finishLog = (status: string, extra = '') => {
    log(`[injector] ${kind} ${route.upstreamModelId} ${status} ${elapsed()}${extra ? ` ${extra}` : ''}`);
  };
  const fetchWithRecovery = async (targetUrl: string): Promise<Response> => {
    while (true) {
      try {
        const response = await fetchImpl(targetUrl, {
          method: 'POST',
          headers: geminiUpstreamHeaders(route.apiKey, route.headers),
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!isTransientStatus(response.status) || retryCount >= maxTransientRetries) {
          return response;
        }
        await response.text().catch(() => '');
        retryCount += 1;
        log(`[injector] retry ${route.upstreamModelId} status=${response.status} attempt=${retryCount}`);
      } catch (error) {
        if (ac.signal.aborted || isAbortError(error) || retryCount >= maxTransientRetries) {
          throw error;
        }
        retryCount += 1;
        log(`[injector] retry ${route.upstreamModelId} network attempt=${retryCount}`);
      }
    }
  };

  try {
    log(`[injector] ${kind} ${route.upstreamModelId} → ${url}`);
    let upstream = await fetchWithRecovery(url);

    if (!upstream.ok) {
      const errBody = await upstream.text();
      const message = errBody || upstream.statusText;
      status = upstream.status >= 500 ? 502 : upstream.status;
      errorKind = isTransientStatus(upstream.status) ? 'upstream' : 'protocol';
      finishLog(String(upstream.status), message.slice(0, 200));
      respondCloudCodeError(res, status, message);
      return;
    }

    if (stream) {
      const iterator = upstream.body
        ? (upstream.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
        : null;
      let firstChunk: IteratorResult<Uint8Array> | undefined;
      if (iterator) {
        do {
          firstChunk = await iterator.next();
        } while (!firstChunk.done && firstChunk.value.byteLength === 0);
      }
      if (!firstChunk || firstChunk.done) {
        retryCount += 1;
        const fallbackUrl = geminiGenerateUrl(baseURL, route.upstreamModelId, false);
        log(`[injector] stream empty, retrying unary ${route.upstreamModelId}`);
        upstream = await fetchWithRecovery(fallbackUrl);
        if (!upstream.ok) {
          const message = await upstream.text() || upstream.statusText;
          status = upstream.status >= 500 ? 502 : upstream.status;
          errorKind = isTransientStatus(upstream.status) ? 'upstream' : 'protocol';
          respondCloudCodeError(res, status, message);
          return;
        }
        const raw = await upstream.text();
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          status = 502;
          errorKind = 'protocol';
          respondCloudCodeError(res, status, `Upstream returned non-JSON: ${raw.slice(0, 200)}`);
          return;
        }
        status = 200;
        const wrapped = wrapGeminiAsCloudCode(sanitizeGeminiPayload(
          payload.response && typeof payload.response === 'object'
            ? payload.response as Record<string, unknown>
            : payload,
        ));
        if (!res.headersSent) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'grpc-status': '0',
          });
        }
        res.end(`data: ${JSON.stringify(wrapped)}\n\n`);
        return;
      }
      if (!res.headersSent) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'grpc-status': '0',
        });
      }
      const decoder = new TextDecoder();
      let leftover = '';
      const forwardChunk = (chunk: Uint8Array): void => {
        if (ac.signal.aborted) return;
        armIdle();
        leftover += decoder.decode(chunk, { stream: true });
        const lines = leftover.split(/\r?\n/);
        leftover = lines.pop() ?? '';
        for (const line of lines) {
          if (!res.writableEnded) res.write(`${wrapSseLine(line)}\n`);
        }
      };
      forwardChunk(firstChunk.value);
      while (!ac.signal.aborted) {
        const next = await iterator!.next();
        if (next.done) break;
        forwardChunk(next.value);
      }
      leftover += decoder.decode();
      if (leftover && !res.writableEnded) res.write(`${wrapSseLine(leftover)}\n`);
      if (!res.writableEnded) res.end();
      status = 200;
      finishLog(ac.signal.aborted ? abortReason(ac.signal) : '200');
      return;
    }

    const raw = await upstream.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      status = 502;
      errorKind = 'protocol';
      finishLog('502', 'non-JSON');
      respondCloudCodeError(res, 502, `Upstream returned non-JSON: ${raw.slice(0, 200)}`);
      return;
    }
    const wrapped = wrapGeminiAsCloudCode(sanitizeGeminiPayload(
      payload.response && typeof payload.response === 'object'
        ? payload.response as Record<string, unknown>
        : payload,
    ));
    status = 200;
    finishLog('200');
    respondJson(res, 200, wrapped);
  } catch (err) {
    if (ac.signal.aborted) {
      const reason = abortReason(ac.signal);
      status = reason === 'timeout' ? 504 : 499;
      errorKind = reason === 'timeout' ? 'timeout' : 'network';
      finishLog(reason);
      if (reason === 'timeout') respondCloudCodeError(res, 504, 'Upstream timed out');
      else if (!res.headersSent && !res.writableEnded) respondCloudCodeError(res, 499, 'Client disconnected');
      else if (!res.writableEnded) res.end();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    errorKind = 'network';
    status = 502;
    finishLog('502', message);
    respondCloudCodeError(res, 502, message);
  } finally {
    clearTimeout(idleTimer);
    detachClient();
    auditFn?.({
      requestId,
      catalogModel,
      upstreamModel: route.upstreamModelId,
      status,
      latencyMs: Date.now() - started,
      streamed: stream,
      retryCount,
      ...(errorKind ? { errorKind } : {}),
    });
  }
}

interface GatewaySession {
  routes: AntigravityRoute[];
  injectedCatalog: CatalogFixture;
  selectedSlotIds: Set<string>;
  routeMap: Map<string, AntigravityRoute>;
  launchRoute: AntigravityRoute | undefined;
  activeRoute: AntigravityRoute | undefined;
  modelConfigsResponse: unknown;
}

function buildGatewaySession(
  routes: AntigravityRoute[],
  templateKey: string,
  previous?: GatewaySession,
): GatewaySession {
  const catalogFixture = catalogFixtureRaw as unknown as CatalogFixture;
  const injectedCatalog = injectRelayModels(catalogFixture, routes, templateKey);
  const selectedSlotRoutes = resolveRelayCatalogSlots(injectedCatalog, routes, templateKey);
  const selectedSlotIds = new Set<string>();
  const routeMap = new Map<string, AntigravityRoute>();
  for (const { slotId, route } of selectedSlotRoutes) {
    selectedSlotIds.add(slotId);
    routeMap.set(slotId, route);
    routeMap.set(route.catalogId, route);
  }
  const launchRoute = selectedSlotRoutes[0]?.route ?? routes[0];
  let activeRoute: AntigravityRoute | undefined;
  if (previous?.activeRoute) {
    activeRoute = routeMap.get(previous.activeRoute.catalogId)
      ?? [...routeMap.values()].find(item => item.upstreamModelId === previous.activeRoute?.upstreamModelId);
  }
  return {
    routes,
    injectedCatalog,
    selectedSlotIds,
    routeMap,
    launchRoute,
    activeRoute,
    modelConfigsResponse: buildListModelConfigsResponse(routes, injectedCatalog, templateKey),
  };
}

export async function startInjectorGateway(
  routes: AntigravityRoute[],
  opts: GatewayOptions = {},
): Promise<GatewayHandle> {
  const templateKey = opts.templateKey ?? 'gemini-3.8-flash-high';
  const log = opts.logFn ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeouts: ForwardTimeouts = {
    unaryMs: opts.unaryTimeoutMs ?? DEFAULT_UNARY_TIMEOUT_MS,
    streamIdleMs: opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  };
  const maxBodyBytes = Number.isFinite(opts.maxBodyBytes) && (opts.maxBodyBytes ?? 0) > 0
    ? Math.floor(opts.maxBodyBytes!)
    : DEFAULT_MAX_BODY_BYTES;
  const configuredRetries = opts.maxTransientRetries ?? DEFAULT_TRANSIENT_RETRIES;
  const maxTransientRetries = Number.isFinite(configuredRetries)
    ? Math.min(3, Math.max(0, Math.floor(configuredRetries)))
    : DEFAULT_TRANSIENT_RETRIES;

  let session = buildGatewaySession(routes, templateKey);
  const resolveRouteForModel = (model: string | undefined): AntigravityRoute | undefined => {
    if (!model) return undefined;
    const direct = session.routeMap.get(model);
    if (direct) return direct;
    const helperPolicy = HELPER_ROUTE_POLICIES.get(model);
    if (!helperPolicy || !session.launchRoute) return undefined;
    if (helperPolicy === 'launch-or-active' && session.activeRoute) return session.activeRoute;
    return session.launchRoute;
  };

  const experimentsResponse = buildListExperimentsResponse();
  const userSettings = {
    telemetryEnabled: false,
    userDataCollectionForceDisabled: true,
    marketingEmailsEnabled: false,
  };

  const server = http.createServer((req, res) => {
    readBody(req, maxBodyBytes).then(bodyStr => {
      const url = req.url || '';
      const lowerUrl = url.toLowerCase();
      const contentType = (req.headers['content-type'] ?? '').toLowerCase();

      if (contentType.includes('proto') || (contentType.includes('grpc') && !contentType.includes('json'))) {
        respondJson(res, 415, { error: { code: 415, message: `Gateway only supports JSON. Received: ${contentType}` } });
        return;
      }

      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(bodyStr) as Record<string, unknown>; } catch { /* empty */ }

      if (lowerUrl.includes('loadcodeassist')) {
        respondJson(res, 200, loadCodeAssistFixture);
        return;
      }
      if (lowerUrl.includes('fetchavailablemodels') || lowerUrl.includes('getavailablemodels')) {
        respondJson(res, 200, session.injectedCatalog);
        return;
      }
      if (lowerUrl.includes('modelconfigs')) {
        respondJson(res, 200, session.modelConfigsResponse);
        return;
      }
      if (lowerUrl.includes('generatecontent') || lowerUrl.includes('generatechat')) {
        const model = parsed?.model as string | undefined;
        const route = resolveRouteForModel(model);
        if (!route) {
          respondCloudCodeError(res, 403, `Unknown model "${model ?? 'unknown'}"`);
          return;
        }
        if (session.selectedSlotIds.has(model ?? '') && isUserTurnRequest(parsed)) {
          session.activeRoute = route;
        }
        const stream = lowerUrl.includes('stream');
        forwardGeminiNative(req, res, route, parsed ?? {}, stream, fetchImpl, log, timeouts, opts.auditFn, maxTransientRetries).catch(err => {
          log(`[injector] forward error: ${err instanceof Error ? err.message : String(err)}`);
          respondCloudCodeError(res, 500, err instanceof Error ? err.message : String(err));
        });
        return;
      }
      if (lowerUrl.includes('fetchadmincontrols') || lowerUrl.includes('record') || lowerUrl.includes('feedback') || lowerUrl.includes('metrics') || lowerUrl.includes('migrate')) {
        respondJson(res, 200, {});
        return;
      }
      if (lowerUrl.includes('userquota')) {
        respondJson(res, 200, { quotaSummary: { remainingQueries: 9999, totalQueries: 9999, quotaType: 'BRIDGE_UNLIMITED' } });
        return;
      }
      if (lowerUrl.includes('userinfo')) {
        respondJson(res, 200, { userSettings, regionCode: 'US' });
        return;
      }
      if (lowerUrl.includes('usersettings')) {
        respondJson(res, 200, { userSettings });
        return;
      }
      if (lowerUrl.includes('experiments') || lowerUrl.includes('experimentstatus')) {
        respondJson(res, 200, experimentsResponse);
        return;
      }
      if (lowerUrl.includes('onboarduser')) {
        respondJson(res, 200, {
          name: 'operations/cmpf.DONE_OPERATION',
          done: true,
          response: {
            '@type': 'type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse',
            cloudaicompanionProject: { id: 'agy-bridge-local', name: 'agy-bridge-local', projectNumber: '0' },
            status: {
              statusCode: 'NOTICE',
              displayMessage: 'Agy Bridge Cloud Code gateway is connected.',
              messageTitle: 'Welcome to Gemini Code Assist',
            },
          },
        });
        return;
      }
      if (lowerUrl.includes('snippet')) { respondJson(res, 200, { snippets: [] }); return; }
      if (lowerUrl.includes('cascadenux') || lowerUrl.includes('listcascade')) { respondJson(res, 200, { cascadeNuxes: [] }); return; }
      if (lowerUrl.includes('denylist') || lowerUrl.includes('checkurl')) { respondJson(res, 200, { denied: false }); return; }
      if (lowerUrl.includes('plugin')) { respondJson(res, 200, { plugins: [] }); return; }
      if (lowerUrl.includes('counttokens')) { respondJson(res, 200, { tokenCount: 0, totalTokens: 0 }); return; }
      if (lowerUrl.includes('listremote') || lowerUrl.includes('listcloudai') || lowerUrl.includes('companionproject')) {
        respondJson(res, 200, { projects: [] });
        return;
      }
      if (url === '/' || lowerUrl.includes('health')) {
        respondJson(res, 200, { status: 'ok', engine: 'agy-bridge', requestId: randomUUID() });
        return;
      }
      respondJson(res, 200, {});
    }).catch(err => {
      if (err instanceof BodyTooLargeError) {
        respondCloudCodeError(res, 413, `Request body exceeds the ${err.maxBytes} byte limit`);
        return;
      }
      respondJson(res, 400, { error: { code: 400, message: `Failed to read request: ${err instanceof Error ? err.message : String(err)}` } });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        resolve({
          port,
          url: `http://127.0.0.1:${port}`,
          update: nextRoutes => {
            session = buildGatewaySession(nextRoutes, templateKey, session);
            log(`[injector] hot-updated ${nextRoutes.length} route(s)`);
          },
          close: () => new Promise<void>((done, fail) => {
            server.closeAllConnections();
            server.close(err => {
              const code = (err as NodeJS.ErrnoException | undefined)?.code;
              if (err && code !== 'ERR_SERVER_NOT_RUNNING') fail(err);
              else done();
            });
          }),
        });
      } else {
        reject(new Error('Failed to get injector address'));
      }
    });
  });
}
