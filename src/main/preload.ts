import { contextBridge, ipcRenderer } from 'electron';
import type { AntigravityTarget, AppConfig, AppState, Upstream } from '../shared/types.js';

contextBridge.exposeInMainWorld('agyBridge', {
  state: () => ipcRenderer.invoke('bridge:state') as Promise<AppState>,
  saveUpstream: (upstream: Omit<Upstream, 'id'> & { id?: string }) => ipcRenderer.invoke('bridge:saveUpstream', upstream),
  deleteUpstream: (id: string) => ipcRenderer.invoke('bridge:deleteUpstream', id),
  setActiveUpstream: (id: string) => ipcRenderer.invoke('bridge:setActiveUpstream', id),
  setSelectedModels: (ids: string[]) => ipcRenderer.invoke('bridge:setSelectedModels', ids),
  updateSettings: (patch: Partial<AppConfig>) => ipcRenderer.invoke('bridge:updateSettings', patch),
  refreshModels: (id: string) => ipcRenderer.invoke('bridge:refreshModels', id),
  startInjector: () => ipcRenderer.invoke('bridge:startInjector'),
  stopInjector: () => ipcRenderer.invoke('bridge:stopInjector'),
  startLocalEngine: () => ipcRenderer.invoke('bridge:startLocalEngine'),
  stopLocalEngine: () => ipcRenderer.invoke('bridge:stopLocalEngine'),
  detectCliproxy: () => ipcRenderer.invoke('bridge:detectCliproxy'),
  loginLocal: () => ipcRenderer.invoke('bridge:loginLocal'),
  openManagement: () => ipcRenderer.invoke('bridge:openManagement'),
  startKeeper: () => ipcRenderer.invoke('bridge:startKeeper'),
  launch: (target: AntigravityTarget) => ipcRenderer.invoke('bridge:launch', target),
  pickFile: () => ipcRenderer.invoke('bridge:pickFile') as Promise<string | null>,
  pickFolder: () => ipcRenderer.invoke('bridge:pickFolder') as Promise<string | null>,
  onState: (handler: (state: AppState) => void) => {
    const listener = (_event: unknown, state: AppState) => handler(state);
    ipcRenderer.on('bridge:state', listener);
    return () => ipcRenderer.removeListener('bridge:state', listener);
  },
});
