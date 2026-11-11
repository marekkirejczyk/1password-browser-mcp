import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page, ElementHandle } from 'playwright-core';
import type { Config } from './config.js';
import type { BrowserManager } from './browser.js';
import type { Logger } from './log.js';
import { activateProcess, sendShortcut } from './mac.js';
import { guard, text, resolve } from './tools.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- field detection ------------------------------ */

type Field = ElementHandle<HTMLInputElement>;
interface LoginFields { username?: Field; password?: Field; otp?: Field }

async function detectFields(page: Page): Promise<LoginFields> {
  try {
    return await detectFieldsInPage(page);
  } catch (e) {
    // Pages that lock down the main world (e.g. MetaMask's LavaMoat scuttling) reject page scripts;
    // Playwright locators run in an isolated world and still work there.
    log?.log(`field detection via page script failed (${(e as Error).message.split('\n')[0]}); using locators`);
    return detectFieldsWithLocators(page);
  }
}

let log: Logger | undefined;

async function detectFieldsWithLocators(page: Page): Promise<LoginFields> {
  const handle = async (sel: string): Promise<Field | undefined> => {
    const loc = page.locator(sel).filter({ visible: true }).first();
    if (!(await loc.count())) return undefined;
    return ((await loc.elementHandle({ timeout: 1000 }).catch(() => null)) as Field | null) ?? undefined;
  };
  const password = await handle('input[type="password"]:not([disabled])');
  const otp = await handle('input[autocomplete="one-time-code"]');
  const username = (await handle('input[autocomplete="username"]:not([disabled]), input[type="email"]:not([disabled])'))
    ?? (await handle('input[name*="user" i]:not([disabled]), input[name*="email" i]:not([disabled]), input[name*="login" i]:not([disabled]), input[id*="user" i]:not([disabled]), input[id*="email" i]:not([disabled])'));
  return { username, password, otp };
}

async function detectFieldsInPage(page: Page): Promise<LoginFields> {
  const handle = await page.evaluateHandle(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const label = (i: HTMLInputElement) => `${i.name} ${i.id} ${i.getAttribute('aria-label') ?? ''} ${i.placeholder ?? ''} ${i.autocomplete ?? ''}`;
    const inputs = Array.from(document.querySelectorAll('input')).filter((i) => !i.disabled && !i.readOnly && visible(i));
    const password = inputs.find((i) => i.type === 'password');
    const textish = inputs.filter((i) => ['text', 'email', 'tel', 'number', ''].includes(i.type));
    const otp = textish.find((i) => i.autocomplete === 'one-time-code')
      ?? textish.find((i) => /\b(otp|totp|one.?time|verification|2fa|mfa|authenticator|security.?code|passcode)\b/i.test(label(i)));
    let username = textish.find((i) => i !== otp && (i.autocomplete === 'username' || i.type === 'email'))
      ?? textish.find((i) => i !== otp && /user|email|login|account|identifier|phone/i.test(label(i)));
    if (!username && password) {
      const idx = inputs.indexOf(password);
      username = inputs.slice(0, idx).reverse().find((i) => textish.includes(i) && i !== otp);
    }
    if (!username && !password && !otp && textish.length === 1) username = textish[0];
    return { username: username ?? null, password: password ?? null, otp: otp ?? null };
  });
  const pick = async (k: string): Promise<Field | undefined> => {
    const p = await handle.getProperty(k);
    const el = p.asElement();
    if (!el) { await p.dispose(); return undefined; }
    return el as Field;
  };
  const out = { username: await pick('username'), password: await pick('password'), otp: await pick('otp') };
  await handle.dispose();
  return out;
}

async function valueLength(el?: Field): Promise<number> {
  if (!el) return -1;
  try { return (await el.inputValue()).length; } catch { return -1; }
}

