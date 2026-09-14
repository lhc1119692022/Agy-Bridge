import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AntigravityRoute, CatalogFixture } from './types.js';
import {
  injectRelayModels,
  resolveRelayCatalogSlots,
  buildListModelConfigsResponse,
  buildListExperimentsResponse,
} from './catalog.js';
import { readBody, type UpstreamFetch } from './http.js';
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
}

export interface GatewayOptions {
  templateKey?: string;
  logFn?: (msg: string) => void;
  fetchImpl?: UpstreamFetch;
}

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
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(json)),
    'grpc-status': '0',
  });
  res.end(json);
}

function isUserTurnRequest(parsed: Record<string, unknown> | undefined): boolean {
  return typeof parsed?.requestId === 'string' && parsed.requestId.startsWith('agent/');
}

async function forwardGeminiNative(
  res: http.ServerResponse,
  route: AntigravityRoute,
  parsed: Record<string, unknown>,
  stream: boolean,
  fetchImpl: UpstreamFetch,
  log: (msg: string) => void,
): Promise<void> {
  const baseURL = route.baseURL;
  if (!baseURL) {
    respondJson(res, 500, { error: { code: 500, message: 'Upstream base URL is missing' } });
    return;
  }

  const url = geminiGenerateUrl(baseURL, route.upstreamModelId, stream);
  const body = cloudCodeToGeminiBody(parsed);
  log(`[injector] ${stream ? 'stream' : 'unary'} ${route.upstreamModelId} → ${url}`);

  const upstream = await fetchImpl(url, {
    method: 'POST',
    headers: geminiUpstreamHeaders(route.apiKey, route.headers),
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    const errBody = await upstream.text();
    log(`[injector] upstream ${upstream.status}: ${errBody.slice(0, 500)}`);
    respondJson(res, upstream.status >= 500 ? 502 : upstream.status, {
      error: { code: upstream.status, message: errBody || upstream.statusText },
    });
    return;
  }

  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'grpc-status': '0',
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    const decoder = new TextDecoder();
    let leftover = '';
    for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
      leftover += decoder.decode(chunk, { stream: true });
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() ?? '';
      for (const line of lines) {
        res.write(`${wrapSseLine(line)}\n`);
      }
    }
    leftover += decoder.decode();
    if (leftover) res.write(`${wrapSseLine(leftover)}\n`);
    res.end();
    return;
  }

  const raw = await upstream.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    respondJson(res, 502, { error: { code: 502, message: `Upstream returned non-JSON: ${raw.slice(0, 200)}` } });
    return;
  }
  const wrapped = wrapGeminiAsCloudCode(sanitizeGeminiPayload(
    payload.response && typeof payload.response === 'object'
      ? payload.response as Record<string, unknown>
      : payload,
  ));
  respondJson(res, 200, wrapped);
}

export async function startInjectorGateway(
  routes: AntigravityRoute[],
  opts: GatewayOptions = {},
): Promise<GatewayHandle> {
  const templateKey = opts.templateKey ?? 'gemini-3.8-flash-high';
  const log = opts.logFn ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));

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

  let activeRoute: AntigravityRoute | undefined;
  const launchRoute = selectedSlotRoutes[0]?.route ?? routes[0];
  const resolveRouteForModel = (model: string | undefined): AntigravityRoute | undefined => {
    if (!model) return undefined;
    const direct = routeMap.get(model);
    if (direct) return direct;
    const helperPolicy = HELPER_ROUTE_POLICIES.get(model);
    if (!helperPolicy || !launchRoute) return undefined;
    if (helperPolicy === 'launch-or-active' && activeRoute) return activeRoute;
    return launchRoute;
  };

  const experimentsResponse = buildListExperimentsResponse();
  const modelConfigsResponse = buildListModelConfigsResponse(routes, injectedCatalog, templateKey);
  const userSettings = {
    telemetryEnabled: false,
    userDataCollectionForceDisabled: true,
    marketingEmailsEnabled: false,
  };

  const server = http.createServer((req, res) => {
    readBody(req).then(bodyStr => {
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
        respondJson(res, 200, injectedCatalog);
        return;
      }
      if (lowerUrl.includes('modelconfigs')) {
        respondJson(res, 200, modelConfigsResponse);
        return;
      }
      if (lowerUrl.includes('generatecontent') || lowerUrl.includes('generatechat')) {
        const model = parsed?.model as string | undefined;
        const route = resolveRouteForModel(model);
        if (!route) {
          respondJson(res, 403, {
            error: { code: 403, message: `Unknown model "${model ?? 'unknown'}"` },
          });
          return;
        }
        if (selectedSlotIds.has(model ?? '') && isUserTurnRequest(parsed)) {
          activeRoute = route;
        }
        const stream = lowerUrl.includes('stream');
        forwardGeminiNative(res, route, parsed ?? {}, stream, fetchImpl, log).catch(err => {
          log(`[injector] forward error: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) {
            respondJson(res, 500, { error: { code: 500, message: err instanceof Error ? err.message : String(err) } });
          } else if (!res.writableEnded) {
            res.end();
          }
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
      respondJson(res, 400, { error: { code: 400, message: `Failed to read request: ${err instanceof Error ? err.message : String(err)}` } });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        resolve({
          port,
          url: `http://127.0.0.1:${port}`,
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
