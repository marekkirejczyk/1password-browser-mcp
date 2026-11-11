#!/usr/bin/env node
// End-to-end smoke test: starts dist/index.js over stdio and calls every browser tool once.
// Usage: BROWSER_MCP_HEADLESS=true node scripts/smoke.mjs [--keep]
//   --keep   leave the browser running at the end (default: browser_close kill=true)
// Exit code 0 when every step passed. Environment variables are passed through to the server.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const LOGIN_URL = process.env.SMOKE_LOGIN_URL ?? 'https://the-internet.herokuapp.com/login';

const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'index.js')], env: process.env, stderr: 'inherit' }));

const results = [];
const first = (r) => r.content.find((c) => c.type === 'text')?.text ?? '';
const call = async (name, args = {}, check) => {
  const t0 = Date.now();
  let r, text, ok, note;
  try {
    r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    text = first(r);
    const img = r.content.find((c) => c.type === 'image');
    ok = !r.isError && (check ? !!check(text, r) : true);
    note = img ? `image ${img.mimeType}, ${Math.round((img.data.length * 3) / 4 / 1024)} KB` : text.split('\n')[0].slice(0, 110);
    if (r.isError) note = `isError: ${text.split('\n')[0].slice(0, 110)}`;
  } catch (e) {
    ok = false; note = `threw: ${e.message.split('\n')[0]}`; text = '';
  }
  results.push({ name: `${name}${Object.keys(args).length ? ' ' + JSON.stringify(args).slice(0, 60) : ''}`, ok, ms: Date.now() - t0, note });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${Date.now() - t0} ms): ${note}`);
  return { text, r };
};
// Expected failures: tool must answer with isError (clean message), not throw or hang.
const expectError = async (name, args, pattern) => {
  const t0 = Date.now();
  let ok, note;
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    const text = first(r);
    ok = !!r.isError && pattern.test(text);
    note = `${r.isError ? 'isError' : 'NOT isError'}: ${text.replace(/\n/g, ' | ').slice(0, 160)}`;
  } catch (e) { ok = false; note = `threw: ${e.message.split('\n')[0]}`; }
  results.push({ name: `${name} (expect clean error)`, ok, ms: Date.now() - t0, note });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} expected error (${Date.now() - t0} ms): ${note}`);
};

const tools = await client.listTools();
console.log(`server exposes ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(', ')}`);

