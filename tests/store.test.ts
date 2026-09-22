import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getConfigPath } from '../src/main/paths.js';
import { loadConfig, saveConfig } from '../src/main/store.js';

describe('config store', () => {
  it('creates and reads the default config in the isolated test home', () => {
    const config = loadConfig();
    const path = getConfigPath();
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).cliproxy.baseUrl).toBe('http://127.0.0.1:8317');
    expect(config.upstreams[0]?.id).toBe('local-cliproxy');
  });

  it('persists configuration without dropping the local upstream', () => {
    const config = loadConfig();
    const saved = saveConfig({
      ...config,
      proxyEnabled: true,
      proxyUrl: 'http://127.0.0.1:7890',
    });
    expect(saved.proxyEnabled).toBe(true);
    expect(saved.upstreams[0]?.id).toBe('local-cliproxy');
    expect(loadConfig().proxyUrl).toBe('http://127.0.0.1:7890');
  });
});
