import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page, type Dialog } from 'playwright-core';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { resolveBrowser, syncProfile, hasExtension, type BrowserInfo, type SyncResult } from './profile.js';
import { frontmostProcessPid, activateProcess } from './mac.js';

export interface ConsoleEntry { time: number; type: string; text: string; location?: string }
export interface NetworkEntry { time: number; method: string; url: string; resourceType: string; status?: number; failure?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    });
    this.browser = browser;
    this.context = context;
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
      ...(this.cfg.disableSync ? ['--disable-sync'] : []),
      ...(this.cfg.headless ? ['--headless=new'] : []),
      ...this.cfg.extraArgs,
      'about:blank',
    ];

    fs.mkdirSync(path.dirname(this.cfg.logFile), { recursive: true, mode: 0o700 });
    const browserLog = this.cfg.logFile.replace(/\.log$/, '') + '.browser.log';
    const fd = fs.openSync(browserLog, 'a', 0o600);
    let exited: number | null | undefined;
    const appBundle = process.platform === 'darwin' ? /^(.*\.app)\/Contents\/MacOS\//.exec(info.executable)?.[1] : undefined;
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

  private listeningPid(): Promise<number | undefined> {
    return new Promise((resolve) => {
      execFile('lsof', ['-nP', `-iTCP:${this.cfg.port}`, '-sTCP:LISTEN', '-t'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(undefined);
        const pid = Number(stdout.trim().split('\n')[0]);
        resolve(Number.isFinite(pid) && pid > 0 ? pid : undefined);
      });
    });
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
    return page;
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
