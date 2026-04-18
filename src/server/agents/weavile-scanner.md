# Weavile Scanner — architecture spec (Pursuit move, #198)

**Status:** spec-only (no code yet). Razor Claw landed the Move roster
field + meta-address serialization + ENS text record publish. This doc
is the next-agent handoff for the Pursuit move (scanner DO refit).

---

## Responsibilities

1. Watch per-chain "stealth announcement" event sources for every
   recipient with a published `stealth-meta-address`.
2. For each announcement, derive the would-be stealth address using the
   recipient's view pubkey (owner never supplies view priv; we hold it
   with the T3 subpoena trade-off called out in the threat model).
3. Match derived addresses against announcement targets. On hit: record
   the sighting, notify the sweep path (Metal Claw move) with
   `(tweak_s, stealth_addr, view_tag)`.

## Event sources per chain

| Chain | Announcer | Transport |
|---|---|---|
| ETH mainnet | ERC-5564 Announcer `0x55649E01B5Df198D18D95b5cc5051630cfD45564` | Alchemy logs webhook → DO alarm |
| Polygon / Base / Arbitrum | Same ERC-5564 interface, per-chain deployments | Alchemy (Base: Blast/Coinbase) per-chain subs |
| Sui | `suiami::stealth_announcer::announce` event (Quick Attack move) | gRPC subscribeEvent / GraphQL polling |
| Sol | Custom program (Quick Attack move) OR transfer memo (Option B) | Helius webhook / RPC `getSignaturesForAddress` on per-recipient probe |
| BTC | OP_RETURN with `0x5EA` marker + ephemeral pubkey | Electrum-style indexer or Mempool.space zmq |
| Tron | TRC-style Announcer (TBD — port ERC-5564) | TronGrid `getEvents` |

## Derivation (scan loop)

Given announcement `{ ephemeral_pub, view_tag }` and recipient view
priv `v`:

1. `shared = ECDH(v, ephemeral_pub)` on the chain's curve
   (`secp256k1.getSharedSecret` for EVM/BTC/Tron;
   `x25519.getSharedSecret` adapted from ed25519 priv for Sui/Sol).
2. `s = hash(shared)` — HKDF-SHA256 for EVM (per EIP-5564 §Naïve
   implementation), BLAKE2b for Sui, SHA-256 for Sol.
3. `first_byte(s)` must equal `view_tag`; mismatch → discard immediately
   (this is the O(1) filter that makes the scan loop cheap).
4. On match: `stealth_pub = spend_pub + s·G` on target curve.
5. Encode `stealth_pub` → chain-native address (keccak tail for EVM,
   base58check for BTC, blake2b for Sui, base58 for Sol).
6. Emit a `WeavileSighting` record so the sweep agent can enqueue a
   Metal Claw ceremony against `stealth_addr`.

Cost per announcement: 1 hash + 1 compare. Only matches trigger ecMul
+ address encoding. For a mailbox receiving ~10 payments/day inside a
feed of ~10k announcements/day, that's ~10k hashes and 10 ecMuls —
trivial on DO budget.

## DO layout (refit from SneaselWatcherAgent)

SneaselWatcher already handles:
- per-recipient state shard (DO id = hash(recipient_address))
- alarm-driven polling of ETH/Sui RPC
- webhook ingest endpoint for Alchemy/Helius
- Seal session-key bootstrap for cold-dest decrypt

Reuse ~60% (per voter 2's analysis):

- ✅ webhook shape (`POST /webhook/:chain`)
- ✅ alarm schedule + backoff
- ✅ per-recipient DO sharding
- ✅ state.storage persistence idioms
- ✅ Seal client bootstrap (needed later for per-stealth Ice Punch cold
  dest decrypt)

New to build:

- ❌ multi-chain event source dispatcher (refactor the single-chain
  ETH-hardcoded path SneaselWatcher has)
- ❌ curve-generic ECDH/tweak derivation (`scan.ts`) — curve per chain
- ❌ view-priv management: one priv per (recipient, chain). Keyed store,
  rotated on owner-triggered `set_stealth_meta` bump
- ❌ `WeavileSighting` persistence + Metal Claw queue handoff

## Dependency on Icy Wind (per-chain IKA provisioning)

Sweep (Metal Claw) is blocked on Icy Wind: each recipient needs a
spend-key IKA dWallet *per chain* (separate secp256k1 and ed25519
dWallets, same `ika_dwallet_id` umbrella because IKA binds them in one
record). Pursuit-only scanning works without Icy Wind — we just log
sightings. No funds move until Icy Wind + Metal Claw land.

## Rotation

When `set_stealth_meta` is called again on-chain, the roster emits
`StealthMetaSet { addr, chains, updated_ms }`. Scanner picks this up on
its event feed (or at alarm interval) and:

1. Updates the in-DO view pubkeys registry.
2. Requests fresh view privs from the owner's browser session (the
   owner is the only entity that ever had them — the on-chain pubkey
   publish doesn't leak the priv).
3. Archives prior view privs for the back-scan window (90 days default)
   so late-arriving payments to pre-rotation addresses still resolve.

## Open questions for Pursuit author

- Storage: per-chain sharding vs single sharded-by-recipient DO? Lean
  toward recipient-sharded because scans cross-reference multiple
  chains' announcements against the same (v, spend_pub) set.
- Back-scan horizon on bootstrap — 90 days default is a guess; depends
  on ERC-5564 index size and Alchemy trace cost.
- Option A (`suiami::stealth_announcer`) vs Option B (memo field) on
  Sui/Sol: spec Option A because we own the contract and can index
  events cleanly. Memo-field is a nice-to-have so third-party senders
  don't need to know our module.

## Handoff

Next move: **Weavile Quick Attack** lands
`suiami::stealth_announcer` Move module + Solana program. Then
**Weavile Pursuit** consumes this spec to refit SneaselWatcher. The
ECDH/tweak helpers can drop into `src/client/weavile-scan.ts` (browser
re-use for in-browser light scanner per threat-model §Hard deferrals).
