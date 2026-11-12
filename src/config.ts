import os from 'node:os';
import path from 'node:path';

export type BrowserKind = 'brave' | 'chrome' | 'chromium' | 'edge';
export type ProfileMode = 'mirror' | 'direct' | 'attach';

export interface Config {
  /** Which browser to drive. 'auto' picks the first installed of brave, chrome, chromium, edge. */
  browser: BrowserKind | 'auto';
  /** Explicit path to the browser binary (overrides detection). */
  executable?: string;
  /** Source user-data-dir (the real profile root). Defaults to the browser's standard location. */
  userDataDir?: string;
  /** Profile folder inside the user-data-dir, e.g. "Default" or "Profile 1". */
  profileDir: string;
  /**
   * mirror  - copy session/extension state of the real profile into ~/.browser-mcp and launch on that copy (default).
   * direct  - launch the browser on the real user-data-dir (Chrome/Brave >= 136 refuse remote debugging there).
   * attach  - only connect to an already running browser exposing CDP at cdpUrl.
   */
  mode: ProfileMode;
  port: number;
  cdpUrl: string;
  mirrorDir: string;
  mirrorSync: 'always' | 'once' | 'never';
  mirrorIndexedDbMaxMB: number;
  mirrorHistory: boolean;
  headless: boolean;
  disableSync: boolean;
  extraArgs: string[];
  /** Shortcut that opens the 1Password extension popup (its "_execute_action" command, see chrome://extensions/shortcuts). Only used by strategy=shortcut (macOS). */
  onePasswordShortcut: string;
  onePasswordExtensionId: string;
  opAccount?: string;
  opPath: string;
  /** Keep all driven tabs in one highlighted tab group (needs an extension with the tabGroups permission). */
  tabGroup: boolean;
  tabGroupTitle: string;
  tabGroupColor: string;
  snapshotMaxChars: number;
  snapshotAfterActions: boolean;
  actionTimeoutMs: number;
  logFile: string;
}

function env(name: string): string | undefined {
  const v = process.env[`BROWSER_MCP_${name}`];
  return v === undefined || v === '' ? undefined : v;
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined) return d;
  return /^(1|true|yes|on)$/i.test(v);
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  // `--some-key=value` on the command line overrides BROWSER_MCP_SOME_KEY in the environment.
  for (const a of argv) {
    const m = /^--([a-z0-9-]+)=(.*)$/i.exec(a);
    if (m) process.env[`BROWSER_MCP_${m[1].toUpperCase().replace(/-/g, '_')}`] = m[2];
  }
  const home = os.homedir();
  const base = env('HOME_DIR') ?? path.join(home, '.browser-mcp');
  const port = Number(env('PORT') ?? 9333);
  return {
    browser: (env('BROWSER') as BrowserKind | 'auto' | undefined) ?? 'auto',
    executable: env('EXECUTABLE'),
    userDataDir: env('USER_DATA_DIR'),
    profileDir: env('PROFILE') ?? 'Default',
    mode: (env('MODE') as ProfileMode | undefined) ?? 'mirror',
    port,
    cdpUrl: env('CDP_URL') ?? `http://127.0.0.1:${port}`,
    mirrorDir: env('MIRROR_DIR') ?? path.join(base, 'profiles'),
    mirrorSync: (env('MIRROR_SYNC') as Config['mirrorSync'] | undefined) ?? 'always',
    mirrorIndexedDbMaxMB: Number(env('MIRROR_INDEXEDDB_MAX_MB') ?? 100),
    mirrorHistory: bool(env('MIRROR_HISTORY'), true),
    headless: bool(env('HEADLESS'), false),
    disableSync: bool(env('DISABLE_SYNC'), true),
    extraArgs: (env('ARGS') ?? '').split(/\s+/).filter(Boolean),
    onePasswordShortcut: env('1P_SHORTCUT') ?? (process.platform === 'darwin' ? 'cmd+shift+x' : 'ctrl+shift+x'),
    onePasswordExtensionId: env('1P_EXTENSION_ID') ?? 'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
    opAccount: env('OP_ACCOUNT'),
    opPath: env('OP_PATH') ?? 'op',
    tabGroup: bool(env('TAB_GROUP'), true),
    tabGroupTitle: env('TAB_GROUP_TITLE') ?? 'Claude',
    tabGroupColor: env('TAB_GROUP_COLOR') ?? 'purple',
    snapshotMaxChars: Number(env('SNAPSHOT_MAX_CHARS') ?? 20000),
    snapshotAfterActions: bool(env('SNAPSHOT_AFTER_ACTIONS'), false),
    actionTimeoutMs: Number(env('ACTION_TIMEOUT_MS') ?? 15000),
    logFile: env('LOG_FILE') ?? path.join(base, 'browser-mcp.log'),
  };
}
