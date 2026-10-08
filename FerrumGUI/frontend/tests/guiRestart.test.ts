import {expect,test} from 'bun:test';
import {waitForGuiRestart} from '../src/utils/guiRestart';

test('waits through disconnects and the old version before accepting the new GUI',async () => {
  const versions = ['old',undefined,'new'];
  let calls = 0;
  await waitForGuiRestart('new',async () => {
    calls++;
    const version = versions.shift();
    if (!version) throw new Error('offline');
    return version;
  },100,1);
  expect(calls).toBe(3);
});

test('does not reload indefinitely when the updated GUI never starts',async () => {
  await expect(waitForGuiRestart('new',async () => 'old',10,1)).rejects.toThrow('did not become ready');
});
