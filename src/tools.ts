import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page, Locator } from 'playwright-core';
import type { Config } from './config.js';
import type { BrowserManager } from './browser.js';

type ToolResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean };

export const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
export const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n').filter((l) => !/^\s+at /.test(l)).slice(0, 12).join('\n');
}

/** Wraps a tool body so thrown errors become MCP error results instead of protocol failures. */
export function guard<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(errorMessage(e));
    }
  };
}

export async function snapshot(page: Page, maxChars: number, header = true): Promise<string> {
  let body: string;
  const p = page as unknown as { ariaSnapshot?: (o: { mode: 'ai' }) => Promise<string> };
  if (typeof p.ariaSnapshot === 'function') body = await p.ariaSnapshot({ mode: 'ai' });
  else body = await (page.locator('body') as unknown as { ariaSnapshot(o: { mode: 'ai' }): Promise<string> }).ariaSnapshot({ mode: 'ai' });
  if (body.length > maxChars) body = body.slice(0, maxChars) + `\n... [truncated ${body.length - maxChars} chars; use browser_find or browser_get_text, or raise maxChars]`;
  if (!header) return body;
  let title = '';
  try { title = await page.title(); } catch { /* ignore */ }
  return `Page: ${title}\nURL: ${page.url()}\n\n${body}`;
}

export const target = {
  ref: z.string().optional().describe('Element ref from browser_snapshot, e.g. "e12"'),
  selector: z.string().optional().describe('Playwright selector (CSS, text=..., role=..., xpath=...) used when no ref is given'),
};

export function resolve(page: Page, t: { ref?: string; selector?: string }): Locator {
  if (t.ref) return page.locator(`aria-ref=${t.ref.replace(/^\[?ref=|\]$/g, '')}`);
  if (t.selector) return page.locator(t.selector).first();
  throw new Error('Provide either ref (from browser_snapshot) or selector');
}

