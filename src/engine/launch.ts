import { execFileSync, execSync, spawn } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, openSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareIdeProfile } from './ide-profile.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runPowerShell(script: string): string {
  return execSync(`powershell.exe -NoProfile -Command ${JSON.stringify(script)}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function commandLineUsesProfile(commandLine: string, profileDir: string): boolean {
  const cmd = commandLine.toLowerCase().replace(/\//g, '\\');
  const dir = profileDir.toLowerCase().replace(/\//g, '\\');
  return cmd.includes(dir);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLockPathHeld(lockPath: string): boolean {
  try {
    const stat = lstatSync(lockPath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(lockPath);
      const pid = Number.parseInt(target.split('-').pop() ?? '', 10);
      return isPidAlive(pid);
    }
  } catch {
    return false;
  }
  try {
    const fd = openSync(lockPath, constants.O_RDWR);
    closeSync(fd);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EAGAIN' || code === 'ETXTBSY';
  }
}

/** True only when Chromium currently holds the profile singleton. Leftover files do not count. */
export function isChromiumProfileLocked(profileDir: string): boolean {
  return ['lockfile', 'SingletonLock'].some(name => isLockPathHeld(join(profileDir, name)));
}

function winIsProcessRunningForProfile(exeName: string, profileDir: string): boolean {
  if (isChromiumProfileLocked(profileDir)) return true;
  try {
    const escapedName = exeName.replace(/'/g, "''");
    const out = runPowerShell(
      `Get-CimInstance Win32_Process -Filter "Name='${escapedName}'" | Select-Object -ExpandProperty CommandLine`,
    );
    return out.split(/\r?\n/).some(line => commandLineUsesProfile(line, profileDir));
  } catch {
    return false;
  }
}

function winQuitProcess(exeName: string): void {
  try {
    runPowerShell(
      `Get-Process -Name '${exeName.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }`,
    );
  } catch { /* ignore */ }
}

function winForceQuitProcess(exeName: string, profileDir: string): void {
  try {
    const escapedDir = profileDir.replace(/'/g, "''");
    runPowerShell(
      `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Where-Object { $_.CommandLine -like '*--user-data-dir=${escapedDir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    );
  } catch { /* ignore */ }
}

function defaultProcessList(): string {
  const psArgs = process.platform === 'linux'
    ? ['-eo', 'pid=,args=']
    : ['-axo', 'pid=,command='];
  if (process.platform !== 'darwin' && process.platform !== 'linux') return '';
  try {
    return execFileSync('ps', psArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024 * 4,
    });
  } catch {
    return '';
  }
}

function linuxAntigravityBinary(): string | null {
  const candidates = [
    '/usr/share/antigravity/antigravity',
    '/opt/antigravity/antigravity',
    join(homedir(), '.local', 'share', 'antigravity', 'antigravity'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function linuxKillByProfile(profileDir: string, signal: NodeJS.Signals): void {
  const output = defaultProcessList();
  for (const line of output.split('\n')) {
    if (!line.includes(`--user-data-dir=${profileDir}`)) continue;
    const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  }
}

export function findAntigravityAppBinary(override = ''): string | null {
  if (override && existsSync(override)) return override;
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    const winPath = join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe');
    return existsSync(winPath) ? winPath : null;
  }
  if (process.platform === 'linux') return linuxAntigravityBinary();
  if (process.platform !== 'darwin') return null;
  const defaultPath = '/Applications/Antigravity.app/Contents/MacOS/Antigravity';
  if (existsSync(defaultPath)) return defaultPath;
  const homePath = join(homedir(), 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Antigravity');
  return existsSync(homePath) ? homePath : null;
}

export function findAntigravityIdeBinary(override = ''): string | null {
  if (override && existsSync(override)) return override;
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    const winPath = join(localAppData, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe');
    return existsSync(winPath) ? winPath : null;
  }
  if (process.platform === 'linux') return linuxAntigravityBinary();
  if (process.platform !== 'darwin') return null;
  const defaultPath = '/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide';
  if (existsSync(defaultPath)) return defaultPath;
  const homePath = join(homedir(), 'Applications', 'Antigravity IDE.app', 'Contents', 'Resources', 'app', 'bin', 'antigravity-ide');
  return existsSync(homePath) ? homePath : null;
}

function isRunningOnUnix(profileDir: string, haystack: (line: string) => boolean): boolean {
  if (isChromiumProfileLocked(profileDir)) return true;
  return defaultProcessList().split('\n').some(haystack);
}

export function isAntigravityIdeRunning(profileDir: string): boolean {
  if (process.platform === 'win32') return winIsProcessRunningForProfile('Antigravity IDE.exe', profileDir);
  return isRunningOnUnix(profileDir, line => (
    process.platform === 'linux'
      ? commandLineUsesProfile(line, profileDir)
      : line.includes('Antigravity IDE.app') && commandLineUsesProfile(line, profileDir)
  ));
}

export function isAntigravityAppRunning(profileDir: string): boolean {
  if (process.platform === 'win32') return winIsProcessRunningForProfile('Antigravity.exe', profileDir);
  return isRunningOnUnix(profileDir, line => (
    process.platform === 'linux'
      ? commandLineUsesProfile(line, profileDir)
      : line.includes('Antigravity.app') && commandLineUsesProfile(line, profileDir)
  ));
}

export async function waitForQuit(isRunning: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning()) return true;
    await sleep(200);
  }
  return !isRunning();
}

export function quitAntigravity(target: 'app' | 'ide', profileDir: string): void {
  if (process.platform === 'win32') {
    winQuitProcess(target === 'ide' ? 'Antigravity IDE.exe' : 'Antigravity.exe');
    return;
  }
  if (process.platform === 'linux') {
    linuxKillByProfile(profileDir, 'SIGTERM');
    return;
  }
  if (process.platform !== 'darwin') return;
  const appName = target === 'ide' ? 'Antigravity IDE' : 'Antigravity';
  try {
    execFileSync('osascript', ['-e', `tell application "${appName}" to quit`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { /* ignore */ }
}

export function forceQuitAntigravity(target: 'app' | 'ide', profileDir: string): void {
  if (process.platform === 'win32') {
    winForceQuitProcess(target === 'ide' ? 'Antigravity IDE.exe' : 'Antigravity.exe', profileDir);
    return;
  }
  if (process.platform === 'linux') linuxKillByProfile(profileDir, 'SIGKILL');
}

export { buildAntigravityChildEnv, detectSystemProxy } from './child-env.js';

export async function launchAntigravity(opts: {
  target: 'app' | 'ide';
  gatewayUrl: string;
  profileDir: string;
  binaryPath: string;
  env: NodeJS.ProcessEnv;
  extraArgs?: string[];
}): Promise<number> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    if (!existsSync(opts.binaryPath)) {
      settle(127);
      return;
    }
    prepareIdeProfile(opts.profileDir, opts.gatewayUrl);
    const args = [
      `--user-data-dir=${opts.profileDir}`,
      '--dns-result-order=ipv4first',
      ...(opts.extraArgs ?? []),
    ];
    const child = spawn(opts.binaryPath, args, {
      stdio: 'ignore',
      detached: true,
      env: opts.env,
    });
    child.unref();
    child.on('spawn', () => settle(0));
    child.on('exit', code => settle(code ?? 1));
    child.on('error', () => settle(1));
  });
}
