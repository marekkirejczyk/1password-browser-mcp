import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Dialog, type Worker } from 'playwright-core';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { resolveBrowser, syncProfile, hasExtension, type BrowserInfo, type SyncResult } from './profile.js';
import { frontmostProcessPid, activateProcess } from './mac.js';
import { isLinux, isMac, hasDisplay, needsNoSandbox, inContainer, listeningPid as findListeningPid } from './platform.js';

export interface ConsoleEntry { time: number; type: string; text: string; location?: string }
export interface NetworkEntry { time: number; method: string; url: string; resourceType: string; status?: number; failure?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HELPER_EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const TAB_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export class BrowserManager {
  private browser?: Browser;
  private context?: BrowserContext;
  private active?: Page;
  private child?: ChildProcess;
  private synced = false;
  private connecting?: Promise<void>;

  info: { browser?: BrowserInfo; userDataDirInUse?: string; launched: boolean; pid?: number; lastSync?: SyncResult } = { launched: false };

  readonly consoleLogs = new WeakMap<Page, ConsoleEntry[]>();
  readonly network = new WeakMap<Page, NetworkEntry[]>();
  readonly dialogs = new WeakMap<Page, Dialog>();

  constructor(private cfg: Config, private log: Logger) {}

  /* ------------------------------ connection ------------------------------ */

