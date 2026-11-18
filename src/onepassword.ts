import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page, ElementHandle } from 'playwright-core';
import type { Config } from './config.js';
import type { BrowserManager } from './browser.js';
import type { Logger } from './log.js';
import { guard, text, resolve } from './tools.js';
import { VaultClient, hostOf, type LoginItem } from './vault.js';

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

  /** The item for this page: an explicit `item` must match by id or title; otherwise the best match for the site's host. */
  const pickItem = async (page: Page, item: string | undefined): Promise<{ chosen: LoginItem; cands: LoginItem[] }> => {
    const host = hostOf(page.url());
    const cands = await op.candidates(host, item);
    let chosen: LoginItem | undefined;
    if (item) {
      const q = item.toLowerCase();
      const matches = (i: LoginItem) => i.id === item || i.title.toLowerCase() === q || i.title.toLowerCase().includes(q);
      chosen = cands.find(matches) ?? (await op.listLogins()).find(matches);
    } else {
      chosen = cands[0];
    }
    if (!chosen) throw new Error(`No 1Password Login item matches ${item ? `"${item}"` : host || 'this page (not a website: pass item=<title>)'}. Use onepassword_items to list candidates and pass item=<id or title>.`);
    if (cands.length > 1 && !item) logger.log(`multiple 1Password items match ${host}; using "${chosen.title}" (${cands.length} candidates)`);
    return { chosen, cands };
  };

  /** Reads the item through the SDK (service account, no prompt) and types the values into the detected fields. */
  const fill = async (page: Page, fields: LoginFields, item: string | undefined, what: 'login' | 'otp', dry = false): Promise<string> => {
    const { chosen, cands } = await pickItem(page, item);
    const notes: string[] = [`${dry ? 'would use' : 'using'} item "${chosen.title}" from vault ${chosen.vaultTitle}${cands.length > 1 ? `; ${cands.length} items match this site` : ''}`];
    if (dry) {
      // Dry run: resolve the item but read no secret.
      const would = what === 'otp' ? (fields.otp ? 'otp' : 'nothing (no one-time-code field detected)') : [fields.username && 'username', fields.password && 'password'].filter(Boolean).join(' and ') || 'nothing (no username/password field detected)';
      notes.push(`dry run, would fill ${would}`);
      return notes.join('\n');
    }
    if (what === 'otp') {
      if (!fields.otp) throw new Error('No one-time-code field detected; pass otpRef.');
      const code = await op.getOtp(chosen);
      if (!code) throw new Error(`Item "${chosen.title}" has no one-time password.`);
      await fields.otp.fill(code);
      notes.push('filled otp');
      return notes.join('\n');
    }
    if (!fields.username && !fields.password) throw new Error('No username/password field detected on this page; pass usernameRef/passwordRef.');
    const creds = await op.getLogin(chosen);
    if (fields.username && creds.username) { await fields.username.fill(creds.username); notes.push('filled username'); }
    if (fields.password && creds.password) { await fields.password.fill(creds.password); notes.push('filled password'); }
    return notes.join('\n');
  };

  server.registerTool('onepassword_fill', {
    title: '1Password: fill login',
    description: 'Fill the login form on the active tab with the matching 1Password Login item: the server reads it through the 1Password SDK (service account, no prompt) and types the values into the detected fields. Credential values are never returned. Pass item=<title or id> when several items match the site or the page is not a website (extension pages). For multi-step forms (username first) call it again on the next step.',
    inputSchema: {
      item: z.string().optional().describe('1Password item title or id to use when several match the site, or when the page has no site'),
      submit: z.boolean().optional().describe('Press Enter in the last filled field afterwards and wait for the resulting navigation'),
      dryRun: z.boolean().optional().describe('Resolve the item and the fields but fill nothing'),
      usernameRef: z.string().optional(), passwordRef: z.string().optional(), otpRef: z.string().optional(),
    },
  }, guard(async ({ item, submit, dryRun, usernameRef, passwordRef, otpRef }) => {
    const page = await mgr.page();
    const fields = await fieldsFromArgs(page, { usernameRef, passwordRef, otpRef });
    const notes: string[] = [describeFields(fields)];
    const dry = dryRun ?? false;
    notes.push(await fill(page, fields, item, 'login', dry));
    const report = await filledReport(fields);
    notes.push(`result: ${report.text}`);
    if (submit && !dry) {
      const last = fields.password ?? fields.username ?? fields.otp;
      if (last) { await submitWith(page, last); notes.push(`submitted; now at ${page.url()}`); }
    }
    return text(notes.join('\n'));
  }));

  server.registerTool('onepassword_otp', {
    title: '1Password: fill one-time code',
    description: 'Fill a TOTP / one-time code field from the matching 1Password item (read through the 1Password SDK). The code is never returned to the caller.',
    inputSchema: {
      item: z.string().optional().describe('1Password item id or title'),
      otpRef: z.string().optional().describe('Ref of the code field if auto-detection fails'),
      submit: z.boolean().optional(),
    },
  }, guard(async ({ item, otpRef, submit }) => {
    const page = await mgr.page();
    const auto = await detectFields(page);
    const otp = otpRef ? ((await resolve(page, { ref: otpRef }).elementHandle()) as Field | null) ?? undefined : auto.otp;
    const fields: LoginFields = { otp };
    const notes: string[] = [`otp field: ${otp ? 'detected' : 'not found'}`];
    notes.push(await fill(page, fields, item, 'otp'));
    if (submit && otp) { await submitWith(page, otp); notes.push(`submitted; now at ${page.url()}`); }
    return text(notes.join('\n'));
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
    description: 'Check the 1Password integration: whether a service account token is set, whether it authenticates, and which vaults it can read.',
    inputSchema: {},
  }, guard(async () => text(await op.status())));
}
