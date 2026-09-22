export type UpstreamKind = 'remote' | 'local';
export type AntigravityTarget = 'app' | 'ide';

export interface UpstreamModel {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface Upstream {
  id: string;
  kind: UpstreamKind;
  name: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  models: UpstreamModel[];
  enabled: boolean;
}

export interface CliproxySettings {
  projectDir: string;
  binaryPath: string;
  port: number;
  /** Client key for using CLIProxyAPI as a generateContent upstream. */
  apiKey: string;
  /** Management-panel login key. Never sent to /v1beta. */
  managementKey: string;
  /** Upstream URL, e.g. http://127.0.0.1:8317 */
  baseUrl: string;
  extraArgs: string[];
  authDir: string;
}

export interface CliproxyAccountInfo {
  file: string;
  type: string;
  email: string;
}

export interface CliproxyInfo {
  projectDir: string | null;
  binaryPath: string | null;
  authDir: string;
  accounts: CliproxyAccountInfo[];
  proxyConfigured: boolean;
  upstreamUrl: string;
  clientKeyCount: number;
}

export interface KeeperEvent {
  id: string;
  timestamp: string;
  model: string;
  source: string;
  endpoint: string;
  failed: boolean;
  latencyMs: number;
  totalTokens: number;
  costUsd: number;
}

export interface KeeperInfo {
  found: boolean;
  running: boolean;
  url: string | null;
  dashboardUrl: string | null;
  error: string | null;
  events: KeeperEvent[];
  eventsError: string | null;
  totalCount: number;
}

export interface AntigravitySettings {
  appPath: string;
  idePath: string;
  target: AntigravityTarget;
}

export const DEFAULT_INJECTOR_PORT = 19621;

export interface AppConfig {
  upstreams: Upstream[];
  activeUpstreamId: string | null;
  selectedModelIds: string[];
  proxyEnabled: boolean;
  proxyUrl: string;
  injectorPort: number;
  cliproxy: CliproxySettings;
  antigravity: AntigravitySettings;
}

export interface EngineStatus {
  injector: {
    running: boolean;
    url: string | null;
    port: number | null;
    error: string | null;
  };
  cliproxy: {
    running: boolean;
    pid: number | null;
    url: string | null;
    error: string | null;
  };
  antigravity: {
    running: boolean;
    injected: boolean;
    target: AntigravityTarget;
    found: boolean;
  };
  keeper: {
    running: boolean;
    url: string | null;
    error: string | null;
  };
}

export interface AppState {
  config: AppConfig;
  status: EngineStatus;
  logs: string[];
  slotCap: number;
  cliproxy: CliproxyInfo;
  keeper: KeeperInfo;
}

export const EMPTY_KEEPER_INFO: KeeperInfo = {
  found: false,
  running: false,
  url: null,
  dashboardUrl: null,
  error: null,
  events: [],
  eventsError: null,
  totalCount: 0,
};

export const LOCAL_UPSTREAM_ID = 'local-cliproxy';

export const DEFAULT_CONFIG: AppConfig = {
  upstreams: [],
  activeUpstreamId: null,
  selectedModelIds: [],
  proxyEnabled: false,
  proxyUrl: '',
  injectorPort: DEFAULT_INJECTOR_PORT,
  cliproxy: {
    projectDir: '',
    binaryPath: '',
    port: 8317,
    apiKey: '',
    managementKey: '',
    baseUrl: 'http://127.0.0.1:8317',
    extraArgs: [],
    authDir: '',
  },
  antigravity: {
    appPath: '',
    idePath: '',
    target: 'app',
  },
};
