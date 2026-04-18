/**
 * Sneasel — private-send flow for `*.whelm.eth` (#197).
 *
 * Wraps the Move `bind_guest_stealth` entry with a client-side helper that
 * Seal-encrypts the cold-squid destination and gates decrypt to ultron
 * (or a designated sweep delegate) via `seal_approve_guest_stealth`.
 *
 * Call shape:
 *   await guestPrivate('amazon.brando', {
 *     hotAddr: '0xHOTeth...',                   // fresh IKA-derived receive addr
 *     coldAddr: '0xCOLDeth...',                 // real squid, never appears on-chain plaintext
 *     chain: 'eth',
 *     ttl: '90d',
 *     sweepDelegate: '0xcaA8d6F0...882d',       // eth@ultron
 *   });
 *
 * Observer-facing view:
 *   amazon.brando.whelm.eth → hotAddr (public CCIP-read, zero history)
 *   funds land at hotAddr, ultron's sweeper (Sneasel Pursuit DO) fires an
 *   IKA-signed sweep after decrypting coldAddr JIT via seal_approve_guest_stealth.
 *
 * Not yet in this move:
 *   - Actual Seal encrypt wiring (Sneasel Blizzard)
 *   - Fresh IKA dWallet provisioning (hotAddr is caller-supplied here)
 *   - SneaselWatcher DO + batched sweep (Sneasel Pursuit / Beat Up)
 *   - Move package upgrade (Sneasel Meditate first, tests before deploy)
 *
 * This file is gated: `bind_guest_stealth` doesn't exist on the currently
 * deployed SUIAMI package yet, so the helper throws a clear message until
 * SUIAMI_STEALTH_PKG is updated past the upgrade.
 */

import type { Transaction } from '@mysten/sui/transactions';

// Set this to the SUIAMI package id AFTER the Move upgrade that landed
// `bind_guest_stealth`. Until then the helper refuses to build a PTB so
// nobody wastes gas on a doomed call.
export const SUIAMI_STEALTH_PKG: string | null = null;

export interface GuestPrivateParams {
  /** Hot receive address — freshly provisioned per guest. ETH addr for
   *  coinType=60, SOL for 501, etc. For now caller supplies; Sneasel
   *  Icy Wind will mint a fresh IKA dWallet per guest automatically. */
  hotAddr: string;
  /** Real cold-squid destination. Never stored on-chain plaintext —
   *  Seal-encrypted against seal_approve_guest_stealth policy. */
  coldAddr: string;
  /** "eth" | "sol" | "btc" | "tron" | "sui" — matches hotAddr chain. */
  chain: string;
  /** TTL string ("30d", "90d", "never") or ms number. */
  ttl: string | number;
  /** Sweep delegate — the address whose on-chain sender proof unlocks
   *  Seal decryption. Typically eth@ultron's IKA-derived address. */
  sweepDelegate: string;
}

export interface GuestPrivateResult {
  ok?: boolean;
  digest?: string;
  label?: string;
  parentName?: string;
  hotAddr?: string;
  chain?: string;
  ttlMs?: number;
  error?: string;
}

/**
 * Encrypt the cold destination with Seal, gated by
 * suiami::roster::seal_approve_guest_stealth. Placeholder for Sneasel
 * Blizzard — mirrors the upgradeSuiami Seal encrypt path in
 * src/client/suiami-seal.ts but points at the new approve fn.
 *
 * Returns the ciphertext bytes that go into `sealed_cold_dest`.
 */
export async function sealEncryptColdDest(_params: {
  coldAddr: string;
  chain: string;
  parentHash: Uint8Array;
  labelBytes: Uint8Array;
  sweepDelegate: string;
}): Promise<Uint8Array> {
  throw new Error(
    '[sneasel] sealEncryptColdDest not yet wired — Sneasel Blizzard move. ' +
    'Plaintext-on-chain IS NOT acceptable; refusing to continue.',
  );
}

/** Build (but do NOT submit) the bind_guest_stealth PTB. Caller submits
 *  via the usual signAndExecuteTransaction path. */
export async function buildBindGuestStealthTx(
  tx: Transaction,
  args: {
    rosterObj: string;
    parentHash: number[];
    labelBytes: number[];
    hotAddr: string;
    chain: string;
    sealedColdDest: Uint8Array;
    ttlMs: number;
    sweepDelegate: string;
  },
): Promise<void> {
  if (!SUIAMI_STEALTH_PKG) {
    throw new Error(
      '[sneasel] SUIAMI_STEALTH_PKG not set — Move upgrade pending. ' +
      'Sneasel Ice Shard landed the entry fns; next is sui move test then publish.',
    );
  }
  tx.moveCall({
    target: `${SUIAMI_STEALTH_PKG}::roster::bind_guest_stealth`,
    arguments: [
      tx.object(args.rosterObj),
      tx.pure.vector('u8', args.parentHash),
      tx.pure.vector('u8', args.labelBytes),
      tx.pure.string(args.hotAddr),
      tx.pure.string(args.chain),
      tx.pure.vector('u8', Array.from(args.sealedColdDest)),
      tx.pure.u64(args.ttlMs),
      tx.pure.address(args.sweepDelegate),
      tx.object('0x6'), // Clock
    ],
  });
}
