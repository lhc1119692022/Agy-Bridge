import { describe, expect, it } from 'vitest';
import {
  BRIDGE_NO_PROXY,
  buildAntigravityLaunchCmd,
  buildAntigravityLaunchPs1,
  isBridgeWrittenProxyEnv,
} from '../src/engine/launch-hook.js';

describe('Antigravity launch wrapper', () => {
  it('embeds the exe path, proxy, IPv4-first flag, and localhost NO_PROXY', () => {
    const cmd = buildAntigravityLaunchCmd({
      exePath: 'C:\\Users\\lhc\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
      proxyUrl: 'http://127.0.0.1:7890',
    });
    expect(cmd).toContain('Antigravity.exe');
    expect(cmd).toContain('HTTPS_PROXY=http://127.0.0.1:7890');
    expect(cmd).toContain('--dns-result-order=ipv4first');
    expect(cmd).toContain('NO_PROXY=127.0.0.1,localhost,::1');
  });

  it('writes a PowerShell launcher that sets process env before Start-Process', () => {
    const ps1 = buildAntigravityLaunchPs1({
      exePath: 'C:\\Users\\lhc\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
      proxyUrl: 'http://127.0.0.1:7890',
    });
    expect(ps1).toContain('Antigravity.exe');
    expect(ps1).toContain("HTTPS_PROXY = $proxy");
    expect(ps1).toContain('--dns-result-order=ipv4first');
    expect(ps1).toContain('127.0.0.1,localhost,::1');
  });

  it('only treats proxy env values the bridge itself wrote as removable', () => {
    expect(isBridgeWrittenProxyEnv('HTTPS_PROXY', 'http://127.0.0.1:7890', 'http://127.0.0.1:7890')).toBe(true);
    expect(isBridgeWrittenProxyEnv('NO_PROXY', BRIDGE_NO_PROXY)).toBe(true);
    expect(isBridgeWrittenProxyEnv('HTTPS_PROXY', 'http://corporate.example:8080', 'http://127.0.0.1:7890')).toBe(false);
    expect(isBridgeWrittenProxyEnv('HTTPS_PROXY', undefined, 'http://127.0.0.1:7890')).toBe(false);
  });
});
