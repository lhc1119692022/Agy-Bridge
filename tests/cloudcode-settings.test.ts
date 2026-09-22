import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyCloudCodeSetting,
  applyOfficialCloudCodeUrl,
  isBridgeCloudCodeUrl,
  restoreCloudCodeSetting,
  restoreOfficialCloudCodeUrl,
} from '../src/engine/cloudcode-settings.js';

describe('official Cloud Code settings', () => {
  it('recognizes injector URLs', () => {
    expect(isBridgeCloudCodeUrl('http://127.0.0.1:19621')).toBe(true);
    expect(isBridgeCloudCodeUrl('http://localhost:19621')).toBe(true);
    expect(isBridgeCloudCodeUrl('https://daily-cloudcode-pa.googleapis.com')).toBe(false);
    expect(isBridgeCloudCodeUrl(undefined)).toBe(false);
  });

  it('writes the injector URL and remembers a non-bridge previous value', () => {
    const applied = applyCloudCodeSetting(
      { 'editor.fontSize': 14, 'jetski.cloudCodeUrl': 'https://example.invalid' },
      'http://127.0.0.1:19621',
    );
    expect(applied.previous).toBe('https://example.invalid');
    expect(applied.next['jetski.cloudCodeUrl']).toBe('http://127.0.0.1:19621');
    expect(applied.next['editor.fontSize']).toBe(14);
  });

  it('does not restore a leftover injector URL', () => {
    const applied = applyCloudCodeSetting(
      { 'jetski.cloudCodeUrl': 'http://127.0.0.1:9096' },
      'http://127.0.0.1:19621',
    );
    expect(applied.previous).toBeNull();
    const restored = restoreCloudCodeSetting(applied.next, applied.previous);
    expect(restored['jetski.cloudCodeUrl']).toBeUndefined();
  });

  it('applies and restores on disk without leaving the injector URL behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-cloudcode-'));
    const backup = join(dir, 'backup.json');
    try {
      applyOfficialCloudCodeUrl(dir, 'http://127.0.0.1:19621', backup);
      const injected = JSON.parse(readFileSync(join(dir, 'User', 'settings.json'), 'utf8')) as { 'jetski.cloudCodeUrl'?: string };
      expect(injected['jetski.cloudCodeUrl']).toBe('http://127.0.0.1:19621');
      restoreOfficialCloudCodeUrl(dir, backup);
      const restored = JSON.parse(readFileSync(join(dir, 'User', 'settings.json'), 'utf8')) as { 'jetski.cloudCodeUrl'?: string };
      expect(restored['jetski.cloudCodeUrl']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
