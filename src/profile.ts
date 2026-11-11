import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BrowserKind } from './config.js';

export interface BrowserInfo {
  kind: BrowserKind;
  name: string;
  executable: string;
  userDataDir: string;
  bundleId?: string;
}

const ORDER: BrowserKind[] = ['brave', 'chrome', 'chromium', 'edge'];

const MAC: Record<BrowserKind, { name: string; app: string; bin: string; data: string; bundle: string }> = {
  brave: { name: 'Brave Browser', app: 'Brave Browser.app', bin: 'Contents/MacOS/Brave Browser', data: 'Library/Application Support/BraveSoftware/Brave-Browser', bundle: 'com.brave.Browser' },
  chrome: { name: 'Google Chrome', app: 'Google Chrome.app', bin: 'Contents/MacOS/Google Chrome', data: 'Library/Application Support/Google/Chrome', bundle: 'com.google.Chrome' },
  chromium: { name: 'Chromium', app: 'Chromium.app', bin: 'Contents/MacOS/Chromium', data: 'Library/Application Support/Chromium', bundle: 'org.chromium.Chromium' },
  edge: { name: 'Microsoft Edge', app: 'Microsoft Edge.app', bin: 'Contents/MacOS/Microsoft Edge', data: 'Library/Application Support/Microsoft Edge', bundle: 'com.microsoft.edgemac' },
};

const LINUX: Record<BrowserKind, { name: string; bins: string[]; data: string }> = {
  brave: { name: 'Brave Browser', bins: ['brave-browser', 'brave'], data: '.config/BraveSoftware/Brave-Browser' },
  chrome: { name: 'Google Chrome', bins: ['google-chrome', 'google-chrome-stable'], data: '.config/google-chrome' },
  chromium: { name: 'Chromium', bins: ['chromium', 'chromium-browser'], data: '.config/chromium' },
  edge: { name: 'Microsoft Edge', bins: ['microsoft-edge', 'microsoft-edge-stable'], data: '.config/microsoft-edge' },
};

function which(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function candidate(kind: BrowserKind): BrowserInfo | undefined {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const m = MAC[kind];
    for (const root of ['/Applications', path.join(home, 'Applications')]) {
      const exe = path.join(root, m.app, m.bin);
      if (fs.existsSync(exe)) return { kind, name: m.name, executable: exe, userDataDir: path.join(home, m.data), bundleId: m.bundle };
    }
    return undefined;
  }
  const l = LINUX[kind];
  for (const b of l.bins) {
    const exe = which(b);
    if (exe) return { kind, name: l.name, executable: exe, userDataDir: path.join(home, l.data) };
  }
  return undefined;
}

/** True when a process of this browser binary is running on its own (not one of ours on a mirrored profile). */
export function isBrowserRunning(executable: string): boolean {
  try {
    const out = execFileSync('pgrep', ['-f', executable], { encoding: 'utf8', timeout: 3000 });
    const pids = out.split('\n').filter(Boolean);
    for (const pid of pids) {
      let cmd = '';
      try { cmd = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8', timeout: 3000 }); } catch { continue; }
      if (cmd.includes('--type=')) continue; // helper process
      if (cmd.includes('.browser-mcp')) continue; // our own mirrored instance
      return true;
    }
  } catch { /* pgrep exits 1 when nothing matches */ }
  return false;
}

export function resolveBrowser(kind: BrowserKind | 'auto', executable?: string, userDataDir?: string): BrowserInfo {
  const kinds = kind === 'auto' ? ORDER : [kind];
  const found = kinds.map(candidate).filter((c): c is BrowserInfo => !!c);
  // Prefer a browser that has a real profile on disk. In auto mode also prefer one that is not
  // running right now: a second instance of the user's daily browser shares its bundle id, so macOS
  // may route links clicked in other apps to the mirrored instance.
  const withProfile = found.filter((c) => fs.existsSync(c.userDataDir));
  const info = (kind === 'auto' ? withProfile.find((c) => !isBrowserRunning(c.executable)) : undefined) ?? withProfile[0] ?? found[0];
  if (!info && !executable) {
    throw new Error(`No supported browser found (looked for ${kinds.join(', ')}). Set BROWSER_MCP_EXECUTABLE.`);
  }
  const base: BrowserInfo = info ?? { kind: kind === 'auto' ? 'chrome' : kind, name: 'Custom browser', executable: executable!, userDataDir: userDataDir ?? '' };
  return { ...base, executable: executable ?? base.executable, userDataDir: userDataDir ?? base.userDataDir };
}

export function listProfiles(userDataDir: string): string[] {
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
    const cache = ls?.profile?.info_cache ?? {};
    return Object.keys(cache);
  } catch {
    return fs.existsSync(path.join(userDataDir, 'Default')) ? ['Default'] : [];
  }
}

export function hasExtension(userDataDir: string, profileDir: string, extensionId: string): boolean {
  return fs.existsSync(path.join(userDataDir, profileDir, 'Extensions', extensionId));
}

/* ----------------------------- profile mirroring ----------------------------- */

const ROOT_FILES = ['Local State', 'First Run'];

const PROFILE_FILES = [
  'Preferences', 'Secure Preferences',
  'Cookies', 'Cookies-journal', 'Extension Cookies', 'Extension Cookies-journal',
  'Login Data', 'Login Data-journal', 'Login Data For Account', 'Login Data For Account-journal',
  'Web Data', 'Web Data-journal', 'Account Web Data', 'Account Web Data-journal',
  'Bookmarks', 'Favicons', 'Favicons-journal',
  'TransportSecurity', 'Trust Tokens', 'Trust Tokens-journal',
  'Affiliation Database', 'Affiliation Database-journal',
  'Shortcuts', 'Shortcuts-journal', 'Top Sites', 'Top Sites-journal', 'Visited Links',
];
const HISTORY_FILES = ['History', 'History-journal'];

