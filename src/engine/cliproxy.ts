import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliproxySettings } from '../shared/types.js';
import { sanitizeSpawnEnv } from './child-env.js';
import { ensureKeeperRunning } from './keeper.js';

export interface CliproxyHandle {
  pid: number | null;
  url: string;
  reused: boolean;
  stop: () => Promise<void>;
}

export interface CliproxyAccount {
  file: string;
  type: string;
  email: string;
}

export interface CliproxyYamlInfo {
  port: number;
  authDir: string;
  apiKeys: string[];
  proxyUrl: string;
}

export function defaultAuthDir(): string {
  return join(homedir(), '.cli-proxy-api');
}

export function resolveAuthDir(authDir?: string): string {
  const raw = authDir?.trim() || defaultAuthDir();
  return raw.replace(/^~(?=[\\/]|$)/, homedir());
}

export function portFromBaseUrl(baseUrl: string | undefined, fallback = 8317): number {
  try {
    const port = Number(new URL(baseUrl || `http://127.0.0.1:${fallback}`).port);
    return port > 0 ? port : fallback;
  } catch {
    return fallback;
  }
}

export function normalizeClientKey(key: string | undefined): string {
  const trimmed = key?.trim() ?? '';
  if (!trimmed || /^agy-bridge(-dummy)?$/i.test(trimmed)) return '';
  return trimmed;
}

export function requireClientKey(key: string | undefined): string {
  const normalized = normalizeClientKey(key);
  if (!normalized) {
    throw new Error('项目 config.yaml 里没有可用的 api-keys。那是中转站客户端 Key，不是管理端登录密码。');
  }
  return normalized;
}

export function pickClientKey(saved: string | undefined, yamlKeys: string[]): string {
  const normalized = normalizeClientKey(saved);
  if (normalized && yamlKeys.includes(normalized)) return normalized;
  return yamlKeys.find(key => normalizeClientKey(key)) || normalized;
}

export function settingsFromProject(projectDir: string, saved?: { apiKey?: string }): {
  projectDir: string;
  binaryPath: string;
  port: number;
  baseUrl: string;
  apiKey: string;
  authDir: string;
  clientKeyCount: number;
} {
  const yaml = readProjectConfig(projectDir);
  const apiKey = pickClientKey(saved?.apiKey, yaml.apiKeys);
  return {
    projectDir,
    binaryPath: findBinaryInProject(projectDir) ?? '',
    port: yaml.port,
    baseUrl: `http://127.0.0.1:${yaml.port}`,
    apiKey,
    authDir: yaml.authDir,
    clientKeyCount: yaml.apiKeys.length,
  };
}

export function unquoteYaml(value: string | undefined): string {
  return (value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

export function parseCliproxyYaml(text: string): CliproxyYamlInfo {
  const port = Number(text.match(/^\s*port:\s*(\d+)\s*$/m)?.[1] ?? 8317);
  const authDir = unquoteYaml(text.match(/^\s*auth-dir:\s*(.+)$/m)?.[1]) || defaultAuthDir();
  const proxyUrl = unquoteYaml(text.match(/^\s*proxy-url:\s*(.+)$/m)?.[1]);
  const apiKeys: string[] = [];
  let inKeys = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*api-keys:\s*$/.test(line)) {
      inKeys = true;
      continue;
    }
    if (inKeys) {
      const item = line.match(/^\s*-\s*(.+)$/);
      if (item) {
        const key = unquoteYaml(item[1]);
        if (key) apiKeys.push(key);
        continue;
      }
      if (line.trim() && !line.startsWith(' ') && !line.startsWith('\t')) inKeys = false;
    }
  }
  return {
    port: Number.isFinite(port) && port > 0 ? port : 8317,
    authDir,
    apiKeys,
    proxyUrl,
  };
}

export function isRealCliproxyBinaryName(name: string): boolean {
  return /^cli-proxy-api(\.exe)?$/i.test(name);
}

export function projectLooksLikeCliproxy(entries: string[]): boolean {
  const names = entries.map(name => name.toLowerCase());
  if (!names.includes('config.yaml')) return false;
  return names.includes('start.cmd') || entries.some(isRealCliproxyBinaryName);
}

export function findBinaryInProject(projectDir: string): string | null {
  if (!projectDir || !existsSync(projectDir)) return null;
  try {
    const match = readdirSync(projectDir).find(isRealCliproxyBinaryName);
    return match ? join(projectDir, match) : null;
  } catch {
    return null;
  }
}

export function findStartScript(projectDir: string): string | null {
  const path = join(projectDir, 'start.cmd');
  return existsSync(path) ? path : null;
}

