#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { Logger } from './log.js';
import { BrowserManager } from './browser.js';
import { registerBrowserTools } from './tools.js';
import { registerOnePasswordTools, OpClient } from './onepassword.js';
import { resolveBrowser, listProfiles, hasExtension } from './profile.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const cfg = loadConfig();
const log = new Logger(cfg.logFile);
const mgr = new BrowserManager(cfg, log);

process.on('uncaughtException', (e) => log.log('uncaughtException', e?.stack ?? String(e)));
process.on('unhandledRejection', (e) => log.log('unhandledRejection', (e as Error)?.stack ?? String(e)));

async function doctor(launch: boolean): Promise<void> {
  const out = (s: string) => process.stdout.write(s + '\n');
  out(`browser-mcp ${version} doctor`);
  out(`mode: ${cfg.mode}`);
  try {
    const b = resolveBrowser(cfg.browser, cfg.executable, cfg.userDataDir);
    out(`browser: ${b.name}\n  executable: ${b.executable}\n  user data dir: ${b.userDataDir}`);
    out(`  profiles: ${listProfiles(b.userDataDir).join(', ') || 'none found'} (using "${cfg.profileDir}")`);
    out(`  1Password extension in source profile: ${hasExtension(b.userDataDir, cfg.profileDir, cfg.onePasswordExtensionId) ? 'yes' : 'no'}`);
  } catch (e) {
    out(`browser: ${(e as Error).message}`);
  }
  const op = new OpClient(cfg.opPath, cfg.opAccount);
  out(`1Password CLI (${cfg.opPath}): ${(await op.available()) ? 'installed' : 'not found'}`);
  if (await op.available()) {
    try { await op.run(['whoami'], 30000); out('  signed in: yes'); } catch (e) { out(`  signed in: no - ${(e as Error).message.split('\n')[0]}`); }
  }
  if (process.platform === 'darwin') {
    try { const { frontmostProcessName } = await import('./mac.js'); out(`accessibility: ok (frontmost app: ${await frontmostProcessName()})`); }
    catch (e) { out(`accessibility: ${(e as Error).message}`); }
  }
  if (launch) {
    out('launching/attaching...');
    await mgr.ensure();
    out(`connected: ${mgr.isConnected()}; user-data-dir in use: ${mgr.info.userDataDirInUse ?? 'external'}; pid ${mgr.info.pid ?? '?'}`);
    if (mgr.info.lastSync) out(`profile sync: ${mgr.info.lastSync.files} files, ${(mgr.info.lastSync.bytes / 1e6).toFixed(1)} MB in ${mgr.info.lastSync.durationMs} ms`);
    out(`tabs: ${mgr.pages().map((p) => p.url()).join(', ')}`);
    out(`1Password extension in driven profile: ${mgr.onePasswordInstalled() ? 'yes' : 'no'}`);
    await mgr.close(false);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('doctor')) {
    await doctor(argv.includes('--launch'));
    process.exit(0);
  }
  const server = new McpServer({ name: 'browser-mcp', version }, {
    instructions: [
      'Drives the user\'s own Chrome/Brave profile (cookies, sessions, extensions) through the DevTools protocol.',
      'Workflow: browser_navigate or browser_snapshot to get element refs like e12, then browser_click / browser_type / browser_fill_form with ref.',
      'Logins: on a sign-in page call onepassword_fill (extension autofill, CLI fallback); for 2FA codes call onepassword_otp. Secrets never come back to you.',
      'Prefer browser_snapshot / browser_get_text over screenshots for reading pages.',
    ].join('\n'),
  });
  registerBrowserTools(server, mgr, cfg);
  registerOnePasswordTools(server, mgr, cfg, log);
  await server.connect(new StdioServerTransport());
  log.log(`browser-mcp ${version} started (mode=${cfg.mode}, browser=${cfg.browser}, cdp=${cfg.cdpUrl})`);
}

main().catch((e) => {
  log.log('fatal', e?.stack ?? String(e));
  process.exit(1);
});
