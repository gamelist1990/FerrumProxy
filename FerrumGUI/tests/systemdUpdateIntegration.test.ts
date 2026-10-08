import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { waitForGuiRestart } from '../frontend/src/utils/guiRestart';

const execute = promisify(execFile);
// Explicit opt-in: these tests create disposable transient units in a Linux test VM.
const enabled = process.platform === 'linux' && process.geteuid?.() === 0 &&
  process.env.FERRUM_GUI_TEST_SYSTEMD === '1' && (await fs.readFile('/proc/1/comm', 'utf8')).trim() === 'systemd';

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

for (const [user, restart] of [['root', 'no'], ['nobody', 'always'], ['nobody', 'on-failure']]) {
  test.skipIf(!enabled)(`real systemd updates ${user} GUI with Restart=${restart} and KillMode=control-group`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-systemd-integration-'));
    const unit = `ferrum-gui-test-${path.basename(root)}.service`;
    const executable = path.join(root, 'gui');
    const module = path.resolve(import.meta.dir, '../src/selfUpdateInstaller.ts');
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}`;
    try {
      const oldEntry = path.join(root, 'old.ts');
      const newEntry = path.join(root, 'new.ts');
      await fs.writeFile(oldEntry, `import {startGuiUpdateInstaller} from ${JSON.stringify(module)};
Bun.serve({hostname:'127.0.0.1',port:${port},async fetch(request){
  if(new URL(request.url).pathname==='/api/self/update'){
    const installer=await startGuiUpdateInstaller();
    setTimeout(()=>void installer.restart(),250);
    return Response.json({version:'new',restartTimeoutMs:installer.restartTimeoutMs});
  }
  return Response.json({guiVersion:'old'});
}});`);
      await fs.writeFile(newEntry, `await Bun.write(${JSON.stringify(path.join(root, 'started.json'))},JSON.stringify({pid:process.pid,args:process.argv.slice(2),cwd:process.cwd(),cgroup:await Bun.file('/proc/self/cgroup').text()}));
Bun.serve({hostname:'127.0.0.1',port:${port},fetch(){return Response.json({guiVersion:'new'});}});`);
      for (const [entry, output] of [[oldEntry, executable], [newEntry, executable + '.new']]) {
        await execute(process.execPath, ['build', '--compile', entry, '--outfile', output]);
      }
      const { stdout: uidText } = await execute('id', ['-u', user]);
      const { stdout: gidText } = await execute('id', ['-g', user]);
      for (const file of [root, executable, executable + '.new']) await fs.chown(file, Number(uidText), Number(gidText));
      const args = ['--private', 'a path with "quotes"', 'trailing\\'];
      await execute('systemd-run', ['--quiet', '--collect', `--unit=${unit}`, '--property=Type=exec',
        '--property=KillMode=control-group', `--property=Restart=${restart}`, '--property=RestartSec=250ms',
        `--property=User=${user}`, `--property=WorkingDirectory=${root}`, '--', executable, ...args]);
      const readVersion = async () => (await (await fetch(`${url}/api/auth/status`)).json()).guiVersion;
      await waitForGuiRestart('old', readVersion, 10000, 50);
      const { stdout: pidText } = await execute('systemctl', ['show', '--value', '--property=MainPID', unit]);
      const oldPid = Number(pidText);
      const ready = await (await fetch(`${url}/api/self/update`, { method: 'POST' })).json();
      expect(ready.version).toBe('new');
      expect(await Bun.file(executable + '.old').exists()).toBe(true);
      expect((await fs.readdir(root)).some(name => name.includes('.update-'))).toBe(false);
      await waitForGuiRestart('new', readVersion, 10000, 50);
      const started = JSON.parse(await fs.readFile(path.join(root, 'started.json'), 'utf8'));
      const { stdout: newPidText } = await execute('systemctl', ['show', '--value', '--property=MainPID', unit]);
      expect(started.pid).toBe(Number(newPidText));
      expect(started.pid).not.toBe(oldPid);
      expect(started.args).toEqual(args);
      expect(started.cwd).toBe(root);
      expect(started.cgroup).toContain(unit);
      expect(await fs.stat(`/proc/${oldPid}`).then(() => true, () => false)).toBe(false);
      const { stdout: policy } = await execute('systemctl', ['show', '--value', '--property=Restart', unit]);
      expect(policy.trim()).toBe(restart);
    } finally {
      await execute('systemctl', ['stop', unit]).catch(() => {});
      const target = path.resolve(root);
      if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('ferrum-systemd-integration-')) throw new Error('Unsafe fixture cleanup');
      await fs.rm(target, { recursive: true, force: true });
    }
  }, 30000);
}
