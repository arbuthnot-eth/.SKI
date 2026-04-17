// Single choke point for deriving the ultron.sui signing keypair.
//
// Raw-key today: reads SHADE_KEEPER_PRIVATE_KEY (bech32 `suiprivkey1…`)
// and derives an Ed25519 keypair. Tomorrow — once IKA imported-key
// ed25519 DKG ships — this helper swaps to a DWalletCap + IKA
// threshold signature without touching any of the 90+ server-side
// call sites.
//
// NEVER call `Ed25519Keypair.fromSecretKey(env.SHADE_KEEPER_PRIVATE_KEY)`
// directly. Always go through ultronKeypair(env) so the raw→IKA
// migration has exactly one line to change.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

export interface UltronEnv {
    /**
     * Preferred name for ultron's Ed25519 private key (bech32 `suiprivkey1…`).
     * Use this for new deploys and future rotations.
     */
    ULTRON_PRIVATE_KEY?: string;
    /**
     * Legacy name — ultron originally shipped as the Shade keeper only.
     * Still accepted for backwards compatibility during the rename
     * window; delete once ULTRON_PRIVATE_KEY is written on every
     * environment.
     */
    SHADE_KEEPER_PRIVATE_KEY?: string;
}

/** Resolve ultron's secret from either the preferred or legacy env name. */
function resolveUltronSecret(env: UltronEnv): string | undefined {
    return env.ULTRON_PRIVATE_KEY ?? env.SHADE_KEEPER_PRIVATE_KEY;
}

/** True if ultron is configured on this env (preferred or legacy name). */
export function hasUltronKey(env: UltronEnv): boolean {
    return !!resolveUltronSecret(env);
}

/**
 * Ultron.sui Ed25519 keypair. One call site away from IKA MPC.
 *
 * Throws if no secret is configured — call sites that tolerate an
 * unconfigured keeper should gate on `hasUltronKey(env)` before
 * invoking, matching the runtime pattern across the agents.
 */
export function ultronKeypair(env: UltronEnv): Ed25519Keypair {
    const secret = resolveUltronSecret(env);
    if (!secret) {
        throw new Error('ultronKeypair: no ULTRON_PRIVATE_KEY or SHADE_KEEPER_PRIVATE_KEY configured');
    }
    return Ed25519Keypair.fromSecretKey(secret);
}

/** Ultron.sui public address. Cheaper than ultronKeypair when only the address is needed. */
export function ultronAddress(env: UltronEnv): string {
    return ultronKeypair(env).getPublicKey().toSuiAddress();
}
