#!/usr/bin/env node
// Minimal stdio MCP client for manual testing:
//   node scripts/mcp-client.mjs '[["browser_status",{}],["browser_navigate",{"url":"https://example.com"}]]'
// BROWSER_MCP_* variables in the environment are passed to the server. Images are saved next to cwd.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '..', 'dist', 'index.js');
const label = process.env.CLIENT_LABEL ? `[${process.env.CLIENT_LABEL}] ` : '';
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env }, stderr: 'pipe' });
const client = new Client({ name: 'mcp-client', version: '0.0.0' });
transport.stderr?.on('data', (d) => { if (process.env.CLIENT_VERBOSE) process.stderr.write(label + d); });
await client.connect(transport);

const steps = JSON.parse(process.argv[2] ?? '[["browser_status",{}]]');
for (const [name, args] of steps) {
  if (name === 'sleep') { await new Promise((r) => setTimeout(r, args)); continue; }
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args ?? {} });
  console.log(`\n${label}### ${name} ${JSON.stringify(args ?? {})} (${Date.now() - t0}ms)${res.isError ? ' ERROR' : ''}`);
  for (const c of res.content) {
    if (c.type === 'text') console.log(c.text.length > 4000 ? c.text.slice(0, 4000) + `\n...[${c.text.length} chars]` : c.text);
    else if (c.type === 'image') { const f = `shot-${Date.now()}.${c.mimeType.split('/')[1]}`; fs.writeFileSync(f, Buffer.from(c.data, 'base64')); console.log(`<image saved ${f}>`); }
  }
}
await client.close();
