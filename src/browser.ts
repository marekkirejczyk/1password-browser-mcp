import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Dialog, type Worker } from 'playwright-core';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { resolveBrowser, syncProfile, type BrowserInfo, type SyncResult } from './profile.js';
import { frontmostProcessPid, activateProcess } from './mac.js';
import { isLinux, isMac, hasDisplay, needsNoSandbox, inContainer, listeningPid as findListeningPid } from './platform.js';
import { SessionRegistry, tryLaunchLock, findFreePort, type SessionRecord } from './sessions.js';

export interface ConsoleEntry { time: number; type: string; text: string; location?: string }
export interface NetworkEntry { time: number; method: string; url: string; resourceType: string; status?: number; failure?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HELPER_EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const TAB_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
/** Colour per session number when none is configured. */
const SESSION_PALETTE = ['purple', 'blue', 'green', 'orange', 'pink', 'cyan', 'yellow', 'red', 'grey'];

export class BrowserManager {
  private browser?: Browser;
  private context?: BrowserContext;
  private active?: Page;
  private child?: ChildProcess;
  private synced = false;
  private connecting?: Promise<void>;
  private shuttingDown = false;

  /** Tabs this server opened (or adopted). Other sessions' tabs in a shared browser are never touched. */
  private readonly owned = new Set<Page>();
  /** chrome.tabs ids of owned pages, resolved through the tab-group extension worker. */
  private readonly tabIds = new Map<Page, number>();
  private tagCounter = 0;

  readonly session: SessionRecord;
  readonly groupTitle: string;
  readonly groupColor: string;

  info: { browser?: BrowserInfo; userDataDirInUse?: string; launched: boolean; pid?: number; lastSync?: SyncResult } = { launched: false };

  readonly consoleLogs = new WeakMap<Page, ConsoleEntry[]>();
  readonly network = new WeakMap<Page, NetworkEntry[]>();
  readonly dialogs = new WeakMap<Page, Dialog>();

  constructor(private cfg: Config, private log: Logger, readonly registry: SessionRegistry) {
    this.session = registry.claim(cfg.sessionName, cfg.sessions);
    const label = cfg.sessionName ?? (this.session.n === 1 ? '' : String(this.session.n));
    this.groupTitle = label ? `${cfg.tabGroupTitle} ${label}` : cfg.tabGroupTitle;
    this.groupColor = cfg.tabGroupColor && TAB_GROUP_COLORS.includes(cfg.tabGroupColor)
      ? cfg.tabGroupColor
      : SESSION_PALETTE[(this.session.n - 1) % SESSION_PALETTE.length];
  }

  /* ------------------------------ connection ------------------------------ */

  async isCdpUp(url = this.cfg.cdpUrl): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(`${url}/json/version`, { signal: ctl.signal });
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
    let launchedNow = false;
    if (this.cfg.sessions === 'isolated') {
      launchedNow = await this.connectIsolated();
    } else if (await this.isCdpUp()) {
      this.log.log(`attaching to existing browser at ${this.cfg.cdpUrl}`);
      await this.describeAttached();
    } else {
      if (this.cfg.mode === 'attach') {
        throw new Error(`No browser is listening at ${this.cfg.cdpUrl}. Start one with --remote-debugging-port=${this.cfg.port} --user-data-dir=<non-default dir>, or switch BROWSER_MCP_MODE to mirror.`);
      }
      launchedNow = await this.launchShared();
    }

    const browser = await chromium.connectOverCDP(this.cfg.cdpUrl, { timeout: 30000 });
    browser.on('disconnected', () => {
      this.log.log('browser disconnected');
      this.browser = undefined;
      this.context = undefined;
      this.active = undefined;
      this.owned.clear();
      this.tabIds.clear();
      this.groupWorker = undefined;
    });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    context.setDefaultTimeout(this.cfg.actionTimeoutMs);
    for (const p of context.pages()) this.wirePage(p);
    // Tabs other sessions (or extensions) open also arrive here; they are observed, never adopted.
    context.on('page', (p) => this.wirePage(p));
    this.browser = browser;
    this.context = context;
    this.info.browser = this.info.browser ?? this.safeResolve();
    this.info.pid = this.info.pid ?? (await this.listeningPid());
    if (launchedNow) {
      // The window we just opened starts with one blank tab: that one is ours.
      for (const p of context.pages()) if (p.url() === 'about:blank') { this.own(p); this.active = p; void this.tagPage(p).then(() => this.ensureTabGroup()); }
    }
  }

