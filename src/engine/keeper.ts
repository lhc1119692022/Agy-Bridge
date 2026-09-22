import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeeperEvent } from '../shared/types.js';
import { sanitizeSpawnEnv } from './child-env.js';

export const KEEPER_REQUEST_HEADER = 'X-CPA-Usage-Keeper-Request';
export const KEEPER_SESSION_COOKIE = 'cpa_usage_keeper_session';
export const DEFAULT_KEEPER_PORT = 8080;

export interface KeeperInstall {
  dir: string;
  binaryPath: string;
  envPath: string;
}

export interface KeeperSettings {
  dir: string;
  binaryPath: string;
  host: string;
  port: number;
  basePath: string;
  dashboardUrl: string;
  healthUrl: string;
  apiBase: string;
  loginPassword: string;
  authEnabled: boolean;
}

export interface KeeperHandle {
  url: string;
  reused: boolean;
}

export interface KeeperEventsPage {
  events: KeeperEvent[];
  totalCount: number;
}

export function parseDotEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

export function keeperDashboardHost(host: string | undefined): string {
  const trimmed = host?.trim() ?? '';
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::' || trimmed === '*') return '127.0.0.1';
  return trimmed;
}

export function joinKeeperBasePath(basePath: string | undefined): string {
  const raw = (basePath ?? '').trim();
  if (!raw || raw === '/') return '';
  return raw.startsWith('/') ? raw.replace(/\/+$/, '') : `/${raw.replace(/\/+$/, '')}`;
}

export function settingsFromKeeperEnv(
  env: Record<string, string>,
  install: KeeperInstall,
): KeeperSettings {
  const port = Number(env.APP_PORT ?? DEFAULT_KEEPER_PORT);
  const host = keeperDashboardHost(env.APP_HOST);
  const basePath = joinKeeperBasePath(env.APP_BASE_PATH);
  const origin = `http://${host}:${Number.isFinite(port) && port > 0 ? port : DEFAULT_KEEPER_PORT}`;
  return {
    dir: install.dir,
    binaryPath: install.binaryPath,
    host,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_KEEPER_PORT,
    basePath,
    dashboardUrl: `${origin}${basePath}/`,
    healthUrl: `${origin}${basePath}/healthz`,
    apiBase: `${origin}${basePath}/api/v1`,
    loginPassword: env.LOGIN_PASSWORD ?? '',
    authEnabled: envFlag(env.AUTH_ENABLED, true),
  };
}

export function findKeeperInstall(projectDir: string): KeeperInstall | null {
  if (!projectDir) return null;
  const dir = join(projectDir, 'keeper');
  const binaryPath = process.platform === 'win32'
    ? join(dir, 'cpa-usage-keeper.exe')
    : join(dir, 'cpa-usage-keeper');
  const envPath = join(dir, '.env');
  if (!existsSync(binaryPath) || !existsSync(envPath)) return null;
  return { dir, binaryPath, envPath };
}

export function readKeeperSettings(projectDir: string): KeeperSettings | null {
  const install = findKeeperInstall(projectDir);
  if (!install) return null;
  const env = parseDotEnv(readFileSync(install.envPath, 'utf8'));
  return settingsFromKeeperEnv(env, install);
}

export function isWindowsImageRunning(imageName: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${imageName}"`, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    return false;
  }
}

export function keeperSilentLaunch(install: KeeperInstall): {
  file: string;
  args: string[];
  cwd: string;
  windowsHide: boolean;
} {
  return {
    file: install.binaryPath,
    args: [],
    cwd: install.dir,
    windowsHide: true,
  };
}

export function parseKeeperEvents(body: unknown): KeeperEventsPage {
  if (!body || typeof body !== 'object') return { events: [], totalCount: 0 };
  const record = body as {
    events?: unknown;
    total_count?: unknown;
  };
  const rows = Array.isArray(record.events) ? record.events : [];
  const events: KeeperEvent[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const tokens = item.tokens && typeof item.tokens === 'object'
      ? item.tokens as Record<string, unknown>
      : {};
    const id = String(item.id || item.request_id || '');
    const timestamp = String(item.timestamp || '');
    if (!timestamp && !id) continue;
    events.push({
      id: id || timestamp,
      timestamp,
      model: String(item.model_alias || item.model || ''),
      source: String(item.source || ''),
      endpoint: String(item.endpoint || ''),
      failed: item.failed === true,
      latencyMs: Number(item.latency_ms) || 0,
      totalTokens: Number(tokens.total_tokens) || 0,
      costUsd: Number(item.cost_usd) || 0,
    });
  }
  events.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.id.localeCompare(a.id));
  const totalCount = Number(record.total_count);
  return {
    events,
    totalCount: Number.isFinite(totalCount) ? totalCount : events.length,
  };
}

