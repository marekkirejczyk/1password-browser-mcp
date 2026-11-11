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

const KEY_CODES: Record<string, number> = {
  enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
};

/**
 * Sends a keyboard shortcut through System Events so the browser (not the page) receives it,
 * which is what triggers extension commands such as 1Password's autofill. Requires that the
 * process hosting this server has Accessibility permission.
 */
export async function sendShortcut(shortcut: string): Promise<void> {
  const parts = shortcut.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const mods = parts.map((m) => {
    switch (m.toLowerCase()) {
      case 'cmd': case 'command': case 'meta': return 'command down';
      case 'shift': return 'shift down';
      case 'alt': case 'option': return 'option down';
      case 'ctrl': case 'control': return 'control down';
      default: throw new Error(`Unknown modifier "${m}" in shortcut "${shortcut}"`);
    }
  });
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  const code = KEY_CODES[key.toLowerCase()];
  const action = code !== undefined
    ? `key code ${code}${using}`
    : `keystroke "${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"${using}`;
  await osascript(`tell application "System Events" to ${action}`);
}

export async function activateProcessByName(name: string): Promise<void> {
  const safe = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await osascript(`tell application "System Events" to set frontmost of process "${safe}" to true`);
}

export async function frontmostProcessPid(): Promise<number> {
  const out = await osascript('tell application "System Events" to get unix id of first process whose frontmost is true');
  const pid = Number(out);
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`unexpected frontmost pid: ${out}`);
  return pid;
}

export async function frontmostProcessName(): Promise<string> {
  return osascript('tell application "System Events" to get name of first process whose frontmost is true');
}
