import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeRuntime } from './runtime.js';
import type { AntigravityTarget, AppConfig, Upstream } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtime = new BridgeRuntime();
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function rendererPath(): string {
  return path.join(__dirname, '..', 'renderer', 'index.html');
}

function appIconPath(): string {
  return path.join(__dirname, '..', 'renderer', 'icon.ico');
}

function broadcast(): void {
  const state = runtime.getState();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('bridge:state', state);
  }
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    icon: appIconPath(),
    backgroundColor: '#f4f6fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void mainWindow.loadFile(rendererPath());
  mainWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray(): void {
  const image = nativeImage.createFromPath(appIconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  const menu = Menu.buildFromTemplate([
    { label: '打开 Agy Bridge', click: () => createWindow() },
    { type: 'separator' },
    { label: '启动注入器', click: () => runtime.startInjector().catch(err => runtime.log(String(err))) },
    { label: '启动 Antigravity 应用', click: () => runtime.launchTarget('app').catch(err => runtime.log(String(err))) },
    { label: '启动 Antigravity IDE', click: () => runtime.launchTarget('ide').catch(err => runtime.log(String(err))) },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setToolTip('Agy Bridge');
  tray.setContextMenu(menu);
  tray.on('click', () => createWindow());
}

function registerIpc(): void {
  ipcMain.handle('bridge:state', () => runtime.getState());
  ipcMain.handle('bridge:saveUpstream', async (_evt, upstream: Omit<Upstream, 'id'> & { id?: string }) => {
    try {
      const result = runtime.saveUpstream(upstream);
      broadcast();
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });
  ipcMain.handle('bridge:deleteUpstream', async (_evt, id: string) => {
    try {
      const result = runtime.deleteUpstream(id);
      broadcast();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('bridge:setActiveUpstream', async (_evt, id: string) => {
    try {
      const result = runtime.setActiveUpstream(id);
      broadcast();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('bridge:setSelectedModels', async (_evt, ids: string[]) => {
    const result = runtime.setSelectedModels(ids);
    broadcast();
    return { ok: true, result };
  });
  ipcMain.handle('bridge:updateSettings', async (_evt, patch: Partial<AppConfig>) => {
    const result = runtime.updateSettings(patch);
    broadcast();
    return { ok: true, result };
  });
  ipcMain.handle('bridge:refreshModels', async (_evt, id: string) => {
    try {
      const result = await runtime.refreshModels(id);
      broadcast();
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.log(message);
      broadcast();
      return { ok: false, error: message };
    }
  });
  ipcMain.handle('bridge:startInjector', async () => {
    try {
      await runtime.startInjector();
      broadcast();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('bridge:stopInjector', async () => {
    await runtime.stopInjector();
    broadcast();
    return { ok: true };
  });
  ipcMain.handle('bridge:startLocalEngine', async () => {
    try {
      await runtime.startLocalEngine();
      broadcast();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('bridge:stopLocalEngine', async () => {
    await runtime.stopLocalEngine();
    broadcast();
    return { ok: true };
  });
  ipcMain.handle('bridge:detectCliproxy', async () => {
    try {
      const result = runtime.detectCliproxyBinary();
      broadcast();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('bridge:openManagement', async () => {
    try {
      const url = `${runtime.managementUrl()}`;
      await shell.openExternal(url);
      runtime.log(`已打开管理页 ${url}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('bridge:loginLocal', async () => {
    try {
      await runtime.loginLocalAntigravity();
      broadcast();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.log(message);
      broadcast();
      return { ok: false, error: message };
    }
  });
  ipcMain.handle('bridge:launch', async (_evt, target: AntigravityTarget) => {
    try {
      await runtime.launchTarget(target);
      broadcast();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.log(message);
      broadcast();
      return { ok: false, error: message };
    }
  });
  ipcMain.handle('bridge:pickFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('bridge:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

app.on('second-instance', () => createWindow());

app.whenReady().then(() => {
  runtime.start();
  runtime.onChange = broadcast;
  registerIpc();
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {
  // tray keeps the app alive
});

let shuttingDown = false;
app.on('before-quit', event => {
  isQuitting = true;
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void runtime.shutdown().finally(() => app.exit(0));
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
});
