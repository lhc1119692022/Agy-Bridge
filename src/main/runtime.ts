import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AntigravityRoute } from '../engine/types.js';
import { maxSwitchSlots } from '../engine/catalog.js';
import { resolveInjectModels } from '../engine/inject-models.js';
import { startInjectorGateway, type GatewayAuditEvent, type GatewayHandle } from '../engine/gateway.js';
import { createUpstreamFetch } from '../engine/http.js';
import {
  findBinaryInProject,
  findCliproxyProject,
  listCliproxyAccounts,
  listGeminiModels,
  loginAntigravity,
  readProjectConfig,
  requireClientKey,
  resolveAuthDir,
  settingsFromProject,
  startCliproxy,
  type CliproxyHandle,
} from '../engine/cliproxy.js';
import {
  ensureKeeperRunning,
  fetchKeeperEvents,
  probeKeeper,
  type KeeperSettings,
} from '../engine/keeper.js';
import {
  applyOfficialCloudCodeUrl,
  restoreOfficialCloudCodeUrl,
} from '../engine/cloudcode-settings.js';
import { installAntigravityLaunchHook } from '../engine/launch-hook.js';
import {
  buildAntigravityChildEnv,
  clearAntigravityLaunchConflicts,
  clearOrphanAntigravityConflicts,
  detectSystemProxy,
  findAntigravityAppBinary,
  findAntigravityIdeBinary,
  forceQuitAntigravity,
  getOfficialAppProfileDir,
  isAntigravity2Running,
  isAntigravityIdeRunning,
  launchAntigravity,
  quitAntigravity,
  waitForQuit,
} from '../engine/launch.js';
import {
  DEFAULT_CONFIG,
  EMPTY_KEEPER_INFO,
  LOCAL_UPSTREAM_ID,
  type AntigravityTarget,
  type AppConfig,
  type AppState,
  type CliproxyInfo,
  type EngineStatus,
  type KeeperInfo,
  type Upstream,
} from '../shared/types.js';
import { getAppProfileDir, getCloudCodeBackupPath, getIdeProfileDir, getLaunchCmdPath, getLaunchPs1Path, getLogPath } from './paths.js';
import { loadConfig, localCliproxyUrl, saveConfig } from './store.js';

const MAX_LOGS = 400;
const STATUS_PROBE_TTL_MS = 2000;
const CLIPROXY_INFO_TTL_MS = 2000;
const KEEPER_EVENTS_TTL_MS = 2500;
const EMIT_DEBOUNCE_MS = 160;
const LOG_FLUSH_MS = 250;

export class BridgeRuntime {
  private config: AppConfig = structuredClone(DEFAULT_CONFIG);
  private logs: string[] = [];
  private injector: GatewayHandle | null = null;
  private cliproxy: CliproxyHandle | null = null;
  private injectorError: string | null = null;
  private cliproxyError: string | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private logWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLogChunk = '';
  private statusPoll: ReturnType<typeof setInterval> | null = null;
  private agyProbe: { at: number; running: boolean; found: boolean } | null = null;
  private cliproxyInfoCache: { at: number; value: CliproxyInfo } | null = null;
  private lastStatusKey = '';
  private keeperSnapshot: KeeperInfo = { ...EMPTY_KEEPER_INFO };
  private keeperCookie: string | null = null;
  private keeperCookieUrl: string | null = null;
  private keeperRefresh: Promise<void> | null = null;
  private lastKeeperFetchAt = 0;
  onChange: (() => void) | null = null;

  start(): void {
    this.config = loadConfig();
    const projectDir = findCliproxyProject(this.config.cliproxy.projectDir);
    if (projectDir) this.applyProjectDir(projectDir, false);
    restoreOfficialCloudCodeUrl(this.officialProfileDir(), getCloudCodeBackupPath());
    this.log('Agy Bridge 已就绪');
    void this.autoStartInjector();
    this.statusPoll = setInterval(() => this.pollStatus(), STATUS_PROBE_TTL_MS);
    setImmediate(() => {
      this.ensureDirectLaunchProxy();
      void this.clearLeftoverAntigravity();
    });
  }

  getState(): AppState {
    return {
      config: this.config,
      status: this.status(),
      logs: this.logs,
      slotCap: maxSwitchSlots(),
      cliproxy: this.cliproxyInfo(),
      keeper: this.keeperSnapshot,
    };
  }

