import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readIdeSettings, writeIdeSettings } from './ide-profile.js';

export const CLOUD_CODE_SETTING = 'jetski.cloudCodeUrl';

export interface CloudCodeBackup {
  previous: string | null;
}

export function isBridgeCloudCodeUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (host === '127.0.0.1' || host === 'localhost' || host === '::1') && parsed.port !== '';
  } catch {
    return false;
  }
}

export function applyCloudCodeSetting(
  settings: Record<string, unknown>,
  gatewayUrl: string,
): { next: Record<string, unknown>; previous: string | null } {
  const raw = settings[CLOUD_CODE_SETTING];
  const previous = typeof raw === 'string' && raw.trim() && !isBridgeCloudCodeUrl(raw)
    ? raw
    : null;
  return {
    next: { ...settings, [CLOUD_CODE_SETTING]: gatewayUrl },
    previous,
  };
}

export function restoreCloudCodeSetting(
  settings: Record<string, unknown>,
  previous: string | null,
): Record<string, unknown> {
  const next = { ...settings };
  if (previous && previous.trim() && !isBridgeCloudCodeUrl(previous)) {
    next[CLOUD_CODE_SETTING] = previous;
  } else {
    delete next[CLOUD_CODE_SETTING];
  }
  return next;
}

export function officialSettingsPath(profileDir: string): string {
  return join(profileDir, 'User', 'settings.json');
}

export function readCloudCodeBackup(backupPath: string): CloudCodeBackup | null {
  if (!existsSync(backupPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(backupPath, 'utf8')) as CloudCodeBackup;
    if (!parsed || typeof parsed !== 'object') return null;
    return { previous: typeof parsed.previous === 'string' ? parsed.previous : null };
  } catch {
    return null;
  }
}

export function writeCloudCodeBackup(backupPath: string, backup: CloudCodeBackup): void {
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
}

export function applyOfficialCloudCodeUrl(
  profileDir: string,
  gatewayUrl: string,
  backupPath: string,
): CloudCodeBackup {
  mkdirSync(join(profileDir, 'User'), { recursive: true });
  const settingsPath = officialSettingsPath(profileDir);
  const settings = readIdeSettings(settingsPath);
  const existingBackup = readCloudCodeBackup(backupPath);
  const applied = applyCloudCodeSetting(settings, gatewayUrl);
  const backup: CloudCodeBackup = {
    previous: existingBackup?.previous ?? applied.previous,
  };
  writeIdeSettings(settingsPath, applied.next);
  writeCloudCodeBackup(backupPath, backup);
  return backup;
}

export function restoreOfficialCloudCodeUrl(profileDir: string, backupPath: string): boolean {
  const settingsPath = officialSettingsPath(profileDir);
  if (!existsSync(settingsPath) && !existsSync(backupPath)) return false;
  const settings = readIdeSettings(settingsPath);
  const backup = readCloudCodeBackup(backupPath);
  const next = restoreCloudCodeSetting(settings, backup?.previous ?? null);
  if (existsSync(settingsPath) || Object.keys(next).length > 0) {
    mkdirSync(join(profileDir, 'User'), { recursive: true });
    writeIdeSettings(settingsPath, next);
  }
  if (existsSync(backupPath)) {
    try {
      writeFileSync(backupPath, JSON.stringify({ previous: null }, null, 2), 'utf8');
    } catch { /* ignore */ }
  }
  return true;
}