export function sessionCookieFromHeaders(headers: Headers): string | null {
  const lines = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter((value): value is string => !!value);
  for (const line of lines) {
    const match = line.match(new RegExp(`${KEEPER_SESSION_COOKIE}=([^;]+)`));
    if (match?.[1]) return match[1];
  }
  return null;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '连接被拒绝';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.status > 0) return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Keeper 未在 ${timeoutMs / 1000}s 内就绪：${lastError}`);
}

function spawnHidden(launch: { file: string; args: string[]; cwd: string }, log: (msg: string) => void): ChildProcess {
  log(`[keeper] ${launch.file}`);
  const child = spawn(launch.file, launch.args, {
    cwd: launch.cwd,
    env: sanitizeSpawnEnv({ ...process.env }),
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();
  return child;
}

export async function ensureKeeperRunning(opts: {
  projectDir: string;
  logFn?: (msg: string) => void;
}): Promise<KeeperHandle> {
  const log = opts.logFn ?? (() => {});
  const settings = readKeeperSettings(opts.projectDir);
  if (!settings) {
    throw new Error('项目里没有可用的 Keeper（需要 keeper/cpa-usage-keeper.exe 和 keeper/.env）');
  }

  try {
    await waitForHttp(settings.healthUrl, 600);
    log(`[keeper] 复用已在 ${settings.dashboardUrl} 监听的实例`);
    return { url: settings.dashboardUrl, reused: true };
  } catch {
    /* spawn */
  }

  if (isWindowsImageRunning('cpa-usage-keeper.exe')) {
    await waitForHttp(settings.healthUrl, 8000);
    log(`[keeper] 复用已在运行的 cpa-usage-keeper`);
    return { url: settings.dashboardUrl, reused: true };
  }

  log(`[keeper] 静默启动 ${settings.binaryPath}`);
  spawnHidden(keeperSilentLaunch({
    dir: settings.dir,
    binaryPath: settings.binaryPath,
    envPath: join(settings.dir, '.env'),
  }), log);
  await waitForHttp(settings.healthUrl, 12000);
  return { url: settings.dashboardUrl, reused: false };
}

export async function loginKeeperSession(settings: KeeperSettings, cookie?: string | null): Promise<string | null> {
  if (!settings.authEnabled) return cookie ?? null;
  if (!settings.loginPassword) {
    throw new Error('keeper .env 没有 LOGIN_PASSWORD，无法读取请求事件');
  }
  const res = await fetch(`${settings.apiBase}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [KEEPER_REQUEST_HEADER]: 'fetch',
      ...(cookie ? { cookie: `${KEEPER_SESSION_COOKIE}=${cookie}` } : {}),
    },
    body: JSON.stringify({ password: settings.loginPassword }),
  });
  if (!res.ok && res.status !== 204) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(res.status === 401
      ? 'Keeper 登录失败：LOGIN_PASSWORD 不正确'
      : `Keeper 登录失败 HTTP ${res.status}: ${body}`);
  }
  return sessionCookieFromHeaders(res.headers) ?? cookie ?? null;
}

async function getKeeperEventsPage(url: string, cookie: string | null): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    headers: cookie ? { cookie: `${KEEPER_SESSION_COOKIE}=${cookie}` } : {},
  });
}

export async function fetchKeeperEvents(opts: {
  settings: KeeperSettings;
  cookie?: string | null;
  pageSize?: 20 | 50 | 100;
}): Promise<{ page: KeeperEventsPage; cookie: string | null }> {
  let cookie = opts.cookie ?? null;
  const pageSize = opts.pageSize ?? 50;
  const url = `${opts.settings.apiBase}/usage/events?range=today&page=1&page_size=${pageSize}`;
  let res = await getKeeperEventsPage(url, cookie);
  if (res.status === 401 && opts.settings.authEnabled) {
    cookie = await loginKeeperSession(opts.settings, null);
    res = await getKeeperEventsPage(url, cookie);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`读取 Keeper 请求事件失败 HTTP ${res.status}: ${body}`);
  }
  return { page: parseKeeperEvents(await res.json()), cookie };
}

export async function probeKeeper(projectDir: string): Promise<{
  settings: KeeperSettings | null;
  running: boolean;
}> {
  const settings = projectDir ? readKeeperSettings(projectDir) : null;
  if (!settings) return { settings: null, running: false };
  try {
    await waitForHttp(settings.healthUrl, 400);
    return { settings, running: true };
  } catch {
    return { settings, running: isWindowsImageRunning('cpa-usage-keeper.exe') };
  }
}
