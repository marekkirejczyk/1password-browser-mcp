import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const isLinux = process.platform === 'linux';
export const isMac = process.platform === 'darwin';

export function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Best-effort container detection (Docker, Podman, LXC, Kubernetes, ...). */
export function inContainer(): boolean {
  if (!isLinux) return false;
  if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) return true;
  try {
    const cg = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/docker|containerd|kubepods|lxc|podman|libpod/i.test(cg)) return true;
  } catch { /* ignore */ }
  try {
    // systemd marks containers in this env var of pid 1; also catches plain chroots/sandboxes that set it.
    const env = fs.readFileSync('/proc/1/environ', 'utf8');
    if (/\bcontainer=/.test(env)) return true;
  } catch { /* ignore */ }
  return false;
}

/** Whether a headful browser could open a window: X11 or Wayland on Linux, always on macOS. */
export function hasDisplay(): boolean {
  if (!isLinux) return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Chromium's sandbox needs either user namespaces or a setuid helper, and refuses to start as root.
 * Both are commonly unavailable in containers and CI, so add --no-sandbox there unless the caller
 * already decided (either way) in BROWSER_MCP_ARGS.
 */
export function needsNoSandbox(): boolean {
  return isLinux && (isRoot() || inContainer());
}

/* ------------------------------ listening pid ------------------------------ */

/** Pid of the process listening on a local TCP port: lsof where available, /proc on Linux, ss as a last resort. */
export function listeningPid(port: number): number | undefined {
  return viaLsof(port) ?? (isLinux ? viaProc(port) ?? viaSs(port) : undefined);
}

function viaLsof(port: number): number | undefined {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = Number(out.trim().split('\n')[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function viaSs(port: number): number | undefined {
  try {
    const out = execFileSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = Number(/pid=(\d+)/.exec(out)?.[1]);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** /proc/net/tcp{,6}: find the socket inode of a LISTEN entry on `port`, then the pid owning that inode. */
function viaProc(port: number): number | undefined {
  const inodes = new Set<string>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let lines: string[];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').slice(1); } catch { continue; }
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const [, local, , st] = cols;
      if (st !== '0A') continue; // LISTEN
      if (parseInt(local.split(':')[1], 16) !== port) continue;
      inodes.add(cols[9]);
    }
  }
  if (!inodes.size) return undefined;
  let pids: string[];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return undefined; }
  for (const pid of pids) {
    let fds: string[];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link: string;
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1])) return Number(pid);
    }
  }
  return undefined;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
