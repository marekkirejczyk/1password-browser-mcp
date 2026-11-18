// End-to-end: two MCP server sessions attached to one headless Chrome sign two tabs in, in parallel,
// with credentials read from 1Password through the SDK (service account; no CLI, no prompt).
//
// Needs OP_SERVICE_ACCOUNT_TOKEN (or, on macOS, a login-keychain item named by
// BROWSER_MCP_TEST_KEYCHAIN_SERVICE, default browser-mcp-op-service-account) with read access to
// the vault BROWSER_MCP_TEST_VAULT (default "Agent") holding the Login items in
// BROWSER_MCP_TEST_ITEMS (default "Meetup,Allegro"). Nothing outside that vault is read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient as createOpClient } from '@1password/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startSite } from './fixture-site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { resolveBrowser } = await import(path.join(root, 'dist/profile.js'));
const { findFreePort } = await import(path.join(root, 'dist/sessions.js'));

const TMP_PREFIX = 'browser-mcp-e2e-';
const VAULT = process.env.BROWSER_MCP_TEST_VAULT || 'Agent';
const ITEMS = (process.env.BROWSER_MCP_TEST_ITEMS || 'Meetup,Allegro').split(',').map((s) => s.trim()).filter(Boolean);
const KEYCHAIN_SERVICE = process.env.BROWSER_MCP_TEST_KEYCHAIN_SERVICE || 'browser-mcp-op-service-account';
const mask = (s) => String(s).replace(/ops_[A-Za-z0-9_-]{20,}/g, 'ops_<masked>');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadToken() {
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) return process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (process.platform === 'darwin') {
    try { return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* fall through */ }
  }
  throw new Error(`No 1Password token: set OP_SERVICE_ACCOUNT_TOKEN or store it in the login keychain as service "${KEYCHAIN_SERVICE}".`);
}

/** Leftovers of an interrupted run: Chrome instances on our temp profiles and the temp dirs themselves. */
async function reapStale() {
  // The pattern must not start with "--" or pgrep reads it as an option. Kill the browsers first and
  // wait for them to go, or they recreate profile files while the directory is being removed.
  let pids = [];
  try {
    const out = execFileSync('pgrep', ['-f', `user-data-dir=${path.join(os.tmpdir(), TMP_PREFIX)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    pids = out.split('\n').map(Number).filter(Boolean);
  } catch { /* none running */ }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  const deadline = Date.now() + 3000;
  while (pids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }) && Date.now() < deadline) await sleep(100);
  const dirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith(TMP_PREFIX));
  for (const d of dirs) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
  if (process.env.E2E_VERBOSE && (pids.length || dirs.length)) console.log(`[setup] reaped ${pids.length} stale browser process(es) and ${dirs.length} temp dir(s)`);
}

const state = { tmp: '', chrome: undefined, cdpUrl: '', browserKind: 'chrome', sites: [], clients: [], expected: new Map() };

async function waitForCdp(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${url}/json/version`); if (r.ok) return; } catch { /* not yet */ }
    if (state.chrome?.exitCode !== null) throw new Error(`Chrome exited with code ${state.chrome.exitCode} before CDP came up`);
    await sleep(200);
  }
  throw new Error(`CDP endpoint ${url} did not come up in ${ms} ms`);
}

async function startServer(name, token) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, 'dist/index.js')],
    env: {
      ...process.env,
      OP_SERVICE_ACCOUNT_TOKEN: token,
      BROWSER_MCP_HOME_DIR: path.join(state.tmp, 'home'),
      BROWSER_MCP_MODE: 'attach', BROWSER_MCP_CDP_URL: state.cdpUrl,
      BROWSER_MCP_SESSIONS: 'shared', BROWSER_MCP_SESSION_NAME: name,
      BROWSER_MCP_TAB_GROUP: 'false', BROWSER_MCP_OP_VAULTS: VAULT,
      BROWSER_MCP_BROWSER: state.browserKind, BROWSER_MCP_USER_DATA_DIR: path.join(state.tmp, 'chrome'),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: `e2e-${name}`, version: '0' });
  await client.connect(transport);
  transport.stderr?.on('data', (d) => { if (process.env.E2E_VERBOSE) process.stderr.write(`[${name}] ${mask(d)}`); });
  const call = async (tool, args = {}) => {
    const t0 = Date.now();
    const r = await client.callTool({ name: tool, arguments: args });
    const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (process.env.E2E_VERBOSE) console.log(`[${name}] ${tool} ${JSON.stringify(args)} -> ${r.isError ? 'ERROR' : 'ok'} (${Date.now() - t0} ms)\n${mask(txt)}`);
    return { ok: !r.isError, text: mask(txt) };
  };
  return { name, client, call, close: () => client.close() };
}