  private statusKey(): string {
    const status = this.status();
    return [
      status.injector.running, status.injector.url, status.injector.error,
      status.cliproxy.running, status.cliproxy.url, status.cliproxy.error,
      status.antigravity.running, status.antigravity.injected, status.antigravity.found,
      status.keeper.running, status.keeper.url, status.keeper.error,
      this.keeperSnapshot.events[0]?.id ?? '', this.keeperSnapshot.events.length,
      this.keeperSnapshot.eventsError ?? '',
    ].join('|');
  }

  private pollStatus(): void {
    void this.refreshKeeperSnapshot();
    const key = this.statusKey();
    if (key === this.lastStatusKey) return;
    this.emit();
  }

  private async refreshKeeperSnapshot(): Promise<void> {
    if (this.keeperRefresh) return this.keeperRefresh;
    const now = Date.now();
    if (now - this.lastKeeperFetchAt < KEEPER_EVENTS_TTL_MS) return;
    this.lastKeeperFetchAt = now;
    this.keeperRefresh = this.loadKeeperSnapshot().finally(() => {
      this.keeperRefresh = null;
    });
    return this.keeperRefresh;
  }

  private async loadKeeperSnapshot(): Promise<void> {
    const projectDir = findCliproxyProject(this.config.cliproxy.projectDir);
    let settings: KeeperSettings | null = null;
    let running = false;
    try {
      const probed = await probeKeeper(projectDir ?? '');
      settings = probed.settings;
      running = probed.running;
    } catch {
      settings = null;
    }
    const next: KeeperInfo = {
      found: !!settings,
      running,
      url: settings?.healthUrl ?? null,
      dashboardUrl: settings?.dashboardUrl ?? null,
      error: settings ? null : (projectDir ? '项目里没有可用的 Keeper' : null),
      events: running ? this.keeperSnapshot.events : [],
      eventsError: running ? this.keeperSnapshot.eventsError : null,
      totalCount: running ? this.keeperSnapshot.totalCount : 0,
    };
    if (running && settings) {
      if (this.keeperCookieUrl !== settings.dashboardUrl) {
        this.keeperCookie = null;
        this.keeperCookieUrl = settings.dashboardUrl;
      }
      try {
        const fetched = await fetchKeeperEvents({ settings, cookie: this.keeperCookie });
        this.keeperCookie = fetched.cookie;
        next.events = fetched.page.events;
        next.totalCount = fetched.page.totalCount;
        next.eventsError = null;
      } catch (err) {
        next.eventsError = err instanceof Error ? err.message : String(err);
      }
    } else {
      this.keeperCookie = null;
      this.keeperCookieUrl = null;
    }
    this.keeperSnapshot = next;
    const key = this.statusKey();
    if (key !== this.lastStatusKey) this.emit();
  }

  private emit(immediate = false): void {
    const fire = (): void => {
      this.emitTimer = null;
      this.lastStatusKey = this.statusKey();
      this.onChange?.();
    };
    if (immediate) {
      if (this.emitTimer) {
        clearTimeout(this.emitTimer);
        this.emitTimer = null;
      }
      fire();
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(fire, EMIT_DEBOUNCE_MS);
  }

  log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.logs.push(line);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.pendingLogChunk += `${line}\n`;
    if (!this.logWriteTimer) {
      this.logWriteTimer = setTimeout(() => this.flushLogFile(), LOG_FLUSH_MS);
    }
    this.emit();
  }

