import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {quoteWindowsArgument} from '../src/selfUpdateInstaller';

async function removeFixture(root: string): Promise<void> {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('ferrum ')) {
    throw new Error('Unsafe cleanup path');
  }
  // Windows can retain executable/cwd handles briefly after the marker is written.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rm(target,{recursive:true,force:true}); return; }
    catch (error) {
      if (attempt >= 40 || !['EACCES','EPERM','EBUSY','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      await Bun.sleep(50);
    }
  }
}

test('Windows command line preserves spaces, embedded quotes, and trailing backslashes',() => {
  expect(quoteWindowsArgument('path with spaces')).toBe('"path with spaces"');
  expect(quoteWindowsArgument('a"b')).toBe('"a\\"b"');
  expect(quoteWindowsArgument('C:\\folder\\')).toBe('"C:\\folder\\\\"');
});

test('installer waits for the old GUI, replaces it, relaunches with the same arguments, and exits',async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"ferrum updater ' & "));
  const executable = path.join(root,process.platform === 'win32' ? 'gui.exe' : 'gui');
  const marker = path.join(root,'started.json');
  const stopped = path.join(root,'old-stopped');
  const installerModule = path.resolve(import.meta.dir,'../src/selfUpdateInstaller.ts');
  try {
    const oldEntry = path.join(root,'old.ts');
    const newEntry = path.join(root,'new.ts');
    const downloaded = path.join(root,process.platform === 'win32' ? 'downloaded.exe' : 'downloaded');
    await fs.writeFile(oldEntry,`import {startGuiUpdateInstaller} from ${JSON.stringify(installerModule)};
await startGuiUpdateInstaller();
await new Promise(resolve=>setTimeout(resolve,300));
await Bun.write(${JSON.stringify(stopped)},'done');
process.exit(0);`);
    await fs.writeFile(newEntry,`await Bun.write(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),stopped:await Bun.file(${JSON.stringify(stopped)}).exists()}));`);
    for (const [entry,output] of [[oldEntry,executable],[newEntry,downloaded]]) {
      const build = Bun.spawn([process.execPath,'build','--compile',entry!,'--outfile',output!],{stdout:'pipe',stderr:'pipe'});
      expect(await build.exited).toBe(0);
    }
    await fs.rename(downloaded,executable+'.new');
    expect(await Bun.file(executable+'.new').exists()).toBe(true);
    const args = ['--private','a path with "quotes"','trailing\\'];
    const old = spawn(executable,args,{cwd:root,stdio:'ignore',windowsHide:true});
    const code = await new Promise<number|null>((resolve,reject) => {old.once('exit',resolve);old.once('error',reject);});
    expect(code).toBe(0);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !(await Bun.file(marker).exists())) await Bun.sleep(100);
    if (!(await Bun.file(marker).exists())) {
      const log = await fs.readFile(executable+'.update.log','utf8').catch(() => fs.readFile(executable+'.installer.log','utf8').catch(() => 'No installer log'));
      throw new Error(`Installer did not restart: ${log}; files: ${(await fs.readdir(root)).join(', ')}`);
    }
    const result = JSON.parse(await fs.readFile(marker,'utf8'));
    expect(result).toEqual({args,stopped:true});
    expect(await Bun.file(executable+'.old').exists()).toBe(true);
    // The installer removes its own script and metadata on completion.
    while (Date.now() < deadline && (await fs.readdir(root)).some(name=>/\.update-/.test(name))) await Bun.sleep(50);
    expect((await fs.readdir(root)).some(name=>/\.update-/.test(name))).toBe(false);
  } finally {
    // Only this freshly generated directory beneath the OS temp directory is disposable.
    await removeFixture(root);
  }
},30000);

test.skipIf(process.platform !== 'win32')('installer restores and restarts the old GUI if the replacement cannot run',async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'ferrum rollback '));
  const executable = path.join(root,'gui.exe');
  const attempted = path.join(root,'attempted');
  const restored = path.join(root,'restored');
  const entry = path.join(root,'old.ts');
  const installerModule = path.resolve(import.meta.dir,'../src/selfUpdateInstaller.ts');
  try {
    await fs.writeFile(entry,`import {startGuiUpdateInstaller} from ${JSON.stringify(installerModule)};
if (await Bun.file(${JSON.stringify(attempted)}).exists()) {
  await Bun.write(${JSON.stringify(restored)},'old GUI restarted');
} else {
  await Bun.write(${JSON.stringify(attempted)},'attempted');
  await startGuiUpdateInstaller();
}
process.exit(0);`);
    const build = Bun.spawn([process.execPath,'build','--compile',entry,'--outfile',executable],{stdout:'pipe',stderr:'pipe'});
    expect(await build.exited).toBe(0);
    await fs.writeFile(executable+'.new','invalid executable');
    const old = spawn(executable,[],{cwd:root,stdio:'ignore',windowsHide:true});
    await new Promise<void>((resolve,reject) => {old.once('exit',()=>resolve());old.once('error',reject);});
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !(await Bun.file(restored).exists())) await Bun.sleep(100);
    expect(await fs.readFile(restored,'utf8')).toBe('old GUI restarted');
    expect(await Bun.file(executable+'.old').exists()).toBe(false);
    while (Date.now() < deadline && (await fs.readdir(root)).some(name=>/\.update-/.test(name))) await Bun.sleep(50);
    expect((await fs.readdir(root)).some(name=>/\.update-/.test(name))).toBe(false);
    expect(await Bun.file(executable+'.update.log').exists()).toBe(true);
  } finally {
    await removeFixture(root);
  }
},30000);
