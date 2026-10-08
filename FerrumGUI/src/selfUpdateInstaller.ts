import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { detectSystemdService, installSystemdUpdate, systemdRestartPlan, type GuiUpdateRestart } from './systemdUpdate.js';

export function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// The installer runs separately and waits for the old GUI to release its executable.
export const windowsInstallerScript = String.raw`param([string]$MetadataPath)
$ErrorActionPreference = 'Stop'
$details = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
$target = [IO.Path]::GetFullPath($details.execPath)
$replacement = $target + '.new'
$backup = $target + '.old'
$installed = $false
try {
  $oldProcess = Get-Process -Id $details.processId -ErrorAction SilentlyContinue
  if ($oldProcess -and -not $oldProcess.WaitForExit(60000)) { throw 'The old GUI did not stop.' }
  if (-not (Test-Path -LiteralPath $replacement -PathType Leaf)) { throw 'The downloaded GUI is missing.' }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
  Move-Item -LiteralPath $target -Destination $backup
  try {
    Move-Item -LiteralPath $replacement -Destination $target
    $installed = $true
    $startOptions = @{FilePath=$target; WorkingDirectory=$details.cwd; WindowStyle='Hidden'; PassThru=$true}
    if ($details.arguments) { $startOptions.ArgumentList = $details.arguments }
    $null = Start-Process @startOptions
  } catch {
    if ($installed) { Move-Item -LiteralPath $target -Destination $replacement -Force }
    Move-Item -LiteralPath $backup -Destination $target
    $startOptions = @{FilePath=$target; WorkingDirectory=$details.cwd; WindowStyle='Hidden'; PassThru=$true}
    if ($details.arguments) { $startOptions.ArgumentList = $details.arguments }
    $null = Start-Process @startOptions
    throw
  }
} catch {
  $_ | Out-String | Set-Content -LiteralPath ($target + '.update.log')
} finally {
  Remove-Item -LiteralPath $MetadataPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;

export const unixInstallerScript = String.raw`#!/bin/sh
parent_pid=$1
target=$2
work_dir=$3
shift 3
replacement="$target.new"
backup="$target.old"
log="$target.update.log"
attempt=0
while kill -0 "$parent_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then echo 'The old GUI did not stop.' > "$log"; exit 1; fi
  sleep 1
done
[ -f "$replacement" ] || { echo 'The downloaded GUI is missing.' > "$log"; exit 1; }
cd "$work_dir" || exit 1
rm -f "$backup"
mv "$target" "$backup" || exit 1
if ! mv "$replacement" "$target"; then
  mv "$backup" "$target"
  nohup "$target" "$@" >> "$log" 2>&1 < /dev/null &
  exit 1
fi
chmod 755 "$target"
nohup "$target" "$@" >> "$log" 2>&1 < /dev/null &
rm -f "$0"
`;

export async function startGuiUpdateInstaller(beforeInstall?: () => Promise<void>): Promise<GuiUpdateRestart> {
  const target = process.execPath;
  const service = await detectSystemdService();
  // Reject unsupported service policies before stopping any managed proxies.
  if (service) systemdRestartPlan(service, process.geteuid!());
  await beforeInstall?.();
  if (service) return installSystemdUpdate(target, service);
  const windows = process.platform === 'win32';
  const scriptPath = `${target}.update-${process.pid}.${windows ? 'ps1' : 'sh'}`;
  const metadataPath = `${scriptPath}.json`;
  try {
    await fs.writeFile(scriptPath, windows ? windowsInstallerScript : unixInstallerScript, {mode:0o600});
    if (windows) {
      await fs.writeFile(metadataPath, JSON.stringify({
        execPath: target, processId: process.pid, cwd: process.cwd(),
        arguments: process.argv.slice(2).map(quoteWindowsArgument).join(' '),
      }), {mode:0o600});
    }
    const log = await fs.open(`${target}.installer.log`,'a',0o600);
    // Bun on Windows kills directly spawned detached children at GUI exit.
    // A cmd/start bootstrap breaks the installer out of that job object:
    // https://github.com/oven-sh/bun/issues/31603
    // Paths travel in environment variables, never in cmd command text.
    const encodedCommand = Buffer.from('& $env:FERRUM_GUI_UPDATE_SCRIPT -MetadataPath $env:FERRUM_GUI_UPDATE_METADATA','utf16le').toString('base64');
    const child = spawn(windows ? 'cmd.exe' : '/bin/sh', windows
      ? ['/d','/c','start','', '/b','powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',encodedCommand]
      : [scriptPath,String(process.pid),target,process.cwd(),...process.argv.slice(2)],
      {detached:!windows,stdio:['ignore',log.fd,log.fd],windowsHide:true,
        env:{...process.env,FERRUM_GUI_UPDATE_SCRIPT:scriptPath,FERRUM_GUI_UPDATE_METADATA:metadataPath}});
    try {
      if (windows) {
        await new Promise<void>((resolve,reject) => {
          child.once('error',reject);
          child.once('exit',code => code === 0 ? resolve() : reject(new Error(`Installer launcher exited with ${code}`)));
        });
      } else {
        await new Promise<void>((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });
        child.unref();
      }
    } finally { await log.close(); }
  } catch (error) {
    await fs.rm(scriptPath,{force:true}).catch(() => {});
    await fs.rm(metadataPath,{force:true}).catch(() => {});
    throw error;
  }
  return { restartTimeoutMs: 90000, restart: async () => { process.exit(0); } };
}
