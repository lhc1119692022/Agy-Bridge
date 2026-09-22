import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

export function buildAntigravityLaunchCmd(opts: {
  exePath: string;
  proxyUrl?: string;
}): string {
  const exe = opts.exePath.replace(/"/g, '');
  const proxy = opts.proxyUrl?.trim() ?? '';
  const proxyLines = proxy
    ? `if "%HTTPS_PROXY%"=="" set "HTTPS_PROXY=${proxy}"\r\nif "%HTTP_PROXY%"=="" set "HTTP_PROXY=${proxy}"\r\nif "%https_proxy%"=="" set "https_proxy=${proxy}"\r\nif "%http_proxy%"=="" set "http_proxy=${proxy}"`
    : 'rem no system proxy detected at hook install time';
  return `@echo off\r
setlocal\r
set "AGY_EXE=${exe}"\r
if not exist "%AGY_EXE%" (\r
  echo Antigravity 2.0 not found: %AGY_EXE%\r
  exit /b 1\r
)\r
${proxyLines}\r
set "NO_PROXY=127.0.0.1,localhost,::1"\r
set "no_proxy=%NO_PROXY%"\r
start "" "%AGY_EXE%" --dns-result-order=ipv4first %*\r
`;
}

export function buildAntigravityLaunchPs1(opts: {
  exePath: string;
  proxyUrl?: string;
}): string {
  const exe = opts.exePath.replace(/'/g, "''");
  const proxy = (opts.proxyUrl?.trim() ?? '').replace(/'/g, "''");
  const proxyBlock = proxy
    ? `$proxy = '${proxy}'
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = $proxy }
if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $proxy }
if (-not $env:https_proxy) { $env:https_proxy = $proxy }
if (-not $env:http_proxy) { $env:http_proxy = $proxy }`
    : '# no system proxy detected at hook install time';
  return `$ErrorActionPreference = 'Stop'
$agy = '${exe}'
if (-not (Test-Path -LiteralPath $agy)) {
  throw "Antigravity 2.0 not found: $agy"
}
${proxyBlock}
$env:NO_PROXY = '127.0.0.1,localhost,::1'
$env:no_proxy = $env:NO_PROXY
Start-Process -FilePath $agy -ArgumentList '--dns-result-order=ipv4first'
`;
}

export function defaultAntigravityShortcutPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Antigravity.lnk');
}

function shortcutSearchRoots(): string[] {
  return [
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(homedir(), 'Desktop'),
    join(process.env.USERPROFILE ?? homedir(), 'OneDrive', 'Desktop'),
    join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop'),
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ];
}

function runPowerShellFile(script: string): string {
  const tmp = join(homedir(), '.agy-bridge', `hook-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, script, 'utf8');
  try {
    return execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', tmp,
    ], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function listAntigravityShortcutPaths(): string[] {
  const found = new Set<string>();
  const known = defaultAntigravityShortcutPath();
  if (existsSync(known)) found.add(known);

  const roots = shortcutSearchRoots().filter(root => existsSync(root));
  if (roots.length === 0) return [...found];

  const rootLiteral = roots.map(root => `'${root.replace(/'/g, "''")}'`).join(', ');
  try {
    const out = runPowerShellFile(`
$ErrorActionPreference = 'SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell
$roots = @(${rootLiteral})
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object {
      $sc = $sh.CreateShortcut($_.FullName)
      $target = [string]$sc.TargetPath
      if ($target -match '(?i)[\\\\/]Antigravity\\.exe$' -and $target -notmatch '(?i)Antigravity IDE') {
        Write-Output $_.FullName
      } elseif ($_.BaseName -match '(?i)^Antigravity$' ) {
        Write-Output $_.FullName
      }
    }
}
`);
    for (const line of out.split(/\r?\n/)) {
      const path = line.trim();
      if (path) found.add(path);
    }
  } catch {
    if (existsSync(known)) found.add(known);
  }
  return [...found];
}

export function writeLaunchCmd(cmdPath: string, exePath: string, proxyUrl?: string): void {
  mkdirSync(dirname(cmdPath), { recursive: true });
  writeFileSync(cmdPath, buildAntigravityLaunchCmd({ exePath, proxyUrl }), 'utf8');
}

export function writeLaunchPs1(ps1Path: string, exePath: string, proxyUrl?: string): void {
  mkdirSync(dirname(ps1Path), { recursive: true });
  writeFileSync(ps1Path, buildAntigravityLaunchPs1({ exePath, proxyUrl }), 'utf8');
}

export function retargetShortcut(lnkPath: string, ps1Path: string, exePath: string): void {
  const escapedLnk = lnkPath.replace(/'/g, "''");
  const escapedPs1 = ps1Path.replace(/'/g, "''");
  const escapedExe = exePath.replace(/'/g, "''");
  const workDir = dirname(exePath).replace(/'/g, "''");
  runPowerShellFile(`
$ErrorActionPreference = 'Stop'
$lnk = '${escapedLnk}'
$ps1 = '${escapedPs1}'
$exe = '${escapedExe}'
$sh = New-Object -ComObject WScript.Shell
$dir = Split-Path -Parent $lnk
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bak = "$lnk.agy-bridge.bak"
if ((Test-Path -LiteralPath $lnk) -and -not (Test-Path -LiteralPath $bak)) {
  Copy-Item -LiteralPath $lnk -Destination $bak -Force
}
$sc = $sh.CreateShortcut($lnk)
$sc.TargetPath = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"'
$sc.WorkingDirectory = '${workDir}'
$sc.IconLocation = ($exe + ',0')
$sc.WindowStyle = 7
$sc.Description = 'Antigravity 2.0 (Agy Bridge launch wrapper)'
$sc.Save()
`);
}

export function readUserEnv(name: string): string | undefined {
  try {
    const out = execSync(`reg query "HKCU\\Environment" /v ${name}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.match(/REG_(?:SZ|EXPAND_SZ)\s+(\S.*)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export const BRIDGE_NO_PROXY = '127.0.0.1,localhost,::1';

export function isBridgeWrittenProxyEnv(
  name: string,
  value: string | undefined,
  proxyUrl?: string,
): boolean {
  const current = value?.trim();
  if (!current) return false;
  const key = name.toUpperCase();
  if (key === 'NO_PROXY') return current === BRIDGE_NO_PROXY;
  const proxy = proxyUrl?.trim();
  if (key === 'HTTPS_PROXY' || key === 'HTTP_PROXY') {
    if (proxy && current === proxy) return true;
    return current === 'http://127.0.0.1:7890';
  }
  return false;
}

function deleteUserEnv(name: string): void {
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    `[Environment]::SetEnvironmentVariable('${name.replace(/'/g, "''")}', $null, 'User')`,
  ], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function persistUserProxyEnv(proxyUrl: string | undefined): string[] {
  const changed: string[] = [];
  if (process.platform !== 'win32') return changed;
  const proxy = proxyUrl?.trim();
  if (!proxy) return changed;
  const pairs: Array<[string, string]> = [
    ['HTTPS_PROXY', proxy],
    ['HTTP_PROXY', proxy],
    ['NO_PROXY', BRIDGE_NO_PROXY],
  ];
  for (const [name, value] of pairs) {
    if (readUserEnv(name) === value) continue;
    execFileSync('setx.exe', [name, value], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    changed.push(name);
  }
  return changed;
}

export function removeBridgeUserProxyEnv(proxyUrl?: string): string[] {
  const removed: string[] = [];
  if (process.platform !== 'win32') return removed;
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
    const current = readUserEnv(name);
    if (!isBridgeWrittenProxyEnv(name, current, proxyUrl)) continue;
    deleteUserEnv(name);
    removed.push(name);
  }
  return removed;
}

export function restoreShortcutFromBackup(lnkPath: string, exePath?: string): boolean {
  const escapedLnk = lnkPath.replace(/'/g, "''");
  const escapedExe = (exePath ?? '').replace(/'/g, "''");
  const out = runPowerShellFile(`
$ErrorActionPreference = 'Stop'
$lnk = '${escapedLnk}'
$bak = "$lnk.agy-bridge.bak"
$exe = '${escapedExe}'
$sh = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $bak) {
  Copy-Item -LiteralPath $bak -Destination $lnk -Force
  Remove-Item -LiteralPath $bak -Force
  Write-Output 'backup'
  exit 0
}
if (-not (Test-Path -LiteralPath $lnk)) { exit 0 }
$sc = $sh.CreateShortcut($lnk)
$lnkArgs = [string]$sc.Arguments
$target = [string]$sc.TargetPath
if ($lnkArgs -match 'launch-antigravity\\.ps1' -or $target -match '(?i)powershell\\.exe$') {
  if (-not $exe) { throw 'missing Antigravity.exe path to restore shortcut' }
  $sc.TargetPath = $exe
  $sc.Arguments = ''
  $sc.WorkingDirectory = Split-Path -Parent $exe
  $sc.IconLocation = ($exe + ',0')
  $sc.WindowStyle = 1
  $sc.Description = 'Antigravity'
  $sc.Save()
  Write-Output 'retarget'
}
`);
  return out === 'backup' || out === 'retarget';
}

export function listPatchedShortcutPaths(): string[] {
  const found = new Set<string>(listAntigravityShortcutPaths());
  found.add(defaultAntigravityShortcutPath());
  const roots = shortcutSearchRoots().filter(root => existsSync(root));
  if (roots.length === 0) return [...found];
  const rootLiteral = roots.map(root => `'${root.replace(/'/g, "''")}'`).join(', ');
  try {
    const out = runPowerShellFile(`
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(${rootLiteral})
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Filter *.lnk.agy-bridge.bak -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName -replace '\\.agy-bridge\\.bak$','' }
  Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object {
      $sh = New-Object -ComObject WScript.Shell
      $sc = $sh.CreateShortcut($_.FullName)
      if ([string]$sc.Arguments -match 'launch-antigravity\\.ps1') { Write-Output $_.FullName }
    }
}
`);
    for (const line of out.split(/\r?\n/)) {
      const path = line.trim();
      if (path) found.add(path);
    }
  } catch { /* keep known paths */ }
  return [...found];
}

export function installAntigravityLaunchHook(opts: {
  cmdPath: string;
  ps1Path: string;
  exePath: string;
  proxyUrl?: string;
}): { cmdPath: string; ps1Path: string; shortcuts: string[]; envChanged: string[]; errors: string[] } {
  writeLaunchCmd(opts.cmdPath, opts.exePath, opts.proxyUrl);
  writeLaunchPs1(opts.ps1Path, opts.exePath, opts.proxyUrl);
  const errors: string[] = [];
  const shortcuts: string[] = [];
  const wanted = new Set(listAntigravityShortcutPaths());
  wanted.add(defaultAntigravityShortcutPath());
  if (process.platform === 'win32') {
    for (const lnk of wanted) {
      try {
        retargetShortcut(lnk, opts.ps1Path, opts.exePath);
        shortcuts.push(lnk);
      } catch (err) {
        errors.push(`${lnk}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  let envChanged: string[] = [];
  try {
    envChanged = persistUserProxyEnv(opts.proxyUrl);
  } catch (err) {
    errors.push(`user env: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { cmdPath: opts.cmdPath, ps1Path: opts.ps1Path, shortcuts, envChanged, errors };
}

export function uninstallAntigravityLaunchHook(opts: {
  cmdPath?: string;
  ps1Path?: string;
  exePath?: string;
  proxyUrl?: string;
}): { shortcuts: string[]; envRemoved: string[]; errors: string[] } {
  const errors: string[] = [];
  const shortcuts: string[] = [];
  if (process.platform === 'win32') {
    for (const lnk of listPatchedShortcutPaths()) {
      try {
        if (restoreShortcutFromBackup(lnk, opts.exePath)) shortcuts.push(lnk);
      } catch (err) {
        errors.push(`${lnk}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  let envRemoved: string[] = [];
  try {
    envRemoved = removeBridgeUserProxyEnv(opts.proxyUrl);
  } catch (err) {
    errors.push(`user env: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const file of [opts.cmdPath, opts.ps1Path]) {
    if (!file) continue;
    try { unlinkSync(file); } catch { /* ignore missing */ }
  }
  return { shortcuts, envRemoved, errors };
}