export function isCliproxyProject(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false;
  try {
    return projectLooksLikeCliproxy(readdirSync(dir));
  } catch {
    return false;
  }
}

export function cliproxyProjectCandidates(): string[] {
  const home = homedir();
  return [
    'D:\\CLIProxyAPI',
    'C:\\CLIProxyAPI',
    join('D:\\Git Project', 'CLIProxyAPI'),
    join(home, 'CLIProxyAPI'),
    join(home, 'Documents', 'CLIProxyAPI'),
    join(home, 'Desktop', 'CLIProxyAPI'),
  ];
}

export function findCliproxyProject(override = ''): string | null {
  if (override.trim() && isCliproxyProject(override.trim())) return override.trim();
  for (const dir of cliproxyProjectCandidates()) {
    if (isCliproxyProject(dir)) return dir;
  }
  const parent = 'D:\\Git Project';
  if (existsSync(parent)) {
    try {
      for (const name of readdirSync(parent)) {
        const dir = join(parent, name);
        if (isCliproxyProject(dir)) return dir;
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function readProjectConfig(projectDir: string): CliproxyYamlInfo {
  const path = join(projectDir, 'config.yaml');
  if (!existsSync(path)) throw new Error(`项目里没有 config.yaml：${path}`);
  return parseCliproxyYaml(readFileSync(path, 'utf8'));
}

export function listCliproxyAccounts(authDir?: string): CliproxyAccount[] {
  const dir = resolveAuthDir(authDir);
  if (!existsSync(dir)) return [];
  const accounts: CliproxyAccount[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const path = join(dir, file);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { type?: unknown; email?: unknown };
      const type = typeof parsed.type === 'string' ? parsed.type : 'unknown';
      const email = typeof parsed.email === 'string' ? parsed.email : file.replace(/\.json$/, '');
      accounts.push({ file, type, email });
    } catch {
      accounts.push({ file, type: 'unknown', email: file.replace(/\.json$/, '') });
    }
  }
  return accounts;
}

export interface ListedModel {
  id: string;
  name: string;
  contextWindow?: number;
}

function readContextWindow(item: Record<string, unknown>): number | undefined {
  const candidates = [
    item.contextWindow,
    item.contextWindowSize,
    item.maxContextTokens,
    item.inputTokenLimit,
    item.context_window,
  ];
  for (const value of candidates) {
    const number = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
    if (Number.isFinite(number) && number > 0) return Math.floor(number);
  }
  return undefined;
}

export function parseModelList(body: unknown): ListedModel[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const gemini = Array.isArray(record.models) ? record.models : [];
  const openai = Array.isArray(record.data) ? record.data : [];
  const rows = [...gemini, ...openai];
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const raw = String(item.id || item.name || '').replace(/^models\//, '');
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const contextWindow = readContextWindow(item);
    models.push({
      id: raw,
      name: String(item.displayName || raw),
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return models;
}

export async function listGeminiModels(opts: {
  baseUrl: string;
  apiKey: string | string[];
  headers?: Record<string, string>;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ models: ListedModel[]; apiKey: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const keys = (Array.isArray(opts.apiKey) ? opts.apiKey : [opts.apiKey])
    .map(key => normalizeClientKey(key))
    .filter(Boolean);
  if (keys.length === 0) requireClientKey('');
  const root = opts.baseUrl.replace(/\/+$/, '').replace(/\/openai$/i, '');
  const urls = [
    `${/\/v1beta$/i.test(root) ? root : `${root}/v1beta`}/models`,
    `${root.replace(/\/v1beta$/i, '')}/v1/models`,
  ];
  let lastError = '列出模型失败';
  for (const key of keys) {
    const headers = {
      Authorization: `Bearer ${key}`,
      'x-goog-api-key': key,
      ...(opts.headers ?? {}),
    };
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, { headers });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          lastError = res.status === 401
            ? '列出模型失败 HTTP 401：config.yaml 中的 api-keys 无法通过校验。'
            : `列出模型失败 HTTP ${res.status}: ${body}`;
          continue;
        }
        const models = parseModelList(await res.json());
        if (models.length > 0) return { models, apiKey: key };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  throw new Error(lastError);
}

async function waitForServer(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '连接被拒绝';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.status > 0) return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`CLIProxyAPI 未在 ${timeoutMs / 1000}s 内就绪：${lastError}`);
}

function stopRealProcess(): void {
  try {
    if (process.platform === 'win32') {
      execSync('taskkill /IM cli-proxy-api.exe /T /F', { stdio: 'ignore' });
    }
  } catch { /* not running */ }
}

export function windowsConsoleLaunch(projectDir: string, innerCommand: string): {
  file: string;
  args: string[];
} {
  const comspec = process.env.ComSpec || 'cmd.exe';
  return {
    file: comspec,
    args: ['/c', `start "CLIProxyAPI" /D "${projectDir}" cmd /k ${innerCommand}`],
  };
}

export function cliproxySilentLaunch(projectDir: string, binary: string, extraArgs: string[] = []): {
  file: string;
  args: string[];
  cwd: string;
  windowsHide: boolean;
} {
  return {
    file: binary,
    args: ['-config', join(projectDir, 'config.yaml'), ...extraArgs],
    cwd: projectDir,
    windowsHide: true,
  };
}

function spawnHidden(launch: { file: string; args: string[]; cwd: string }, log: (msg: string) => void): ChildProcess {
  log(`[cliproxy] ${launch.file} ${launch.args.join(' ')}`);
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

function openProjectConsole(projectDir: string, innerCommand: string, log: (msg: string) => void): ChildProcess {
  const launch = windowsConsoleLaunch(projectDir, innerCommand);
  log(`[cliproxy] ${launch.file} ${launch.args.join(' ')}`);
  const child = spawn(launch.file, launch.args, {
    cwd: projectDir,
    env: sanitizeSpawnEnv({ ...process.env }),
    stdio: 'ignore',
    detached: true,
    windowsHide: false,
    windowsVerbatimArguments: true,
  });
  child.unref();
  return child;
}

export async function startCliproxy(opts: {
  settings: CliproxySettings;
  logFn?: (msg: string) => void;
}): Promise<CliproxyHandle> {
  const log = opts.logFn ?? (() => {});
  const projectDir = findCliproxyProject(opts.settings.projectDir);
  if (!projectDir) {
    throw new Error('未找到 CLIProxyAPI 项目文件夹。请选择包含 config.yaml 和 start.cmd 的目录，例如 D:\\CLIProxyAPI。');
  }
  const binary = findBinaryInProject(projectDir);
  const port = opts.settings.port || portFromBaseUrl(opts.settings.baseUrl) || 8317;
  const url = `http://127.0.0.1:${port}`;
  const authDir = resolveAuthDir(opts.settings.authDir);
  mkdirSync(authDir, { recursive: true });
  const accounts = listCliproxyAccounts(authDir);
  log(`[cliproxy] 项目 ${projectDir}`);
  log(`[cliproxy] 出站代理由 CLIProxyAPI 自己的 config.yaml 负责，Agy Bridge 不读取密钥`);
  log(`[cliproxy] auth-dir ${authDir}，账号 ${accounts.length} 个`);

  try {
    await ensureKeeperRunning({ projectDir, logFn: log });
  } catch (err) {
    log(`[cliproxy] Keeper 未同步拉起：${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await waitForServer(`${url}/v1/models`, 800);
    log(`[cliproxy] 复用已在 ${url} 监听的实例`);
    return { pid: null, url, reused: true, stop: async () => { stopRealProcess(); } };
  } catch {
    /* spawn the binary hidden; do not open the management page */
  }

  if (!binary) {
    throw new Error(`项目文件夹里没有 cli-proxy-api：${projectDir}。请选择包含 config.yaml 和原项目二进制的目录。`);
  }

  log(`[cliproxy] 静默启动，不打开管理页`);
  const child = spawnHidden(cliproxySilentLaunch(projectDir, binary, opts.settings.extraArgs), log);

  try {
    await waitForServer(`${url}/v1/models`, 20000);
  } catch (err) {
    stopRealProcess();
    throw err;
  }

  return {
    pid: child.pid ?? null,
    url,
    reused: false,
    stop: async () => { stopRealProcess(); },
  };
}

export async function loginAntigravity(opts: {
  projectDir: string;
  logFn?: (msg: string) => void;
}): Promise<void> {
  const projectDir = findCliproxyProject(opts.projectDir);
  if (!projectDir) throw new Error('未找到 CLIProxyAPI 项目文件夹');
  const binary = findBinaryInProject(projectDir);
  if (!binary) throw new Error('项目文件夹里没有原项目的 cli-proxy-api，无法登录');
  const log = opts.logFn ?? (() => {});
  const configPath = join(projectDir, 'config.yaml');
  log(`[cliproxy] 新开终端执行 antigravity-login`);
  await new Promise<void>((resolve, reject) => {
    const child = openProjectConsole(
      projectDir,
      `"${binary}" -config "${configPath}" -antigravity-login`,
      log,
    );
    child.on('error', reject);
    child.on('spawn', () => resolve());
  });
}
