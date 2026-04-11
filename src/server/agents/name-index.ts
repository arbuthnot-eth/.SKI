/**
 * NameIndex — global SuiNS target-reverse index.
 *
 * SuiNS only exposes *primary* reverse lookup (defaultNameRecord).
 * Any address that's the target of a name but never ran `set_default`
 * would render as hex everywhere. This DO keeps a shared
 * { address → [names] } map that any sui.ski visitor contributes to
 * whenever their client resolves `@name → address`.
 *
 * Singleton: always accessed via idFromName('singleton'). State is
 * a flat object persisted through the Agent framework's state bag.
 *
 * Write: POST /set { address, name }
 * Read:  GET  /get/<address>
 * Bulk:  POST /bulk [{ address, name }, ...]
 *
 * Entries are capped at 8 names per address, most-recent first, so
 * the map stays small and the "latest name touched" wins for display.
 */

import { Agent } from 'agents';

interface NameIndexState {
  // address(lowercase) → [name(lowercase, no .sui), …]
  reverse: Record<string, string[]>;
}

interface Env {
  [key: string]: unknown;
}

const MAX_NAMES_PER_ADDRESS = 8;

function _normAddr(a: unknown): string | null {
  if (typeof a !== 'string') return null;
  const s = a.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(s) ? s : null;
}

function _normName(n: unknown): string | null {
  if (typeof n !== 'string') return null;
  const s = n.trim().toLowerCase().replace(/\.sui$/, '');
  return /^[a-z0-9-]{1,63}$/.test(s) ? s : null;
}

export class NameIndex extends Agent<Env, NameIndexState> {
  initialState: NameIndexState = { reverse: {} };

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /set { address, name }
    if (request.method === 'POST' && url.pathname.endsWith('/set')) {
      const body = await request.json().catch(() => ({})) as { address?: string; name?: string };
      const addr = _normAddr(body.address);
      const name = _normName(body.name);
      if (!addr || !name) return Response.json({ ok: false, error: 'bad input' }, { status: 400 });
      this._addMapping(addr, name);
      return Response.json({ ok: true });
    }

    // POST /bulk [{ address, name }, …]
    if (request.method === 'POST' && url.pathname.endsWith('/bulk')) {
      const body = await request.json().catch(() => []) as Array<{ address?: string; name?: string }>;
      if (!Array.isArray(body)) return Response.json({ ok: false, error: 'bad input' }, { status: 400 });
      let written = 0;
      for (const row of body.slice(0, 200)) {
        const addr = _normAddr(row.address);
        const name = _normName(row.name);
        if (addr && name) { this._addMapping(addr, name); written++; }
      }
      return Response.json({ ok: true, written });
    }

    // GET /get/<address>
    const getMatch = url.pathname.match(/\/get\/(0x[0-9a-fA-F]{64})$/);
    if (request.method === 'GET' && getMatch) {
      const addr = getMatch[1].toLowerCase();
      const names = this.state.reverse[addr] ?? [];
      return Response.json({ address: addr, names });
    }

    // GET /size — diagnostics
    if (request.method === 'GET' && url.pathname.endsWith('/size')) {
      const addrCount = Object.keys(this.state.reverse).length;
      const nameCount = Object.values(this.state.reverse).reduce((s, v) => s + v.length, 0);
      return Response.json({ addresses: addrCount, names: nameCount });
    }

    return new Response('not found', { status: 404 });
  }

  private _addMapping(addr: string, name: string): void {
    const reverse = { ...this.state.reverse };
    const current = reverse[addr] ?? [];
    const filtered = current.filter(n => n !== name);
    filtered.unshift(name);
    reverse[addr] = filtered.slice(0, MAX_NAMES_PER_ADDRESS);
    this.setState({ reverse });
  }
}
