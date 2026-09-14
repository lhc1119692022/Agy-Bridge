import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandLineUsesProfile, isChromiumProfileLocked } from '../src/engine/launch.js';

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

  it('does not treat leftover Chromium files as a running instance', () => {
    withProfile(dir => {
      writeFileSync(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/abc');
      writeFileSync(join(dir, 'lockfile'), '');
      writeFileSync(join(dir, 'SingletonLock'), 'stale-host-1');
      expect(isChromiumProfileLocked(dir)).toBe(false);
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
