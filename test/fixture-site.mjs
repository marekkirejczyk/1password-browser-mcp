// A tiny login site for the end-to-end test. Each instance expects one username/password pair and
// records successful logins in memory, so the test can assert who signed in without printing secrets.
import http from 'node:http';
import crypto from 'node:crypto';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

export async function startSite({ name, expected }) {
  const cookie = `sid_${name.replace(/[^a-z0-9]/gi, '')}`;
  const sessions = new Map();
  const logins = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(`${name} login`, `<form method="post" action="/login">
        <label>Username <input type="text" name="username" autocomplete="username" required></label>
        <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
        <button type="submit">Log in</button></form>`));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const ok = form.get('username') === expected.username && form.get('password') === expected.password;
        logins.push({ ok, usernameMatched: form.get('username') === expected.username, time: Date.now() });
        if (!ok) { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(`${name} login`, '<p class="error">Wrong credentials</p>')); return; }
        const sid = crypto.randomBytes(16).toString('hex');
        sessions.set(sid, form.get('username'));
        res.writeHead(303, { 'set-cookie': `${cookie}=${sid}; Path=/; HttpOnly`, location: '/me' });
        res.end();
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/me') {
      const sid = (req.headers.cookie ?? '').split(/;\s*/).map((c) => c.split('=')).find((c) => c[0] === cookie)?.[1];
      if (sid && sessions.has(sid)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(`${name} account`, `<p id="status">Signed in to ${name}</p>`)); return; }
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(`${name} account`, '<p id="status">Not signed in</p>')); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    name, port, url: `http://127.0.0.1:${port}`, logins,
    // Chrome keeps keep-alive connections open; drop them or close() waits for its idle timeout.
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
