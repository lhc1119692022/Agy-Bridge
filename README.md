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
3. **启动 Antigravity IDE / 应用**：会用隔离 profile，并把 `jetski.cloudCodeUrl` 指到注入器。
4. **本地引擎**：选择已经部署好的 CLIProxyAPI **项目文件夹**（`config.yaml` + `start.cmd`，例如 `D:\CLIProxyAPI`）。启动会打开终端跑 `start.cmd`，和桌面快捷方式一样。不要把自制的 `CLIProxyAPI` 快捷方式当成程序。出站代理用项目自己的 config.yaml。

系统代理只用于出站。Antigravity 访问 `127.0.0.1` 会走 `NO_PROXY`，不要让本地注入器被代理拐走。

## 不同步的东西

本应用不内嵌 CLIProxyAPI 源码，也不做 Claude / Codex / Gemini CLI 启动器。那些能力分别属于 CLIProxyAPI 和 relay-ai。
