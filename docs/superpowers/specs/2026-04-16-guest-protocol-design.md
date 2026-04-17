# Guest Protocol — Design

**Date:** 2026-04-16
**Status:** Draft for review
**Pokemon (gitops):** Togepi — new-arrival / joy / fresh-start energy
**Related:**
- `docs/suiami-identity.mdx` (Crowds + subsidized Rumble)
- `contracts/suiami/sources/roster.move` (SUIAMI identity substrate)
- Memory: `project_suilana_ikasystem.md`, `project_rumble.md`

## One-line

Guest Protocol provisions a **leaf SuiNS subname** + a **DKG-gas micro-grant** to any new arrival, so they can claim a name, fund their wallet, Rumble their squids, and land in the SUIAMI roster with zero upfront capital.

## Problem

Today, entering the Suilana Ikasystem requires:
1. A Sui wallet with some SUI (non-zero entry cost)
2. A SuiNS name registration ($10+/yr for 5+ chars, $100-500/yr for shorter)
3. Gas for DKG (~$0.02-0.05 per Rumble)
4. Seal session key signing prompts (wallet friction)

A cold user with zero SUI can't even pay for their first tx. They can't be resolved by SUIAMI (no name, no roster entry). They can't Rumble (no gas). This is the chicken-and-egg that Guest Protocol solves.

## Goal

Turn "I showed up with nothing" into "I have a sub-identity, cross-chain addresses, and a verified SUIAMI record" in under 60 seconds and without the user paying anything.

## Non-goals

- **Not a full SuiNS replacement.** Guest leaves are disposable, parent-owned. Users who want a real transferable name go through the normal SuiNS flow.
- **Not infinite subsidy.** Anti-Sybil controls cap cost per claimant.
- **Not an airdrop.** The micro-grant is only enough to Rumble, not to trade.
- **Not a bypass for KYC/compliance.** Guest accounts are Seal-gated like everyone else and subject to the same CF-edge enrichment.

## Architecture

```
Cold User (no wallet yet)
     │
     │ 1. Visit sui.ski/guest or any /guest/<parent> link
     ▼
┌──────────────────────────────┐
│ Guest panel — sui.ski        │
│                              │
│  - Connect wallet OR mint    │
│    ephemeral zkLogin account │
│  - Pick a label (5+ chars)   │
│  - Submit                    │
└──────────────┬───────────────┘
               │
               │ 2. POST /api/guest/claim
               ▼
┌──────────────────────────────┐
│ Worker — guest-issuer.ts     │
│                              │
│  Rate-limit + Turnstile      │
│  → ultron.sui keeper signs:  │
│    a. SubnameCap mint under  │
│       guest parent           │
│    b. SUI transfer (0.05     │
│       SUI = ~$0.25) to user  │
│    c. SUIAMI roster seed    │
│       with leaf name         │
└──────────────┬───────────────┘
               │
               │ 3. User runs Rumble
               ▼
┌──────────────────────────────┐
│ Browser — Rumble DKG         │
│  Provisions cross-chain      │
│  squids (BTC/ETH/SOL)        │
│  Writes to SUIAMI roster     │
│  Fees paid from the micro-   │
│  grant                       │
└──────────────────────────────┘

Elapsed: ~45-60s end-to-end. Cost to SKI cache: ~$0.30 per guest.
```

## On-chain surface

### New Move module: `suiami::guest`

```move
module suiami::guest;

use suins::subdomain_registration::SubDomainRegistration;
use suins::subname::{Self, SubnameCap};

/// Shared registry tracking guest claims to prevent duplicates per address.
public struct GuestRegistry has key {
    id: UID,
    /// Parent SuiNS names enrolled as guest parents — `portal.sui`,
    /// `splash.sui`, etc. Multiple parents for geographic / crowd routing.
    parents: VecMap<String, GuestParent>,
    /// Address → timestamp of most recent claim. Enforces cooldown.
    last_claim_ms: Table<address, u64>,
    /// Per-address lifetime claim counter. Caps abuse.
    claim_count: Table<address, u32>,
}

public struct GuestParent has store {
    /// The parent name (e.g. "portal").
    name: String,
    /// SubnameCap delegating subname-minting authority. Owned by the
    /// GuestRegistry (not a custodian), so only the `mint_guest`
    /// entry can use it.
    cap: SubnameCap,
    /// Max claims per address per parent (default 1 — one leaf per
    /// crowd).
    max_per_address: u32,
    /// Cooldown between claims from the same address (default 7 days).
    cooldown_ms: u64,
}
```

