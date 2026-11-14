import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pidAlive } from './platform.js';

export interface SessionRecord {
  n: number;
  pid: number;
  name?: string;
  mode: 'shared' | 'isolated';
  port?: number;
  started: string;
}

/**
 * Small on-disk registry of live server processes (~/.browser-mcp/sessions/<n>.json). It hands each
 * server the lowest free number, which names its tab group and, in isolated mode, its profile copy.
 * Records of dead processes are reclaimed on the fly.
 */
export class SessionRegistry {
  readonly dir: string;
  record?: SessionRecord;

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, 'sessions');
  }

  claim(name: string | undefined, mode: SessionRecord['mode']): SessionRecord {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (let n = 1; n < 1000; n++) {
      const file = path.join(this.dir, `${n}.json`);
      const rec: SessionRecord = { n, pid: process.pid, name, mode, started: new Date().toISOString() };
      try {
        fs.writeFileSync(file, JSON.stringify(rec), { flag: 'wx', mode: 0o600 });
        this.record = rec;
        return rec;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const existing = readRecord(file);
        if (!existing || !pidAlive(existing.pid)) {
          try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
          n--; // retry the same number
        }
      }
    }
    throw new Error('too many live browser-mcp sessions');
  }

  update(patch: Partial<SessionRecord>): void {
    if (!this.record) return;
    this.record = { ...this.record, ...patch };
    try { fs.writeFileSync(path.join(this.dir, `${this.record.n}.json`), JSON.stringify(this.record)); } catch { /* ignore */ }
  }

  release(): void {
    if (!this.record) return;
    try { fs.rmSync(path.join(this.dir, `${this.record.n}.json`), { force: true }); } catch { /* ignore */ }
    this.record = undefined;
  }

  /** Live sessions, this one included; stale records are removed. */
  list(): SessionRecord[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out: SessionRecord[] = [];
    for (const f of names) {
      const file = path.join(this.dir, f);
      const rec = readRecord(file);
      if (rec && pidAlive(rec.pid)) out.push(rec);
      else { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
    }
    return out.sort((a, b) => a.n - b.n);
  }
}

function readRecord(file: string): SessionRecord | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as SessionRecord; } catch { return undefined; }
}

/**
 * Exclusive launch lock per CDP port so that several servers starting at once launch one browser.
 * Returns a release function when acquired, or undefined when another live process holds it.
 */
export function tryLaunchLock(baseDir: string, port: number): (() => void) | undefined {
  const file = path.join(baseDir, `launch-${port}.lock`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file, { force: true }); } catch { /* ignore */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder = 0;
      try { holder = Number(fs.readFileSync(file, 'utf8')); } catch { /* ignore */ }
      let stale = !holder || !pidAlive(holder);
      if (!stale) { try { stale = Date.now() - fs.statSync(file).mtimeMs > 120000; } catch { stale = true; } }
      if (!stale) return undefined;
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  }
  return undefined;
}

/** First TCP port in [start, start + count) that nothing on 127.0.0.1 listens on. */
export async function findFreePort(start: number, count = 200): Promise<number> {
  for (let port = start; port < start + count; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port in ${start}-${start + count - 1}`);
}