export function registerBrowserTools(server: McpServer, mgr: BrowserManager, cfg: Config): void {
  const after = async (page: Page, want: boolean | undefined, prefix: string): Promise<ToolResult> => {
    const doSnap = want ?? cfg.snapshotAfterActions;
    if (!doSnap) return text(`${prefix}\nURL: ${page.url()}`);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return text(`${prefix}\n\n${await snapshot(page, cfg.snapshotMaxChars)}`);
  };
  const snapOpt = z.boolean().optional().describe('Return an accessibility snapshot of the page after the action (default from BROWSER_MCP_SNAPSHOT_AFTER_ACTIONS)');

  server.registerTool('browser_status', {
    title: 'Browser status',
    description: 'Report which browser/profile this server drives, whether it is connected, open tabs, and 1Password availability. Connects (launching the browser if needed) when connect=true.',
    inputSchema: { connect: z.boolean().optional().describe('Connect/launch now (default true)') },
  }, guard(async ({ connect }) => {
    const lines: string[] = [];
    if (connect ?? true) await mgr.ensure();
    const b = mgr.info.browser;
    lines.push(`mode: ${cfg.mode}`);
    lines.push(`browser: ${b ? `${b.name} (${b.executable})` : 'unresolved'}`);
    lines.push(`source profile: ${b?.userDataDir ?? '?'} / ${cfg.profileDir}`);
    lines.push(`user-data-dir in use: ${mgr.info.userDataDirInUse ?? (cfg.mode === 'attach' ? 'external' : '?')}`);
    lines.push(`cdp: ${cfg.cdpUrl} (${mgr.isConnected() ? 'connected' : 'not connected'}, launched by this server: ${mgr.info.launched}, pid: ${mgr.info.pid ?? '?'})`);
    if (mgr.info.lastSync) lines.push(`last profile sync: ${mgr.info.lastSync.files} files, ${(mgr.info.lastSync.bytes / 1e6).toFixed(1)} MB, ${mgr.info.lastSync.durationMs} ms, skipped large IndexedDB origins: ${mgr.info.lastSync.skippedIndexedDb.length}`);
    lines.push(`1Password extension in profile: ${mgr.onePasswordInstalled() ? 'yes' : 'no'}; popup shortcut: ${cfg.onePasswordShortcut}`);
    if (mgr.isConnected()) {
      const pages = mgr.pages();
      const active = await mgr.page();
      lines.push(`tabs (${pages.length}):`);
      for (const [i, p] of pages.entries()) lines.push(`  ${i}${p === active ? '*' : ' '} ${p.url()}`);
    }
    return text(lines.join('\n'));
  }));

  server.registerTool('browser_navigate', {
    title: 'Navigate',
    description: 'Navigate the active tab to a URL and return a snapshot.',
    inputSchema: {
      url: z.string().describe('Absolute URL (https:// is prepended when missing)'),
      newTab: z.boolean().optional().describe('Open in a new tab instead of the active one'),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
      snapshot: z.boolean().optional().describe('Include a snapshot (default true)'),
    },
  }, guard(async ({ url, newTab, waitUntil, snapshot: snap }) => {
    const u = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    const page = newTab ? await mgr.newPage() : await mgr.page();
    await page.goto(u, { waitUntil: waitUntil ?? 'load', timeout: 45000 });
    if (snap ?? true) return text(await snapshot(page, cfg.snapshotMaxChars));
    return text(`Navigated to ${page.url()}\nTitle: ${await page.title()}`);
  }));

  server.registerTool('browser_history', {
    title: 'Back / forward / reload',
    description: 'Go back, go forward, or reload the active tab.',
    inputSchema: { action: z.enum(['back', 'forward', 'reload']), snapshot: snapOpt },
  }, guard(async ({ action, snapshot: snap }) => {
    const page = await mgr.page();
    if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
    else if (action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });
    return after(page, snap ?? true, `${action} done`);
  }));

  server.registerTool('browser_tabs', {
    title: 'Tabs',
    description: 'List, open, select, or close tabs. Indexes refer to the list returned by action=list.',
    inputSchema: {
      action: z.enum(['list', 'new', 'select', 'close']),
      index: z.number().int().optional().describe('Tab index for select/close (close defaults to the active tab)'),
      url: z.string().optional().describe('URL for action=new'),
      focus: z.boolean().optional().describe('select only: also raise the browser window (default false, so the user keeps their focus)'),
    },
  }, guard(async ({ action, index, url, focus }) => {
    await mgr.ensure();
    if (action === 'new') {
      const p = await mgr.newPage(url);
      return text(`Opened tab ${mgr.pages().indexOf(p)}: ${p.url()}`);
    }
    const pages = mgr.pages();
    if (action === 'select') {
      if (index === undefined || !pages[index]) throw new Error(`No tab at index ${index}`);
      mgr.setActive(pages[index]);
      if (focus) await pages[index].bringToFront();
      return text(`Active tab ${index}: ${pages[index].url()}`);
    }
    if (action === 'close') {
      const p = index === undefined ? await mgr.page() : pages[index];
      if (!p) throw new Error(`No tab at index ${index}`);
      await p.close();
      return text(`Closed tab. Remaining: ${mgr.pages().length}`);
    }
    const active = await mgr.page();
    const lines = await Promise.all(pages.map(async (p, i) => `${i}${p === active ? '*' : ' '} ${JSON.stringify(await p.title().catch(() => ''))} ${p.url()}`));
    return text(lines.join('\n') || 'no tabs');
  }));

  server.registerTool('browser_snapshot', {
    title: 'Accessibility snapshot',
    description: 'Return the accessibility tree of the active tab with element refs (e.g. [ref=e12]) usable by browser_click, browser_type, etc. Preferred over screenshots for reading or locating content.',
    inputSchema: {
      maxChars: z.number().int().optional().describe(`Truncate after this many characters (default ${cfg.snapshotMaxChars})`),
    },
  }, guard(async ({ maxChars }) => text(await snapshot(await mgr.page(), maxChars ?? cfg.snapshotMaxChars))));

  server.registerTool('browser_find', {
    title: 'Find in snapshot',
    description: 'Search the accessibility snapshot for lines containing a text (case-insensitive) and return them with refs.',
    inputSchema: { query: z.string(), limit: z.number().int().optional() },
  }, guard(async ({ query, limit }) => {
    const page = await mgr.page();
    const snap = await snapshot(page, 2_000_000, false);
    const q = query.toLowerCase();
    const hits = snap.split('\n').filter((l) => l.toLowerCase().includes(q)).slice(0, limit ?? 30).map((l) => l.trim());
    return text(hits.length ? hits.join('\n') : `No snapshot lines contain "${query}"`);
  }));

  server.registerTool('browser_screenshot', {
    title: 'Screenshot',
    description: 'Take a screenshot of the active tab (or of one element) and return it as an image.',
    inputSchema: {
      ...target,
      fullPage: z.boolean().optional(),
      format: z.enum(['jpeg', 'png']).optional().describe('Default jpeg'),
      quality: z.number().int().min(1).max(100).optional().describe('JPEG quality, default 70'),
    },
  }, guard(async ({ ref, selector, fullPage, format, quality }) => {
    const page = await mgr.page();
    const type = format ?? 'jpeg';
    const opts = { type, ...(type === 'jpeg' ? { quality: quality ?? 70 } : {}) } as const;
    const buf = (ref || selector)
      ? await resolve(page, { ref, selector }).screenshot(opts)
      : await page.screenshot({ ...opts, fullPage: fullPage ?? false });
    return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: `image/${type}` }] };
  }));

  server.registerTool('browser_click', {
    title: 'Click',
    description: 'Click an element identified by ref or selector.',
    inputSchema: {
      ...target,
      button: z.enum(['left', 'right', 'middle']).optional(),
      doubleClick: z.boolean().optional(),
      modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
      force: z.boolean().optional().describe('Skip actionability checks'),
      snapshot: snapOpt,
    },
  }, guard(async ({ ref, selector, button, doubleClick, modifiers, force, snapshot: snap }) => {
    const page = await mgr.page();
    const loc = resolve(page, { ref, selector });
    const o = { button, modifiers, force };
    if (doubleClick) await loc.dblclick(o); else await loc.click(o);
    return after(page, snap, 'Clicked');
  }));

  server.registerTool('browser_type', {
    title: 'Type text',
    description: 'Type into an input/textarea/contenteditable. Replaces the current value unless append=true. Optionally presses Enter afterwards.',
    inputSchema: {
      ...target,
      text: z.string(),
      append: z.boolean().optional(),
      slowly: z.boolean().optional().describe('Type key by key to trigger per-key handlers'),
      submit: z.boolean().optional().describe('Press Enter after typing'),
      snapshot: snapOpt,
    },
  }, guard(async ({ ref, selector, text: value, append, slowly, submit, snapshot: snap }) => {
    const page = await mgr.page();
    const loc = resolve(page, { ref, selector });
    if (slowly || append) {
      await loc.click();
      if (!append) await loc.fill('');
      await loc.pressSequentially(value, { delay: slowly ? 40 : 0 });
    } else {
      await loc.fill(value);
    }
    if (submit) await loc.press('Enter');
    return after(page, snap, `Typed ${value.length} chars${submit ? ' and pressed Enter' : ''}`);
  }));

  server.registerTool('browser_fill_form', {
    title: 'Fill form',
    description: 'Fill several fields at once. Each field takes a ref or selector plus a value; checkboxes take "true"/"false", selects take the option value or label.',
    inputSchema: {
      fields: z.array(z.object({
        ref: z.string().optional(),
        selector: z.string().optional(),
        value: z.string(),
        kind: z.enum(['text', 'checkbox', 'select', 'radio']).optional(),
      })),
      snapshot: snapOpt,
    },
  }, guard(async ({ fields, snapshot: snap }) => {
    const page = await mgr.page();
    for (const f of fields) {
      const loc = resolve(page, f);
      const kind = f.kind ?? 'text';
      if (kind === 'checkbox' || kind === 'radio') await loc.setChecked(/^(true|1|yes|on)$/i.test(f.value));
      else if (kind === 'select') await loc.selectOption({ label: f.value }).catch(() => loc.selectOption(f.value));
      else await loc.fill(f.value);
    }
    return after(page, snap, `Filled ${fields.length} fields`);
  }));

  server.registerTool('browser_press_key', {
    title: 'Press key',
    description: 'Press a key or chord (e.g. "Enter", "Tab", "Escape", "Control+a", "ArrowDown") on the focused element or on a target.',
    inputSchema: { key: z.string(), ...target, snapshot: snapOpt },
  }, guard(async ({ key, ref, selector, snapshot: snap }) => {
    const page = await mgr.page();
    if (ref || selector) await resolve(page, { ref, selector }).press(key); else await page.keyboard.press(key);
    return after(page, snap, `Pressed ${key}`);
  }));

  server.registerTool('browser_hover', {
    title: 'Hover',
    description: 'Hover over an element.',
    inputSchema: { ...target, snapshot: snapOpt },
  }, guard(async ({ ref, selector, snapshot: snap }) => {
    const page = await mgr.page();
    await resolve(page, { ref, selector }).hover();
    return after(page, snap, 'Hovered');
  }));

  server.registerTool('browser_select_option', {
    title: 'Select option',
    description: 'Select option(s) in a <select> by value or label.',
    inputSchema: { ...target, values: z.array(z.string()), snapshot: snapOpt },
  }, guard(async ({ ref, selector, values, snapshot: snap }) => {
    const page = await mgr.page();
    const loc = resolve(page, { ref, selector });
    try { await loc.selectOption(values); } catch { await loc.selectOption(values.map((label) => ({ label }))); }
    return after(page, snap, `Selected ${values.join(', ')}`);
  }));

  server.registerTool('browser_scroll', {
    title: 'Scroll',
    description: 'Scroll the page (or scroll an element into view when ref/selector is given).',
    inputSchema: {
      ...target,
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      pixels: z.number().optional().describe('Default 600'),
      snapshot: snapOpt,
    },
  }, guard(async ({ ref, selector, direction, pixels, snapshot: snap }) => {
    const page = await mgr.page();
    if (ref || selector) {
      await resolve(page, { ref, selector }).scrollIntoViewIfNeeded();
      return after(page, snap, 'Scrolled element into view');
    }
    const px = pixels ?? 600;
    const dx = direction === 'left' ? -px : direction === 'right' ? px : 0;
    const dy = direction === 'up' ? -px : direction === 'left' || direction === 'right' ? 0 : px;
    await page.mouse.wheel(dx, dy);
    return after(page, snap, `Scrolled ${direction ?? 'down'} ${px}px`);
  }));

  server.registerTool('browser_wait_for', {
    title: 'Wait',
    description: 'Wait for text to appear/disappear, a selector, a URL pattern, network idle, or a fixed time.',
    inputSchema: {
      text: z.string().optional(),
      textGone: z.string().optional(),
      selector: z.string().optional(),
      url: z.string().optional().describe('Glob or substring of the URL to wait for'),
      networkIdle: z.boolean().optional(),
      timeMs: z.number().optional(),
      timeoutMs: z.number().optional().describe('Default 15000'),
    },
  }, guard(async ({ text: t, textGone, selector, url, networkIdle, timeMs, timeoutMs }) => {
    const page = await mgr.page();
    const timeout = timeoutMs ?? 15000;
    const done: string[] = [];
    if (timeMs) { await page.waitForTimeout(timeMs); done.push(`waited ${timeMs}ms`); }
    if (t) { await page.getByText(t).first().waitFor({ state: 'visible', timeout }); done.push(`"${t}" visible`); }
    if (textGone) { await page.getByText(textGone).first().waitFor({ state: 'hidden', timeout }); done.push(`"${textGone}" gone`); }
    if (selector) { await page.locator(selector).first().waitFor({ state: 'visible', timeout }); done.push(`${selector} visible`); }
    if (url) { await page.waitForURL(url.includes('*') ? url : `**${url}**`, { timeout }); done.push(`url ${page.url()}`); }
    if (networkIdle) { await page.waitForLoadState('networkidle', { timeout }); done.push('network idle'); }
    return text(done.join('; ') || 'nothing to wait for');
  }));

  server.registerTool('browser_evaluate', {
    title: 'Evaluate JavaScript',
    description: 'Run JavaScript in the page. Provide an expression or a function body; with ref/selector the function receives the element as its argument. Returns the JSON-serialised result.',
    inputSchema: {
      expression: z.string().describe('e.g. "document.title" or "(el) => el.textContent"'),
      ...target,
    },
  }, guard(async ({ expression, ref, selector }) => {
    const page = await mgr.page();
    let result: unknown;
    const looksLikeFn = /^\s*(async\s*)?(\(|function\b|[a-zA-Z_$][\w$]*\s*=>)/.test(expression);
    if (ref || selector) {
      const handle = await resolve(page, { ref, selector }).elementHandle();
      if (!handle) throw new Error('Element not found');
      result = await handle.evaluate(looksLikeFn ? new Function(`return (${expression})`)() : new Function('el', `return (${expression})`) as never);
    } else {
      result = looksLikeFn ? await page.evaluate(new Function(`return (${expression})`)() as never) : await page.evaluate(expression);
    }
    const out = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return text(out === undefined ? 'undefined' : out.length > 50000 ? out.slice(0, 50000) + '\n...[truncated]' : out);
  }));

  server.registerTool('browser_get_text', {
    title: 'Get text',
    description: 'Return the visible text of the page or of an element.',
    inputSchema: { ...target, maxChars: z.number().int().optional().describe('Default 30000') },
  }, guard(async ({ ref, selector, maxChars }) => {
    const page = await mgr.page();
    const t = (ref || selector) ? await resolve(page, { ref, selector }).innerText() : await page.locator('body').innerText();
    const max = maxChars ?? 30000;
    return text(t.length > max ? t.slice(0, max) + `\n...[truncated ${t.length - max} chars]` : t);
  }));

  server.registerTool('browser_console', {
    title: 'Console messages',
    description: 'Return recent console messages and page errors from the active tab.',
    inputSchema: { onlyErrors: z.boolean().optional(), limit: z.number().int().optional(), clear: z.boolean().optional() },
  }, guard(async ({ onlyErrors, limit, clear }) => {
    const page = await mgr.page();
    const logs = mgr.consoleLogs.get(page) ?? [];
    const sel = (onlyErrors ? logs.filter((l) => l.type === 'error' || l.type === 'warning') : logs).slice(-(limit ?? 50));
    const out = sel.map((l) => `[${l.type}] ${l.text}${l.location ? `  (${l.location})` : ''}`).join('\n');
    if (clear) logs.length = 0;
    return text(out || 'no console messages');
  }));

  server.registerTool('browser_network', {
    title: 'Network requests',
    description: 'Return recent network requests from the active tab (method, status, URL).',
    inputSchema: { filter: z.string().optional().describe('Substring filter on URL'), limit: z.number().int().optional(), clear: z.boolean().optional() },
  }, guard(async ({ filter, limit, clear }) => {
    const page = await mgr.page();
    const net = mgr.network.get(page) ?? [];
    const sel = (filter ? net.filter((n) => n.url.includes(filter)) : net).slice(-(limit ?? 60));
    const out = sel.map((n) => `${n.method} ${n.status ?? (n.failure ? `FAILED(${n.failure})` : 'pending')} ${n.resourceType} ${n.url}`).join('\n');
    if (clear) net.length = 0;
    return text(out || 'no requests recorded');
  }));

  server.registerTool('browser_dialog', {
    title: 'Handle dialog',
    description: 'Accept or dismiss a pending alert/confirm/prompt dialog on the active tab.',
    inputSchema: { accept: z.boolean(), promptText: z.string().optional() },
  }, guard(async ({ accept, promptText }) => {
    const page = await mgr.page();
    const d = mgr.dialogs.get(page);
    if (!d) return text('No pending dialog');
    const msg = `${d.type()}: ${d.message()}`;
    if (accept) await d.accept(promptText); else await d.dismiss();
    mgr.dialogs.delete(page);
    return text(`${accept ? 'Accepted' : 'Dismissed'} ${msg}`);
  }));

  server.registerTool('browser_upload_file', {
    title: 'Upload file',
    description: 'Set files on a file input (or click a button that opens a file chooser and feed it the files).',
    inputSchema: { ...target, paths: z.array(z.string()).describe('Absolute file paths'), viaChooser: z.boolean().optional() },
  }, guard(async ({ ref, selector, paths, viaChooser }) => {
    const page = await mgr.page();
    const loc = resolve(page, { ref, selector });
    if (viaChooser) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), loc.click()]);
      await chooser.setFiles(paths);
    } else {
      await loc.setInputFiles(paths);
    }
    return text(`Uploaded ${paths.length} file(s)`);
  }));

  server.registerTool('browser_resize', {
    title: 'Resize viewport',
    description: 'Resize the active tab viewport.',
    inputSchema: { width: z.number().int(), height: z.number().int() },
  }, guard(async ({ width, height }) => {
    const page = await mgr.page();
    await page.setViewportSize({ width, height });
    return text(`Viewport ${width}x${height}`);
  }));

  server.registerTool('browser_close', {
    title: 'Close',
    description: 'Detach from the browser (it keeps running, sessions stay alive) or quit it with kill=true.',
    inputSchema: { kill: z.boolean().optional() },
  }, guard(async ({ kill }) => text(await mgr.close(kill ?? false))));
}
