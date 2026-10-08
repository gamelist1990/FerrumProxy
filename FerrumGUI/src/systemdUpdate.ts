import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export interface SystemdService {
  unit: string;
  user: boolean;
  properties: Record<string, string>;
}

export interface GuiUpdateRestart {
  restartTimeoutMs: number;
  restart: () => Promise<void>;
}

export function serviceFromCgroup(cgroup: string): { unit: string; user: boolean } | undefined {
  for (const line of cgroup.split('\n')) {
    const match = line.match(/^(?:0::|\d+:name=systemd:)(\/.*)$/);
    if (!match) continue;
    const unit = match[1].split('/').filter(Boolean).at(-1);
    // A login scope/user manager is not the GUI's service. Never restart it.
    if (unit && /^[A-Za-z0-9_:@.\\-]+\.service$/.test(unit) && !/^user@\d+\.service$/.test(unit)) {
      return { unit, user: /\/user@\d+\.service\//.test(match[1]) };
    }
  }
  return undefined;
}

export async function runSystemctl(args: string[]): Promise<string> {
  const { stdout } = await execute('systemctl', args, { timeout: 10000, encoding: 'utf8', maxBuffer: 65536 });
  return stdout;
}

export async function detectSystemdService(options: {
  platform?: string; invocationId?: string; pid?: number;
  readCgroup?: () => Promise<string>; run?: typeof runSystemctl;
} = {}): Promise<SystemdService | undefined> {
  const platform = options.platform ?? process.platform;
  const invocationId = options.invocationId ?? process.env.INVOCATION_ID;
  if (platform !== 'linux' || !invocationId) return undefined;
  const service = serviceFromCgroup(await (options.readCgroup ?? (() => fs.readFile('/proc/self/cgroup', 'utf8')))());
  if (!service) throw new Error('Cannot identify the systemd service running this GUI. Use the GUI binary directly in ExecStart.');
  const output = await (options.run ?? runSystemctl)([
    ...(service.user ? ['--user'] : []), '--no-ask-password', '--no-pager', 'show',
    '--property=MainPID,InvocationID,Restart,RestartUSec,RestartPreventExitStatus,SuccessExitStatus,RefuseManualStart,RefuseManualStop,ExitType',
    '--', service.unit,
  ]);
  const properties: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  if (Number(properties.MainPID) !== (options.pid ?? process.pid) || properties.InvocationID !== invocationId) {
    throw new Error(`The GUI is not the main process of ${service.unit}. Use the GUI binary directly in ExecStart.`);
  }
  return { ...service, properties };
}

export function systemdDurationMs(value: string): number {
  if (value === '0') return 0;
  const units: Record<string, number> = { us: .001, ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000, w: 604800000 };
  let total = 0;
  const remainder = value.replace(/(\d+(?:\.\d+)?)\s*(us|ms|min|s|h|d|w)\b/g, (_, amount, unit) => {
    total += Number(amount) * units[unit];
    return '';
  }).trim();
  if (remainder || !Number.isFinite(total) || !value) throw new Error(`Unsupported systemd restart delay: ${value}`);
  return total;
}

export function automaticRestartExitCode(properties: Record<string, string>): number | undefined {
  if (properties.ExitType === 'cgroup') return undefined;
  const prevent = new Set((properties.RestartPreventExitStatus || '').split(/\s+/));
  const success = new Set(['0', ...(properties.SuccessExitStatus || '').split(/\s+/)]);
  for (let code = 0; code < 126; code++) {
    if (prevent.has(String(code))) continue;
    if (properties.Restart === 'always' ||
      (properties.Restart === 'on-success' && success.has(String(code))) ||
      (properties.Restart === 'on-failure' && !success.has(String(code)))) return code;
  }
  return undefined;
}

export function systemdRestartPlan(service: SystemdService, uid: number): { managerRestart: boolean; exitCode: number; restartTimeoutMs: number } {
  const canRestart = (uid === 0 || service.user) && service.properties.RefuseManualStart !== 'yes' && service.properties.RefuseManualStop !== 'yes';
  if (canRestart) return { managerRestart: true, exitCode: 0, restartTimeoutMs: 90000 };
  const exitCode = automaticRestartExitCode(service.properties);
  if (exitCode === undefined) {
    throw new Error(`${service.unit} cannot restart this GUI automatically. Set Restart=always with ExitType=main, or run it with permission to restart its systemd unit.`);
  }
  return { managerRestart: false, exitCode, restartTimeoutMs: 90000 + systemdDurationMs(service.properties.RestartUSec || '100ms') };
}

export async function installSystemdUpdate(target: string, service: SystemdService, options: {
  uid?: number; run?: typeof runSystemctl; exit?: (code: number) => void;
} = {}): Promise<GuiUpdateRestart> {
  const plan = systemdRestartPlan(service, options.uid ?? process.geteuid!());
  const replacement = `${target}.new`;
  const backup = `${target}.old`;
  const mode = (await fs.stat(target)).mode & 0o777;
  await fs.chmod(replacement, mode);
  // Linux allows replacing a running executable's directory entry. Copy the
  // backup first, then rename atomically so systemd never observes a missing path.
  await fs.copyFile(target, backup);
  await fs.rename(replacement, target);
  return {
    restartTimeoutMs: plan.restartTimeoutMs,
    async restart() {
      if (plan.managerRestart) {
        try {
          // The manager owns the queued job after our service/cgroup is killed.
          await (options.run ?? runSystemctl)([
            ...(service.user ? ['--user'] : []), '--no-ask-password', '--no-block', 'restart', '--', service.unit,
          ]);
        } catch (error) {
          await fs.appendFile(`${target}.update.log`, `Systemd restart failed for ${service.unit}: ${String(error)}\n`, { mode: 0o600 }).catch(() => {});
          await fs.rename(backup, target);
          throw error;
        }
      }
      (options.exit ?? (code => process.exit(code)))(plan.exitCode);
    },
  };
}
