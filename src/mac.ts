import { execFile } from 'node:child_process';

export function osascript(script: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`osascript failed: ${stderr?.trim() || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

/** Brings the window of the given process id to the front (macOS only). */
export async function activateProcess(pid: number): Promise<void> {
  await osascript(`tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`);
}

export async function frontmostProcessPid(): Promise<number> {
  const out = await osascript('tell application "System Events" to get unix id of first process whose frontmost is true');
  const pid = Number(out);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`unexpected frontmost pid: ${out}`);
  return pid;
}
