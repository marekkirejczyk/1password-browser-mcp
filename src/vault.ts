import { createClient, type Client, type Item, type ItemOverview, ItemCategory, ItemFieldType } from '@1password/sdk';
import type { Config } from './config.js';

/** A Login-like item as the tools see it: no secret values, only what is needed to pick one. */
export interface LoginItem {
  id: string;
  title: string;
  vaultId: string;
  vaultTitle: string;
  category: string;
  urls: string[];
}

export interface LoginCredentials { username?: string; password?: string }

const FILL_CATEGORIES = new Set<string>([ItemCategory.Login, ItemCategory.Password, ItemCategory.CryptoWallet]);
const CACHE_MS = 5 * 60 * 1000;

/**
 * Reads 1Password through the official SDK with a service account token (OP_SERVICE_ACCOUNT_TOKEN).
 * Headless by construction: no desktop app, no CLI, no prompt. A service account only ever sees the
 * shared vaults it was granted; `cfg.opVaults` narrows that further to an allowlist of vault titles or ids.
 */
export class VaultClient {
  private client?: Promise<Client>;
  private cache?: { time: number; items: LoginItem[] };

  constructor(private cfg: Pick<Config, 'opToken' | 'opVaults'>, private version: string) {}

  get configured(): boolean { return !!this.cfg.opToken; }

  private connect(): Promise<Client> {
    if (!this.cfg.opToken) return Promise.reject(new Error('1Password is not configured: set OP_SERVICE_ACCOUNT_TOKEN to a service account token with read access to the vaults the agent may use.'));
    if (!this.client) {
      this.client = createClient({ auth: this.cfg.opToken, integrationName: '1password-browser-mcp', integrationVersion: this.version })
        .catch((e) => { this.client = undefined; throw new Error(`1Password SDK could not authenticate: ${(e as Error).message}`); });
    }
    return this.client;
  }

  /** Vaults the token can read, filtered by the allowlist (titles or ids, case-insensitive). */
  async vaults(): Promise<Array<{ id: string; title: string; itemCount: number }>> {
    const client = await this.connect();
    const all = (await client.vaults.list()).map((v) => ({ id: v.id, title: v.title, itemCount: v.activeItemCount }));
    if (!this.cfg.opVaults.length) return all;
    const allow = this.cfg.opVaults.map((s) => s.toLowerCase());
    return all.filter((v) => allow.includes(v.title.toLowerCase()) || allow.includes(v.id.toLowerCase()));
  }

  /** Login, Password and Crypto Wallet items across the allowed vaults (cached for five minutes). */
  async listLogins(): Promise<LoginItem[]> {
    if (this.cache && Date.now() - this.cache.time < CACHE_MS) return this.cache.items;
    const client = await this.connect();
    const vaults = await this.vaults();
    if (!vaults.length) throw new Error(`No readable 1Password vault${this.cfg.opVaults.length ? ` matches BROWSER_MCP_OP_VAULTS=${this.cfg.opVaults.join(',')}` : ' is granted to this service account'}.`);
    const items: LoginItem[] = [];
    for (const v of vaults) {
      const list = await client.items.list(v.id);
      for (const it of list) if (FILL_CATEGORIES.has(it.category) && it.state !== 'archived') items.push(toLoginItem(it, v.title));
    }
    this.cache = { time: Date.now(), items };
    return items;
  }

  invalidate(): void { this.cache = undefined; }

  /** Items for a site, best match first; `hint` is an id or a title substring and may stand alone when there is no host. */
  async candidates(host: string, hint?: string): Promise<LoginItem[]> {
    const items = await this.listLogins();
    const h = normHost(host);
    const q = hint?.toLowerCase();
    const byHint = (it: LoginItem) => !!q && (it.id === hint || it.title.toLowerCase().includes(q));
    if (!h) return q ? items.filter(byHint) : [];
    return items.map((it) => {
      let score = 0;
      for (const u of it.urls) {
        const ih = normHost(hostOf(u));
        if (!ih) continue;
        if (ih === h) score = Math.max(score, 3);
        else if (h.endsWith('.' + ih) || ih.endsWith('.' + h)) score = Math.max(score, 2);
      }
      if (q) score += it.id === hint ? 10 : byHint(it) ? 1 : 0;
      return { it, score };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.it);
  }

  private async getItem(item: LoginItem): Promise<Item> {
    const client = await this.connect();
    return client.items.get(item.vaultId, item.id);
  }

  async getLogin(item: LoginItem): Promise<LoginCredentials> {
    const full = await this.getItem(item);
    const f = full.fields;
    const byId = (id: string) => f.find((x) => x.id === id && x.value)?.value;
    const labelled = (re: RegExp, type?: ItemFieldType) => f.find((x) => (!type || x.fieldType === type) && re.test(x.title) && x.value)?.value;
    return {
      username: byId('username') ?? labelled(/user|email|login/i, ItemFieldType.Text) ?? labelled(/user|email|login/i, ItemFieldType.Email),
      // Password and Crypto Wallet items keep the secret in a concealed field (e.g. "password", "wallet password").
      password: byId('password') ?? labelled(/password|passphrase|pin/i, ItemFieldType.Concealed) ?? f.find((x) => x.fieldType === ItemFieldType.Concealed && x.value)?.value,
    };
  }

  /** Current TOTP code, or undefined when the item has no one-time password. */
  async getOtp(item: LoginItem): Promise<string | undefined> {
    const full = await this.getItem(item);
    const totp = full.fields.find((x) => x.fieldType === ItemFieldType.Totp);
    if (!totp) return undefined;
    const d = totp.details;
    if (d?.type === 'Otp') {
      if (d.content.code) return d.content.code;
      throw new Error(`1Password could not compute the one-time code for "${item.title}": ${d.content.errorMessage ?? 'unknown error'}`);
    }
    return totp.value || undefined;
  }

  /** One-line health report for onepassword_status; never throws. */
  async status(): Promise<string> {
    if (!this.configured) return 'sdk: OP_SERVICE_ACCOUNT_TOKEN not set (1Password tools unavailable)';
    try {
      const vaults = await this.vaults();
      return `sdk: service account ok; vaults: ${vaults.map((v) => `${v.title} (${v.itemCount} items)`).join(', ') || 'none'}${this.cfg.opVaults.length ? ` (allowlist: ${this.cfg.opVaults.join(', ')})` : ''}`;
    } catch (e) {
      return `sdk: ${(e as Error).message}`;
    }
  }
}

function toLoginItem(it: ItemOverview, vaultTitle: string): LoginItem {
  return { id: it.id, title: it.title, vaultId: it.vaultId, vaultTitle, category: it.category, urls: it.websites.map((w) => w.url) };
}

/** Hostname of an http(s) URL; empty for extension and browser UI pages, which have no site to match. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return /^https?:$/.test(u.protocol) ? u.hostname : '';
  } catch { return ''; }
}
export function normHost(h: string): string { return h.toLowerCase().replace(/^www\./, ''); }