const PROFILE_DIRS = [
  'Network',
  'Extensions', 'Extension Rules', 'Extension Scripts', 'Extension State',
  'Local Extension Settings', 'Sync Extension Settings', 'Managed Extension Settings',
  'Local Storage', 'Session Storage', 'WebStorage', 'Storage',
];

const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile', 'DevToolsActivePort'];

export interface SyncOptions {
  profileDir: string;
  indexedDbMaxBytes: number;
  includeHistory: boolean;
  alwaysIncludeOrigins: string[]; // e.g. chrome-extension_<1password id>
}

export interface SyncResult {
  files: number;
  bytes: number;
  skippedIndexedDb: string[];
  durationMs: number;
}

function dirSize(p: string): number {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
    }
  }
  return total;
}

class Syncer {
  files = 0;
  bytes = 0;

  copyFile(src: string, dst: string): void {
    let s: fs.Stats;
    try { s = fs.statSync(src); } catch { return; }
    if (!s.isFile()) return;
    try {
      const d = fs.statSync(dst);
      if (d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 1) return; // unchanged
    } catch { /* missing */ }
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dst);
    try { fs.utimesSync(dst, s.atime, s.mtime); } catch { /* ignore */ }
    this.files++;
    this.bytes += s.size;
  }

  copyDir(src: string, dst: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    for (const e of entries) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) this.copyDir(s, d);
      else if (e.isFile()) this.copyFile(s, d);
    }
  }
}

/**
 * Copies the parts of a Chromium profile that carry identity (cookies, storage, extensions and their
 * state, saved logins, preferences) into `dstRoot`, skipping caches and other bulky disposable data.
 * Safe to run while the source browser is open; repeated runs are incremental.
 */
export function syncProfile(srcRoot: string, dstRoot: string, opts: SyncOptions): SyncResult {
  const t0 = Date.now();
  if (!fs.existsSync(path.join(srcRoot, opts.profileDir))) {
    throw new Error(`Profile "${opts.profileDir}" not found in ${srcRoot}. Available: ${listProfiles(srcRoot).join(', ') || 'none'}`);
  }
  fs.mkdirSync(dstRoot, { recursive: true, mode: 0o700 });
  const sy = new Syncer();
  const skipped: string[] = [];

  for (const f of ROOT_FILES) sy.copyFile(path.join(srcRoot, f), path.join(dstRoot, f));
  if (!fs.existsSync(path.join(dstRoot, 'First Run'))) fs.writeFileSync(path.join(dstRoot, 'First Run'), '');

  const sp = path.join(srcRoot, opts.profileDir);
  const dp = path.join(dstRoot, opts.profileDir);
  fs.mkdirSync(dp, { recursive: true, mode: 0o700 });
  for (const f of PROFILE_FILES) sy.copyFile(path.join(sp, f), path.join(dp, f));
  if (opts.includeHistory) for (const f of HISTORY_FILES) sy.copyFile(path.join(sp, f), path.join(dp, f));
  for (const d of PROFILE_DIRS) if (fs.existsSync(path.join(sp, d))) sy.copyDir(path.join(sp, d), path.join(dp, d));

  // IndexedDB: per-origin size cap, extension origins always included.
  const idb = path.join(sp, 'IndexedDB');
  if (fs.existsSync(idb)) {
    for (const e of fs.readdirSync(idb, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const s = path.join(idb, e.name);
      const forced = opts.alwaysIncludeOrigins.some((o) => e.name.startsWith(o));
      if (!forced && dirSize(s) > opts.indexedDbMaxBytes) { skipped.push(e.name); continue; }
      sy.copyDir(s, path.join(dp, 'IndexedDB', e.name));
    }
  }

  for (const f of LOCK_FILES) { try { fs.rmSync(path.join(dstRoot, f), { force: true }); } catch { /* ignore */ } }
  patchPreferences(path.join(dp, 'Preferences'));
  patchLocalState(path.join(dstRoot, 'Local State'), opts.profileDir);

  return { files: sy.files, bytes: sy.bytes, skippedIndexedDb: skipped, durationMs: Date.now() - t0 };
}

function patchPreferences(file: string): void {
  try {
    const prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
    prefs.profile = prefs.profile ?? {};
    prefs.profile.exit_type = 'Normal';
    prefs.profile.exited_cleanly = true;
    prefs.session = prefs.session ?? {};
    prefs.session.restore_on_startup = 5; // new tab page; the mirror never restores the source's tabs
    delete prefs.session.startup_urls;
    fs.writeFileSync(file, JSON.stringify(prefs));
  } catch { /* leave as is */ }
}

function patchLocalState(file: string, profileDir: string): void {
  try {
    const ls = JSON.parse(fs.readFileSync(file, 'utf8'));
    ls.profile = ls.profile ?? {};
    ls.profile.last_used = profileDir;
    ls.profile.last_active_profiles = [profileDir];
    if (ls.profile.info_cache) {
      for (const k of Object.keys(ls.profile.info_cache)) if (k !== profileDir) delete ls.profile.info_cache[k];
    }
    fs.writeFileSync(file, JSON.stringify(ls));
  } catch { /* leave as is */ }
}