await call('browser_status', {}, (t) => /connected/.test(t) && !/not connected/.test(t));
const nav = await call('browser_navigate', { url: 'https://example.com' }, (t) => /Example Domain/.test(t) && /\[ref=e\d+\]/.test(t));
const find = await call('browser_find', { query: 'link "Learn more"' }, (t) => /ref=\w+/.test(t));
const ref = /\[ref=(\w+)\]/.exec(find.text)?.[1];
// The link leaves example.com (to iana.org); only the click and the resulting navigation are asserted,
// so the test does not depend on that third host being reachable.
await call('browser_click', { ref, snapshot: true }, (t) => /^Clicked/.test(t) && !/URL: https:\/\/example\.com\//.test(t));
await call('browser_navigate', { url: LOGIN_URL }, (t) => /textbox "Username"/.test(t) && /textbox "Password"/.test(t));
await call('browser_navigate', { url: 'https://example.com', snapshot: false }, (t) => /Navigated to https:\/\/example\.com/.test(t));
await call('browser_history', { action: 'back' }, (t) => /URL: https:\/\/the-internet\.herokuapp\.com\/login/.test(t));
const user = /\[ref=(\w+)\]/.exec((await call('browser_find', { query: 'textbox "Username"' }, (t) => /textbox "Username" \[ref=\w+\]/.test(t))).text)?.[1];
await call('browser_type', { ref: user, text: 'tomsmith' });
await call('browser_evaluate', { expression: 'document.querySelector("#username").value' }, (t) => t === 'tomsmith');
await call('browser_fill_form', { fields: [{ selector: '#password', value: 'SuperSecretPassword!' }] });
await call('browser_get_text', { selector: 'h2' }, (t) => /Login Page/.test(t));
await call('browser_screenshot', {}, (t, r) => r.content.some((c) => c.type === 'image'));
await call('browser_screenshot', { selector: 'h2', format: 'png' }, (t, r) => r.content.some((c) => c.type === 'image'));
await call('browser_evaluate', { expression: 'console.log("smoke-console-marker"); console.error("smoke-error-marker"); 1 + 1' }, (t) => t === '2');
await call('browser_console', {}, (t) => /smoke-console-marker/.test(t) && /smoke-error-marker/.test(t));
await call('browser_console', { onlyErrors: true, clear: true }, (t) => /smoke-error-marker/.test(t) && !/smoke-console-marker/.test(t));
await call('browser_network', { filter: 'herokuapp' }, (t) => /GET 200 document https:\/\/the-internet\.herokuapp\.com\/login/.test(t));
await call('browser_press_key', { key: 'End' });
await call('browser_scroll', { direction: 'down', pixels: 200 });
await call('browser_hover', { selector: 'h2' });
await call('browser_wait_for', { text: 'Login Page', timeoutMs: 5000 }, (t) => /visible/.test(t));
await call('browser_resize', { width: 800, height: 600 }, (t) => /800x600/.test(t));

// select + file input on an inline page (no network)
await call('browser_navigate', { url: 'data:text/html,<title>Form</title><select id=s><option>alpha<option>beta</select><input type=file id=f>' }, (t) => /combobox/.test(t));
await call('browser_select_option', { selector: '#s', values: ['beta'] }, (t) => /Selected beta/.test(t));
await call('browser_evaluate', { expression: 'document.querySelector("#s").value' }, (t) => t === 'beta');
await call('browser_upload_file', { selector: '#f', paths: [fileURLToPath(import.meta.url)] }, (t) => /Uploaded 1 file/.test(t));
await call('browser_evaluate', { expression: 'document.querySelector("#f").files[0].name' }, (t) => t === 'smoke.mjs');
await call('browser_snapshot', { maxChars: 500 }, (t) => /Page: Form/.test(t));

// tabs
await call('browser_tabs', { action: 'new', url: 'https://example.com' }, (t) => /Opened tab \d+: https:\/\/example\.com/.test(t));
const list = await call('browser_tabs', { action: 'list' }, (t) => t.split('\n').length >= 2 && /\*/.test(t));
await call('browser_tabs', { action: 'select', index: 0 }, (t) => /Active tab 0/.test(t));
await call('browser_tabs', { action: 'close', index: 1 }, (t) => /Closed tab/.test(t));
await call('browser_tabs', { action: 'list' }, (t) => t.split('\n').length === list.text.split('\n').length - 1);

// dialog
await call('browser_evaluate', { expression: 'setTimeout(() => confirm("smoke dialog"), 50); "scheduled"' }, (t) => t === 'scheduled');
await new Promise((r) => setTimeout(r, 500));
await call('browser_dialog', { accept: true }, (t) => /Accepted confirm: smoke dialog/.test(t));

// 1Password on the login page: no extension in profile and no `op` on this machine, so both must fail cleanly.
await call('browser_navigate', { url: LOGIN_URL, snapshot: false }, (t) => /Navigated to/.test(t));
await call('onepassword_status', {}, (t) => /extension .* in profile: no/.test(t) && /cli .*: not found/.test(t));
await expectError('onepassword_fill', {}, /cli: .*1Password CLI not found|cli: .*op|extension not found/i);
await expectError('onepassword_fill', { strategy: 'shortcut' }, /only supported on macOS|extension not found/i);
await expectError('onepassword_otp', {}, /not found|no one-time/i);
await expectError('onepassword_items', {}, /not found/i);

await call('browser_status', { connect: false }, (t) => /tabs \(\d+\)/.test(t));
if (!keep) await call('browser_close', { kill: true }, (t) => /SIGTERM|closed/.test(t));
await client.close();

const failed = results.filter((r) => !r.ok);
console.log('\n| tool | result | ms | note |\n|---|---|---|---|');
for (const r of results) console.log(`| ${r.name.replace(/\|/g, '\\|')} | ${r.ok ? 'pass' : 'FAIL'} | ${r.ms} | ${r.note.replace(/\|/g, '\\|')} |`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
