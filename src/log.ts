import fs from 'node:fs';
import path from 'node:path';

// stdout is the MCP transport: everything diagnostic goes to stderr and the log file.
export class Logger {
  private fd?: number;
  constructor(private file?: string) {
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.fd = fs.openSync(file, 'a', 0o600);
      } catch {
        this.fd = undefined;
      }
    }
  }
  log(msg: string, ...rest: unknown[]): void {
    const line = `[${new Date().toISOString()}] ${msg}${rest.length ? ' ' + rest.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(' ') : ''}`;
    process.stderr.write(line + '\n');
    if (this.fd !== undefined) {
      try { fs.writeSync(this.fd, line + '\n'); } catch { /* ignore */ }
    }
  }
}
