import { describe, expect, it } from 'vitest';
import { normalizeClientKey, parseCliproxyYaml, parseModelList, pickClientKey, projectLooksLikeCliproxy, requireClientKey, windowsConsoleLaunch } from '../src/engine/cliproxy.js';
import { isLoopbackUrl } from '../src/engine/http.js';

describe('CLIProxyAPI helpers', () => {
  it('recognizes a project folder by config.yaml + start.cmd, not a homemade CLIProxyAPI shortcut', () => {
    expect(projectLooksLikeCliproxy(['config.yaml', 'start.cmd', 'cli-proxy-api.exe'])).toBe(true);
    expect(projectLooksLikeCliproxy(['config.yaml', 'start.cmd'])).toBe(true);
    expect(projectLooksLikeCliproxy(['CLIProxyAPI.exe', 'CLIProxyAPI.lnk'])).toBe(false);
    expect(projectLooksLikeCliproxy(['config.yaml', 'CLIProxyAPI.exe'])).toBe(false);
  });

  it('reads port, auth-dir and api-keys from the project config.yaml', () => {
    const info = parseCliproxyYaml(`
host: ""
port: 8317
auth-dir: "~/.cli-proxy-api"
api-keys:
  - "client-key-1"
  - "client-key-2"
proxy-url: "http://127.0.0.1:7890"
debug: false
`);
    expect(info.port).toBe(8317);
    expect(info.authDir).toBe('~/.cli-proxy-api');
    expect(info.apiKeys).toEqual(['client-key-1', 'client-key-2']);
    expect(info.proxyUrl).toBe('http://127.0.0.1:7890');
  });

  it('parses both Gemini and OpenAI model lists', () => {
    expect(parseModelList({
      models: [{ name: 'models/gemini-3-flash', displayName: 'Flash' }],
    })).toEqual([{ id: 'gemini-3-flash', name: 'Flash' }]);
    expect(parseModelList({
      data: [{ id: 'gemini-3-pro' }],
    })).toEqual([{ id: 'gemini-3-pro', name: 'gemini-3-pro' }]);
  });

  it('opens a new console with start, instead of an empty Electron-attached cmd', () => {
    const launch = windowsConsoleLaunch('D:\\CLIProxyAPI', 'start.cmd');
    expect(launch.args[0]).toBe('/c');
    expect(launch.args[1]).toContain('start "CLIProxyAPI"');
    expect(launch.args[1]).toContain('/D "D:\\CLIProxyAPI"');
    expect(launch.args[1]).toContain('cmd /k start.cmd');
    expect(launch.args.join(' ')).not.toMatch(/CLIProxyAPI\.exe/);
  });

  it('uses api-keys from the project yaml and ignores leftover placeholder keys', () => {
    expect(normalizeClientKey('agy-bridge')).toBe('');
    expect(pickClientKey('agy-bridge', ['client-a', 'client-b'])).toBe('client-a');
    expect(pickClientKey('client-b', ['client-a', 'client-b'])).toBe('client-b');
    expect(() => requireClientKey('agy-bridge')).toThrow(/没有可用的 api-keys/);
  });

  it('does not send loopback injector traffic through the system proxy', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8317/v1beta/models')).toBe(true);
    expect(isLoopbackUrl('https://ezaiclub.com/v1beta/models')).toBe(false);
  });
});
