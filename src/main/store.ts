import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_INJECTOR_PORT, LOCAL_UPSTREAM_ID, type AppConfig, type Upstream } from '../shared/types.js';
import { getConfigPath } from './paths.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(raw: unknown): AppConfig {
  const base: AppConfig = structuredClone(DEFAULT_CONFIG);
  if (!isObject(raw)) return base;
  if (Array.isArray(raw.upstreams)) {
    base.upstreams = raw.upstreams.filter(item => isObject(item) && typeof item.id === 'string') as Upstream[];
  }
  if (typeof raw.activeUpstreamId === 'string' || raw.activeUpstreamId === null) {
    base.activeUpstreamId = raw.activeUpstreamId as string | null;
  }
  if (Array.isArray(raw.selectedModelIds)) {
    base.selectedModelIds = raw.selectedModelIds.filter(id => typeof id === 'string') as string[];
  }
  if (typeof raw.proxyEnabled === 'boolean') base.proxyEnabled = raw.proxyEnabled;
  if (typeof raw.proxyUrl === 'string') base.proxyUrl = raw.proxyUrl;
  if (typeof raw.injectorPort === 'number' && raw.injectorPort >= 0 && raw.injectorPort <= 65535) {
    base.injectorPort = raw.injectorPort || DEFAULT_INJECTOR_PORT;
  }
  if (isObject(raw.cliproxy)) {
    if (typeof raw.cliproxy.projectDir === 'string') base.cliproxy.projectDir = raw.cliproxy.projectDir;
    if (typeof raw.cliproxy.binaryPath === 'string') base.cliproxy.binaryPath = raw.cliproxy.binaryPath;
    if (typeof raw.cliproxy.port === 'number') base.cliproxy.port = raw.cliproxy.port;
    if (typeof raw.cliproxy.apiKey === 'string') base.cliproxy.apiKey = raw.cliproxy.apiKey;
    if (typeof raw.cliproxy.managementKey === 'string') base.cliproxy.managementKey = raw.cliproxy.managementKey;
    if (typeof raw.cliproxy.baseUrl === 'string') base.cliproxy.baseUrl = raw.cliproxy.baseUrl;
    if (Array.isArray(raw.cliproxy.extraArgs)) {
      base.cliproxy.extraArgs = raw.cliproxy.extraArgs.filter(arg => typeof arg === 'string') as string[];
    }
    if (typeof raw.cliproxy.authDir === 'string') base.cliproxy.authDir = raw.cliproxy.authDir;
  }
  if (isObject(raw.antigravity)) {
    if (typeof raw.antigravity.appPath === 'string') base.antigravity.appPath = raw.antigravity.appPath;
    if (typeof raw.antigravity.idePath === 'string') base.antigravity.idePath = raw.antigravity.idePath;
    if (raw.antigravity.target === 'app' || raw.antigravity.target === 'ide') {
      base.antigravity.target = raw.antigravity.target;
    }
  }
  return base;
}

export function localCliproxyUrl(config: AppConfig): string {
  const fromSettings = config.cliproxy.baseUrl?.trim();
  if (fromSettings) return fromSettings.replace(/\/+$/, '');
  return `http://127.0.0.1:${config.cliproxy.port || 8317}`;
}

function withLocalUpstream(config: AppConfig): AppConfig {
  const existing = config.upstreams.find(item => item.id === LOCAL_UPSTREAM_ID);
  const local: Upstream = {
    id: LOCAL_UPSTREAM_ID,
    kind: 'local',
    name: existing?.name || '本地 CLIProxyAPI',
    baseUrl: localCliproxyUrl(config),
    apiKey: config.cliproxy.apiKey || existing?.apiKey || '',
    models: existing?.models ?? [],
    enabled: existing?.enabled ?? false,
  };
  const others = config.upstreams.filter(item => item.id !== LOCAL_UPSTREAM_ID);
  return { ...config, upstreams: [local, ...others] };
}

export function loadConfig(): AppConfig {
  const path = getConfigPath();
  if (!existsSync(path)) {
    const initial = withLocalUpstream(structuredClone(DEFAULT_CONFIG));
    saveConfig(initial);
    return initial;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return withLocalUpstream(mergeConfig(parsed));
  } catch {
    return withLocalUpstream(structuredClone(DEFAULT_CONFIG));
  }
}

export function saveConfig(config: AppConfig): AppConfig {
  const next = withLocalUpstream(config);
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
