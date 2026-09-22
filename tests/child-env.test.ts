import { describe, expect, it } from 'vitest';
import {
  applyOutboundProxy,
  buildAntigravityChildEnv,
  parseWindowsInternetProxy,
  parseWindowsProxyServer,
  sanitizeSpawnEnv,
} from '../src/engine/child-env.js';

describe('child env', () => {
  it('strips Electron parent variables so Antigravity.exe is not launched as a nested Electron', () => {
    const env = sanitizeSpawnEnv({
      PATH: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
      CHROME_CRASHPAD_PIPE_NAME: '\\\\.\\pipe\\foo',
      NODE_OPTIONS: '--require something',
      CLOUD_CODE_URL: 'http://127.0.0.1:9',
    });
    expect(env.PATH).toBe('C:\\Windows');
    expect(env.CLOUD_CODE_URL).toBe('http://127.0.0.1:9');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_NO_ASAR).toBeUndefined();
    expect(env.CHROME_CRASHPAD_PIPE_NAME).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('parses Windows Internet Settings proxy', () => {
    expect(parseWindowsInternetProxy({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7890' }))
      .toBe('http://127.0.0.1:7890');
    expect(parseWindowsInternetProxy({ ProxyEnable: 0, ProxyServer: '127.0.0.1:7890' }))
      .toBeUndefined();
    expect(parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7890'))
      .toBe('http://127.0.0.1:7890');
  });

  it('keeps localhost off the outbound proxy', () => {
    const env = applyOutboundProxy({ PATH: 'x' }, 'http://127.0.0.1:7890');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.NO_PROXY).toContain('127.0.0.1');
    expect(env.NO_PROXY).toContain('localhost');
  });

  it('injects Cloud Code only when a gateway URL is provided', () => {
    const injected = buildAntigravityChildEnv({
      gatewayUrl: 'http://127.0.0.1:9',
      proxyUrl: 'http://127.0.0.1:7890',
      baseEnv: { PATH: 'C:\\Windows' },
    });
    expect(injected.CLOUD_CODE_URL).toBe('http://127.0.0.1:9');
    expect(injected.ANTIGRAVITY_API_KEY).toBe('agy-bridge-dummy');
    expect(injected.HTTPS_PROXY).toBe('http://127.0.0.1:7890');

    const official = buildAntigravityChildEnv({
      proxyUrl: 'http://127.0.0.1:7890',
      baseEnv: {
        PATH: 'C:\\Windows',
        CLOUD_CODE_URL: 'http://127.0.0.1:9',
        ANTIGRAVITY_API_KEY: 'agy-bridge-dummy',
        GEMINI_API_KEY: 'agy-bridge-dummy',
      },
    });
    expect(official.CLOUD_CODE_URL).toBeUndefined();
    expect(official.ANTIGRAVITY_API_KEY).toBeUndefined();
    expect(official.GEMINI_API_KEY).toBeUndefined();
    expect(official.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(official.NO_PROXY).toContain('127.0.0.1');
  });
});
