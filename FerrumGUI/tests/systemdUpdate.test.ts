import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  serviceFromCgroup, detectSystemdService, automaticRestartExitCode,
  systemdDurationMs, systemdRestartPlan, installSystemdUpdate,
} from '../src/systemdUpdate';

describe('systemd GUI update', () => {
  test('identifies system and user service units without confusing login scopes or user managers', () => {
    expect(serviceFromCgroup('0::/system.slice/ferrumproxy.service\n')).toEqual({ unit: 'ferrumproxy.service', user: false });
    expect(serviceFromCgroup('1:name=systemd:/system.slice/ferrum-gui@home.service\n')).toEqual({ unit: 'ferrum-gui@home.service', user: false });
    expect(serviceFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/ferrum-gui.service')).toEqual({ unit: 'ferrum-gui.service', user: true });
    for (const scope of ['0::/user.slice/user-1000.slice/session-1.scope', '0::/user.slice/user-1000.slice/user@1000.service', '0::/']) {
      expect(serviceFromCgroup(scope)).toBeUndefined();
    }
  });

  test('requires both the GUI PID and invocation ID to match the service', async () => {
    const calls: string[][] = [];
    const options = {
      platform: 'linux', invocationId: 'my-invocation', pid: 123,
      readCgroup: async () => '0::/system.slice/ferrumproxy.service',
      run: async (args: string[]) => {
        calls.push(args);
        return 'MainPID=123\nInvocationID=my-invocation\nRestart=always\nRestartUSec=3s\nExitType=main';
      },
    };
    const service = await detectSystemdService(options);
    expect(service?.unit).toBe('ferrumproxy.service');
    expect(calls[0].slice(-2)).toEqual(['--', 'ferrumproxy.service']);
    await expect(detectSystemdService({ ...options, pid: 124 })).rejects.toThrow('not the main process');
    await expect(detectSystemdService({ ...options, invocationId: 'other' })).rejects.toThrow('not the main process');
    expect(await detectSystemdService({ ...options, platform: 'win32' })).toBeUndefined();
  });

  test('queues a manager restart for root or user units, including Restart=no', () => {
    const service = { unit: 'ferrumproxy.service', user: false, properties: { Restart: 'no' } };
    expect(systemdRestartPlan(service, 0).managerRestart).toBe(true);
    expect(systemdRestartPlan({ ...service, user: true }, 1000).managerRestart).toBe(true);
    expect(() => systemdRestartPlan(service, 1000)).toThrow('Restart=always');
  });

  test('uses a restartable exit status for an unprivileged system service and honors its restart delay', () => {
    expect(automaticRestartExitCode({ Restart: 'always' })).toBe(0);
    expect(automaticRestartExitCode({ Restart: 'on-success' })).toBe(0);
    expect(automaticRestartExitCode({ Restart: 'on-failure' })).toBe(1);
    expect(automaticRestartExitCode({ Restart: 'on-failure', SuccessExitStatus: '1 2', RestartPreventExitStatus: '3' })).toBe(4);
    expect(automaticRestartExitCode({ Restart: 'always', RestartPreventExitStatus: '0' })).toBe(1);
    expect(automaticRestartExitCode({ Restart: 'always', ExitType: 'cgroup' })).toBeUndefined();
    expect(automaticRestartExitCode({ Restart: 'no' })).toBeUndefined();
    const plan = systemdRestartPlan({ unit: 'gui.service', user: false, properties: { Restart: 'on-failure', RestartUSec: '2min 3s' } }, 1000);
    expect(plan).toEqual({ managerRestart: false, exitCode: 1, restartTimeoutMs: 213000 });
    expect(systemdDurationMs('100ms')).toBe(100);
    expect(systemdDurationMs('1h 30min')).toBe(5400000);
    expect(() => systemdDurationMs('infinity')).toThrow();
  });

  test.each([false, true])('installs before restart and keeps service startup under its own manager (user=%s)', async user => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-systemd-'));
    const target = path.join(root, 'gui');
    const calls: string[][] = [];
    const exits: number[] = [];
    try {
      await fs.writeFile(target, 'old');
      await fs.writeFile(target + '.new', 'new');
      const installer = await installSystemdUpdate(target, { unit: 'ferrumproxy.service', user, properties: { Restart: 'no' } }, {
        uid: 0,
        run: async args => {
          expect(await fs.readFile(target, 'utf8')).toBe('new');
          calls.push(args);
          return '';
        }, exit: code => { exits.push(code); },
      });
      expect(await fs.readFile(target, 'utf8')).toBe('new');
      expect(await fs.readFile(target + '.old', 'utf8')).toBe('old');
      expect(calls).toEqual([]);
      await installer.restart();
      expect(calls).toEqual([[...(user ? ['--user'] : []), '--no-ask-password', '--no-block', 'restart', '--', 'ferrumproxy.service']]);
      expect(exits).toEqual([0]);
    } finally {
      for (const name of ['gui', 'gui.new', 'gui.old']) await fs.unlink(path.join(root, name)).catch(() => {});
      await fs.rmdir(root);
    }
  });

  test('a denied manager restart restores the old binary and leaves the current GUI alive', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-systemd-'));
    const target = path.join(root, 'gui');
    try {
      await fs.writeFile(target, 'old');
      await fs.writeFile(target + '.new', 'new');
      const installer = await installSystemdUpdate(target, { unit: 'gui.service', user: false, properties: {} }, {
        uid: 0, run: async () => { throw new Error('Access denied'); }, exit: () => { throw new Error('Must not exit'); },
      });
      await expect(installer.restart()).rejects.toThrow('Access denied');
      expect(await fs.readFile(target, 'utf8')).toBe('old');
      expect(await fs.readFile(target + '.update.log', 'utf8')).toContain('Access denied');
    } finally {
      for (const name of ['gui', 'gui.new', 'gui.old', 'gui.update.log']) await fs.unlink(path.join(root, name)).catch(() => {});
      await fs.rmdir(root);
    }
  });

  test('an unprivileged service installs first, then exits with its on-failure restart status', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-systemd-'));
    const target = path.join(root, 'gui');
    const exits: number[] = [];
    try {
      await fs.writeFile(target, 'old');
      await fs.writeFile(target + '.new', 'new');
      const installer = await installSystemdUpdate(target, { unit: 'gui.service', user: false, properties: { Restart: 'on-failure', RestartUSec: '3s' } }, {
        uid: 1000, run: async () => { throw new Error('Must not run systemctl as an unprivileged user'); },
        exit: code => { exits.push(code); },
      });
      expect(exits).toEqual([]);
      expect(await fs.readFile(target, 'utf8')).toBe('new');
      await installer.restart();
      expect(exits).toEqual([1]);
      expect(installer.restartTimeoutMs).toBe(93000);
    } finally {
      for (const name of ['gui', 'gui.new', 'gui.old']) await fs.unlink(path.join(root, name)).catch(() => {});
      await fs.rmdir(root);
    }
  });

  test('an unsupported service policy cannot replace the working binary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-systemd-'));
    const target = path.join(root, 'gui');
    try {
      await fs.writeFile(target, 'old');
      await fs.writeFile(target + '.new', 'new');
      await expect(installSystemdUpdate(target, { unit: 'gui.service', user: false, properties: { Restart: 'no' } }, { uid: 1000 })).rejects.toThrow('cannot restart');
      expect(await fs.readFile(target, 'utf8')).toBe('old');
      expect(await fs.readFile(target + '.new', 'utf8')).toBe('new');
    } finally {
      for (const name of ['gui', 'gui.new', 'gui.old']) await fs.unlink(path.join(root, name)).catch(() => {});
      await fs.rmdir(root);
    }
  });
});
