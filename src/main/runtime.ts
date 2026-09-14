import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AntigravityRoute } from '../engine/types.js';
import { maxSwitchSlots } from '../engine/catalog.js';
import { resolveInjectModels } from '../engine/inject-models.js';
import { startInjectorGateway, type GatewayHandle } from '../engine/gateway.js';
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
  buildAntigravityChildEnv,
  detectSystemProxy,
  findAntigravityAppBinary,
  findAntigravityIdeBinary,
  forceQuitAntigravity,
  isAntigravityAppRunning,
  isAntigravityIdeRunning,
  launchAntigravity,
  quitAntigravity,
  waitForQuit,
} from '../engine/launch.js';
import {
  DEFAULT_CONFIG,
  LOCAL_UPSTREAM_ID,
  type AntigravityTarget,
  type AppConfig,
  type AppState,
  type CliproxyInfo,
  type EngineStatus,
  type Upstream,
} from '../shared/types.js';
import { getAppProfileDir, getIdeProfileDir, getLogPath } from './paths.js';
import { loadConfig, localCliproxyUrl, saveConfig } from './store.js';

const MAX_LOGS = 400;

export class BridgeRuntime {
  private config: AppConfig = structuredClone(DEFAULT_CONFIG);
  private logs: string[] = [];
  private injector: GatewayHandle | null = null;
  private cliproxy: CliproxyHandle | null = null;
  private injectorError: string | null = null;
  private cliproxyError: string | null = null;
  onChange: (() => void) | null = null;

  start(): void {
    this.config = loadConfig();
    const projectDir = findCliproxyProject(this.config.cliproxy.projectDir);
    if (projectDir) this.applyProjectDir(projectDir, false);
    this.log('Agy Bridge 已就绪');
  }

  getState(): AppState {
    return {
      config: this.config,
      status: this.status(),
      logs: [...this.logs],
      slotCap: maxSwitchSlots(),
      cliproxy: this.cliproxyInfo(),
    };
  }

  private emit(): void {
    this.onChange?.();
  }

  log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.logs.push(line);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    try {
      const path = getLogPath();
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${line}\n`, 'utf8');
    } catch { /* ignore disk errors */ }
    this.emit();
  }

  private persist(next: AppConfig): void {
    this.config = saveConfig(next);
    this.emit();
  }

  private cliproxyInfo(): CliproxyInfo {
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
    return {
      projectDir,
      binaryPath: projectDir ? findBinaryInProject(projectDir) : null,
      authDir,
      accounts: listCliproxyAccounts(authDir),
      proxyConfigured,
      upstreamUrl,
      clientKeyCount,
    };
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
    return this.config;
  }

  setSelectedModels(ids: string[]): AppConfig {
    const unique: string[] = [];
    for (const id of ids) {
      if (!unique.includes(id)) unique.push(id);
    }
    this.persist({ ...this.config, selectedModelIds: unique });
    if (this.injector) {
      this.log('勾选已保存。请重新点「启动注入器」或「启动 Antigravity」，新勾选才会进入模型列表。');
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
    const nextModels = listed.models.map(model => ({ id: model.id, name: model.name }));
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

  async startInjector(): Promise<void> {
    if (this.injector) await this.stopInjector();
    this.injectorError = null;
    try {
      const routes = this.buildRoutes();
      this.injector = await startInjectorGateway(routes, {
        logFn: msg => this.log(msg),
        fetchImpl: createUpstreamFetch(this.proxyUrl()),
      });
      this.log(`注入器已启动 ${this.injector.url}，模型 ${routes.map(route => route.displayName).join(', ')}`);
    } catch (err) {
      this.injectorError = err instanceof Error ? err.message : String(err);
      this.log(`注入器启动失败：${this.injectorError}`);
      throw err;
    } finally {
      this.emit();
    }
  }

  async stopInjector(): Promise<void> {
    if (!this.injector) return;
    const handle = this.injector;
    this.injector = null;
    await handle.close();
    this.log('注入器已停止');
    this.emit();
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
    this.emit();
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
      this.log(`CLIProxyAPI ${this.cliproxy.reused ? '已复用' : '已启动'} ${this.cliproxy.url}`);
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
      this.emit();
    }
  }

  async stopLocalEngine(): Promise<void> {
    if (!this.cliproxy) return;
    const handle = this.cliproxy;
    this.cliproxy = null;
    await handle.stop();
    this.log('CLIProxyAPI 已停止');
    this.emit();
  }

  private profileDir(target: AntigravityTarget): string {
    return target === 'ide' ? getIdeProfileDir() : getAppProfileDir();
  }

  async launchTarget(target: AntigravityTarget): Promise<void> {
    await this.startInjector();
    const gatewayUrl = this.injector!.url;
    const profileDir = this.profileDir(target);
    const isRunning = target === 'ide'
      ? () => isAntigravityIdeRunning(profileDir)
      : () => isAntigravityAppRunning(profileDir);
    if (isRunning()) {
      this.log('检测到已在运行的 Antigravity，正在重启以加载注入器…');
      quitAntigravity(target, profileDir);
      if (!(await waitForQuit(isRunning, 4000))) {
        forceQuitAntigravity(target, profileDir);
        await waitForQuit(isRunning, 4000);
      }
    }
    const binary = target === 'ide'
      ? findAntigravityIdeBinary(this.config.antigravity.idePath)
      : findAntigravityAppBinary(this.config.antigravity.appPath);
    if (!binary) {
      throw new Error(target === 'ide' ? '未找到 Antigravity IDE' : '未找到 Antigravity 应用');
    }
    const proxyUrl = this.proxyUrl() ?? detectSystemProxy();
    if (proxyUrl) this.log(`Antigravity 出站代理：${proxyUrl}（本地 127.0.0.1 不走代理）`);
    else this.log('未检测到系统代理。Antigravity 2.0 启动时会刷新 Google OAuth，国内 IPv6 不通时窗口可能黑屏。请开系统代理，或在设置里填写 HTTP 代理。');
    const env = buildAntigravityChildEnv({ gatewayUrl, proxyUrl });
    const code = await launchAntigravity({
      target,
      gatewayUrl,
      profileDir,
      binaryPath: binary,
      env,
    });
    if (code !== 0) throw new Error(`Antigravity 启动失败（code ${code}）`);
    this.persist({ ...this.config, antigravity: { ...this.config.antigravity, target } });
    this.log(`已启动 Antigravity ${target} → ${gatewayUrl}`);
  }

  async shutdown(): Promise<void> {
    await this.stopInjector();
    await this.stopLocalEngine();
  }

  status(): EngineStatus {
    const target = this.config.antigravity.target;
    const profileDir = this.profileDir(target);
    const found = target === 'ide'
      ? !!findAntigravityIdeBinary(this.config.antigravity.idePath)
      : !!findAntigravityAppBinary(this.config.antigravity.appPath);
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
        running: target === 'ide' ? isAntigravityIdeRunning(profileDir) : isAntigravityAppRunning(profileDir),
        target,
        found,
      },
    };
  }
}