async function filledReport(f: LoginFields): Promise<{ username: boolean; password: boolean; otp: boolean; text: string }> {
  const u = await valueLength(f.username), p = await valueLength(f.password), o = await valueLength(f.otp);
  const fmt = (name: string, n: number) => (n < 0 ? `${name}: n/a` : `${name}: ${n > 0 ? 'filled' : 'empty'}`);
  return { username: u > 0, password: p > 0, otp: o > 0, text: [fmt('username', u), fmt('password', p), fmt('otp', o)].join(', ') };
}

/* ------------------------------ extension strategies ----------------------------- */

interface UiState { menu: boolean; buttonVisible: boolean; liveText: string }

/** Reads the state of the UI the 1Password extension injects into the page (live regions, field button). */
async function onePasswordUi(page: Page): Promise<UiState> {
  if (!/^https?:/.test(page.url())) return { menu: false, buttonVisible: false, liveText: 'the 1Password extension does not run inside other extensions\' pages or browser UI pages' };
  return page.evaluate(() => {
    const live = Array.from(document.querySelectorAll('[id^="1p-"][role="status"]')).map((e) => e.textContent?.trim() ?? '').filter(Boolean).join(' | ');
    const btn = document.querySelector('com-1password-button');
    const r = btn?.getBoundingClientRect();
    return { menu: /menu is available/i.test(live), buttonVisible: !!r && r.width > 0 && r.height > 0, liveText: live };
  });
}

interface StrategyResult { ok: boolean; detail: string }

async function changed(before: Awaited<ReturnType<typeof filledReport>>, fields: LoginFields): Promise<{ ok: boolean; after: Awaited<ReturnType<typeof filledReport>> }> {
  const after = await filledReport(fields);
  const ok = (after.password && !before.password) || (after.username && !before.username) || (after.otp && !before.otp);
  return { ok, after };
}

async function waitForFill(before: Awaited<ReturnType<typeof filledReport>>, fields: LoginFields, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = await changed(before, fields);
  while (!last.ok && Date.now() < deadline) { await sleep(250); last = await changed(before, fields); }
  return last;
}

/** Inline menu: focus the field, let the extension open its suggestion menu, pick the first entry with the keyboard. */
async function fillViaInlineMenu(page: Page, fields: LoginFields, log: Logger, dryRun: boolean): Promise<StrategyResult> {
  const anchor = fields.username ?? fields.password ?? fields.otp;
  if (!anchor) return { ok: false, detail: 'inline: no login field found on page' };
  await anchor.click();
  let ui = await onePasswordUi(page);
  const deadline = Date.now() + 3000;
  while (!ui.menu && Date.now() < deadline) {
    if (ui.buttonVisible) { await page.locator('com-1password-button').click({ timeout: 1000 }).catch(() => {}); }
    await sleep(250);
    ui = await onePasswordUi(page);
  }
  if (!ui.menu) {
    const why = ui.liveText ? `extension said: "${ui.liveText}"` : 'no 1Password UI appeared (extension locked, no saved item for this site, or inline menu disabled)';
    return { ok: false, detail: `inline: menu did not open; ${why}` };
  }
  log.log(`1Password inline menu open: ${ui.liveText}`);
  if (dryRun) {
    await page.keyboard.press('ArrowDown');
    await sleep(400);
    const hasMenu = await page.evaluate(() => !!document.querySelector('com-1password-menu'));
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: hasMenu, detail: `inline: ${hasMenu ? 'a suggestion is available (dry run, not filled)' : 'menu present but no suggestion for this site'}` };
  }
  const before = await filledReport(fields);
  await page.keyboard.press('ArrowDown');
  await sleep(400);
  // The suggestion list (<com-1password-menu>) only materialises when there is something to pick.
  // Without it, Enter would just submit the empty form.
  const hasMenu = await page.evaluate(() => !!document.querySelector('com-1password-menu'));
  if (!hasMenu) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, detail: 'inline: 1Password has no suggestion for this site (no saved Login matches its URL)' };
  }
  await page.keyboard.press('Enter');
  const { ok, after } = await waitForFill(before, fields, 4000);
  if (!ok) await page.keyboard.press('Escape').catch(() => {});
  return { ok, detail: `inline: ${ok ? 'filled' : 'suggestion selected but nothing was filled'} (${after.text})` };
}

