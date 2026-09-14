import { execSync } from 'node:child_process';

const ELECTRON_ENV_PREFIXES = ['ELECTRON_', 'CHROME_', 'GOOGLE_CHROME_'];
const ELECTRON_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'CHROME_CRASHPAD_PIPE_NAME',
  'ORIGINAL_XDG_CURRENT_DESKTOP',
]);

export function sanitizeSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(clean)) {
    if (ELECTRON_ENV_KEYS.has(key) || ELECTRON_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      delete clean[key];
    }
  }
  return clean;
}

export function parseWindowsProxyServer(server: string | undefined): string | undefined {
  const raw = server?.trim();
  if (!raw) return undefined;
  if (raw.includes('=')) {
    const parts = Object.fromEntries(
      raw.split(';').map(part => {
        const [scheme, value] = part.split('=');
        return [scheme.trim().toLowerCase(), (value ?? '').trim()];
      }).filter(([, value]) => value),
    );
    const picked = parts.https || parts.http || parts.socks || parts.socks5;
    return picked ? ensureProxyUrl(picked, parts.socks || parts.socks5 ? 'socks5' : 'http') : undefined;
  }
  return ensureProxyUrl(raw, 'http');
}

function ensureProxyUrl(value: string, fallbackScheme: 'http' | 'socks5'): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `${fallbackScheme}://${value}`;
}

export function parseWindowsInternetProxy(settings: {
  ProxyEnable?: number;
  ProxyServer?: string;
}): string | undefined {
  if (settings.ProxyEnable !== 1) return undefined;
  return parseWindowsProxyServer(settings.ProxyServer);
}

function readWindowsInternetProxy(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out);
    const server = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i)?.[1];
    if (!enabled) return undefined;
    return parseWindowsProxyServer(server);
  } catch {
    return undefined;
  }
}

export function detectSystemProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY;
  if (fromEnv?.trim()) return fromEnv.trim();
  return readWindowsInternetProxy();
}

export function applyOutboundProxy(
  env: NodeJS.ProcessEnv,
  proxyUrl: string | undefined,
): NodeJS.ProcessEnv {
  const next = { ...env };
  const noProxy = [next.NO_PROXY, next.no_proxy, '127.0.0.1', 'localhost', '::1']
    .filter(Boolean)
    .join(',');
  next.NO_PROXY = noProxy;
  next.no_proxy = noProxy;
  if (proxyUrl) {
    next.HTTP_PROXY = proxyUrl;
    next.HTTPS_PROXY = proxyUrl;
    next.http_proxy = proxyUrl;
    next.https_proxy = proxyUrl;
    next.ALL_PROXY = proxyUrl;
    next.all_proxy = proxyUrl;
  }
  return next;
}

export function buildAntigravityChildEnv(opts: {
  gatewayUrl: string;
  proxyUrl?: string;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  let env = sanitizeSpawnEnv({ ...(opts.baseEnv ?? process.env) });
  env.CLOUD_CODE_URL = opts.gatewayUrl;
  env.ANTIGRAVITY_API_KEY = 'agy-bridge-dummy';
  env.GEMINI_API_KEY = 'agy-bridge-dummy';
  env.GOOGLE_API_KEY = 'agy-bridge-dummy';
  env.GOOGLE_GEMINI_API_KEY = 'agy-bridge-dummy';
  const proxyUrl = opts.proxyUrl?.trim() || detectSystemProxy(env);
  env = applyOutboundProxy(env, proxyUrl);
  return env;
}
