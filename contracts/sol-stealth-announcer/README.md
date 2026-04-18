# sol-stealth-announcer

Solana program — the Solana-side counterpart to
`suiami::stealth_announcer` (Sui) and the EIP-5564 Announcer (ETH
mainnet `0x55649e01…5564`). Currently a **spec**, not shipped code.
Weavile Quick Attack (#198) lands the Sui module + scanner plumbing;
this doc reserves the Solana surface area for the next Weavile move.

## Purpose

Recipients of stealth payments cannot publish a per-recipient index
(that would link stealth addrs back to the meta-address). Instead every
sender broadcasts the tuple

```
(scheme_id, stealth_address, ephemeral_pubkey, view_tag, metadata)
```

via an on-chain log. Scanners watch that log, skip ~255/256 entries by
`view_tag`, then ECDH the remaining entries against their view privkey
to find their own payments. EIP-5564 is the reference; this program
replicates the surface on Solana so a single Weavile Pursuit scanner DO
can treat Solana and Sui announcements interchangeably with ETH ones.

## Program name

`stealth_announcer` — Blueshift/Pinocchio or Anchor. Choice deferred to
the deploy move; Prism Vault (Quasar framework, `wx2Q9nM8n1vamXpYeP7m…`)
is the precedent for Solana-side SKI code, so Quasar is the default.

## Instruction

```
announce(
    ephemeral_pubkey: [u8; N],      // N = 33 secp256k1 | 32 ed25519
    stealth_addr: Pubkey,           // derived stealth address (32 bytes)
    view_tag: u8,
    metadata: Vec<u8>,              // ≤ 1024 bytes
    scheme_id: u8,                  // 0 = secp256k1, 1 = ed25519 sui, 2 = ed25519 sol
)
```

Validation mirrors the Sui module:
- `scheme_id ∈ {0, 1, 2}` — else `InvalidSchemeId`
- `ephemeral_pubkey.len() == 33` for scheme 0, else 32 — else `BadEphemeralPubkey`
- `metadata.len() ≤ 1024` — else `MetadataTooLarge`

No accounts are written. No PDAs, no rent, no authority. Permissionless
— anyone may announce for any stealth address (the view-tag + ECDH
flow prevents false-announcement scans from costing recipients
anything beyond a single tag comparison).

## Observation surface

Two options, pick one at deploy time:

1. **`sol_log_data` / program logs** — emit the announcement as a
   base64-encoded event blob. Cheapest (no account allocation). Scanner
   parses via Helius `logSubscribe` websocket. Matches the
   zero-storage semantics of the Sui event emitter.

2. **Account-data write to a PDA per tx** — `PDA = [b"announcement",
   clock.unix_timestamp, ephemeral_pubkey_first_8]`. Expensive (rent),
   but queryable via `getProgramAccounts` retroactively. Useful only
   if scanners can't commit to 24/7 log streaming.

**Pick 1** — aligns with Sui's event-only model and keeps fees low
enough that senders don't feel the announcement tax.

## Scanner integration

Pursuit DO subscribes via Helius (or any Solana RPC supporting
`logsSubscribe`) filtered to this program id. When the program is
deployed, the id is published in the Weavile docs the same way
`SUIAMI_WEAVILE_PKG` is in `src/client/weavile-meta.ts`. Until then,
the TypeScript helper (`src/client/weavile-announcer-sol.ts`, future)
refuses to build instructions.

## Interop with Sui announcer

Same tuple, same scheme-id registry, same view-tag semantics. A
recipient who registers one `StealthMeta` across eth/sui/sol in the
SUIAMI roster runs a single scanner against three chains and finds
payments wherever they land. Metadata format (inline memo vs Walrus
blob id) is caller-defined and consistent across chains by convention,
not by on-chain enforcement.

## Non-goals

- No sender auth. EIP-5564 is permissionless by design and so is this.
- No on-chain curve validation. Bad ephemeral pubkey = self-DoS (no
  scanner will derive a match) — same posture as the Sui module.
- No retention policy. Logs are Solana's problem; scanners are
  expected to backfill via Helius enhanced history when cold-starting.

## Next move

Ship a Quasar program + a matching `src/client/weavile-announcer-sol.ts`
helper. Fold into Weavile Pursuit DO at the same time so the scanner
subscribes to both chains from day one.