before(async () => {
  if (process.env.E2E_VERBOSE) console.log(`[setup] module loaded at process uptime ${process.uptime().toFixed(1)} s`);
  const t0 = Date.now(); const lap = (l) => { if (process.env.E2E_VERBOSE) console.log(`[setup] ${l} +${Date.now() - t0} ms`); };
  const token = loadToken();
  await reapStale();
  state.tmp = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));

  // Expected credentials come straight from the vault, so the fixtures verify what the server typed.
  const op = await createOpClient({ auth: token, integrationName: 'browser-mcp-e2e', integrationVersion: '0' });
  const vault = (await op.vaults.list()).find((v) => v.title === VAULT);
  assert.ok(vault, `vault "${VAULT}" is not readable by this token`);
  const overviews = await op.items.list(vault.id);
  for (const title of ITEMS) {
    const ov = overviews.find((i) => i.title === title && i.category === 'Login');
    assert.ok(ov, `Login item "${title}" not found in vault "${VAULT}"`);
    const item = await op.items.get(vault.id, ov.id);
    const field = (id) => item.fields.find((f) => f.id === id)?.value;
    const expected = { username: field('username'), password: field('password') };
    assert.ok(expected.username && expected.password, `item "${title}" lacks a username or password`);
    state.expected.set(title, expected);
  }
  lap('vault read');
  for (const title of ITEMS) state.sites.push(await startSite({ name: title, expected: state.expected.get(title) }));

  // A throwaway headless Chrome on an empty profile; the servers attach to it.
  const browser = resolveBrowser(process.env.BROWSER_MCP_BROWSER || 'chrome', process.env.BROWSER_MCP_EXECUTABLE);
  state.browserKind = browser.kind;
  const port = await findFreePort(9400);
  state.cdpUrl = `http://127.0.0.1:${port}`;
  const userDataDir = path.join(state.tmp, 'chrome');
  state.chrome = spawn(browser.executable, [
    `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`, '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--password-store=basic', 'about:blank',
  ], { stdio: 'ignore' });
  process.on('exit', () => { try { state.chrome?.kill('SIGKILL'); } catch { /* gone */ } });
  await waitForCdp(state.cdpUrl, 20000);
  lap('chrome up');

  state.clients = await Promise.all(ITEMS.map((t) => startServer(t.toLowerCase(), token)));
  lap('servers connected');
});

after(async () => {
  const t0 = Date.now(); const lap = (l) => { if (process.env.E2E_VERBOSE) console.log(`[teardown] ${l} +${Date.now() - t0} ms`); };
  await Promise.allSettled(state.clients.map((c) => c.close()));
  lap('servers closed');
  if (state.chrome && state.chrome.exitCode === null) {
    state.chrome.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (state.chrome.exitCode === null && Date.now() < deadline) await sleep(100);
    if (state.chrome.exitCode === null) state.chrome.kill('SIGKILL');
  }
  lap('chrome stopped');
  await Promise.allSettled(state.sites.map((s) => s.close()));
  lap('sites closed');
  if (state.tmp) fs.rmSync(state.tmp, { recursive: true, force: true });
  lap('temp removed');
});

test('each session reports the service account and the allowed vault', async () => {
  await Promise.all(state.clients.map(async (c) => {
    const r = await c.call('onepassword_status');
    assert.ok(r.ok, r.text);
    assert.match(r.text, /sdk: service account ok/);
    assert.match(r.text, new RegExp(`vaults: ${VAULT} \\(`));
    assert.doesNotMatch(r.text, /sensitive/i, 'the allowlist must hide other vaults');
    assert.match(r.text, /extension \(\w+\) in profile: no/, 'the throwaway profile has no extension');
  }));
});

test('two sessions sign in to two sites in parallel through the SDK', async () => {
  const results = await Promise.all(state.clients.map(async (c, i) => {
    const site = state.sites[i];
    const nav = await c.call('browser_navigate', { url: `${site.url}/login`, snapshot: false });
    assert.ok(nav.ok, nav.text);
    const fill = await c.call('onepassword_fill', { item: site.name, submit: true });
    return { c, site, fill };
  }));
  for (const { c, site, fill } of results) {
    assert.ok(fill.ok, `${c.name}: ${fill.text}`);
    assert.match(fill.text, /sdk: filled username/);
    assert.match(fill.text, /sdk: filled password/);
    assert.equal(site.logins.length, 1, `${site.name}: expected exactly one login attempt, got ${site.logins.length}`);
    assert.match(fill.text, /submitted; now at http:\/\/127\.0\.0\.1:\d+\/me/);
    assert.ok(site.logins[0].ok, `${site.name}: the fixture rejected the submitted credentials`);
    const me = await c.call('browser_get_text', {});
    assert.ok(me.ok, me.text);
    assert.match(me.text, new RegExp(`Signed in to ${site.name}`));
  }
});

test('each session owns exactly its own tab', async () => {
  for (const c of state.clients) {
    const mine = await c.call('browser_tabs', { action: 'list' });
    assert.ok(mine.ok, mine.text);
    const own = mine.text.split('\n').filter((l) => /127\.0\.0\.1:\d+\/me/.test(l));
    assert.equal(own.length, 1, `${c.name} should list one tab of its own:\n${mine.text}`);
  }
});