### Entry: `mint_guest(registry, parent_name, label, recipient, clock, ctx)`

- Caller: anyone (permissionless in principle, rate-gated via Turnstile at the worker tier).
- Effects:
  1. Assert `parent_name` is enrolled in the registry.
  2. Assert `last_claim_ms[recipient] + cooldown_ms < now`.
  3. Assert `claim_count[recipient] < max_per_address`.
  4. Use `GuestParent.cap` to mint a leaf subname `<label>.<parent>.sui` pointing at `recipient`.
  5. Emit `GuestMinted { recipient, full_name, parent, claimed_at }` event.
  6. Bump counters.

Leaf subnames (not node) — cheaper, parent can revoke if abused, no standalone NFT.

### Entry: `revoke_guest(registry, parent_name, label, ctx)`

- Caller: admin (the parent's owner, or a multisig of SKI operators).
- Effect: removes the leaf + decrements the claimant's counter.
- Used if a guest abuses, becomes dormant for >6mo, or the parent is retired.

### Entry: `enroll_parent(registry, parent_nft, ctx)`

- Caller: holder of the parent SuiNS NFT (brando.sui, superteam.sui crowd owners, etc.).
- Effect: extracts a `SubnameCap` from the parent NFT and deposits it in the registry with default cooldown/max params.

## Off-chain surface (Cloudflare Worker)

### Route: `GET /guest`

Renders the Guest Protocol landing. Shows:
- List of enrolled parents (flair per crowd — portal / splash / etc.)
- Label input (5+ chars, live-validated)
- "Claim & Rumble" button

### Route: `POST /api/guest/claim`

Request: `{ parent, label, recipient, turnstileToken }`

Worker steps:
1. Verify Cloudflare Turnstile token.
2. Rate-limit by IP hash (reuse the `cf-context` ipHash): max 3 claims/IP/24h.
3. Verify `label` passes SuiNS validation + is available under `<parent>`.
4. Verify `recipient` address doesn't already have a leaf under `<parent>` (on-chain check via GraphQL).
5. Build an ultron-signed PTB:
   - `suiami::guest::mint_guest(registry, parent, label, recipient, clock, ctx)`
   - `transfer::public_transfer(split_from_gas(0.05 SUI), recipient)` — the micro-grant
   - Optional: `maybeAppendRoster` so SUIAMI roster gets a first-draft entry (cf_history piggyback via the existing `buildWithTx` chokepoint)
6. Sign via `UltronSigningAgent` DO, submit via Helius/gRPC race.
7. Return `{ fullName, digest }`.

### Route: `GET /guest/<parent>`

Direct deep link per parent — `sui.ski/guest/portal` → portal.sui landing, skips the parent picker.

### Worker state

- `GUEST_RATE_LIMIT_KV` — CF KV namespace tracking IP → claim count + timestamp. 24h TTL.
- Reuses existing `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` env vars.
- Reuses `UltronSigningAgent` DO for keeper-signed PTBs.

## Economics

Per guest:
- SubnameCap mint gas: ~0.001 SUI
- Leaf subname registration: 0 (leaves are free to the parent owner)
- Micro-grant: 0.05 SUI (~$0.25 at SUI=$5)
- Worker / Turnstile / KV overhead: negligible

Total cost to SKI cache: **~$0.26 per verified SUIAMI identity**.

ROI path (per existing memory):
- Every Rumble-provisioned user can generate roster write fees, decrypt offerings via Sibyl, inference charges, Satellite spreads
- Break-even is ~3-5 on-chain actions per guest
- Long tail fully covers the subsidy

## Anti-Sybil controls

| Control | Purpose | Tier |
|---|---|---|
| Cloudflare Turnstile | Humanness check pre-tx | worker |
| IP-hash rate limit (3/24h) | Per-device throttle | worker |
| `max_per_address` per parent | Per-wallet cap | on-chain |
| `cooldown_ms` per parent | Temporal throttle | on-chain |
| CF edge enrichment in roster write | Cohort analytics / ASN filtering | future consumer |
| `verified` flag in SUIAMI record | Guests start `verified: false`; flip `true` only after Rumble | existing |

If Sybil pressure materializes, we add Chronicom leaderboard deprioritization for non-residential ASNs (already in the doc).

## Parent enrollment

Initial parents — all already owned:
- **portal.sui** (brando.sui, per memory) — the default gateway crowd
- **splash.sui** (brando.sui) — historical mint-default
- **ignite.sui** (brando.sui) — hackathon/launch energy, might fit Solana Frontier audience
- **crowd.sui** (brando.sui) — literal crowd onboarding

Each parent owner runs `enroll_parent` once to delegate SubnameCap to the registry.

Crowds (encrypt.sui, superteam.sui) stay as the identity-verified subname tiers — they enroll separately in Porygon ZA's crowd namespace, not the Guest registry. Guest Protocol is the on-ramp *to* crowds.

## Integration with existing primitives

- **SUIAMI** — every guest mint triggers a seeded roster entry (`set_identity` with bare name only). Guests can upgrade to full SUIAMI (squid blob + cross-chain addresses) after Rumble.
- **Rumble** — guest's micro-grant covers the DKG gas. The `rumble()` client hook already exists; Guest Protocol just makes sure the gas is there.
- **Prism / Thunder** — guests can receive Prisms and Thunders immediately. Sending requires a bit more gas (roster write fees), covered by user's own top-up or another micro-grant.
- **CF edge enrichment** — the guest-mint PTB flows through `buildWithTx`, which piggybacks `cf_history` attachment. Day-zero enrichment coverage.
- **Porygon ZA (MVR)** — guests can consume MVR resolves, but namespace registration requires owning a root SuiNS (different tier).

## Rollout phases

1. **Phase 1 — mint-only.** Enroll one parent (`portal.sui`). Ship `mint_guest`, worker route, landing page. No micro-grant yet; user brings own gas.
2. **Phase 2 — with micro-grant.** Add SUI transfer to the PTB. Fund ultron's Solana/Sui addresses accordingly. Ship Turnstile gating.
3. **Phase 3 — auto-Rumble.** After the micro-grant lands, the landing page auto-triggers Rumble via the existing client hook. Guest leaves the page fully SUIAMI-verified.
4. **Phase 4 — multi-parent.** Enroll splash/ignite/crowd. Deep-link per parent.
5. **Phase 5 — revocation + churn.** `revoke_guest` for dormant leaves after 6 months. Recycles labels for future claimants.

## Open questions

1. **Do we require zkLogin fallback for users without wallets?** Proposed: yes — integrate existing `src/server/zklogin-proxy.ts`. Users sign in with Google/Apple/Twitch, get a zkLogin account, claim their guest name, receive the micro-grant, and Rumble from that zkLogin account. Maximum zero-to-SUIAMI frictionlessness.
2. **Label allowlist / denylist?** Blocked list for obvious slurs, reserved for brand terms (iusd / sui / solana / ski) — parents can override.
3. **Expiration?** Leaf subnames don't expire on-chain, but Phase 5 revocation gives us a knob. Default: 180-day dormancy threshold.
4. **Multi-crowd claims?** User wants one leaf per crowd they join. `max_per_address` is per-parent, so they can claim `alice.portal.sui` + `alice.splash.sui` + `alice.ignite.sui` by default — one per parent.
5. **Cross-chain micro-grant?** Should the micro-grant also include some SOL if the user will consume Prisms on Solana? Proposed: no for v1; handle via a second Guest-like flow if demand materializes.

## Success criteria

- A cold user (no wallet, no SUI) can land on `sui.ski/guest`, authenticate via zkLogin, pick a label, receive a leaf subname + micro-grant, Rumble their squids, and land in SUIAMI in under 90 seconds.
- Cost per verified identity ≤ $0.50.
- Abuse rate (claims that never Rumble or Rumble once and go dormant) < 40% in the first 30 days.
- Guest Protocol feeds >50% of new SUIAMI roster entries within 90 days of launch.

## Pokemon tracking

- **Togepi** (fairy, egg) — GuestRegistry Move contract + base mint path
- **Togetic** (fairy/flying) — worker `/api/guest/claim` + Turnstile + rate limit + micro-grant
- **Togekiss** (fairy/flying) — landing page + zkLogin fallback + auto-Rumble + Frontier-friendly polish

Moves inside each Pokemon = commits. Evolution (PR merge) per Pokemon.
