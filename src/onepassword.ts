import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page, ElementHandle } from 'playwright-core';
import type { Config } from './config.js';
import type { BrowserManager } from './browser.js';
import type { Logger } from './log.js';
import { activateProcess, sendShortcut } from './mac.js';
import { guard, text, resolve } from './tools.js';
import { VaultClient, hostOf, type LoginItem } from './vault.js';

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

/**
 * Presses Enter in a field and waits for the navigation it usually triggers. Sign-ins that stay on the
 * page (fetch-based) just time out quietly, so the reported URL is where the page ended up either way.
 */
async function submitWith(page: Page, field: Field): Promise<void> {
  const nav = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: 3000 }).catch(() => undefined);
  await field.press('Enter');
  await nav;
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/* ----------------------------------- tools ---------------------------------- */

export function registerOnePasswordTools(server: McpServer, mgr: BrowserManager, cfg: Config, logger: Logger, version: string): void {
  log = logger;
  const op = new VaultClient(cfg, version);
  const sdk = op.configured;

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

  /** Programmatic fill: the SDK reads the item (service account, no prompt) and the server types the values. */
  const sdkFill = async (page: Page, fields: LoginFields, item: string | undefined, what: 'login' | 'otp', dry = false): Promise<string> => {
    const host = hostOf(page.url());
    let chosen: LoginItem | undefined;
    const cands = await op.candidates(host, item);
    if (item) {
      // An explicit item must match by id or title; never fall back to a different item for the site.
      const q = item.toLowerCase();
      const matches = (i: LoginItem) => i.id === item || i.title.toLowerCase() === q || i.title.toLowerCase().includes(q);
      chosen = cands.find(matches) ?? (await op.listLogins()).find(matches);
    } else {
      chosen = cands[0];
    }
    if (!chosen) throw new Error(`No 1Password Login item matches ${item ? `"${item}"` : host || 'this page (not a website: pass item=<title>)'}. Use onepassword_items to list candidates and pass item=<id or title>.`);
    if (cands.length > 1 && !item) logger.log(`multiple 1Password items match ${host}; using "${chosen.title}" (${cands.length} candidates)`);
    const notes: string[] = [`sdk: ${dry ? 'would use' : 'using'} item "${chosen.title}" from vault ${chosen.vaultTitle}${cands.length > 1 ? `; ${cands.length} items match this site` : ''}`];
    if (dry) {
      // Dry run: resolve the item but read no secret.
      const would = what === 'otp' ? (fields.otp ? 'otp' : 'nothing (no one-time-code field detected)') : [fields.username && 'username', fields.password && 'password'].filter(Boolean).join(' and ') || 'nothing (no username/password field detected)';
      notes.push(`sdk: dry run, would fill ${would}`);
      return notes.join('\n');
    }
    if (what === 'otp') {
      if (!fields.otp) throw new Error('No one-time-code field detected; pass otpRef.');
      const code = await op.getOtp(chosen);
      if (!code) throw new Error(`Item "${chosen.title}" has no one-time password.`);
      await fields.otp.fill(code);
      notes.push('sdk: filled otp');
      return notes.join('\n');
    }
    const creds = await op.getLogin(chosen);
    if (fields.username && creds.username) { await fields.username.fill(creds.username); notes.push('sdk: filled username'); }
    if (fields.password && creds.password) { await fields.password.fill(creds.password); notes.push('sdk: filled password'); }
    if (!fields.username && !fields.password) throw new Error('No username/password field detected on this page; pass usernameRef/passwordRef.');
    return notes.join('\n');
  };

  const sdkHint = sdk ? '' : ' (strategy=sdk needs OP_SERVICE_ACCOUNT_TOKEN)';

  server.registerTool('onepassword_fill', {
    title: '1Password: fill login',
    description: `Fill the login form on the active tab from 1Password. Strategies: sdk (the 1Password SDK reads the item with a service account token and the server types the values; fully programmatic, no prompt), inline (extension inline menu on the focused field), popup (extension popup page: search item, Open & Fill), shortcut (macOS keystrokes, needs Accessibility). ${sdk ? 'auto = sdk, inline, popup.' : 'auto = inline, popup (no service account token is set, so sdk is unavailable).'} Credential values are never returned. For multi-step forms (username first) call it again on the next step.`,
    inputSchema: {
      strategy: z.enum(['auto', 'extension', 'inline', 'popup', 'sdk', 'shortcut']).optional().describe(sdk ? 'auto = sdk -> inline -> popup; extension = inline -> popup' : 'auto = extension = inline -> popup' + sdkHint),
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
    const order: Array<'inline' | 'popup' | 'sdk' | 'shortcut'> = strat === 'auto' && sdk ? ['sdk', 'inline', 'popup'] : strat === 'auto' || strat === 'extension' ? ['inline', 'popup'] : [strat];
    const dry = dryRun ?? false;
    let done = false;
    for (const s of order) {
      if (done) break;
      if (s === 'sdk') {
        // A dry run resolves the item without reading secrets and counts as handled, so it does not fall
        // through to the extension strategies (which may wait for an unlock).
        try { notes.push(await sdkFill(page, fields, item, 'login', dry)); done = true; }
        catch (e) { notes.push(`sdk: ${(e as Error).message}`); }
        continue;
      }
      if (s === 'shortcut' && process.platform !== 'darwin') { notes.push('shortcut: only supported on macOS (uses System Events); use sdk, inline or popup'); continue; }
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
      if (last) { await submitWith(active, last); notes.push(`submitted; now at ${active.url()}`); }
    }
    if (!done && !order.includes('sdk') && !dry) notes.push(`hint: strategy=sdk fills programmatically through the 1Password SDK${sdkHint}`);
    return done ? text(notes.join('\n')) : { content: [{ type: 'text', text: notes.join('\n') }], isError: true };
  }));

  server.registerTool('onepassword_otp', {
    title: '1Password: fill one-time code',
    description: `Fill a TOTP / one-time code field from the matching 1Password item (${sdk ? 'auto = sdk via the service account, then the extension inline menu' : 'extension inline menu; strategy=sdk needs OP_SERVICE_ACCOUNT_TOKEN'}). The code is never returned to the caller.`,
    inputSchema: {
      strategy: z.enum(['auto', 'inline', 'sdk']).optional(),
      item: z.string().optional().describe('1Password item id or title (sdk)'),
      otpRef: z.string().optional().describe('Ref of the code field if auto-detection fails'),
      submit: z.boolean().optional(),
    },
  }, guard(async ({ strategy, item, otpRef, submit }) => {
    const page = await mgr.page();
    const auto = await detectFields(page);
    const otp = otpRef ? ((await resolve(page, { ref: otpRef }).elementHandle()) as Field | null) ?? undefined : auto.otp;
    const fields: LoginFields = { otp };
    const notes: string[] = [`otp field: ${otp ? 'detected' : 'not found'}`];
    const order: Array<'inline' | 'sdk'> = (strategy ?? 'auto') === 'auto' ? (sdk ? ['sdk', 'inline'] : ['inline']) : [strategy as 'inline' | 'sdk'];
    let done = false;
    for (const s of order) {
      if (done) break;
      if (s === 'inline') {
        if (!mgr.onePasswordInstalled()) { notes.push('inline: 1Password extension not found in this profile'); continue; }
        const r = await fillViaInlineMenu(page, fields, logger, false);
        notes.push(r.detail); done = r.ok;
      } else {
        try { notes.push(await sdkFill(page, fields, item, 'otp')); done = true; } catch (e) { notes.push(`sdk: ${(e as Error).message}`); }
      }
    }
    if (!done && !order.includes('sdk')) notes.push(`hint: strategy=sdk reads the code through the 1Password SDK${sdkHint}`);
    if (done && submit && otp) { await submitWith(page, otp); notes.push(`submitted; now at ${page.url()}`); }
    return done ? text(notes.join('\n')) : { content: [{ type: 'text', text: notes.join('\n') }], isError: true };
  }));

  server.registerTool('onepassword_items', {
    title: '1Password: list matching items',
    description: 'List 1Password Login, Password and Crypto Wallet items matching the active tab\'s site (or a given host/query) through the 1Password SDK: title, vault, id, websites. No secrets are returned.',
    inputSchema: { host: z.string().optional(), query: z.string().optional().describe('Title substring'), refresh: z.boolean().optional() },
  }, guard(async ({ host, query, refresh }) => {
    if (refresh) op.invalidate();
    const h = host ?? hostOf((await mgr.page()).url());
    const items = h ? await op.candidates(h, query) : (await op.listLogins()).filter((i) => !query || i.title.toLowerCase().includes(query.toLowerCase()));
    if (!items.length) return text(`No 1Password Login items match ${h ? `${h}${query ? ` / "${query}"` : ''}` : `"${query ?? ''}"`}`);
    return text(items.slice(0, 25).map((i) => `${i.title}  vault=${i.vaultTitle}  id=${i.id}${i.urls.length ? `  urls=${i.urls.join(',')}` : ''}`).join('\n'));
  }));

  server.registerTool('onepassword_status', {
    title: '1Password: status',
    description: 'Check 1Password integration: SDK / service account state and readable vaults, extension present in the driven profile, autofill shortcut, Accessibility permission for the shortcut strategy.',
    inputSchema: {},
  }, guard(async () => {
    const lines: string[] = [];
    lines.push(await op.status());
    lines.push(`extension (${cfg.onePasswordExtensionId}) in profile: ${mgr.onePasswordInstalled() ? 'yes' : 'no'}`);
    lines.push(process.platform === 'darwin'
      ? `popup shortcut used by strategy=shortcut: ${cfg.onePasswordShortcut} (verify at chrome://extensions/shortcuts; override with BROWSER_MCP_1P_SHORTCUT)`
      : `strategy=shortcut: macOS only (not available on ${process.platform}); sdk, inline and popup work here`);
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
