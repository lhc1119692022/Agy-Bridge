import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function getAppHome(): string {
  const override = process.env.AGY_BRIDGE_HOME?.trim();
  const home = override && override.length > 0 ? override : join(homedir(), '.agy-bridge');
  mkdirSync(home, { recursive: true });
  return home;
}

export function getConfigPath(): string {
  return join(getAppHome(), 'config.json');
}

export function getLogPath(): string {
  return join(getAppHome(), 'logs', 'bridge.log');
}

export function getAppProfileDir(): string {
  return join(getAppHome(), 'antigravity', 'app-profile');
}

export function getIdeProfileDir(): string {
  return join(getAppHome(), 'antigravity', 'ide-profile');
}

export function getCliproxyConfigPath(): string {
  return join(getAppHome(), 'cliproxy.yaml');
}

export function getCloudCodeBackupPath(): string {
  return join(getAppHome(), 'cloudcode-backup.json');
}

export function getLaunchCmdPath(): string {
  return join(getAppHome(), 'launch-antigravity.cmd');
}

export function getLaunchPs1Path(): string {
  return join(getAppHome(), 'launch-antigravity.ps1');
}
