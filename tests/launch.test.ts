import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAntigravityLaunchPlan,
  commandLineIsAntigravityLanguageServer,
  commandLineIsElectronHelper,
  commandLineMatchesOfficialAppProcess,
  commandLineUsesProfile,
  isAntigravity2Running,
  isChromiumProfileLocked,
  sameProfileDir,
} from '../src/engine/launch.js';

function withProfile(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agy-profile-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Antigravity running detection', () => {
  it('matches a profile path inside a Windows command line', () => {
    const profile = 'C:\\Users\\lhc\\.agy-bridge\\antigravity\\app-profile';
    expect(commandLineUsesProfile(
      '"C:\\...\\Antigravity.exe" --user-data-dir=C:\\Users\\lhc\\.agy-bridge\\antigravity\\app-profile',
      profile,
    )).toBe(true);
    expect(commandLineUsesProfile(
      'Antigravity.exe --user-data-dir=C:/Users/lhc/.agy-bridge/antigravity/app-profile',
      profile,
    )).toBe(true);
    expect(commandLineUsesProfile('Antigravity.exe --user-data-dir=C:\\Users\\lhc\\AppData\\Roaming\\Antigravity', profile)).toBe(false);
  });

  it('does not treat Chromium helper processes as the main window', () => {
    expect(commandLineIsElectronHelper('Antigravity.exe --type=gpu-process --user-data-dir=C:\\Users\\lhc\\.agy-bridge\\antigravity\\app-profile')).toBe(true);
    expect(commandLineIsElectronHelper('"C:\\Programs\\Antigravity\\Antigravity.exe" --user-data-dir=C:\\Users\\lhc\\.agy-bridge\\antigravity\\app-profile')).toBe(false);
    expect(commandLineIsElectronHelper('Antigravity.exe --type=crashpad-handler')).toBe(true);
  });

  it('keeps official and isolated Antigravity 2.0 command lines apart', () => {
    const isolated = 'C:\\Users\\lhc\\.agy-bridge\\antigravity\\app-profile';
    const official = 'C:\\Users\\lhc\\AppData\\Roaming\\Antigravity';
    const startMenu = '"C:\\Users\\lhc\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe"';
    const injected = `"C:\\Users\\lhc\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --user-data-dir=${isolated} --dns-result-order=ipv4first`;
    const officialRelaunch = `"C:\\Users\\lhc\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --user-data-dir=${official} --dns-result-order=ipv4first`;
    const gpuIsolated = `Antigravity.exe --type=gpu-process --user-data-dir=${isolated}`;

    expect(commandLineMatchesOfficialAppProcess(startMenu, official, isolated)).toBe(true);
    expect(commandLineMatchesOfficialAppProcess(officialRelaunch, official, isolated)).toBe(true);
    expect(commandLineMatchesOfficialAppProcess(injected, official, isolated)).toBe(false);
    expect(commandLineMatchesOfficialAppProcess(gpuIsolated, official, isolated)).toBe(false);
    expect(commandLineMatchesOfficialAppProcess('', official, isolated)).toBe(false);
    expect(commandLineUsesProfile(injected, isolated)).toBe(true);
    expect(commandLineUsesProfile(startMenu, isolated)).toBe(false);
    expect(sameProfileDir(official, 'C:/Users/lhc/AppData/Roaming/Antigravity/')).toBe(true);
  });

  it('always launches Antigravity 2.0 with IPv4-first DNS on the given profile', () => {
    const official = 'C:\\Users\\lhc\\AppData\\Roaming\\Antigravity';
    const ide = 'C:\\Users\\lhc\\.agy-bridge\\antigravity\\ide-profile';
    const app = buildAntigravityLaunchPlan({ target: 'app', profileDir: official });
    const idePlan = buildAntigravityLaunchPlan({ target: 'ide', profileDir: ide });
    expect(app.writeIdeIsolatedSettings).toBe(false);
    expect(app.args).toContain(`--user-data-dir=${official}`);
    expect(app.args).toContain('--dns-result-order=ipv4first');
    expect(idePlan.writeIdeIsolatedSettings).toBe(true);
    expect(idePlan.args).toContain(`--user-data-dir=${ide}`);
  });

  it('recognizes Antigravity language_server leftovers', () => {
    expect(commandLineIsAntigravityLanguageServer(
      'C:\\Users\\lhc\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe --standalone --override_ide_name antigravity --app_data_dir antigravity',
    )).toBe(true);
    expect(commandLineIsAntigravityLanguageServer(
      'C:\\Users\\lhc\\AppData\\Local\\Programs\\Antigravity IDE\\resources\\bin\\language_server.exe --override_ide_name "Antigravity IDE"',
    )).toBe(false);
    expect(commandLineIsAntigravityLanguageServer('C:\\other\\language_server.exe')).toBe(false);
  });

  it('does not treat leftover Chromium files as a running instance', () => {
    withProfile(dir => {
      writeFileSync(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/abc');
      writeFileSync(join(dir, 'lockfile'), '');
      writeFileSync(join(dir, 'SingletonLock'), 'stale-host-1');
      expect(isChromiumProfileLocked(dir)).toBe(false);
      expect(isAntigravity2Running(dir, dir)).toBe(false);
    });
  });

  it('treats a live SingletonLock pid as locked', () => {
    withProfile(dir => {
      const lockPath = join(dir, 'SingletonLock');
      try {
        symlinkSync(`testhost-${process.pid}`, lockPath);
      } catch {
        return;
      }
      expect(isChromiumProfileLocked(dir)).toBe(true);
    });
  });

  it('ignores a SingletonLock symlink whose pid is gone', () => {
    withProfile(dir => {
      const lockPath = join(dir, 'SingletonLock');
      try {
        symlinkSync('testhost-2147483647', lockPath);
      } catch {
        return;
      }
      expect(isChromiumProfileLocked(dir)).toBe(false);
    });
  });
});
