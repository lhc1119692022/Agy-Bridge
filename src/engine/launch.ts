import { execFile, spawn } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, openSync, readlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareIdeProfile } from './ide-profile.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function execFileAsync(file: string, args: string[], extra?: { maxBuffer?: number }): Promise<string> {
  return new Promise(resolve => {
    execFile(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
      maxBuffer: extra?.maxBuffer ?? 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      resolve(String(stdout ?? '').trim());
    });
  });
}

function runPowerShell(script: string): Promise<string> {
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

export function normalizeProfileDir(profileDir: string): string {
  return profileDir.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
}

export function sameProfileDir(a: string, b: string): boolean {
  return normalizeProfileDir(a) === normalizeProfileDir(b);
}

export function commandLineUsesProfile(commandLine: string, profileDir: string): boolean {
  const cmd = commandLine.toLowerCase().replace(/\//g, '\\');
  const dir = normalizeProfileDir(profileDir);
  return dir.length > 0 && cmd.includes(dir);
}

export function commandLineIsElectronHelper(commandLine: string): boolean {
  return /--type=/i.test(commandLine);
}

export function commandLineHasUserDataDir(commandLine: string): boolean {
  return /--user-data-dir=/i.test(commandLine);
}

export function commandLineIsAntigravityLanguageServer(commandLine: string): boolean {
  const cmd = commandLine.toLowerCase().replace(/\//g, '\\');
  if (!cmd.includes('language_server')) return false;
  if (cmd.includes('antigravity ide')) return false;
  return cmd.includes('\\antigravity\\')
    || cmd.includes('override_ide_name antigravity')
    || cmd.includes('--app_data_dir antigravity');
}

/**
 * Official Antigravity 2.0: default profile, or an explicit official --user-data-dir.
 * Never matches the isolated injected profile.
 */
export function commandLineMatchesOfficialAppProcess(
  commandLine: string,
  officialProfileDir: string,
  isolatedProfileDir: string,
): boolean {
  const cmd = commandLine.trim();
  if (!cmd) return false;
  if (commandLineUsesProfile(cmd, isolatedProfileDir)) return false;
  if (commandLineUsesProfile(cmd, officialProfileDir)) return true;
  return !commandLineIsElectronHelper(cmd) && !commandLineHasUserDataDir(cmd);
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

interface ListedProcess {
  pid: number;
  commandLine: string;
}

async function listWinProcesses(exeName: string): Promise<ListedProcess[]> {
  const escapedName = exeName.replace(/'/g, "''");
  try {
    const out = await runPowerShell(
      `Get-CimInstance Win32_Process -Filter "Name='${escapedName}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
    );
    if (!out) return [];
    const parsed = JSON.parse(out) as { ProcessId: number; CommandLine?: string } | Array<{ ProcessId: number; CommandLine?: string }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map(row => ({ pid: Number(row.ProcessId), commandLine: row.CommandLine ?? '' }))
      .filter(row => Number.isFinite(row.pid) && row.pid > 0);
  } catch {
    return [];
  }
}

async function winPidsMatching(exeName: string, match: (commandLine: string) => boolean): Promise<number[]> {
  return (await listWinProcesses(exeName))
    .filter(proc => match(proc.commandLine))
    .map(proc => proc.pid);
}

async function winCloseMainWindows(pids: number[]): Promise<void> {
  if (pids.length === 0) return;
  await runPowerShell(
    `@(${pids.join(',')}) | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() } }`,
  );
}

async function winKillProcessTrees(pids: number[]): Promise<void> {
  const unique = [...new Set(pids)].filter(pid => Number.isFinite(pid) && pid > 0);
  await Promise.all(unique.map(async pid => {
    const out = await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    if (!out) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  }));
}

async function defaultProcessList(): Promise<string> {
  const psArgs = process.platform === 'linux'
    ? ['-eo', 'pid=,args=']
    : ['-axo', 'pid=,command='];
  if (process.platform !== 'darwin' && process.platform !== 'linux') return '';
  return execFileAsync('ps', psArgs, { maxBuffer: 1024 * 1024 * 4 });
}

async function unixPidsMatching(match: (commandLine: string) => boolean): Promise<number[]> {
  const pids: number[] = [];
  for (const line of (await defaultProcessList()).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pid = Number.parseInt(trimmed.split(/\s+/)[0] ?? '', 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (match(trimmed)) pids.push(pid);
  }
  return pids;
}

function unixKillPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* already gone */ }
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

export function getOfficialAppProfileDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Antigravity');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Antigravity');
  }
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'Antigravity');
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

export function isAntigravityIdeRunning(profileDir: string): boolean {
  return isChromiumProfileLocked(profileDir);
}

export function isAntigravityAppRunning(profileDir: string): boolean {
  return isChromiumProfileLocked(profileDir);
}

export function isOfficialAntigravityAppRunning(
  officialProfileDir: string,
  _isolatedProfileDir: string,
): boolean {
  return isChromiumProfileLocked(officialProfileDir);
}

export async function waitForQuit(isRunning: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning()) return true;
    await sleep(200);
  }
  return !isRunning();
}

function exeNameFor(target: 'app' | 'ide'): string {
  return target === 'ide' ? 'Antigravity IDE.exe' : 'Antigravity.exe';
}

/** Quit only processes that use this profile. Never kills the other Antigravity 2.0 instance. */
export async function quitAntigravity(target: 'app' | 'ide', profileDir: string): Promise<void> {
  const match = (commandLine: string) => (
    !commandLineIsElectronHelper(commandLine) && commandLineUsesProfile(commandLine, profileDir)
  );
  if (process.platform === 'win32') {
    await winCloseMainWindows(await winPidsMatching(exeNameFor(target), match));
    return;
  }
  unixKillPids(await unixPidsMatching(match), 'SIGTERM');
}

export async function forceQuitAntigravity(target: 'app' | 'ide', profileDir: string): Promise<void> {
  const match = (commandLine: string) => commandLineUsesProfile(commandLine, profileDir);
  if (process.platform === 'win32') {
    await winKillProcessTrees(await winPidsMatching(exeNameFor(target), match));
    return;
  }
  unixKillPids(await unixPidsMatching(match), 'SIGKILL');
}

export async function quitOfficialAntigravityApp(isolatedProfileDir: string, officialProfileDir: string): Promise<void> {
  const match = (commandLine: string) => (
    !commandLineIsElectronHelper(commandLine)
    && commandLineMatchesOfficialAppProcess(commandLine, officialProfileDir, isolatedProfileDir)
  );
  if (process.platform === 'win32') {
    await winCloseMainWindows(await winPidsMatching('Antigravity.exe', match));
    return;
  }
  unixKillPids(await unixPidsMatching(match), 'SIGTERM');
}

export async function forceQuitOfficialAntigravityApp(isolatedProfileDir: string, officialProfileDir: string): Promise<void> {
  const match = (commandLine: string) => (
    commandLineMatchesOfficialAppProcess(commandLine, officialProfileDir, isolatedProfileDir)
  );
  if (process.platform === 'win32') {
    await winKillProcessTrees(await winPidsMatching('Antigravity.exe', match));
    return;
  }
  unixKillPids(await unixPidsMatching(match), 'SIGKILL');
}

export function clearStaleChromiumSidecars(profileDir: string): void {
  if (!profileDir || isChromiumProfileLocked(profileDir)) return;
  for (const name of ['DevToolsActivePort', 'lockfile', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const path = join(profileDir, name);
    if (!existsSync(path)) continue;
    if (isLockPathHeld(path)) continue;
    try { unlinkSync(path); } catch { /* still in use */ }
  }
}

async function languageServerPids(): Promise<number[]> {
  if (process.platform === 'win32') {
    return winPidsMatching('language_server.exe', commandLineIsAntigravityLanguageServer);
  }
  return unixPidsMatching(commandLineIsAntigravityLanguageServer);
}

async function antigravityExePids(): Promise<number[]> {
  if (process.platform === 'win32') {
    return (await listWinProcesses('Antigravity.exe')).map(proc => proc.pid);
  }
  return unixPidsMatching(line => /antigravity/i.test(line) && !/antigravity ide/i.test(line));
}

async function antigravityMainPids(): Promise<number[]> {
  if (process.platform === 'win32') {
    return (await listWinProcesses('Antigravity.exe'))
      .filter(proc => proc.commandLine && !commandLineIsElectronHelper(proc.commandLine))
      .map(proc => proc.pid);
  }
  return unixPidsMatching(line => (
    /antigravity/i.test(line)
    && !/antigravity ide/i.test(line)
    && !commandLineIsElectronHelper(line)
  ));
}

async function killPids(pids: number[]): Promise<void> {
  if (pids.length === 0) return;
  if (process.platform === 'win32') await winKillProcessTrees(pids);
  else unixKillPids(pids, 'SIGKILL');
}

/**
 * After the window is gone, GPU/crashpad/language_server often remain and block the next Start Menu launch.
 * Does not kill a live official main window.
 */
export async function clearOrphanAntigravityConflicts(isolatedProfileDir: string, officialProfileDir: string): Promise<string[]> {
  const notes: string[] = [];
  const isolatedPids = process.platform === 'win32'
    ? await winPidsMatching('Antigravity.exe', cmd => commandLineUsesProfile(cmd, isolatedProfileDir))
    : await unixPidsMatching(line => commandLineUsesProfile(line, isolatedProfileDir));
  if (isolatedPids.length > 0) {
    await killPids(isolatedPids);
    notes.push(`cleared isolated Antigravity (${isolatedPids.length})`);
  }
  if ((await antigravityMainPids()).length === 0) {
    const leftovers = [...await antigravityExePids(), ...await languageServerPids()];
    if (leftovers.length > 0) {
      await killPids(leftovers);
      notes.push(`cleared leftover Antigravity occupancy (${leftovers.length})`);
    }
    clearStaleChromiumSidecars(officialProfileDir);
  }
  clearStaleChromiumSidecars(isolatedProfileDir);
  return notes;
}

/** Full stop before launching from Agy Bridge: window, helpers, language_server, stale locks. */
export async function clearAntigravityLaunchConflicts(officialProfileDir: string, isolatedProfileDir: string): Promise<void> {
  await quitAntigravity2(officialProfileDir, isolatedProfileDir);
  const pids = [
    ...await antigravityExePids(),
    ...await languageServerPids(),
  ];
  if (process.platform === 'win32') await winKillProcessTrees(pids);
  else unixKillPids(pids, 'SIGKILL');
  clearStaleChromiumSidecars(isolatedProfileDir);
  clearStaleChromiumSidecars(officialProfileDir);
}

export { buildAntigravityChildEnv, detectSystemProxy } from './child-env.js';

export function buildAntigravityLaunchPlan(opts: {
  target: 'app' | 'ide';
  profileDir: string;
  extraArgs?: string[];
}): { args: string[]; writeIdeIsolatedSettings: boolean } {
  return {
    args: [
      `--user-data-dir=${opts.profileDir}`,
      '--dns-result-order=ipv4first',
      ...(opts.extraArgs ?? []),
    ],
    writeIdeIsolatedSettings: opts.target === 'ide',
  };
}

export function isAntigravity2Running(officialProfileDir: string, isolatedProfileDir: string): boolean {
  return isChromiumProfileLocked(officialProfileDir)
    || isChromiumProfileLocked(isolatedProfileDir);
}

export async function quitAntigravity2(officialProfileDir: string, isolatedProfileDir: string): Promise<void> {
  await quitOfficialAntigravityApp(isolatedProfileDir, officialProfileDir);
  await quitAntigravity('app', isolatedProfileDir);
}

export async function forceQuitAntigravity2(officialProfileDir: string, isolatedProfileDir: string): Promise<void> {
  await forceQuitOfficialAntigravityApp(isolatedProfileDir, officialProfileDir);
  await forceQuitAntigravity('app', isolatedProfileDir);
}

export async function launchAntigravity(opts: {
  target: 'app' | 'ide';
  gatewayUrl?: string;
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
    const plan = buildAntigravityLaunchPlan({
      target: opts.target,
      profileDir: opts.profileDir,
      extraArgs: opts.extraArgs,
    });
    if (plan.writeIdeIsolatedSettings && opts.gatewayUrl) {
      prepareIdeProfile(opts.profileDir, opts.gatewayUrl);
    }
    const child = spawn(opts.binaryPath, plan.args, {
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
