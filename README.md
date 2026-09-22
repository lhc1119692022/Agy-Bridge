# Agy Bridge

把 **generateContent 中转站**注入 Antigravity 的 Electron 壳。

```
第三方中转站  ──┐
                ├── generateContent ──► 注入器 ── Cloud Code ──► Antigravity
CLIProxyAPI    ──┘
```

- **注入器**：本机伪装成 Cloud Code，把当前上游塞进 Antigravity 的模型列表。
- **本地引擎**：不重写账号池。把 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 当 sidecar 跑，账号、轮询、出站代理跟它的版本走。
- **上游管理**：远程中转站和本地 CLIProxyAPI 是同类项，注入器只选一个。

Antigravity 的 Cloud Code 目录/槽位逻辑来自 [relay-ai](https://github.com/jacob-bd/relay-ai) 的 `src/antigravity/`。官方协议变了，优先同步那一套 fixture / catalog / slot-registry，而不是在壳里手写。

和 `relay-ai` 并排放时可以：

```bash
npm run sync:relay
npm test
```

这会更新 `fetchAvailableModels` fixture 和 slot-registry。`catalog.ts` 若有协议变化需要对照 relay-ai 手工合并。

## 可靠性保护

注入器已吸收 `relay-ai` 近期的几项网关恢复策略：

- 流式上游返回 `200` 但没有任何事件时，默认重试一次非流式请求，并以单条 SSE 事件回放给 Antigravity。
- 默认仅对网络异常和 `408/425/429/5xx` 瞬时错误重试一次；鉴权、参数和协议错误不会盲目重试。
- 单次 JSON 请求体默认限制为 4 MiB，超限直接返回 `413`，不会触达上游。
- 每次转发记录目录模型、真实上游模型、状态码、延迟和重试次数，便于定位“显示模型”和“实际调用模型”不一致的问题。
- 拉取模型时保留上游返回的 context window；测试统一使用临时配置目录，不会修改真实用户配置。

## 开发

```bash
cd agy-bridge
npm install
npm test
npm start
```

Windows 可再打包：

```bash
npm run package:win
```

配置写在 `%USERPROFILE%\.agy-bridge\config.json`。

## 使用

1. **上游**：加一个讲 Gemini 原生协议的中转站（Base URL + API Key），点「拉模型」。
2. **注入器**：选当前上游和要暴露的模型，启动注入器。
3. **Antigravity 2.0**（第一优先级，不是 IDE）：从 **Agy Bridge 窗口**启动才会注入。请先退出已打开的官方窗口再开桥。
   - 注入器绑在固定端口（默认 `127.0.0.1:19621`）。桥在跑时临时写入官方 `settings.json` 的 `jetski.cloudCodeUrl`；退出桥时删掉。
   - 从本窗口启动时，代理只加在这一次进程上。
   - 开始菜单直开容易卡在 Google 登录确认（界面一直黑）。桥会给开始菜单带上你已经开着的系统代理，不改 `Antigravity.exe` 安装包。2.0 若重装快捷方式，再开一次桥会重新挂上。
4. **本地引擎**：选择已经部署好的 CLIProxyAPI **项目文件夹**（`config.yaml` + `cli-proxy-api`，例如 `D:\CLIProxyAPI`）。从本窗口启动是静默的：同时拉起 CLIProxyAPI 和 Keeper，不自动打开管理页。需要时再点「打开管理页」或「启动 Keeper」。不要把自制的 `CLIProxyAPI` 快捷方式当成程序。出站代理用项目自己的 config.yaml。

访问 `127.0.0.1` 走 `NO_PROXY`，不要让本地注入器被代理拐走。

## 不同步的东西

本应用不内嵌 CLIProxyAPI 源码，也不做 Claude / Codex / Gemini CLI 启动器。那些能力分别属于 CLIProxyAPI 和 relay-ai。
