# Plan — pivot ENS subname joins from `waap.eth` → `whelm.eth`

**Date:** 2026-04-17 · **Issue:** #167 Beldum arc · **Status:** Active (adopted mid-session by brando)

## Why pivot

Original Beldum scope (#167) used `waap.eth` as the parent for subname joins. That gated everything on running `whelm('waap')` in Phantom — a user action that was the last red blocker in the Metang-arc handoff.

`whelm.eth` is already whelmed into an IKA-native dWallet (it was the *first* use of the whelm vocab — see `feedback_whelm_vocab.md`). Moving the parent to `whelm.eth` deletes the blocker entirely. Zen Headbutt can deploy today.

Bonus: the name itself is thematic — "whelm.eth" as the engulfing parent that the IKA dWallet oversees. Matches the water/electricity vocabulary already in play.

## What changes semantically

| Before | After |
|---|---|
| `alice.waap.eth` resolves to IKA-derived BTC/ETH/SOL via CCIP-read | `alice.whelm.eth` resolves the same way |
| Parent ENS node: `namehash('waap.eth')` | Parent ENS node: `namehash('whelm.eth')` |
| OffchainResolver gated on ultron + hot signer | Same — parent swap, not auth swap |
| SuiNS twin: `alice.waap.sui` | SuiNS twin: `alice.whelm.sui` (or keep waap.sui if user prefers) |
| L1 registrar: `ENS.setResolver(namehash(waap.eth), gatewayAddr)` after whelm | `ENS.setResolver(namehash(whelm.eth), gatewayAddr)` — signable TODAY via brando/dWallet flow |

## Multi-parent support (optional)

The CCIP-read gateway can accept subnames under EITHER parent. Implementation: change `WAAP_ETH_LABEL` from a string constant to a small `ACCEPTED_PARENTS` set and check membership. That way:
- Whelm-first rollout: set resolver on `whelm.eth`, serve `*.whelm.eth`.
- Later, once user runs `whelm('waap')` and deploys resolver there too, `*.waap.eth` lights up without a code change.

## Moves (Metang arc continues until Metagross gate)

- [ ] **Metang Rollout** — gateway accepts `*.whelm.eth` subnames (multi-parent aware); existing `*.waap.eth` handling stays as a fallback
- [ ] **Metang Brick Break** — ENS L1 tx: set resolver for `whelm.eth` → existing OffchainResolver contract (signed from the whelm.eth dWallet; ~$2 L1 gas)
- [ ] **Metang Headbutt** — first end-to-end test: mint `superteam.whelm.eth`, bind to existing SUIAMI roster entry, resolve via Brave/ensideas
- [ ] **Metang Heal Block** — client UI: "Register ENS join" button next to existing SuiNS flow; defaults parent to `whelm.eth`
- [ ] **Metagross** — evolution gate: at least one live paid-app (Brave/PayPal) sends ETH successfully to `*.whelm.eth`

## What stays untouched

- OffchainResolver.sol contract (already deployed, no redeploy — just bind via ENS Registry)
- SUIAMI roster types (no schema change — `ens_name` field already generic)
- Seal v3 policy (accepts either name_hash or ens_hash, v6 package already live)
- ENS signer rotation (Smeargle already shipped fresh key `0xe7AC32Bf…0a11`)

## Blockers removed

- ~~`whelm('waap')` in Phantom~~ → n/a with whelm.eth as parent
- ~~Zen Headbutt redeploy budget~~ → existing resolver gets re-bound, not redeployed

## Blockers remaining

- **whelm.eth L1 resolver setup** — user signs `ENS.setResolver(namehash(whelm.eth), gatewayAddr)` via Phantom/IKA dWallet flow. Should take <1 min; spec'd in Brick Break move.
- **Gateway code update** — multi-parent awareness. Metang Rollout move (server edit).

## Decision

Adopted 2026-04-17 mid-session. User directive: "we're likely going to start the ens joins under whelm.eth right? go ahead with the next stuff."

This doc is authoritative over #167 body. #167 body will get a comment linking here.
