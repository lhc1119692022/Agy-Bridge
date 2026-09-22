import { describe, expect, it } from 'vitest';
import {
  envFlag,
  joinKeeperBasePath,
  keeperDashboardHost,
  keeperSilentLaunch,
  parseDotEnv,
  parseKeeperEvents,
  sessionCookieFromHeaders,
  settingsFromKeeperEnv,
} from '../src/engine/keeper.js';

describe('CPA Usage Keeper helpers', () => {
  it('reads host, port, password and auth flag from keeper .env', () => {
    const env = parseDotEnv(`
# comment
APP_HOST=127.0.0.1
APP_PORT=8080
APP_BASE_PATH=
AUTH_ENABLED=true
LOGIN_PASSWORD="secret-pass"
`);
    const settings = settingsFromKeeperEnv(env, {
      dir: 'D:\\CLIProxyAPI\\keeper',
      binaryPath: 'D:\\CLIProxyAPI\\keeper\\cpa-usage-keeper.exe',
      envPath: 'D:\\CLIProxyAPI\\keeper\\.env',
    });
    expect(settings.port).toBe(8080);
    expect(settings.host).toBe('127.0.0.1');
    expect(settings.loginPassword).toBe('secret-pass');
    expect(settings.authEnabled).toBe(true);
    expect(settings.dashboardUrl).toBe('http://127.0.0.1:8080/');
    expect(settings.healthUrl).toBe('http://127.0.0.1:8080/healthz');
    expect(settings.apiBase).toBe('http://127.0.0.1:8080/api/v1');
  });

  it('maps 0.0.0.0 and a subpath onto a local dashboard URL', () => {
    expect(keeperDashboardHost('0.0.0.0')).toBe('127.0.0.1');
    expect(joinKeeperBasePath('/cpa/')).toBe('/cpa');
    expect(envFlag('false', true)).toBe(false);
    expect(envFlag('', true)).toBe(true);
  });

  it('starts Keeper hidden in its own folder', () => {
    const launch = keeperSilentLaunch({
      dir: 'D:\\CLIProxyAPI\\keeper',
      binaryPath: 'D:\\CLIProxyAPI\\keeper\\cpa-usage-keeper.exe',
      envPath: 'D:\\CLIProxyAPI\\keeper\\.env',
    });
    expect(launch.file).toBe('D:\\CLIProxyAPI\\keeper\\cpa-usage-keeper.exe');
    expect(launch.args).toEqual([]);
    expect(launch.cwd).toBe('D:\\CLIProxyAPI\\keeper');
    expect(launch.windowsHide).toBe(true);
  });

  it('maps Keeper request events newest first', () => {
    const page = parseKeeperEvents({
      total_count: 2,
      events: [
        {
          id: '1',
          timestamp: '2026-09-15T01:00:00Z',
          model: 'gemini-3.8-flash',
          source: 'antigravity.json',
          endpoint: '/v1beta/models/gemini-3.8-flash:generateContent',
          failed: false,
          latency_ms: 120,
          tokens: { total_tokens: 80 },
          cost_usd: 0.01,
        },
        {
          id: '2',
          timestamp: '2026-09-15T02:00:00Z',
          model: 'gemini-3.8-pro',
          source: 'codex',
          failed: true,
          latency_ms: 40,
          tokens: { total_tokens: 12 },
        },
      ],
    });
    expect(page.totalCount).toBe(2);
    expect(page.events.map(event => event.id)).toEqual(['2', '1']);
    expect(page.events[0]).toMatchObject({
      model: 'gemini-3.8-pro',
      failed: true,
      latencyMs: 40,
      totalTokens: 12,
    });
  });

  it('reads the Keeper session cookie from Set-Cookie', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'cpa_usage_keeper_session=abc123; Path=/; HttpOnly');
    expect(sessionCookieFromHeaders(headers)).toBe('abc123');
  });
});