  /** Shared mode: one launcher per port; everybody else waits for the CDP endpoint to come up. */
  private async launchShared(): Promise<boolean> {
    fs.mkdirSync(this.cfg.homeDir, { recursive: true, mode: 0o700 });
    const release = tryLaunchLock(this.cfg.homeDir, this.cfg.port);
    if (release) {
      try {
        if (await this.isCdpUp()) { await this.describeAttached(); return false; }
        await this.launch();
        return true;
      } finally {
        release();
      }
    }
    this.log.log(`another session is launching the browser on port ${this.cfg.port}; waiting`);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (await this.isCdpUp()) { await this.describeAttached(); return false; }
      await sleep(300);
    }
    throw new Error(`Waited 90 s for another session to bring up the browser on port ${this.cfg.port}; it did not. Check ${this.cfg.logFile}.`);
  }

  /** Isolated mode: own port, own profile copy, own instance. */
  private async connectIsolated(): Promise<boolean> {
    if (this.cfg.mode === 'attach') throw new Error('BROWSER_MCP_SESSIONS=isolated cannot be combined with BROWSER_MCP_MODE=attach.');
    if (!this.cfg.cdpUrlExplicit && !this.info.launched) {
      this.cfg.port = await findFreePort(this.cfg.port + 1);
      this.cfg.cdpUrl = `http://127.0.0.1:${this.cfg.port}`;
    }
    this.registry.update({ port: this.cfg.port });
    if (await this.isCdpUp()) {
      // Our own earlier instance (server restarted with ISOLATED_KEEP) or an explicit CDP_URL.
      this.log.log(`attaching to isolated browser at ${this.cfg.cdpUrl}`);
      await this.describeAttached();
      return false;
    }
    const info = resolveBrowser(this.cfg.browser, this.cfg.executable, this.cfg.userDataDir);
    const dir = path.join(this.cfg.mirrorDir, `${info.kind}-${this.cfg.sessionName ?? this.session.n}`);
    await this.launch(dir);
    return true;
  }

  private async describeAttached(): Promise<void> {
    if (this.info.userDataDirInUse) return;
    // Most likely a browser a server launched earlier (it outlives the server on purpose).
    // Identify it from the listening process rather than from the configured preference.
    const found = await this.resolveFromListeningProcess();
    const info = found?.info ?? this.safeResolve();
    this.info.browser = info;
    if (found?.userDataDir) this.info.userDataDirInUse = found.userDataDir;
    else if (this.cfg.mode === 'mirror' && info && fs.existsSync(path.join(this.cfg.mirrorDir, info.kind, this.cfg.profileDir))) this.info.userDataDirInUse = path.join(this.cfg.mirrorDir, info.kind);
    else if (this.cfg.mode === 'direct' && info) this.info.userDataDirInUse = info.userDataDir;
  }

  /** Identifies the browser listening on the CDP port from its command line (binary path and --user-data-dir). */
  private async resolveFromListeningProcess(): Promise<{ info: BrowserInfo; userDataDir?: string } | undefined> {
    const pid = await this.listeningPid();
    if (!pid) return undefined;
    const cmd = await new Promise<string>((resolve) => execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5000 }, (err, out) => resolve(err ? '' : out.trim())));
    if (!cmd) return undefined;
    const exe = cmd.split(/ --/)[0].trim();
    const userDataDir = /--user-data-dir=("[^"]*"|\S+)/.exec(cmd)?.[1]?.replace(/^"|"$/g, '');
    const kind = (['brave', 'chrome', 'chromium', 'edge'] as const).find((k) => { try { return resolveBrowser(k).executable === exe; } catch { return false; } });
    if (!kind) return undefined;
    this.info.pid = pid;
    return { info: resolveBrowser(kind, undefined, this.cfg.userDataDir), userDataDir };
  }

  private safeResolve(): BrowserInfo | undefined {
    try { return resolveBrowser(this.cfg.browser, this.cfg.executable, this.cfg.userDataDir); } catch { return undefined; }
  }

  /** Launches the browser; `userDataDirOverride` is the per-session copy in isolated mode. */
  private async launch(userDataDirOverride?: string): Promise<void> {
    const info = resolveBrowser(this.cfg.browser, this.cfg.executable, this.cfg.userDataDir);
    this.info.browser = info;
    let userDataDir = info.userDataDir;

    if (this.cfg.mode === 'mirror' || userDataDirOverride) {
      const dst = userDataDirOverride ?? path.join(this.cfg.mirrorDir, info.kind);
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
      this.owned.delete(page);
      this.tabIds.delete(page);
    });
  }

  /** Takes a page under this session's control. */
  private own(page: Page): void {
    if (this.owned.has(page)) return;
    this.wirePage(page);
    this.owned.add(page);
    // Windows our pages open (target=_blank, window.open) belong to us too.
    page.on('popup', (p) => {
      this.own(p);
      void this.tagPage(p).then(() => this.ensureTabGroup());
    });
  }

  isOwned(page: Page): boolean {
    return this.owned.has(page);
  }

  /** Tabs of this session (default) or every tab in the browser. */
  pages(all = false): Page[] {
    const live = (this.context?.pages() ?? []).filter((p) => !p.isClosed());
    return all ? live : live.filter((p) => this.owned.has(p));
  }

  async page(): Promise<Page> {
    await this.ensure();
    if (this.active && !this.active.isClosed() && this.owned.has(this.active)) return this.active;
    const mine = this.pages().filter((p) => !p.url().startsWith('chrome-extension://') && !p.url().startsWith('devtools://'));
    this.active = mine[mine.length - 1] ?? (await this.newPage());
    return this.active;
  }

  /** Makes a page the active one; a tab from another session is adopted by this one. */
  setActive(page: Page): void {
    if (!this.owned.has(page)) { this.own(page); void this.tagPage(page).then(() => this.ensureTabGroup()); }
    this.active = page;
  }

  async newPage(url?: string): Promise<Page> {
    const ctx = await this.ensure();
    const page = await ctx.newPage();
    this.own(page);
    this.active = page;
    await this.tagPage(page);
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    void this.ensureTabGroup();
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

  private async groupWorkerWithRetry(): Promise<Worker | undefined> {
    // Service workers of freshly started extensions may not be registered with Playwright yet.
    let worker = await this.findGroupWorker();
    for (let i = 0; i < 10 && !worker; i++) { await sleep(300); worker = await this.findGroupWorker(); }
    return worker;
  }

  /**
   * Learns the chrome.tabs id of a page: its title is briefly set to a unique token that the extension
   * worker looks up. Pages that block page scripts (LavaMoat wallets) keep working, just ungrouped.
   */
  private async tagPage(page: Page): Promise<void> {
    if (!this.cfg.tabGroup || this.tabIds.has(page) || page.isClosed()) return;
    const worker = await this.groupWorkerWithRetry();
    if (!worker) return;
    const token = `bmcp-${this.session.n}-${process.pid}-${++this.tagCounter}`;
    try {
      const previous = await page.evaluate((t) => { const o = document.title; document.title = t; return o; }, token);
      let id: number | null = null;
      for (let i = 0; i < 8 && id === null; i++) {
        id = await worker.evaluate(async (q: string) => {
          const c = (globalThis as unknown as { chrome: any }).chrome;
          const tabs: Array<{ id: number }> = await c.tabs.query({ title: q });
          return tabs[0]?.id ?? null;
        }, token);
        if (id === null) await sleep(120);
      }
      await page.evaluate((o) => { document.title = o; }, previous).catch(() => {});
      if (id !== null) this.tabIds.set(page, id);
    } catch (e) {
      this.log.log(`tab tagging skipped: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  /** Keeps this session's tabs in one titled, coloured tab group. */
  async ensureTabGroup(): Promise<void> {
    if (!this.cfg.tabGroup || !this.context) return;
    try {
      const worker = await this.groupWorkerWithRetry();
      if (!worker) return;
      const ids = this.pages().map((p) => this.tabIds.get(p)).filter((id): id is number => id !== undefined);
      if (!ids.length) return;
      await worker.evaluate(async ({ ids, title, color }) => {
        const c = (globalThis as unknown as { chrome: any }).chrome;
        // Only tabs whose ids we resolved ourselves: openerTabId is not usable here, because a tab created
        // over CDP inherits the window's active tab as opener, which in a shared window may be another session's.
        const tabs: Array<{ id: number; url?: string; pendingUrl?: string; groupId: number; windowId: number }> = await c.tabs.query({});
        const mine = new Set<number>(ids);
        const groups: Array<{ id: number; title?: string; windowId: number }> = await c.tabGroups.query({ title });
        const byWindow = new Map<number, number[]>();
        for (const t of tabs) {
          if (!mine.has(t.id)) continue;
          if (t.groupId !== -1 && groups.some((g) => g.id === t.groupId)) continue;
          byWindow.set(t.windowId, [...(byWindow.get(t.windowId) ?? []), t.id]);
        }
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        // tabGroups.update right after tabs.group can fail with "No group with id" while Chrome is still
        // settling the new group; a few short retries cover it.
        const update = async (groupId: number) => {
          for (let i = 0; i < 5; i++) {
            try { await c.tabGroups.update(groupId, { title, color }); return; } catch (e) { if (i === 4) throw e; await wait(150); }
          }
        };
        for (const [windowId, tabIds] of byWindow) {
          const existing = groups.find((g) => g.windowId === windowId);
          let groupId: number;
          try {
            groupId = await c.tabs.group(existing ? { tabIds, groupId: existing.id } : { tabIds, createProperties: { windowId } });
          } catch {
            groupId = await c.tabs.group({ tabIds, createProperties: { windowId } }); // the old group vanished meanwhile
          }
          await wait(100);
          await update(groupId);
          if (!existing) groups.push({ id: groupId, title, windowId });
        }
        for (const g of groups) await c.tabGroups.update(g.id, { title, color }).catch(() => {});
      }, { ids, title: this.groupTitle, color: this.groupColor });
    } catch (e) {
      this.tabGroupStatus = `failed: ${(e as Error).message.split('\n')[0]}`;
      this.log.log('tab group', this.tabGroupStatus);
    }
  }

  /* ------------------------------- lifecycle ------------------------------ */

  /** Closes this session's tabs (shared) without touching anybody else's. */
  async closeOwnedTabs(): Promise<number> {
    const mine = this.pages();
    await Promise.all(mine.map((p) => p.close().catch(() => {})));
    return mine.length;
  }

  async close(killBrowser: boolean, closeTabs = false): Promise<string> {
    const notes: string[] = [];
    if (closeTabs && this.browser?.isConnected()) notes.push(`closed ${await this.closeOwnedTabs()} tab(s) of this session`);
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

  /** Server exit: shared sessions drop their tabs, isolated sessions take their browser and profile copy with them. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      if (this.cfg.sessions === 'isolated') {
        if (!this.cfg.isolatedKeep) {
          const dir = this.info.userDataDirInUse;
          await this.close(true).catch(() => {});
          const pid = this.info.pid;
          if (pid) {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) { try { process.kill(pid, 0); await sleep(150); } catch { break; } }
          }
          if (dir && dir.startsWith(this.cfg.mirrorDir)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
        }
      } else if (!this.cfg.keepTabs && this.browser?.isConnected()) {
        await Promise.race([this.closeOwnedTabs(), sleep(2500)]);
      }
    } finally {
      this.registry.release();
    }
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