/** Popup page: the extension popup works as an ordinary tab; search the item and click "Open & Fill". */
async function fillViaPopup(page: Page, fields: LoginFields, mgr: BrowserManager, cfg: Config, log: Logger, item: string | undefined, dryRun: boolean): Promise<StrategyResult> {
  const ctx = await mgr.ensure();
  const host = hostOf(page.url());
  const queries = [item, host.replace(/^www\./, ''), host.replace(/^www\./, '').split('.').slice(-2, -1)[0]].filter((q): q is string => !!q);
  if (!queries.length) return { ok: false, detail: 'popup: this page is not a website, so there is no site to match; pass item=<title>' };
  const popup = await ctx.newPage();
  try {
    await popup.goto(`chrome-extension://${cfg.onePasswordExtensionId}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await sleep(800);
    // Locked? Click Unlock and give the user time to approve (Touch ID in the app, or the password in the window).
    const unlock = popup.getByRole('button', { name: /unlock|sign in/i }).first();
    if (await unlock.isVisible().catch(() => false)) {
      await unlock.click().catch(() => {});
      log.log('1Password popup is locked; waiting for unlock');
      await popup.getByRole('searchbox').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
    }
    const search = popup.getByRole('searchbox').first();
    if (!(await search.isVisible().catch(() => false))) {
      return { ok: false, detail: 'popup: 1Password is locked. Unlock it in the browser window (or approve in the 1Password app) and retry.' };
    }
    let names: string[] = [];
    for (const q of queries) {
      await search.fill(q);
      await sleep(700);
      names = await popup.getByRole('treeitem').allInnerTexts().catch(() => []);
      if (names.length) break;
    }
    const items = popup.getByRole('treeitem');
    const count = await items.count();
    if (!count) return { ok: false, detail: `popup: no 1Password item matches ${queries.map((q) => `"${q}"`).join(' / ')}. Pass item=<title> or use onepassword_items.` };
    await items.first().click();
    await sleep(400);
    const title = (await items.first().innerText().catch(() => '')).split('\n')[0];
    const fill = popup.getByRole('button', { name: /open\s*(&|and)\s*fill/i }).first();
    if (!(await fill.isVisible().catch(() => false))) return { ok: false, detail: `popup: item "${title}" selected but it has no "Open & Fill" action (not a Login item?)` };
    if (dryRun) return { ok: true, detail: `popup: would Open & Fill "${title}"${count > 1 ? ` (${count} matches, first chosen)` : ''} (dry run)` };

    const pagesBefore = new Set(ctx.pages());
    const before = await filledReport(fields);
    await fill.click();
    // 1Password opens the item's website (new tab or current) and fills it.
    let target: Page | undefined;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !target) {
      target = ctx.pages().find((p) => !pagesBefore.has(p) && !p.url().startsWith('chrome-extension://'));
      if (!target) await sleep(200);
    }
    if (target) {
      mgr.setActive(target);
      await popup.close().catch(() => {});
      await target.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(1500);
      const f = await detectFields(target);
      const r = await filledReport(f);
      const ok = r.username || r.password;
      return { ok, detail: `popup: opened "${title}" at ${target.url()} (${r.text})${ok ? '' : '; the site may use a multi-step form, call onepassword_fill again'}` };
    }
    mgr.setActive(page);
    const { ok, after } = await waitForFill(before, fields, 4000);
    return { ok, detail: `popup: Open & Fill "${title}" -> ${ok ? 'filled current page' : 'nothing filled'} (${after.text})` };
  } finally {
    await popup.close().catch(() => {});
    if ((await mgr.page()) === popup || (await mgr.page()).isClosed()) mgr.setActive(page);
  }
}

/** macOS keyboard route: open the popup with its global shortcut and confirm the top suggestion with Enter. */
async function fillViaShortcut(page: Page, fields: LoginFields, mgr: BrowserManager, cfg: Config, item: string | undefined, dryRun: boolean): Promise<StrategyResult> {
  if (process.platform !== 'darwin') return { ok: false, detail: 'shortcut: only supported on macOS' };
  const anchor = fields.username ?? fields.password ?? fields.otp;
  if (anchor) await anchor.click();
  await page.bringToFront();
  const pid = await mgr.browserPid();
  if (pid) await activateProcess(pid).catch(() => {});
  await sleep(300);
  const before = await filledReport(fields);
  try {
    await sendShortcut(cfg.onePasswordShortcut);
    await sleep(1200);
    if (item) { await sendShortcut(item); await sleep(800); }
    if (dryRun) { await sendShortcut('escape'); return { ok: true, detail: 'shortcut: popup opened via System Events (dry run)' }; }
    await sendShortcut('enter');
  } catch (e) {
    return { ok: false, detail: `shortcut: ${(e as Error).message}. Grant Accessibility permission to the app running this server (System Settings > Privacy & Security > Accessibility).` };
  }
  const { ok, after } = await waitForFill(before, fields, 4000);
  if (!ok) await sendShortcut('escape').catch(() => {});
  return { ok, detail: `shortcut ${cfg.onePasswordShortcut}+Enter: ${ok ? 'filled' : 'nothing filled (1Password locked, or no suggestion for this site)'} (${after.text})` };
}

/* ---------------------------------- op CLI ---------------------------------- */

interface OpItem { id: string; title: string; vault?: { name?: string }; urls?: Array<{ href: string; primary?: boolean }>; additional_information?: string; account?: string }
interface OpAccount { url: string; email?: string; account_uuid: string }

class NotSignedIn extends Error {}

export class OpClient {
  private cache?: { time: number; items: OpItem[] };
  constructor(private opPath: string, private account?: string) {}

  /** Runs `op`; `account` scopes the call (item ids are only unique within an account). */
  async run(args: string[], timeoutMs = 90000, account?: string): Promise<string> {
    try {
      return await this.exec(args, timeoutMs, account);
    } catch (e) {
      if (!(e instanceof NotSignedIn) || args[0] === 'signin') throw e;
      // The app-integration session lapsed (app locked, restarted or updated). `op signin` makes the
      // 1Password app ask for Touch ID; then the original call is retried once.
      const acct = account ?? this.account;
      try {
        await this.exec(['signin'], 120000, acct);
      } catch (se) {
        throw new Error(`1Password CLI is not signed in and signing in through the app failed: ${(se as Error).message.split('\n')[0]}\nEnable "Integrate with 1Password CLI" in the 1Password app (Settings > Developer) and unlock it, or run "eval $(op signin)" and pass the OP_SESSION_* variable to this server's environment.`);
      }
      return this.exec(args, timeoutMs, account);
    }
  }

  private exec(args: string[], timeoutMs: number, account?: string): Promise<string> {
    const acct = account ?? this.account;
    const full = [...args, ...(acct ? ['--account', acct] : [])];
    return new Promise((resolve, reject) => {
      execFile(this.opPath, full, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, OP_FORMAT: 'json' } }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message).trim();
          if (/not signed in|no account|sign in|authorization/i.test(msg)) {
            return reject(new NotSignedIn(`1Password CLI is not signed in: ${msg}`));
          }
          if (/ENOENT/.test(msg)) return reject(new Error(`1Password CLI not found at "${this.opPath}" (brew install 1password-cli, or set BROWSER_MCP_OP_PATH).`));
          return reject(new Error(`op ${args.slice(0, 3).join(' ')} failed: ${msg}`));
        }
        resolve(stdout);
      });
    });
  }

  async available(): Promise<boolean> {
    try { await this.run(['--version'], 5000); return true; } catch { return false; }
  }

  async accounts(): Promise<OpAccount[]> {
    if (this.account) return [{ url: this.account, account_uuid: this.account }];
    try {
      const list = JSON.parse(await this.run(['account', 'list', '--format', 'json'], 15000)) as OpAccount[];
      if (list.length) return list;
    } catch { /* fall through: let op pick its default */ }
    return [{ url: '', account_uuid: '' }];
  }

  /** Login, Password and Crypto Wallet items across every account the CLI knows (unless BROWSER_MCP_OP_ACCOUNT pins one). */
  async listLogins(): Promise<OpItem[]> {
    if (this.cache && Date.now() - this.cache.time < 5 * 60 * 1000) return this.cache.items;
    const items: OpItem[] = [];
    const errors: string[] = [];
    for (const a of await this.accounts()) {
      try {
        const out = await this.run(['item', 'list', '--categories', 'Login,Password,Crypto Wallet', '--format', 'json'], 90000, a.account_uuid || undefined);
        for (const it of JSON.parse(out) as OpItem[]) items.push({ ...it, account: a.account_uuid || undefined });
      } catch (e) {
        errors.push(`${a.url || 'default account'}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    if (!items.length && errors.length) throw new Error(errors.join('; '));
    this.cache = { time: Date.now(), items };
    return items;
  }

  invalidate(): void { this.cache = undefined; }

  async candidates(host: string, hint?: string): Promise<OpItem[]> {
    const items = await this.listLogins();
    const h = normHost(host);
    if (!h) {
      if (!hint) return [];
      const q = hint.toLowerCase();
      return items.filter((it) => it.id === hint || it.title.toLowerCase().includes(q) || (it.additional_information ?? '').toLowerCase().includes(q));
    }
    const scored = items.map((it) => {
      let score = 0;
      for (const u of it.urls ?? []) {
        const ih = normHost(hostOf(u.href));
        if (!ih) continue;
        if (ih === h) score = Math.max(score, 3);
        else if (h.endsWith('.' + ih) || ih.endsWith('.' + h)) score = Math.max(score, 2);
      }
      if (hint) {
        const q = hint.toLowerCase();
        if (it.id === hint) score += 10;
        else if (it.title.toLowerCase().includes(q) || (it.additional_information ?? '').toLowerCase().includes(q)) score += 1;
      }
      return { it, score };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    return scored.map((s) => s.it);
  }

  async getLogin(item: OpItem): Promise<{ username?: string; password?: string }> {
    const out = await this.run(['item', 'get', item.id, '--format', 'json', '--reveal'], 90000, item.account);
    const parsed = JSON.parse(out) as { fields?: Array<{ purpose?: string; label?: string; value?: string; type?: string }> };
    const fields = parsed.fields ?? [];
    const byPurpose = (p: string) => fields.find((f) => f.purpose === p)?.value;
    return {
      username: byPurpose('USERNAME') ?? fields.find((f) => /user|email|login/i.test(f.label ?? '') && f.type === 'STRING')?.value,
      // Password and Crypto Wallet items keep the secret in a concealed field (e.g. "password", "wallet password").
      password: byPurpose('PASSWORD') ?? fields.find((f) => f.type === 'CONCEALED' && /password|passphrase|pin/i.test(f.label ?? ''))?.value ?? fields.find((f) => f.type === 'CONCEALED')?.value,
    };
  }

  async getOtp(item: OpItem): Promise<string> {
    return (await this.run(['item', 'get', item.id, '--otp'], 90000, item.account)).trim();
  }
}

/** Hostname of an http(s) URL; empty for extension and browser UI pages, which have no site to match. */
function hostOf(url: string): string {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return /^https?:$/.test(u.protocol) ? u.hostname : '';
  } catch { return ''; }
}
function normHost(h: string): string { return h.toLowerCase().replace(/^www\./, ''); }

/* ----------------------------------- tools ---------------------------------- */

export function registerOnePasswordTools(server: McpServer, mgr: BrowserManager, cfg: Config, logger: Logger): void {
  log = logger;
  const op = new OpClient(cfg.opPath, cfg.opAccount);

  const fieldsFromArgs = async (page: Page, a: { usernameRef?: string; passwordRef?: string; otpRef?: string }): Promise<LoginFields> => {
    const auto = await detectFields(page);
    const pick = async (ref?: string) => (ref ? ((await resolve(page, { ref }).elementHandle()) as Field | null) ?? undefined : undefined);
    return {
      username: (await pick(a.usernameRef)) ?? auto.username,
      password: (await pick(a.passwordRef)) ?? auto.password,
      otp: (await pick(a.otpRef)) ?? auto.otp,
    };
  };

  const describeFields = (f: LoginFields) => `fields detected: username=${f.username ? 'yes' : 'no'}, password=${f.password ? 'yes' : 'no'}, otp=${f.otp ? 'yes' : 'no'}`;

  const cliFill = async (page: Page, fields: LoginFields, item: string | undefined, what: 'login' | 'otp'): Promise<string> => {
    const host = hostOf(page.url());
    let chosen: OpItem | undefined;
    const cands = await op.candidates(host, item);
    if (item) {
      // An explicit item must match by id or title; never fall back to a different item for the site.
      const q = item.toLowerCase();
      const matches = (i: OpItem) => i.id === item || i.title.toLowerCase() === q || i.title.toLowerCase().includes(q);
      chosen = cands.find(matches) ?? (await op.listLogins()).find(matches);
    } else {
      chosen = cands[0];
    }
    if (!chosen) throw new Error(`No 1Password Login item matches ${item ? `"${item}"` : host || 'this page (not a website: pass item=<title>)'}. Use onepassword_items to list candidates and pass item=<id or title>.`);
    if (cands.length > 1 && !item) logger.log(`multiple 1Password items match ${host}; using "${chosen.title}" (${cands.length} candidates)`);
    const notes: string[] = [`cli: using item "${chosen.title}"${chosen.additional_information ? ` (${chosen.additional_information})` : ''} from vault ${chosen.vault?.name ?? '?'}${cands.length > 1 ? `; ${cands.length} items match this site` : ''}`];
    if (what === 'otp') {
      if (!fields.otp) throw new Error('No one-time-code field detected; pass otpRef.');
      const code = await op.getOtp(chosen);
      if (!code) throw new Error(`Item "${chosen.title}" has no one-time password.`);
      await fields.otp.fill(code);
      notes.push('cli: filled otp');
      return notes.join('\n');
    }
    const creds = await op.getLogin(chosen);
    if (fields.username && creds.username) { await fields.username.fill(creds.username); notes.push('cli: filled username'); }
    if (fields.password && creds.password) { await fields.password.fill(creds.password); notes.push('cli: filled password'); }
    if (!fields.username && !fields.password) throw new Error('No username/password field detected on this page; pass usernameRef/passwordRef.');
    return notes.join('\n');
  };

  server.registerTool('onepassword_fill', {
    title: '1Password: fill login',
    description: 'Fill the login form on the active tab from 1Password. Strategies: cli (1Password CLI reads the item, the server types the values; fully programmatic), inline (extension inline menu on the focused field), popup (extension popup page: search item, Open & Fill), shortcut (macOS keystrokes, needs Accessibility). auto = cli, inline, popup. Credential values are never returned. For multi-step forms (username first) call it again on the next step.',
    inputSchema: {
      strategy: z.enum(['auto', 'extension', 'inline', 'popup', 'cli', 'shortcut']).optional().describe('auto = cli -> inline -> popup; extension = inline -> popup'),
      item: z.string().optional().describe('1Password item title/id to prefer when several match the site'),
      submit: z.boolean().optional().describe('Press Enter in the last filled field afterwards'),
      dryRun: z.boolean().optional().describe('Stop right before the fill step and report what would happen'),
      usernameRef: z.string().optional(), passwordRef: z.string().optional(), otpRef: z.string().optional(),
    },
  }, guard(async ({ strategy, item, submit, dryRun, usernameRef, passwordRef, otpRef }) => {
    const page = await mgr.page();
    const fields = await fieldsFromArgs(page, { usernameRef, passwordRef, otpRef });
    const notes: string[] = [describeFields(fields)];
    const strat = strategy ?? 'auto';
    const order: Array<'inline' | 'popup' | 'cli' | 'shortcut'> = strat === 'auto' ? ['cli', 'inline', 'popup'] : strat === 'extension' ? ['inline', 'popup'] : [strat];
    const dry = dryRun ?? false;
    let done = false;
    for (const s of order) {
      if (done) break;
      if (s === 'cli') {
        if (dry) { notes.push('cli: skipped in dry run'); continue; }
        try { notes.push(await cliFill(page, fields, item, 'login')); done = true; }
        catch (e) { notes.push(`cli: ${(e as Error).message}`); }
        continue;
      }
      if (!mgr.onePasswordInstalled()) { notes.push(`${s}: 1Password extension not found in this profile`); continue; }
      const r = s === 'inline' ? await fillViaInlineMenu(page, fields, logger, dry)
        : s === 'popup' ? await fillViaPopup(page, fields, mgr, cfg, logger, item, dry)
        : await fillViaShortcut(page, fields, mgr, cfg, item, dry);
      notes.push(r.detail);
      done = r.ok;
    }
    const active = await mgr.page();
    const report = active === page ? await filledReport(fields) : await filledReport(await detectFields(active));
    notes.push(`result: ${report.text}${active !== page ? ` on ${active.url()}` : ''}`);
    if (done && submit && !dry) {
      const f = active === page ? fields : await detectFields(active);
      const last = f.password ?? f.username ?? f.otp;
      if (last) { await last.press('Enter'); await active.waitForLoadState('domcontentloaded').catch(() => {}); notes.push(`submitted; now at ${active.url()}`); }
    }
    return done ? text(notes.join('\n')) : { content: [{ type: 'text', text: notes.join('\n') }], isError: true };
  }));

  server.registerTool('onepassword_otp', {
    title: '1Password: fill one-time code',
    description: 'Fill a TOTP / one-time code field from the matching 1Password item (CLI first, then extension inline menu). The code is never returned to the caller.',
    inputSchema: {
      strategy: z.enum(['auto', 'inline', 'cli']).optional(),
      item: z.string().optional().describe('1Password item id or title (CLI)'),
      otpRef: z.string().optional().describe('Ref of the code field if auto-detection fails'),
      submit: z.boolean().optional(),
    },
  }, guard(async ({ strategy, item, otpRef, submit }) => {
    const page = await mgr.page();
    const auto = await detectFields(page);
    const otp = otpRef ? ((await resolve(page, { ref: otpRef }).elementHandle()) as Field | null) ?? undefined : auto.otp;
    const fields: LoginFields = { otp };
    const notes: string[] = [`otp field: ${otp ? 'detected' : 'not found'}`];
    const order: Array<'inline' | 'cli'> = (strategy ?? 'auto') === 'auto' ? ['cli', 'inline'] : [strategy as 'inline' | 'cli'];
    let done = false;
    for (const s of order) {
      if (done) break;
      if (s === 'inline') {
        if (!mgr.onePasswordInstalled()) { notes.push('inline: 1Password extension not found in this profile'); continue; }
        const r = await fillViaInlineMenu(page, fields, logger, false);
        notes.push(r.detail); done = r.ok;
      } else {
        try { notes.push(await cliFill(page, fields, item, 'otp')); done = true; } catch (e) { notes.push(`cli: ${(e as Error).message}`); }
      }
    }
    if (done && submit && otp) { await otp.press('Enter'); await page.waitForLoadState('domcontentloaded').catch(() => {}); notes.push(`submitted; now at ${page.url()}`); }
    return done ? text(notes.join('\n')) : { content: [{ type: 'text', text: notes.join('\n') }], isError: true };
  }));

  server.registerTool('onepassword_items', {
    title: '1Password: list matching items',
    description: 'List 1Password Login, Password and Crypto Wallet items matching the active tab\'s site (or a given host/query) via the 1Password CLI: title, username, vault, id. No secrets are returned.',
    inputSchema: { host: z.string().optional(), query: z.string().optional().describe('Title/username substring'), refresh: z.boolean().optional() },
  }, guard(async ({ host, query, refresh }) => {
    if (refresh) op.invalidate();
    const h = host ?? hostOf((await mgr.page()).url());
    const items = h ? await op.candidates(h, query) : (await op.listLogins()).filter((i) => !query || i.title.toLowerCase().includes(query.toLowerCase()) || (i.additional_information ?? '').toLowerCase().includes(query.toLowerCase()));
    if (!items.length) return text(`No 1Password Login items match ${h ? `${h}${query ? ` / "${query}"` : ''}` : `"${query ?? ''}"`}`);
    return text(items.slice(0, 25).map((i) => `${i.title}  (${i.additional_information ?? 'no username'})  vault=${i.vault?.name ?? '?'}  id=${i.id}${i.account ? `  account=${i.account}` : ''}`).join('\n'));
  }));

  server.registerTool('onepassword_status', {
    title: '1Password: status',
    description: 'Check 1Password integration: extension present in the driven profile, CLI availability and sign-in state, autofill shortcut, Accessibility permission for the shortcut strategy.',
    inputSchema: {},
  }, guard(async () => {
    const lines: string[] = [];
    lines.push(`extension (${cfg.onePasswordExtensionId}) in profile: ${mgr.onePasswordInstalled() ? 'yes' : 'no'}`);
    lines.push(`popup shortcut used by strategy=shortcut: ${cfg.onePasswordShortcut} (verify at chrome://extensions/shortcuts; override with BROWSER_MCP_1P_SHORTCUT)`);
    const avail = await op.available();
    lines.push(`cli (${cfg.opPath}): ${avail ? 'installed' : 'not found'}`);
    if (avail) {
      try {
        const accts = await op.accounts();
        const ok: string[] = [];
        for (const a of accts) { try { await op.run(['whoami'], 60000, a.account_uuid || undefined); ok.push(a.url || 'default'); } catch (e) { lines.push(`cli account ${a.url}: ${(e as Error).message.split('\n')[0]}`); } }
        lines.push(`cli accounts searched: ${ok.join(', ') || 'none'}`);
      } catch (e) { lines.push(`cli sign-in: ${(e as Error).message}`); }
    }
    if (mgr.onePasswordInstalled()) {
      try {
        const ctx = await mgr.ensure();
        const popup = await ctx.newPage();
        try {
          await popup.goto(`chrome-extension://${cfg.onePasswordExtensionId}/popup/index.html`, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await popup.waitForTimeout(800);
          const unlocked = await popup.getByRole('searchbox').first().isVisible().catch(() => false);
          lines.push(`extension state: ${unlocked ? 'unlocked' : 'locked (unlock it in the browser window; the popup strategy will also prompt)'}`);
        } finally { await popup.close().catch(() => {}); }
      } catch (e) { lines.push(`extension state: unknown (${(e as Error).message.split('\n')[0]})`); }
    }
    if (process.platform === 'darwin') {
      try { const { frontmostProcessName } = await import('./mac.js'); await frontmostProcessName(); lines.push('accessibility (System Events): ok'); }
      catch (e) { lines.push(`accessibility (System Events): ${(e as Error).message}`); }
    }
    return text(lines.join('\n'));
  }));
}
