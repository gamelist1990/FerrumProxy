export async function waitForGuiRestart(
  version: string,
  readVersion: () => Promise<string | undefined> = async () => {
    const response = await fetch('/api/auth/status',{cache:'no-store',signal:AbortSignal.timeout(2500)});
    if (!response.ok) throw new Error('GUI is restarting');
    return (await response.json()).guiVersion;
  },
  timeoutMs = 90000,
  intervalMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await readVersion() === version) return; } catch { /* Wait through the restart. */ }
    await new Promise(resolve => setTimeout(resolve,intervalMs));
  }
  throw new Error('The updated GUI did not become ready. Check the GUI update log and restart the GUI.');
}
