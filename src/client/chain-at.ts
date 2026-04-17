// Canonical resolver for the `chain@name` identifier format.
// Per feedback_address_format.md: sol@ultron, eth@brando, btc@stables,
// tron@whelm, sui@superteam — the chain key comes first, then the
// SUIAMI-registered name.
//
// Single entry point for any call site that needs to turn a human-
// readable identifier into a raw chain address. Hits the SUIAMI
// roster, returns whatever is in `chains[<chain>]` for the named
// record.

import { readByName } from 'suiami/roster';

export interface ResolveChainAddrResult {
    ok: boolean;
    chain?: string;
    name?: string;
    address?: string;
    error?: string;
}

/**
 * Resolve a `chain@name` identifier to the raw chain address stored
 * in the SUIAMI roster for that name.
 *
 * Returns `{ ok: true, chain, name, address }` on success,
 * `{ ok: false, error }` otherwise.
 *
 * Accepts any chain key the roster records — eth, sol, btc, tron, sui,
 * etc. Unknown chains return `{ ok: false, error: 'no-<chain>-squid' }`.
 */
export async function resolveChainAddr(identifier: string): Promise<ResolveChainAddrResult> {
    if (!identifier || typeof identifier !== 'string') {
        return { ok: false, error: 'bad-identifier' };
    }
    const m = identifier.match(/^([a-z0-9]+)@([a-z0-9][a-z0-9-]*)$/i);
    if (!m) {
        return { ok: false, error: 'bad-format — expected <chain>@<name>' };
    }
    const chain = m[1].toLowerCase();
    const name = m[2].toLowerCase();
    try {
        const record = await readByName(name);
        if (!record) return { ok: false, error: `no SUIAMI record for ${name}`, chain, name };
        // Special-case: sui@<name> resolves to the record's sui_address
        // even if chains["sui"] isn't explicitly set — every record has
        // a sui_address by construction.
        if (chain === 'sui') {
            return { ok: true, chain, name, address: record.sui_address };
        }
        const address = record.chains?.[chain];
        if (!address) return { ok: false, error: `no ${chain} squid in roster for ${name}`, chain, name };
        return { ok: true, chain, name, address };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), chain, name };
    }
}

/** Convenience: throw-on-miss variant for consumers that prefer exceptions. */
export async function chainAt(identifier: string): Promise<string> {
    const r = await resolveChainAddr(identifier);
    if (!r.ok || !r.address) throw new Error(`chainAt(${identifier}): ${r.error ?? 'unknown'}`);
    return r.address;
}