  private flushLogFile(): void {
    this.logWriteTimer = null;
    if (!this.pendingLogChunk) return;
    const chunk = this.pendingLogChunk;
    this.pendingLogChunk = '';
    try {
      const path = getLogPath();
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, chunk, 'utf8');
    } catch { /* ignore disk errors */ }
  }

  private persist(next: AppConfig): void {
    this.config = saveConfig(next);
    this.cliproxyInfoCache = null;
    this.emit(true);
  }

  private cliproxyInfo(): CliproxyInfo {
    const now = Date.now();
    if (this.cliproxyInfoCache && now - this.cliproxyInfoCache.at < CLIPROXY_INFO_TTL_MS) {
      return this.cliproxyInfoCache.value;
    }
    const projectDir = findCliproxyProject(this.config.cliproxy.projectDir);
    let authDir = resolveAuthDir(this.config.cliproxy.authDir);
    let proxyConfigured = false;
    let clientKeyCount = 0;
    let upstreamUrl = localCliproxyUrl(this.config);
    if (projectDir) {
      try {
        const yaml = readProjectConfig(projectDir);
        authDir = resolveAuthDir(yaml.authDir || this.config.cliproxy.authDir);
        proxyConfigured = !!yaml.proxyUrl;
        clientKeyCount = yaml.apiKeys.length;
        upstreamUrl = `http://127.0.0.1:${yaml.port}`;
      } catch { /* ignore */ }
    }
    const value: CliproxyInfo = {
      projectDir,
      binaryPath: projectDir ? findBinaryInProject(projectDir) : null,
      authDir,
      accounts: listCliproxyAccounts(authDir),
      proxyConfigured,
      upstreamUrl,
      clientKeyCount,
    };
    this.cliproxyInfoCache = { at: now, value };
    return value;
  }

  private applyProjectDir(projectDir: string, emitLog = true): void {
    const fromProject = settingsFromProject(projectDir, { apiKey: this.config.cliproxy.apiKey });
    const { clientKeyCount, ...cliproxyFields } = fromProject;
    const cliproxy = { ...this.config.cliproxy, ...cliproxyFields };
    const upstreams = this.config.upstreams.map(item => (
      item.id === LOCAL_UPSTREAM_ID
        ? { ...item, baseUrl: fromProject.baseUrl, apiKey: fromProject.apiKey, enabled: true }
        : item
    ));
    this.config = saveConfig({ ...this.config, cliproxy, upstreams });
    this.cliproxyInfoCache = null;
    if (emitLog) this.log(`已从项目读取中转站 ${fromProject.baseUrl}，客户端 Key ${clientKeyCount} 把`);
  }

  saveUpstream(input: Omit<Upstream, 'id'> & { id?: string }): AppConfig {
    const id = input.id?.trim() || `remote-${randomUUID().slice(0, 8)}`;
    const upstream: Upstream = {
      id,
      kind: id === LOCAL_UPSTREAM_ID ? 'local' : 'remote',
      name: input.name.trim() || '未命名中转站',
      baseUrl: input.baseUrl.trim(),
      apiKey: input.apiKey,
      headers: input.headers,
      models: input.models ?? [],
      enabled: input.enabled ?? true,
    };
    const rest = this.config.upstreams.filter(item => item.id !== id);
    const upstreams = id === LOCAL_UPSTREAM_ID ? [upstream, ...rest] : [...rest, upstream];
    this.persist({
      ...this.config,
      upstreams,
      activeUpstreamId: this.config.activeUpstreamId ?? id,
      ...(id === LOCAL_UPSTREAM_ID
        ? {
            cliproxy: {
              ...this.config.cliproxy,
              baseUrl: upstream.baseUrl,
              apiKey: upstream.apiKey,
            },
          }
        : {}),
    });
    this.log(`已保存上游 ${upstream.name}`);
    return this.config;
  }

  deleteUpstream(id: string): AppConfig {
    if (id === LOCAL_UPSTREAM_ID) {
      throw new Error('本地 CLIProxyAPI 上游不能删除，只能停用');
    }
    const upstreams = this.config.upstreams.filter(item => item.id !== id);
    const activeUpstreamId = this.config.activeUpstreamId === id
      ? (upstreams[0]?.id ?? null)
      : this.config.activeUpstreamId;
    this.persist({ ...this.config, upstreams, activeUpstreamId });
    this.log(`已删除上游 ${id}`);
    return this.config;
  }

  setActiveUpstream(id: string): AppConfig {
    const upstream = this.config.upstreams.find(item => item.id === id);
    if (!upstream) {
      throw new Error('找不到该上游');
    }
    const available = new Set(upstream.models.map(model => model.id));
    const selectedModelIds = this.config.activeUpstreamId === id
      ? this.config.selectedModelIds
      : this.config.selectedModelIds.filter(modelId => available.has(modelId));
    this.persist({ ...this.config, activeUpstreamId: id, selectedModelIds });
    this.log(`当前上游切换为 ${upstream.name}`);
    if (this.injector) {
      void this.refreshInjector('上游已切换，注入器已按固定端口重启。Antigravity 2.0 不用重开。');
    }
    return this.config;
  }

  setSelectedModels(ids: string[]): AppConfig {
    const unique: string[] = [];
    for (const id of ids) {
      if (!unique.includes(id)) unique.push(id);
    }
    this.persist({ ...this.config, selectedModelIds: unique });
    if (this.injector) {
      if (unique.length === 0) void this.stopInjector();
      else void this.refreshInjector('注入列表已更新，注入器已按固定端口重启。Antigravity 2.0 不用重开。');
    }
    return this.config;
  }

  updateSettings(patch: Partial<AppConfig>): AppConfig {
    this.persist({
      ...this.config,
      ...patch,
      cliproxy: { ...this.config.cliproxy, ...(patch.cliproxy ?? {}) },
      antigravity: { ...this.config.antigravity, ...(patch.antigravity ?? {}) },
    });
    if (patch.cliproxy?.projectDir) {
      const projectDir = findCliproxyProject(this.config.cliproxy.projectDir);
      if (projectDir) this.applyProjectDir(projectDir);
    }
    return this.config;
  }

  activeUpstream(): Upstream | null {
    return this.config.upstreams.find(item => item.id === this.config.activeUpstreamId) ?? null;
  }

  private proxyUrl(): string | undefined {
    return this.config.proxyEnabled ? this.config.proxyUrl.trim() || undefined : undefined;
  }

  managementUrl(): string {
    return `${localCliproxyUrl(this.config)}/management.html`;
  }

  keeperDashboardUrl(): string {
    return this.keeperSnapshot.dashboardUrl || 'http://127.0.0.1:8080/';
  }

  async startKeeper(): Promise<string> {
    const projectDir = findCliproxyProject(this.config.cliproxy.projectDir);
    if (!projectDir) throw new Error('未找到 CLIProxyAPI 项目文件夹');
    this.applyProjectDir(projectDir);
    const handle = await ensureKeeperRunning({
      projectDir,
      logFn: msg => this.log(msg),
    });
    this.log(`Keeper ${handle.reused ? '已复用' : '已启动'} ${handle.url}`);
    this.lastKeeperFetchAt = 0;
    await this.refreshKeeperSnapshot();
    this.emit(true);
    return handle.url;
  }

  async refreshModels(id: string): Promise<AppConfig> {
    const upstream = this.config.upstreams.find(item => item.id === id);
    if (!upstream) throw new Error('找不到该上游');
    let apiKeys: string | string[] = upstream.apiKey;
    if (id === LOCAL_UPSTREAM_ID) {
      const projectDir = findCliproxyProject(this.config.cliproxy.projectDir);
      if (projectDir) this.applyProjectDir(projectDir, false);
      const yamlKeys = projectDir ? readProjectConfig(projectDir).apiKeys : [];
      apiKeys = yamlKeys.length > 0
        ? yamlKeys
        : requireClientKey(this.config.cliproxy.apiKey || upstream.apiKey);
    }
    const listed = await listGeminiModels({
      baseUrl: id === LOCAL_UPSTREAM_ID
        ? localCliproxyUrl(this.config)
        : upstream.baseUrl,
      apiKey: apiKeys,
      headers: upstream.headers,
      fetchImpl: createUpstreamFetch(this.proxyUrl()),
    });
    const nextModels = listed.models.map(model => ({
      id: model.id,
      name: model.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    }));
    const available = new Set(nextModels.map(model => model.id));
    this.saveUpstream({ ...upstream, models: nextModels, apiKey: listed.apiKey });
    if (id === LOCAL_UPSTREAM_ID) {
      this.persist({
        ...this.config,
        cliproxy: { ...this.config.cliproxy, apiKey: listed.apiKey },
      });
    }
    this.persist({
      ...this.config,
      selectedModelIds: this.config.selectedModelIds.filter(modelId => available.has(modelId)),
    });
    this.log(`上游 ${upstream.name} 拉到 ${nextModels.length} 个模型`);
    if (this.injector && id === this.config.activeUpstreamId) {
      void this.refreshInjector('模型列表已更新，注入器已按固定端口重启。');
    }
    return this.config;
  }

  private buildRoutes(): AntigravityRoute[] {
    const upstream = this.activeUpstream();
    if (!upstream) throw new Error('还没有选择上游');
    const slotCap = maxSwitchSlots();
    const plan = resolveInjectModels({
      catalog: upstream.models,
      selectedIds: this.config.selectedModelIds,
      slotCap,
    });
    const models = plan.models;
    if (models.length === 0) {
      throw new Error(`请先在注入器页勾选要注入的模型。Antigravity 最多同时显示 ${slotCap} 个。`);
    }
    if (plan.skippedIds.length > 0) {
      this.log(`超出 ${slotCap} 个槽位，未注入：${plan.skippedIds.join(', ')}`);
    }
    return models.map(model => ({
      catalogId: `agy-bridge__${upstream.id}__${model.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      providerId: upstream.id,
      providerName: upstream.name,
      modelId: model.id,
      upstreamModelId: model.id,
      displayName: `${model.name} (Bridge)`,
      modelFormat: 'gemini-native',
      npm: '@ai-sdk/google',
      apiKey: upstream.apiKey,
      headers: upstream.headers,
      baseURL: upstream.baseUrl,
      contextWindow: model.contextWindow ?? 1_048_576,
    }));
  }

  private officialProfileDir(): string {
    return getOfficialAppProfileDir();
  }

  private isolatedProfileDir(): string {
    return getAppProfileDir();
  }

  private ensureDirectLaunchProxy(): void {
    const exe = findAntigravityAppBinary(this.config.antigravity.appPath);
    const proxyUrl = this.proxyUrl() ?? detectSystemProxy();
    if (!exe) {
      this.log('未找到 Antigravity 2.0，无法给直开加上出站代理');
      return;
    }
    if (!proxyUrl) {
      this.log('未检测到系统代理。直开 2.0 校验 Google 登录时可能卡住黑屏，请先打开 Clash。');
      return;
    }
    try {
      const result = installAntigravityLaunchHook({
        cmdPath: getLaunchCmdPath(),
        ps1Path: getLaunchPs1Path(),
        exePath: exe,
        proxyUrl,
      });
      if (result.shortcuts.length > 0) {
        this.log(`直开已带上系统代理（${proxyUrl}），开始菜单进入时不再卡在 Google 登录确认`);
      }
      if (result.envChanged.length > 0) {
        this.log(`已写入用户代理环境 ${result.envChanged.join(', ')}`);
      }
      for (const error of result.errors) this.log(`直开代理警告：${error}`);
    } catch (err) {
      this.log(`设置直开代理失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async clearLeftoverAntigravity(): Promise<void> {
    try {
      const notes = await clearOrphanAntigravityConflicts(this.isolatedProfileDir(), this.officialProfileDir());
      for (const note of notes) this.log(note);
    } catch (err) {
      this.log(`清理 Antigravity 残留失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async autoStartInjector(): Promise<void> {
    try {
      await this.startInjector();
      this.log('注入器已随 Agy Bridge 启动。从本窗口启动 Antigravity 2.0 才会注入；请先退出已打开的官方窗口。');
    } catch (err) {
      restoreOfficialCloudCodeUrl(this.officialProfileDir(), getCloudCodeBackupPath());
      this.log(`注入器未自动启动：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async closeInjectorServer(): Promise<void> {
    if (!this.injector) return;
    const handle = this.injector;
    this.injector = null;
    await handle.close();
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  private async refreshInjector(message: string): Promise<void> {
    try {
      await this.startInjector();
      this.log(message);
    } catch (err) {
      this.log(`注入器更新失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async startInjector(): Promise<void> {
    this.injectorError = null;
    try {
      const routes = this.buildRoutes();
      if (this.injector) {
        this.injector.update(routes);
        applyOfficialCloudCodeUrl(
          this.officialProfileDir(),
          this.injector.url,
          getCloudCodeBackupPath(),
        );
        this.log(`注入器已热更新 ${this.injector.url}，模型 ${routes.map(route => route.displayName).join(', ')}`);
        return;
      }
      this.injector = await startInjectorGateway(routes, {
        port: this.config.injectorPort,
        logFn: msg => this.log(msg),
        fetchImpl: createUpstreamFetch(this.proxyUrl()),
        auditFn: event => this.logGatewayAudit(event),
      });
      applyOfficialCloudCodeUrl(
        this.officialProfileDir(),
        this.injector.url,
        getCloudCodeBackupPath(),
      );
      this.log(`注入器已启动 ${this.injector.url}，模型 ${routes.map(route => route.displayName).join(', ')}`);
    } catch (err) {
      this.injectorError = err instanceof Error ? err.message : String(err);
      this.log(`注入器启动失败：${this.injectorError}`);
      restoreOfficialCloudCodeUrl(this.officialProfileDir(), getCloudCodeBackupPath());
      throw err;
    } finally {
      this.emit(true);
    }
  }

  private logGatewayAudit(event: GatewayAuditEvent): void {
    const outcome = event.errorKind
      ? `${event.status}/${event.errorKind}`
      : String(event.status);
    this.log(`[audit] ${event.catalogModel} → ${event.upstreamModel} ${outcome} ${event.latencyMs}ms${event.retryCount ? ` retry=${event.retryCount}` : ''}`);
  }

  async stopInjector(): Promise<void> {
    const hadInjector = !!this.injector;
    await this.closeInjectorServer();
    restoreOfficialCloudCodeUrl(this.officialProfileDir(), getCloudCodeBackupPath());
    if (hadInjector) this.log('注入器已停止，已恢复官方 Cloud Code 设置。已打开的 Antigravity 2.0 不会被强制重启。');
    this.emit(true);
  }

  detectCliproxyBinary(): AppConfig {
    const projectDir = findCliproxyProject(this.config.cliproxy.projectDir);
    if (!projectDir) throw new Error('未找到 CLIProxyAPI 项目文件夹（需要 config.yaml 和 start.cmd）');
    this.applyProjectDir(projectDir);
    return this.config;
  }

  async loginLocalAntigravity(): Promise<void> {
    const projectDir = findCliproxyProject(this.config.cliproxy.projectDir);
    if (!projectDir) throw new Error('未找到 CLIProxyAPI 项目文件夹');
    await loginAntigravity({
      projectDir,
      logFn: msg => this.log(msg),
    });
    this.log('Antigravity 账号登录流程已结束，请查看本地引擎页的账号列表');
    this.cliproxyInfoCache = null;
    this.emit(true);
  }

  async startLocalEngine(): Promise<void> {
    if (this.cliproxy) await this.stopLocalEngine();
    this.cliproxyError = null;
    try {
      const projectDir = findCliproxyProject(this.config.cliproxy.projectDir);
      if (!projectDir) throw new Error('未找到 CLIProxyAPI 项目文件夹');
      this.applyProjectDir(projectDir);
      this.cliproxy = await startCliproxy({
        settings: this.config.cliproxy,
        logFn: msg => this.log(msg),
      });
      this.log(`CLIProxyAPI ${this.cliproxy.reused ? '已复用' : '已静默启动'} ${this.cliproxy.url}`);
      this.lastKeeperFetchAt = 0;
      void this.refreshKeeperSnapshot();
      this.setActiveUpstream(LOCAL_UPSTREAM_ID);
      try {
        await this.refreshModels(LOCAL_UPSTREAM_ID);
      } catch (err) {
        this.log(`中转站已启动，但拉模型失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      this.cliproxyError = err instanceof Error ? err.message : String(err);
      this.log(`CLIProxyAPI 启动失败：${this.cliproxyError}`);
      throw err;
    } finally {
      this.cliproxyInfoCache = null;
      this.emit(true);
    }
  }

  async stopLocalEngine(): Promise<void> {
    if (!this.cliproxy) return;
    const handle = this.cliproxy;
    this.cliproxy = null;
    await handle.stop();
    this.log('CLIProxyAPI 已停止');
    this.cliproxyInfoCache = null;
    this.emit(true);
  }

  private profileDir(target: AntigravityTarget): string {
    return target === 'ide' ? getIdeProfileDir() : getAppProfileDir();
  }

  private async restartIfRunning(
    isRunning: () => boolean,
    quit: () => void | Promise<void>,
    forceQuit: () => void | Promise<void>,
    message: string,
  ): Promise<void> {
    if (!isRunning()) return;
    this.log(message);
    await quit();
    if (!(await waitForQuit(isRunning, 4000))) {
      await forceQuit();
      await waitForQuit(isRunning, 4000);
    }
  }

  private logProxy(proxyUrl: string | undefined): void {
    if (proxyUrl) this.log(`Antigravity 出站代理：${proxyUrl}（本地 127.0.0.1 不走代理）`);
    else this.log('未检测到系统代理。Antigravity 2.0 启动时会刷新 Google OAuth，国内 IPv6 不通时窗口可能黑屏。请开系统代理，或在设置里填写 HTTP 代理。');
  }

  private async relaunchAntigravity2(): Promise<void> {
    const binary = findAntigravityAppBinary(this.config.antigravity.appPath);
    if (!binary) throw new Error('未找到 Antigravity 2.0');
    const officialDir = this.officialProfileDir();
    const isolatedDir = this.isolatedProfileDir();
    const busy = () => isAntigravity2Running(officialDir, isolatedDir);
    if (busy()) this.log('检测到已在运行或残留的 Antigravity，先关掉再启动…');
    await clearAntigravityLaunchConflicts(officialDir, isolatedDir);
    if (!(await waitForQuit(busy, 4000))) {
      this.log('等待 Antigravity 退出超时，仍尝试启动');
    }
    const proxyUrl = this.proxyUrl() ?? detectSystemProxy();
    this.logProxy(proxyUrl);
    const env = buildAntigravityChildEnv({
      gatewayUrl: this.injector?.url,
      proxyUrl,
    });
    const code = await launchAntigravity({
      target: 'app',
      gatewayUrl: this.injector?.url,
      profileDir: officialDir,
      binaryPath: binary,
      env,
    });
    if (code !== 0) throw new Error(`Antigravity 2.0 启动失败（code ${code}）`);
    this.agyProbe = null;
    this.persist({ ...this.config, antigravity: { ...this.config.antigravity, target: 'app' } });
    this.log(this.injector
      ? `已启动 Antigravity 2.0（注入 ${this.injector.url}）`
      : '已启动 Antigravity 2.0（官方 Cloud Code）');
  }

  async launchTarget(target: AntigravityTarget): Promise<void> {
    if (target === 'ide') {
      await this.startInjector();
      const gatewayUrl = this.injector!.url;
      const profileDir = this.profileDir('ide');
      await this.restartIfRunning(
        () => isAntigravityIdeRunning(profileDir),
        () => quitAntigravity('ide', profileDir),
        () => forceQuitAntigravity('ide', profileDir),
        '正在重启 Antigravity IDE…',
      );
      const binary = findAntigravityIdeBinary(this.config.antigravity.idePath);
      if (!binary) throw new Error('未找到 Antigravity IDE');
      const proxyUrl = this.proxyUrl() ?? detectSystemProxy();
      this.logProxy(proxyUrl);
      const env = buildAntigravityChildEnv({ gatewayUrl, proxyUrl });
      const code = await launchAntigravity({
        target: 'ide',
        gatewayUrl,
        profileDir,
        binaryPath: binary,
        env,
      });
      if (code !== 0) throw new Error(`Antigravity IDE 启动失败（code ${code}）`);
      this.agyProbe = null;
      this.persist({ ...this.config, antigravity: { ...this.config.antigravity, target } });
      this.log(`已启动 Antigravity IDE → ${gatewayUrl}`);
      return;
    }
    await this.startInjector();
    await this.relaunchAntigravity2();
  }

  async shutdown(): Promise<void> {
    if (this.statusPoll) {
      clearInterval(this.statusPoll);
      this.statusPoll = null;
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    await this.stopInjector();
    await this.stopLocalEngine();
    try {
      await clearAntigravityLaunchConflicts(this.officialProfileDir(), this.isolatedProfileDir());
      this.log('已清掉 Antigravity 进程树和 language_server，避免下次直开被占用');
    } catch (err) {
      this.log(`退出时清理 Antigravity 失败：${err instanceof Error ? err.message : String(err)}`);
    }
    this.flushLogFile();
  }

  private probeAntigravity(force = false): { running: boolean; found: boolean } {
    const now = Date.now();
    if (!force && this.agyProbe && now - this.agyProbe.at < STATUS_PROBE_TTL_MS) {
      return this.agyProbe;
    }
    const officialDir = this.officialProfileDir();
    const isolatedDir = this.isolatedProfileDir();
    const running = isAntigravity2Running(officialDir, isolatedDir);
    const found = !!findAntigravityAppBinary(this.config.antigravity.appPath);
    this.agyProbe = { at: now, running, found };
    return this.agyProbe;
  }

  status(): EngineStatus {
    const target = this.config.antigravity.target;
    const agy = this.probeAntigravity();
    return {
      injector: {
        running: !!this.injector,
        url: this.injector?.url ?? null,
        port: this.injector?.port ?? null,
        error: this.injectorError,
      },
      cliproxy: {
        running: !!this.cliproxy,
        pid: this.cliproxy?.pid ?? null,
        url: this.cliproxy?.url ?? null,
        error: this.cliproxyError,
      },
      antigravity: {
        running: agy.running,
        injected: !!this.injector,
        target,
        found: agy.found,
      },
      keeper: {
        running: this.keeperSnapshot.running,
        url: this.keeperSnapshot.dashboardUrl,
        error: this.keeperSnapshot.error,
      },
    };
  }
}