  async isCdpUp(): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(`${this.cfg.cdpUrl}/json/version`, { signal: ctl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return !!this.browser?.isConnected();
  }

  async ensure(): Promise<BrowserContext> {
    if (this.context && this.browser?.isConnected()) return this.context;
    if (!this.connecting) this.connecting = this.connect().finally(() => (this.connecting = undefined));
    await this.connecting;
    return this.context!;
  }

  private async connect(): Promise<void> {
    if (await this.isCdpUp()) {
      this.log.log(`attaching to existing browser at ${this.cfg.cdpUrl}`);
      if (!this.info.userDataDirInUse) {
        // Most likely a browser this server launched earlier (it outlives the server on purpose).
        const info = this.safeResolve();
        if (this.cfg.mode === 'mirror' && info && fs.existsSync(path.join(this.cfg.mirrorDir, info.kind, this.cfg.profileDir))) {
          this.info.userDataDirInUse = path.join(this.cfg.mirrorDir, info.kind);
        } else if (this.cfg.mode === 'direct' && info) {
          this.info.userDataDirInUse = info.userDataDir;
        }
      }
    } else {
      if (this.cfg.mode === 'attach') {
        throw new Error(`No browser is listening at ${this.cfg.cdpUrl}. Start one with --remote-debugging-port=${this.cfg.port} --user-data-dir=<non-default dir>, or switch BROWSER_MCP_MODE to mirror.`);
      }
      await this.launch();
    }
    const browser = await chromium.connectOverCDP(this.cfg.cdpUrl, { timeout: 30000 });
    browser.on('disconnected', () => {
      this.log.log('browser disconnected');
      this.browser = undefined;
      this.context = undefined;
      this.active = undefined;
    });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    context.setDefaultTimeout(this.cfg.actionTimeoutMs);
    for (const p of context.pages()) this.wirePage(p);
    context.on('page', (p) => {
      this.wirePage(p);
      this.active = p;
      void this.ensureTabGroup();
    });
    this.browser = browser;
    this.context = context;
    void this.ensureTabGroup();
    this.info.browser = this.info.browser ?? this.safeResolve();
    this.info.pid = this.info.pid ?? (await this.listeningPid());
  }

  private safeResolve(): BrowserInfo | undefined {
    try { return resolveBrowser(this.cfg.browser, this.cfg.executable, this.cfg.userDataDir); } catch { return undefined; }
  }

  private async launch(): Promise<void> {
    const info = resolveBrowser(this.cfg.browser, this.cfg.executable, this.cfg.userDataDir);
    this.info.browser = info;
    let userDataDir = info.userDataDir;

    if (this.cfg.mode === 'mirror') {
      const dst = path.join(this.cfg.mirrorDir, info.kind);
      const needSync = this.cfg.mirrorSync === 'always' || (this.cfg.mirrorSync === 'once' && !this.synced) || !fs.existsSync(path.join(dst, this.cfg.profileDir));
      if (needSync) {
        this.log.log(`syncing profile ${info.userDataDir}/${this.cfg.profileDir} -> ${dst}`);
        const res = syncProfile(info.userDataDir, dst, {
          profileDir: this.cfg.profileDir,
          indexedDbMaxBytes: this.cfg.mirrorIndexedDbMaxMB * 1024 * 1024,
          includeHistory: this.cfg.mirrorHistory,
          alwaysIncludeOrigins: ['chrome-extension_'],
        });
        this.info.lastSync = res;
        this.synced = true;
        this.log.log(`sync done: ${res.files} files, ${(res.bytes / 1e6).toFixed(1)} MB in ${res.durationMs} ms; skipped IndexedDB origins: ${res.skippedIndexedDb.length}`);
      }
      userDataDir = dst;
    } else if (this.cfg.mode === 'direct') {
      if (!fs.existsSync(userDataDir)) throw new Error(`User data dir not found: ${userDataDir}`);
    }
    this.info.userDataDirInUse = userDataDir;

    if (isLinux && !this.cfg.headless && !hasDisplay()) {
      throw new Error(`${info.name} needs a display to open a window, but neither DISPLAY nor WAYLAND_DISPLAY is set. Set BROWSER_MCP_HEADLESS=true, or run this server under xvfb-run / from a desktop session.`);
    }
    // Linux sandboxing: Chromium refuses to start as root and the sandbox usually cannot be set up in
    // containers. Add --no-sandbox there unless the user already passed it (or decided otherwise) in BROWSER_MCP_ARGS.
    const userSetSandbox = this.cfg.extraArgs.some((a) => /^--(no-sandbox|disable-setuid-sandbox)\b/.test(a));
    const linuxArgs = isLinux
      ? [
        ...(needsNoSandbox() && !userSetSandbox ? ['--no-sandbox'] : []),
        // /dev/shm is tiny in many containers and Chromium crashes renderers when it fills up.
        ...(inContainer() && !this.cfg.extraArgs.includes('--disable-dev-shm-usage') ? ['--disable-dev-shm-usage'] : []),
      ]
      : [];
    if (linuxArgs.length) this.log.log(`linux: adding ${linuxArgs.join(' ')} (${needsNoSandbox() ? 'running as root or in a container' : 'container detected'})`);

    const args = [
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${this.cfg.profileDir}`,
      `--remote-debugging-port=${this.cfg.port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      // Playwright launches Chromium with this too: with the back/forward cache on, page.goBack() /
      // goForward() restore from cache without the lifecycle events Playwright waits for and time out.
      '--disable-back-forward-cache',
      ...(this.cfg.disableSync ? ['--disable-sync'] : []),
      // Branded Chrome >= 137 ignores --load-extension; Brave/Chromium/Edge honour it. Harmless when ignored.
      ...(this.cfg.tabGroup && fs.existsSync(HELPER_EXTENSION_DIR) ? [`--load-extension=${HELPER_EXTENSION_DIR}`] : []),
      ...(this.cfg.headless ? ['--headless=new'] : []),
      ...linuxArgs,
      ...this.cfg.extraArgs,
      'about:blank',
    ];

    fs.mkdirSync(path.dirname(this.cfg.logFile), { recursive: true, mode: 0o700 });
    const browserLog = this.cfg.logFile.replace(/\.log$/, '') + '.browser.log';
    const fd = fs.openSync(browserLog, 'a', 0o600);
    let exited: number | null | undefined;
    const appBundle = isMac ? /^(.*\.app)\/Contents\/MacOS\//.exec(info.executable)?.[1] : undefined;
    let previousPid: number | undefined;
    if (appBundle && !this.cfg.headless) {
      // LaunchServices starts a second instance (-n) in the background (-g). Chromium still
      // activates itself when its first window appears, so we hand focus back afterwards.
      previousPid = await frontmostProcessPid().catch(() => undefined);
      this.log.log(`launching ${info.name} in background via open: ${appBundle} ${args.join(' ')}`);
      const opener = spawn('open', ['-g', '-n', '-a', appBundle, '--args', ...args], { stdio: ['ignore', fd, fd] });
      await new Promise<void>((resolve) => opener.on('exit', (code) => { if (code) exited = code; resolve(); }));
      this.info.pid = undefined;
    } else {
      this.log.log(`launching ${info.name}: ${info.executable} ${args.join(' ')}`);
      const child = spawn(info.executable, args, { detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
      child.on('exit', (code) => { exited = code; });
      this.child = child;
      this.info.pid = child.pid;
    }
    this.info.launched = true;

    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      if (await this.isCdpUp()) {
        if (!this.info.pid) this.info.pid = await this.listeningPid();
        if (previousPid) void this.restoreFocus(previousPid);
        return;
      }
      if (exited !== undefined) break;
      await sleep(250);
    }
    const tail = readTail(browserLog, 20);
    if (/non-default data directory/i.test(tail)) {
      throw new Error(`${info.name} refuses remote debugging on its default profile directory (Chromium >= 136). Use BROWSER_MCP_MODE=mirror (default) instead of direct.\n${tail}`);
    }
    if (/Missing X server|\$DISPLAY|platform failed to initialize/i.test(tail)) {
      throw new Error(`${info.name} could not open a window (no usable X11/Wayland display). Set BROWSER_MCP_HEADLESS=true or run under xvfb-run.\n${tail}`);
    }
    if (/Running as root without --no-sandbox|no sandbox|setuid sandbox/i.test(tail)) {
      throw new Error(`${info.name} refused to start because of its sandbox. Pass BROWSER_MCP_ARGS=--no-sandbox.\n${tail}`);
    }
    if (exited !== undefined) {
      throw new Error(`${info.name} exited immediately (code ${exited}). If the browser is already running on this user-data-dir, quit it first or use mirror mode.\n${tail}`);
    }
    throw new Error(`Timed out waiting for ${info.name} to expose CDP on port ${this.cfg.port}.\n${tail}`);
  }

  /** Gives focus back to the app that had it before the browser window appeared. */
  private async restoreFocus(previousPid: number): Promise<void> {
    const deadline = Date.now() + 6000;
    let hasWindow = false;
    while (Date.now() < deadline && !hasWindow) {
      try {
        const res = await fetch(`${this.cfg.cdpUrl}/json/list`);
        const targets = (await res.json()) as Array<{ type: string }>;
        hasWindow = targets.some((t) => t.type === 'page');
      } catch { /* retry */ }
      if (!hasWindow) await sleep(200);
    }
    for (const delay of [600, 1500]) {
      await sleep(delay);
      await activateProcess(previousPid).catch(() => {});
    }
  }

  /** Pid listening on the CDP port (lsof, /proc or ss; see platform.ts). Used when we attached rather than launched. */
  private async listeningPid(): Promise<number | undefined> {
    return findListeningPid(this.cfg.port);
  }

  async browserPid(): Promise<number | undefined> {
    return this.info.pid ?? (this.info.pid = await this.listeningPid());
  }

  /* --------------------------------- pages -------------------------------- */

  private wirePage(page: Page): void {
    if (this.consoleLogs.has(page)) return;
    const logs: ConsoleEntry[] = [];
    const net: NetworkEntry[] = [];
    this.consoleLogs.set(page, logs);
    this.network.set(page, net);
    page.on('console', (m) => {
      const loc = m.location();
      logs.push({ time: Date.now(), type: m.type(), text: m.text(), location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined });
      if (logs.length > 300) logs.splice(0, logs.length - 300);
    });
    page.on('pageerror', (e) => {
      logs.push({ time: Date.now(), type: 'error', text: e.message });
    });
    page.on('request', (r) => {
      net.push({ time: Date.now(), method: r.method(), url: r.url(), resourceType: r.resourceType() });
      if (net.length > 500) net.splice(0, net.length - 500);
    });
    page.on('response', (r) => {
      const e = net.find((n) => n.url === r.url() && n.status === undefined && n.method === r.request().method());
      if (e) e.status = r.status();
    });
    page.on('requestfailed', (r) => {
      const e = net.find((n) => n.url === r.url() && n.status === undefined);
      if (e) e.failure = r.failure()?.errorText ?? 'failed';
    });
    page.on('dialog', (d) => {
      if (d.type() === 'beforeunload') { d.accept().catch(() => {}); return; }
      this.dialogs.set(page, d);
      this.log.log(`dialog (${d.type()}): ${d.message()}`);
    });
    page.on('close', () => {
      if (this.active === page) this.active = undefined;
    });
  }

  pages(): Page[] {
    return (this.context?.pages() ?? []).filter((p) => !p.isClosed());
  }

  async page(): Promise<Page> {
    const ctx = await this.ensure();
    if (this.active && !this.active.isClosed()) return this.active;
    const pages = ctx.pages().filter((p) => !p.isClosed());
    const preferred = pages.filter((p) => !p.url().startsWith('chrome-extension://') && !p.url().startsWith('devtools://'));
    this.active = preferred[preferred.length - 1] ?? pages[pages.length - 1] ?? (await ctx.newPage());
    return this.active;
  }

  setActive(page: Page): void {
    this.active = page;
  }

  async newPage(url?: string): Promise<Page> {
    const ctx = await this.ensure();
    const page = await ctx.newPage();
    this.active = page;
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.ensureTabGroup();
    return page;
  }

  /* ------------------------------- tab group ------------------------------ */

  tabGroupStatus: string = 'not attempted';
  private groupWorker?: Worker;

  /** Finds an extension service worker whose manifest grants tabGroups: our helper first, any other as fallback. */
  private async findGroupWorker(): Promise<Worker | undefined> {
    if (this.groupWorker) {
      try { await this.groupWorker.evaluate(() => 1); return this.groupWorker; } catch { this.groupWorker = undefined; }
    }
    const ctx = this.context;
    if (!ctx) return undefined;
    const candidates: Array<{ worker: Worker; name: string; helper: boolean }> = [];
    for (const w of ctx.serviceWorkers()) {
      if (!w.url().startsWith('chrome-extension://')) continue;
      try {
        const m = await w.evaluate(() => {
          const c = (globalThis as unknown as { chrome?: { runtime?: { getManifest(): { name: string; permissions?: string[] } } } }).chrome;
          const man = c?.runtime?.getManifest();
          return man ? { name: man.name, perms: man.permissions ?? [] } : null;
        });
        if (m && m.perms.includes('tabGroups') && m.perms.includes('tabs')) candidates.push({ worker: w, name: m.name, helper: m.name.includes('browser-mcp') });
      } catch { /* worker gone */ }
    }
    candidates.sort((a, b) => Number(b.helper) - Number(a.helper));
    const pick = candidates[0];
    if (pick) { this.groupWorker = pick.worker; this.tabGroupStatus = `via ${pick.helper ? 'helper extension' : `"${pick.name}" extension`}`; }
    else this.tabGroupStatus = 'no extension with the tabGroups permission is loaded (helper ignored by this browser?)';
    return pick?.worker;
  }

  /** Puts every ordinary tab of the driven instance into one titled, coloured tab group. */
  async ensureTabGroup(): Promise<void> {
    if (!this.cfg.tabGroup || !this.context) return;
    const color = TAB_GROUP_COLORS.includes(this.cfg.tabGroupColor) ? this.cfg.tabGroupColor : 'purple';
    try {
      // Service workers of freshly started extensions may not be registered with Playwright yet.
      let worker = await this.findGroupWorker();
      for (let i = 0; i < 10 && !worker; i++) { await sleep(300); worker = await this.findGroupWorker(); }
      if (!worker) return;
      await worker.evaluate(async ({ title, color }) => {
        const c = (globalThis as unknown as { chrome: any }).chrome;
        const tabs: Array<{ id: number; url?: string; pendingUrl?: string; groupId: number; windowId: number }> = await c.tabs.query({});
        const ours = tabs.filter((t) => !(t.url ?? t.pendingUrl ?? '').startsWith('chrome-extension://') && !(t.url ?? '').startsWith('devtools://'));
        const groups: Array<{ id: number; title?: string; windowId: number }> = await c.tabGroups.query({ title });
        const byWindow = new Map<number, number[]>();
        for (const t of ours) { if (t.groupId === -1 || !groups.some((g) => g.id === t.groupId)) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) ?? []), t.id]); }
        for (const [windowId, tabIds] of byWindow) {
          const existing = groups.find((g) => g.windowId === windowId);
          const groupId: number = await c.tabs.group(existing ? { tabIds, groupId: existing.id } : { tabIds, createProperties: { windowId } });
          await c.tabGroups.update(groupId, { title, color });
        }
        for (const g of groups) await c.tabGroups.update(g.id, { title, color }).catch(() => {});
      }, { title: this.cfg.tabGroupTitle, color });
    } catch (e) {
      this.tabGroupStatus = `failed: ${(e as Error).message.split('\n')[0]}`;
      this.log.log('tab group', this.tabGroupStatus);
    }
  }

  async close(killBrowser: boolean): Promise<string> {
    const notes: string[] = [];
    if (killBrowser) {
      const pid = await this.browserPid();
      if (this.browser?.isConnected()) {
        try { await this.browser.close(); notes.push('browser closed'); } catch { /* ignore */ }
      }
      if (pid) { try { process.kill(pid, 'SIGTERM'); notes.push(`sent SIGTERM to pid ${pid}`); } catch { /* ignore */ } }
    } else if (this.browser) {
      // Detach only: the browser keeps running and we re-attach on the next call.
      const b = this.browser;
      this.browser = undefined; this.context = undefined; this.active = undefined;
      try { (b as unknown as { _connection?: { close(): void } })._connection?.close(); } catch { /* ignore */ }
      notes.push('detached; browser left running');
    }
    return notes.join('; ') || 'nothing to do';
  }

  onePasswordInstalled(): boolean {
    const dir = this.info.userDataDirInUse ?? this.info.browser?.userDataDir ?? this.safeResolve()?.userDataDir;
    return !!dir && hasExtension(dir, this.cfg.profileDir, this.cfg.onePasswordExtensionId);
  }
}

function readTail(file: string, lines: number): string {
  try {
    const data = fs.readFileSync(file, 'utf8');
    return data.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}
