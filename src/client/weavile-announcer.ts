/**
 * Weavile Quick Attack (#198) — stealth_announcer PTB helper.
 *
 * Sui-native analog of the EIP-5564 Announcer event
 * (`0x55649e01…5564` on ETH mainnet). Posts a `StealthAnnouncement`
 * event so scanner DOs (Weavile Pursuit, not-yet-built) can find
 * stealth payments without a per-recipient index.
 *
 * Scheme ids:
 *   0 = secp256k1 eth-compat  (33-byte compressed ephemeral pubkey)
 *   1 = ed25519 sui-native    (32-byte ephemeral pubkey)
 *   2 = ed25519 sol-native    (32-byte ephemeral pubkey)
 *
 * Metadata cap: 1024 bytes (inline memo or Walrus blob pointer —
 * don't try to ship attachments inline).
 *
 * Package id: reuses `SUIAMI_WEAVILE_PKG` from `weavile-meta.ts`.
 * Module upgrade lands `stealth_announcer::announce` in the same
 * package bump as Razor Claw's `set_stealth_meta`; both helpers are
 * therefore gated on the same const.
 */

import type { Transaction as TxType } from '@mysten/sui/transactions';
import { SUIAMI_WEAVILE_PKG } from './weavile-meta';

export type StealthSchemeId = 0 | 1 | 2;

export const SCHEME_SECP256K1: StealthSchemeId = 0;
export const SCHEME_SUI_ED25519: StealthSchemeId = 1;
export const SCHEME_SOL_ED25519: StealthSchemeId = 2;

export const MAX_METADATA_LEN = 1024;

function fromHex(hex: string): Uint8Array {
  const s = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) {
    throw new Error(`[weavile-announcer] odd-length hex "${hex.slice(0, 20)}…"`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export interface AnnounceArgs {
  /** Sender's one-shot ephemeral pubkey. 32 bytes (ed25519) or 33 bytes
   *  (secp256k1 compressed). Accepts hex string (with or without 0x) or
   *  raw bytes. */
  ephemeralPubkey: Uint8Array | string;
  /** Derived stealth Sui address. 0x-prefixed 32-byte hex (the moveCall
   *  layer serializes via `tx.pure.address`). */
  stealthAddr: string;
  /** 1-byte view-tag hint. Scanner skips ~255/256 announcements on
   *  mismatch before attempting ECDH. 0-255 inclusive. */
  viewTag: number;
  /** Optional inline payload (encrypted memo, Walrus blob id, etc.).
   *  Capped at 1024 bytes on-chain. */
  metadata?: Uint8Array | string;
  /** 0 / 1 / 2. See scheme constants. */
  schemeId: StealthSchemeId;
}

/**
 * Append `stealth_announcer::announce` to the caller's PTB.
 *
 * Refuses to build until `SUIAMI_WEAVILE_PKG` is set. Package is live
 * at `0xf4910af0747d53df5e0900c10b1f362407564e717fdee321c2777d535e915c77`,
 * so the null-gate is satisfied today — the throw remains for future
 * rollbacks or unit-test environments that clear the const.
 *
 * Validates locally before building so bad inputs surface as browser
 * errors rather than on-chain aborts with opaque codes:
 *   - scheme_id ∈ {0,1,2}
 *   - view_tag ∈ [0,255]
 *   - ephemeral_pubkey length matches scheme
 *   - metadata ≤ 1024 bytes
 */
export function buildAnnounceTx(tx: TxType, args: AnnounceArgs): void {
  if (!SUIAMI_WEAVILE_PKG) {
    throw new Error(
      '[weavile-announcer] SUIAMI_WEAVILE_PKG not set — stealth_announcer ' +
      'not yet published. Deploy the weavile upgrade first.',
    );
  }

  if (args.schemeId !== 0 && args.schemeId !== 1 && args.schemeId !== 2) {
    throw new Error(`[weavile-announcer] invalid schemeId ${args.schemeId} (expected 0|1|2)`);
  }

  if (!Number.isInteger(args.viewTag) || args.viewTag < 0 || args.viewTag > 255) {
    throw new Error(`[weavile-announcer] viewTag must be integer 0-255, got ${args.viewTag}`);
  }

  const pkBytes = typeof args.ephemeralPubkey === 'string'
    ? fromHex(args.ephemeralPubkey)
    : args.ephemeralPubkey;

  const expectedLen = args.schemeId === SCHEME_SECP256K1 ? 33 : 32;
  if (pkBytes.length !== expectedLen) {
    throw new Error(
      `[weavile-announcer] ephemeralPubkey length ${pkBytes.length} ` +
      `!= expected ${expectedLen} for schemeId ${args.schemeId}`,
    );
  }

  const metaBytes = !args.metadata
    ? new Uint8Array(0)
    : typeof args.metadata === 'string'
      ? fromHex(args.metadata)
      : args.metadata;

  if (metaBytes.length > MAX_METADATA_LEN) {
    throw new Error(
      `[weavile-announcer] metadata ${metaBytes.length} bytes > cap ${MAX_METADATA_LEN}`,
    );
  }

  tx.moveCall({
    target: `${SUIAMI_WEAVILE_PKG}::stealth_announcer::announce`,
    arguments: [
      tx.pure.vector('u8', Array.from(pkBytes)),
      tx.pure.address(args.stealthAddr),
      tx.pure.u8(args.viewTag),
      tx.pure.vector('u8', Array.from(metaBytes)),
      tx.pure.u8(args.schemeId),
      tx.object('0x6'), // Clock
    ],
  });
}

/** Parsed `StealthAnnouncement` event shape (as decoded from the Sui
 *  events API — field names match the Move struct). Exported so
 *  scanner code can type event payloads without redeclaring. */
export interface StealthAnnouncementEvent {
  announcer: string;        // 0x-address
  ephemeral_pubkey: number[] | string; // bcs-decoded bytes (array) or hex
  stealth_addr: string;     // 0x-address
  view_tag: number;         // u8
  metadata: number[] | string;
  scheme_id: number;        // u8
  announced_ms: string;     // u64 decoded to string
}
