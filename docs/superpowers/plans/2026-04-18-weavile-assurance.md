# Weavile Assurance — EIP-4337 Paymaster Integration Design

**Date:** 2026-04-18
**Issue:** #198 (Weavile)
**Arc:** Weavile (stealth addresses) — Assurance sub-arc
**Status:** Design doc. Ship-gate for Weavile public launch.
**Dependencies:**
- `docs/superpowers/plans/2026-04-18-sneasel-weavile-threat-model.md` — T2 threat model
- `src/server/agents/weavile-scanner.ts` — scanner DO (Pursuit move)
- `src/server/agents/weavile-stealth-derive.ts` — pure ECDH derivation
- `src/client/weavile-meta.ts` — `ska:<id>:<chain=hex>|` meta-address format
- `src/server/agents/sneasel-watcher.ts` — sweep DO pattern reference

---

## TL;DR

- Without paymaster-sponsored gas, funding a stealth receive address from any common source re-links the anonymity graph; arxiv 2308.01703 shows 48.5% of Umbra mainnet payments deanonymized this way. Assurance eliminates this vector.
- Per-guest one-shot session tickets issued by the `WeavileAssuranceAgent` DO prevent the paymaster operator from clustering recipients across sweeps on its own books — the session ticket scheme is the core novel piece.
- Assurance covers ETH/EVM via Pimlico verifying paymaster, SOL via Kora fee-payer co-sign, Sui via native sponsored PTB (SponsorAgent), and BTC via Ark vTXO pooling; IKA 2PC-MPC signs the UserOp/tx hash on every chain without any private key landing on Workers.

---

## Section 1 — Paymaster Choice Per Chain

### 1.1 Ethereum / EVM (eth, polygon, base, arbitrum)

**Choice: Pimlico Verifying Paymaster (hosted), self-managed sponsorship policy, daily rotation of signer key.**

The verifying paymaster pattern works as follows: the paymaster contract exposes `validatePaymasterUserOp(userOp, userOpHash, maxCost)`. The paymaster's off-chain signer produces a short-lived ECDSA signature over `(userOpHash, validAfter, validUntil, paymasterAddress)` which is embedded in `paymasterAndData`. The EntryPoint on-chain verifies this signature; if valid, the paymaster's staked ETH deposit covers the UserOp's gas.

**Why Pimlico over Biconomy or Alchemy Gas Manager:**
- Pimlico's verifying paymaster is the lowest-coupling hosted option: the paymaster signer is a key we control, not Pimlico's. Pimlico's infra only provides the bundler and relays the already-signed `paymasterAndData`.
- Alchemy Gas Manager uses Alchemy's signing key — they can cluster by policy ID, which is linkable.
- Biconomy Nexus adds a higher abstraction (session keys, smart accounts) that conflicts with the IKA 2PC-MPC model where the account IS the IKA dWallet.
- Self-hosted paymaster requires running an EntryPoint-staked Ethereum node, which is operationally heavier than acceptable for v1.

**The critical IKA-native constraint:** The paymaster signer key that signs `paymasterAndData` CANNOT be a raw keypair on a Worker. This key must be an IKA dWallet secp256k1 key. The `WeavileAssuranceAgent` DO calls `UltronSigningAgent` to produce the verifying paymaster signature via IKA 2PC-MPC over the EIP-712 digest. This is the same signing pattern used by shade-executor for ETH tx submission.

**Self-hosted vs hosted trade-offs:**

| Dimension | Pimlico hosted bundler | Self-hosted bundler |
|---|---|---|
| Ops burden | Zero — Pimlico runs nodes | High — requires ETH node + mempool access |
| Privacy | Pimlico sees all UserOp hashes | Zero third-party visibility |
| Reliability | Pimlico SLA | Self-managed |
| Linking risk | Pimlico can cluster by API key, not by `paymasterAndData` signer | None |

For v1, the correct choice is Pimlico bundler + IKA-signed verifying paymaster. The `paymasterAndData` signer is IKA-native, so Pimlico cannot link recipients — they see UserOp hashes but not the mapping from stealth addr to identity. Pimlico's API key is a single cohort marker, but cohort-level linking is a T2b threat (much weaker than address clustering). Rotate the Pimlico API key monthly to limit even that exposure.

**Funding model:** The paymaster's EntryPoint deposit must be funded in ETH. Budget assumption: Weavile sweep is a simple transfer — approximately 21,000 gas for ETH, ~65,000 for ERC-20 sweeps. At 30 gwei base + 5 gwei priority = 35 gwei, one sweep costs ~0.00075 ETH (~$3 at $4,000/ETH). Budget $50/month in paymaster ETH reserve to cover early-launch volume (~16 sweeps/day). SUIAMI budget line covers this. Aegislash compliance agent should alert if reserve drops below $20.

**Multi-chain EVM:** polygon, base, arbitrum all use the same verifying paymaster pattern with chain-specific EntryPoint addresses and separate Pimlico endpoints. The `WeavileAssuranceAgent` DO holds per-chain EntryPoint addresses and routes accordingly.

### 1.2 Solana

**Choice: Kora (Solana Foundation fee relayer) or self-hosted Octane.**

Solana's fee sponsorship model is simpler than EIP-4337: every transaction has an explicit `feePayer` field. If `feePayer != signer`, the fee payer co-signs and pays. This is the Kora/Octane pattern.

**Architecture for Weavile SOL sweep:**
1. `WeavileScannerAgent` derives the stealth address for a matched SOL announcement.
2. The DO constructs a Solana transaction that sweeps from `stealthAddr` to the cold destination, with `feePayer = KORA_FEE_PAYER_PUBKEY`.
3. The stealth address's IKA dWallet (ed25519, per spend pubkey from the meta-address) signs the transaction body via IKA 2PC-MPC (the scan DO calls `UltronSigningAgent.signEd25519`).
4. The DO sends the partially-signed transaction to the Kora endpoint for co-sign + broadcast.

**Self-hosted Octane** (github.com/anza-xyz/octane) is the alternative — same pattern, no third party. For v1 Kora hosted is preferred; self-host in v2 if volume or T3 concerns warrant it.

**Funding model:** Kora can be configured to charge in SPL tokens (USDC). Budget: Solana fees are ~5,000 lamports per tx = ~$0.001. Negligible. Even at 100 sweeps/day, $3/month. Kora/Octane fee-payer key holds a small SOL float; Aegislash alerts at < 0.1 SOL.

### 1.3 Sui

**Choice: Native Sui sponsored transactions via `SponsorAgent` DO (already in codebase).**

Sui has first-class protocol-level sponsored transactions. The sponsor signs the `GasData` object in the PTB; the sender (stealth dWallet) signs the transaction body. These are two independent signatures — the sweep tx carries both. No external protocol or third party required.

The `SponsorAgent` DO at `src/server/agents/sponsor.ts` already implements this pattern for Splash registration. Weavile sweep re-uses it: the stealth dWallet's IKA ed25519 user share signs the sweep PTB; `SponsorAgent` provides gas.

**Funding model:** Sui gas is denominated in MIST. A simple object transfer costs ~0.003 SUI. Budget 0.1 SUI/sweep to cover complex PTBs. At $4/SUI, that is $0.40/sweep on worst case. In practice <$0.01 for simple transfers. Float: keep 10 SUI in the sponsor wallet.

### 1.4 Bitcoin

**No EIP-4337 on BTC.** The equivalent privacy primitive for fee-funding a stealth sweep without linking the funder to the recipient is:

**Primary: Ark Protocol vTXO pool (recommended).**

Ark lets users exchange vTXOs (virtual UTXOs) via the ASP (Ark Service Provider) in CoinJoin rounds every ~5 seconds. The sweep proceeds as: the IKA dWallet's secp256k1 spend key redeems the stealth UTXO into an Ark vTXO; the ASP batches this redemption with other users, breaking the direct fee-funding link. The ASP pays the on-chain miner fee from its liquidity pool.

**Fallback: CPFP sweep by a hot-funding UTXO owned by a different IKA dWallet, then CoinJoin.**

If Ark is not available (requires node), a simpler fallback: the sweep transaction is fee-bumped via CPFP by a distinct IKA secp256k1 dWallet (not the same key as any other user). This is weaker than Ark but stronger than direct funding from ultron. A per-sweep fresh IKA DKG session for the CPFP key is ideal but expensive.

**For v1 Weavile Assurance, BTC uses CPFP with a per-sweep dedicated IKA dWallet.** Ark v2 integration is a follow-up arc ("Weavile Blizzard BTC").

**Funding model:** BTC miner fees depend on mempool. Budget ~2,000 sats/sweep for medium priority. At $100k/BTC, that is $2/sweep. High. Buffer 0.001 BTC (~$100) in the CPFP dWallet float. Aegislash alerts below 0.0005 BTC.

---

## Section 2 — Anonymity-Set Hygiene

### 2.1 The Umbra linkability problem (arxiv 2308.01703)

The paper identifies four deanonymization heuristics, the most damaging being H1 (gas funding source) and H2 (common paymaster). H1 is exactly what we are solving: 48.5% of mainnet Umbra recipients are identified because they funded the stealth address gas from a previously-used address. H2 shows that even with a paymaster, if every user uses the same paymaster address in `paymasterAndData`, the paymaster operator can cluster all recipients in its own database.

**H2 mitigation requires per-sweep unlinkable paymaster tickets** — not just a shared API key. This is the session ticket scheme.

### 2.2 Per-guest session ticket scheme

A **session ticket** is a single-use opaque blob that the `WeavileAssuranceAgent` DO issues per pending stealth sweep. It contains:

```
SessionTicket {
  ticketId:      bytes32   // random, server-generated, single-use
  stealthAddr:   bytes     // chain-native, hashed in the DO, not returned to caller
  validAfter:    uint48    // timestamp
  validUntil:    uint48    // validAfter + 15 minutes
  chainId:       uint64
  entryPoint:    address   // EVM only
  nonce:         bytes32   // prevents replay
}
```

The ticket's HMAC is computed with a DO-internal rotating secret (`ASSURANCE_TICKET_SECRET`, a 32-byte value rotated weekly, stored in DO state not in wrangler secrets so rotation is in-app). The ticket is issued to the sweep procedure internally — it is never handed to the client or a third party.

**Issuance location: DO-internal, not client.** The `WeavileAssuranceAgent` DO creates the ticket when it enqueues a sweep, uses it once when calling the paymaster endpoint, then marks it consumed in DO state. The client never sees it.

**How it prevents paymaster clustering:**

The ticket embeds no cross-sweep linkage. The DO issues one ticket per sweep with a fresh `ticketId`. The paymaster endpoint sees `ticketId` as an opaque nonce it must honor (it has no routing value to the paymaster operator). Different sweeps for the same recipient produce completely different `ticketId` values, and the paymaster's `validatePaymasterUserOp` only verifies the ECDSA signature over the UserOp hash — it has no access to `ticketId` unless we include it in `paymasterAndData`. We do NOT include it there.

In other words: the session ticket is purely internal audit state for the DO. It functions as a rate-limiter and replay-prevention guard within the Assurance DO, not as something published to the paymaster. The paymaster linkability protection comes from a different mechanism: the IKA-signed `paymasterAndData` signer key is rotated per calendar week. Within a week, the same signer key appears in all `paymasterAndData` entries — this is unavoidable with a verifying paymaster model. The ticket scheme prevents the *DO itself* from accidentally reusing context across sweeps (a different attack surface).

**For paymaster-operator clustering prevention specifically:** use Pimlico's sponsorship policies to assign each Weavile sweep to a randomly-selected policy ID from a pool of N distinct policy accounts (each pre-funded). The paymaster operator can cluster within a policy ID but not across them. With N=10 policies each representing a different funding source, the operator's cohort resolution degrades to 1/10th confidence. The DO picks the policy ID via `ticketId % N`.

### 2.3 Ticket lifecycle in the DO

```
pendingStealths → enqueueAssuranceSweep → issueTicket → store in AssurancePendingTicket
AssurancePendingTicket.used = false
on sweep attempt: verify ticket not used, not expired, mark used
on sweep success: append to completedSweeps, trim tickets
on sweep failure: ticket is consumed, re-issue a new one (not the same nonce)
```

Tickets expire after 15 minutes. If the sweep hasn't fired within 15 minutes (e.g., DO eviction), the next alarm issues a fresh ticket.

---

## Section 3 — Sweep Path Modification

### 3.1 Current path (without Assurance)

`WeavileScannerAgent.tick()` → detects `pendingStealths` → stub sweep (logs only, Metal Claw TODO). The current TODO in `weavile-scanner.ts:673` says "kick off an IKA sweep ceremony against `stealthAddr`."

When Metal Claw wires the real sweep, it will call `UltronSigningAgent` to produce an IKA 2PC-MPC signature over the chain-appropriate transaction payload, then submit it via a chain-appropriate RPC.

### 3.2 Modified path with Assurance (EVM focus)

The EIP-4337 `UserOperation` has this structure relevant to Weavile:

```
UserOperation {
  sender:              address     // = stealth address (smart account on EVM)
  nonce:               uint256     // from EntryPoint.getNonce(sender)
  initCode:            bytes       // empty (stealth addr is pre-deployed, or deploy + sweep in one)
  callData:            bytes       // encoded sweep call: transfer asset to cold dest
  callGasLimit:        uint256
  verificationGasLimit:uint256
  preVerificationGas:  uint256
  maxFeePerGas:        uint256
  maxPriorityFeePerGas:uint256
  paymasterAndData:    bytes       // [paymaster_addr][IKA-sig][validAfter][validUntil]
  signature:           bytes       // IKA 2PC-MPC over userOpHash (EIP-712)
}
```

**The stealth address must be a smart account** for EIP-4337 — a plain EOA cannot be a 4337 `sender`. This is the key architectural implication. Two options:

**Option A (recommended): Deploy a minimal smart account at the stealth address during sweep.**
Use a `CREATE2` factory to deploy a minimal ERC-4337 account (e.g., a SimpleAccount from the eth-infinitism reference implementation) at the stealth address, funded by the paymaster in the `initCode` path. The IKA dWallet secp256k1 spend key owns the account. The `initCode` is the factory call; the account is deployed and swept in one UserOperation.

**Option B: Pre-deploy smart accounts for all derived stealth addresses.**
Not feasible — stealth addresses are generated on-demand per payment.

Option A requires: (1) a `CREATE2` factory that accepts IKA dWallet pubkey as owner, (2) the account's `validateUserOp` verifying the IKA signature.

**The IKA signature over the UserOp hash:**

The `userOpHash` is `keccak256(abi.encode(userOp.hash(), entryPoint, chainId))` per EIP-4337. This is a 32-byte scalar — exactly what IKA 2PC-MPC's `sign(hash, curve=secp256k1)` takes as input.

**Pattern:**
1. `WeavileAssuranceAgent` assembles the `UserOperation` with all gas fields set.
2. DO computes `userOpHash = entryPoint.getUserOpHash(userOp)` via a static `eth_call` to the EntryPoint contract (read-only, can use any JSON-RPC endpoint).
3. DO issues the sweep by calling `UltronSigningAgent.signForStealth({ dwalletId, hash: userOpHash, curve: 'secp256k1' })` — this triggers IKA 2PC-MPC and returns a 64-byte secp256k1 signature.
4. DO sets `userOp.signature = encodedIKASignature`.
5. DO constructs `paymasterAndData`: `[paymasterAddress][IKAPaymasterSig][validAfter|validUntil]`. The paymaster sig is produced by a SEPARATE IKA dWallet dedicated to paymaster signing (not the spend key). This key lives in `UltronSigningAgent` as `PAYMASTER_SIGNER_DWALLET`.
6. DO calls Pimlico `eth_sendUserOperation` with the fully assembled UserOp.

**The two separate IKA keys:**
- **Spend key** (per-stealth): IKA dWallet provisioned from the meta-address spend pubkey. Signs `userOpHash` to authorize the sweep.
- **Paymaster signer key** (shared, rotated weekly): IKA dWallet secp256k1 that signs `paymasterAndData`. This key's public address is registered in the on-chain verifying paymaster contract. Rotation means calling the paymaster's `setVerifyingSigner` every week with the new IKA dWallet pubkey.

### 3.3 Assembly location

**UserOperation is assembled in the `WeavileAssuranceAgent` DO**, not in the client and not in IKA. The client is never in the sweep path after the initial subscription setup.

The DO cannot use gRPC (CF Workers constraint from CLAUDE.md), so:
- Nonce fetch: `eth_call` to EntryPoint via PublicNode JSON-RPC (`https://eth-rpc.publicnode.com` for ETH)
- `getUserOpHash`: same `eth_call`
- Gas estimation: `eth_estimateUserOperationGas` via Pimlico bundler API
- Submission: `eth_sendUserOperation` via Pimlico bundler API

All are HTTP JSON requests, compatible with CF Workers/DOs.

### 3.4 Jitter + batching interaction

**Jitter is preserved and enhanced, not cancelled.** The existing `SCAN_JITTER_MAX_MS = 30min` in `weavile-scanner.ts:51` stays. With Assurance, we add a second layer of jitter at the paymaster submission step: after the UserOp is assembled, the DO waits an additional random delay of 0–5 minutes before calling Pimlico. This breaks correlation between "announcement detected" and "UserOp submitted" at the block level.

**Batching and the paymaster:** Pimlico's bundler batches multiple UserOps into one `handleOps` call for gas efficiency. This batching is at the bundler level and is invisible to us — we submit one UserOp per sweep; Pimlico decides whether to bundle it with unrelated UserOps. This is safe: bundler batching does not link our UserOps any more than mempool co-presence would.

We must NOT batch multiple stealth sweeps into a single UserOp's `callData` (multi-call) because it would re-create the cross-sweep graph that Ice Fang was designed to break. **One stealth address = one UserOperation, period.**

---

## Section 4 — Threat Model Delta

### Newly defeated by Assurance

**T2 (chain analytics) — gas funding heuristic (H1 in arxiv 2308.01703) is defeated.**
Before Assurance: stealth address first receives ETH from a funding source (ultron or any common wallet) to pay sweep gas. That funding transaction is a direct link. After Assurance: the stealth address's first on-chain interaction is the UserOperation sponsored by the paymaster. The stealth address never receives ETH from a human-controlled wallet; it only ever receives the asset being swept and gas sponsorship from an anonymous paymaster contract.

**T2 — common-input clustering via shared gas wallet is defeated.**
Before Assurance: if two different stealth addresses (for two different Weavile recipients) both received ETH from the same gas wallet, Arkham would immediately cluster them. After Assurance: they both route through the EntryPoint, which co-bundles with thousands of unrelated UserOps globally. No common input.

**T2 — CPFP/fee-bump funding leak on BTC is partially defeated.**
Per-sweep IKA dWallet for CPFP key means no two sweeps share a funding UTXO. The CPFP key itself is not linked to the identity.

### Still not defeated

**T2 — shared paymaster contract as cohort marker (H2).** All Weavile sweeps appear in the paymaster contract's event log with the same `paymasterAndData` address prefix. Arkham can identify "this address was swept using the SKI Weavile paymaster" and form a cohort. This is a weaker linkage than the funding heuristic — it reveals "this address is probably a Weavile stealth address" but not "which identity owns it." The N-policy mitigation (§2.2) dilutes this further but does not eliminate it. Full elimination would require mixing with a public shared paymaster (e.g., Pimlico's own ERC-20 paymaster) where thousands of other users appear — accepted as v2 work.

**T2 — timing correlation at block level.** Even with 30-min jitter, a patient chain analyst who correlates announcement timestamp with sweep timestamp across many stealth payments can narrow the window. The 30-min jitter beats naive correlation but not statistical clustering over many payments.

**T3 (server subpoena) — unchanged.** The `WeavileAssuranceAgent` DO stores the mapping between stealth address and session ticket (short-lived). The `WeavileScannerAgent` DO stores view keys. CF subpoena retrieves these. This is the accepted T3 trade-off documented in the threat model.

**T4 — spend-share + IKA network compromise — unchanged.** IKA network remains 2-of-3 threshold.

**T5 — forced disclosure — unchanged.** View key + spend share forced disclosure path unchanged.

### Updated ship-gate language for threat-model.md

The following line in the Weavile conditions section:

`- ☐ **Assurance** — 4337 paymaster in sweep path, batched + randomized timing`

Should be updated to:

`- ☐ **Assurance** — per-chain paymaster sponsors stealth sweep gas (ETH/EVM: Pimlico verifying paymaster + IKA-signed paymasterAndData; SOL: Kora co-sign; Sui: SponsorAgent PTB; BTC: per-sweep CPFP dWallet); H1 gas-funding heuristic defeated; H2 paymaster cohort linkage partially mitigated via N-policy rotation.`

---

## Section 5 — File Plan

### Files to CREATE

**`src/server/agents/weavile-assurance.ts`**
New Durable Object: `WeavileAssuranceAgent`. Core of Assurance. Manages session tickets, assembles UserOperations for EVM sweeps, routes to Kora for SOL and SponsorAgent for Sui, and calls UltronSigningAgent for all IKA signing. One DO instance per recipient (same sharding key as `WeavileScannerAgent`). Contains `AssurancePendingTicket`, `AssuranceCompletedSweep` state shapes, and the `_issueTicket / _consumeTicket` internal lifecycle.

**`src/server/agents/weavile-assurance-evm.ts`**
Pure EVM UserOperation assembly helpers: `buildUserOp`, `estimateUserOpGas`, `signPaymasterData`, `submitUserOp`. No DO state, no IKA calls — these are pure-ish async functions that take explicit parameters (entryPoint addr, nonce, chainId, callData, pimlico API key). Extracted to a separate file so they can be unit-tested without a DO mock. Depends on `fetch` only (HTTP JSON-RPC).

**`src/server/agents/weavile-assurance-sol.ts`**
Solana co-sign path: `buildSolSweepTx`, `submitViakora`. Takes the partially-IKA-signed Solana transaction (SOL sweep from stealth addr to cold dest) and co-signs + submits via Kora. Pure async, no DO state.

**`src/server/agents/weavile-assurance-btc.ts`**
BTC CPFP path: `buildBtcCpfpSweep`. Constructs the CPFP spend from the per-sweep dedicated IKA dWallet. Stub in pt1, wired in pt2.

**`src/server/agents/__tests__/weavile-assurance.test.ts`**
Unit tests: ticket issuance, ticket replay rejection, ticket expiry, EVM UserOp assembly (mock Pimlico), session ticket pool rotation (N-policy), SOL co-sign path mock.

**`src/server/agents/__tests__/weavile-assurance-evm.test.ts`**
Pure unit tests for `buildUserOp`, `signPaymasterData` determinism, `estimateUserOpGas` mock, `submitUserOp` error handling.

### Files to MODIFY

**`src/server/agents/weavile-scanner.ts`**
Modify `tick()` sweep stub (line 673 TODO comment): instead of logging and returning, call `WeavileAssuranceAgent.enqueueSweep(pendingStealth)` via DO binding. Add `WEAVILE_ASSURANCE` to the `Env` interface as a `DurableObjectNamespace`. The scanner's job ends at detection + enqueueing; Assurance handles execution.

**`wrangler.jsonc`**
Add `WeavileAssuranceAgent` to `durable_objects.bindings` and `migrations` (v14: `new_sqlite_classes: ["WeavileAssuranceAgent"]`).

**`src/server/agents/ultron-signing-agent.ts`**
Add `signForStealth({ dwalletId, hash: Uint8Array, curve: 'secp256k1' | 'ed25519' }): Promise<{ sig: Uint8Array }>` callable. This is the IKA 2PC-MPC signing entry point for arbitrary 32-byte hashes (UserOp hash for EVM, tx body hash for SOL/Sui). Reuses the existing IKA ceremony machinery. The paymaster signer dWallet spec is added here as `PAYMASTER_SIGNER_DWALLET`.

**`docs/superpowers/plans/2026-04-18-sneasel-weavile-threat-model.md`**
Update Weavile ship-gate checkbox for Assurance with the expanded language from §4.

**`src/server/index.ts`**
Bind `WeavileAssuranceAgent` in the Worker's DO routing logic (same pattern as `SneaselWatcherAgent` and `WeavileScannerAgent` bindings).

### Files NOT modified (per feedback_no_subagent_ui_changes)

- Any file in `src/ui.ts` — UI copy for Weavile "private" language is a separate brando-owned move.
- `src/client/weavile-meta.ts` — meta-address format is stable.
- `src/server/agents/weavile-stealth-derive.ts` — pure math, no changes needed.

---

## Section 6 — Data Flow

### EVM stealth sweep end-to-end with Assurance

```
WeavileScannerAgent.tick()
  → match found: PendingStealth { chain='eth', stealthAddr, tweakHex, recipientSuiAddr }
  → call WeavileAssuranceAgent.enqueueSweep(pendingStealth)

WeavileAssuranceAgent.enqueueSweep()
  → store as AssurancePendingTicket { ticketId=random32, stealthAddr, chain, issuedAtMs, used=false }
  → schedule alarm

WeavileAssuranceAgent._runAssuranceAlarm()
  → for each unused, unexpired AssurancePendingTicket:
    1. fetch cold destination via Seal decrypt (same path as SneaselWatcher Blizzard move)
    2. build callData: encode(transfer(coldDest, fullBalance)) for EVM
    3. fetch nonce: eth_call → EntryPoint.getNonce(stealthAddr)
    4. call weavile-assurance-evm.buildUserOp(stealthAddr, callData, nonce, chainId)
    5. compute userOpHash: eth_call → EntryPoint.getUserOpHash(userOp)
    6. call UltronSigningAgent.signForStealth({ dwalletId: stealthDwallet, hash: userOpHash, curve: 'secp256k1' })
       → IKA 2PC-MPC → returns sig (64 bytes)
    7. set userOp.signature = encodeSignature(sig)
    8. pick policyId = ticketId[0] % N
    9. call UltronSigningAgent.signForStealth({ dwalletId: PAYMASTER_SIGNER_DWALLET, hash: paymasterDataHash, ... })
       → returns paymaster sig
    10. set userOp.paymasterAndData = [paymasterAddr][paymasterSig][validAfter][validUntil]
    11. call weavile-assurance-evm.submitUserOp(userOp, PIMLICO_BUNDLER_URL[policyId])
        → POST eth_sendUserOperation → returns userOpHash
    12. mark ticket used
    13. append CompletedSweep { stealthAddrShort, digest: userOpHash, executedAtMs }
    14. update WeavileScannerAgent state: move from pendingStealths to completedSweeps
```

### Jitter placement

Two independent jitter windows:
- Window 1 (already in WeavileScannerAgent): 30s–30min from announcement detection to enqueue. Defeats announcement-to-sweep timing correlation at block resolution.
- Window 2 (new in WeavileAssuranceAgent): 0–5min from enqueue to UserOp submission. Defeats DO-alarm-cadence correlation.

---

## Section 7 — Build Sequence

### Weavile Assurance pt1 — Foundation (landable moves 1–5)

- [ ] **Move 1: UltronSigningAgent `signForStealth` callable.** Add the generic 32-byte hash signing entry point. Add `PAYMASTER_SIGNER_DWALLET` spec (requires a fresh DKG ceremony — "Rumble the paymaster squid" — before this can be wired end-to-end). Unit test mocks IKA and verifies callable contract shape.
- [ ] **Move 2: `weavile-assurance-evm.ts` pure helpers.** `buildUserOp`, `estimateUserOpGas`, `signPaymasterData`, `submitUserOp`. No DO dep. Full unit tests with mocked Pimlico responses.
- [ ] **Move 3: `WeavileAssuranceAgent` DO scaffold.** State shape: `pendingTickets`, `completedSweeps`. `enqueueSweep` callable (writes ticket, schedules alarm). `_runAssuranceAlarm` stub (just drains expired tickets, logs). `poke`/`status` callables. Tests: ticket issuance, expiry, replay rejection.
- [ ] **Move 4: wrangler.jsonc + index.ts wiring.** Add `WeavileAssuranceAgent` DO binding (v14 migration). Wire route in `src/server/index.ts`. Deploy.
- [ ] **Move 5: WeavileScannerAgent sweep handoff.** Modify `tick()` stub to call `WeavileAssuranceAgent.enqueueSweep` via DO binding. Integration test: scanner enqueues → assurance ticket appears.

### Weavile Assurance pt2 — EVM Live Sweep (moves 6–9)

- [ ] **Move 6: Paymaster squid DKG.** Rumble `PAYMASTER_SIGNER_DWALLET` (secp256k1) via brando's browser + IKA DKG. Record dwalletId + encryptedShareId. Deploy the on-chain verifying paymaster contract (or configure Pimlico's) with the new pubkey as signer. Store constant in `ultron-signing-agent.ts`.
- [ ] **Move 7: `_runAssuranceAlarm` EVM live path.** Wire the full 14-step flow from §6. Seal decrypt for cold dest. `eth_call` for nonce + userOpHash. Full IKA signing for both spend key and paymaster signer. Pimlico submission. N=5 policy pool rotation.
- [ ] **Move 8: EVM smoke test.** Manual: fund a test stealth address on Sepolia with 0.001 ETH. Confirm UserOp appears in Pimlico's dashboard. Confirm sweep lands at cold dest. Confirm stealth address never received ETH from any EOA.
- [ ] **Move 9: Update threat-model.md Assurance checkbox to ☑ for EVM.** Note SOL/Sui/BTC checkboxes remain open.

### Weavile Assurance pt3 — Multi-chain (moves 10–13)

- [ ] **Move 10: SOL sweep via Kora.** Wire `weavile-assurance-sol.ts`. Kora fee-payer endpoint. IKA ed25519 signing for the tx body. Test on devnet.
- [ ] **Move 11: Sui sweep via SponsorAgent.** Wire `SponsorAgent` as gas sponsor for stealth dWallet PTBs. IKA ed25519 signing for the PTB. Test on testnet.
- [ ] **Move 12: BTC CPFP sweep.** Wire `weavile-assurance-btc.ts`. Per-sweep IKA secp256k1 DKG for CPFP key. Test on signet.
- [ ] **Move 13: Full threat-model.md Assurance ☑.** All four chains confirmed. Update ship-gate language per §4.

Total estimated move count: **13 moves** across 3 pts.

---

## Section 8 — Testing Strategy

### Unit-testable (bun:test, no network)

- `weavile-assurance-evm.ts`: `buildUserOp` shape, `signPaymasterData` determinism, `estimateUserOpGas` error cases, `submitUserOp` error handling.
- `WeavileAssuranceAgent._issueTicket`: produces unique `ticketId` per call.
- `WeavileAssuranceAgent._consumeTicket`: rejects used ticket, rejects expired ticket, accepts valid ticket.
- N-policy selection: `ticketId[0] % N` determinism.
- `SneaselWatcher → WeavileAssuranceAgent` enqueue integration: scanner mock calls `enqueueSweep`, ticket appears in state.

### Local Anvil/local-validator fork required

- EVM UserOp assembly against a local EntryPoint fork: `eth_call` to `getNonce` + `getUserOpHash`, verify computed hash matches on-chain.
- Verifying paymaster `validatePaymasterUserOp` execution: confirm IKA-signed `paymasterAndData` is accepted by the on-chain contract.
- Smart account deployment via `CREATE2` initCode: confirm account deploys at derived stealth address.

### Mainnet smoke

- SOL: fund test stealth addr on mainnet with 0.01 SOL. Confirm Kora co-signs and sweeps without recipient addr ever appearing as a funder.
- ETH: fund test stealth addr on Sepolia with 0.001 ETH. Confirm Pimlico executes UserOp. Confirm no EOA-funded ETH at stealth addr in Etherscan history.
- BTC: test on signet only (CPFP cost too high for mainnet smoke).
- Sui: test on testnet (SponsorAgent already proven on mainnet for Splash).

---

## Open Questions (Brando's call)

1. **Smart account standard for EVM stealth addresses.** Which minimal account do we deploy at stealth addrs? (a) eth-infinitism `SimpleAccount` — battle-tested, larger bytecode, known audits; (b) bespoke minimal proxy — smaller, cheaper, unaudited. Recommendation: (a) for safety; brando may prefer (b) to minimize on-chain fingerprint.

2. **Paymaster squid DKG timing.** Move 6 requires a fresh rumble for `PAYMASTER_SIGNER_DWALLET` — brando's browser action, not automatable. When can this happen? Hard dependency gating pt2.

3. **Pimlico API key scope.** N=5 vs N=10 policies. More policies = weaker operator clustering, higher management burden. N separate Pimlico accounts vs N separate policies within one account?

4. **Kora vs self-hosted Octane for SOL.** Kora hosted = easier for v1. If volume becomes meaningful (>50/day), evaluate Octane self-host for T3.

5. **BTC v1 vs Ark v1.** Ark requires ASP access. If self-hosting needed, CPFP-only in pt1 and Ark integration becomes "Weavile Blizzard BTC" follow-up.

6. **View key rotation policy for T3 mitigation.** Assurance doesn't change the view key model. Should Assurance include `rotateViewKey` on `WeavileScannerAgent`, or is that a separate "Weavile Ice Punch" arc item?

---

## References

- EIP-4337 — Account Abstraction Using Alt Mempool
- EIP-5564 — Stealth Addresses
- arxiv 2308.01703 — Anonymity Analysis of the Umbra Stealth Address Scheme on Ethereum
- Pimlico Verifying Paymaster — https://docs.pimlico.io/infra/paymaster/verifying-paymaster/faqs
- Kora (Solana fee relayer) — https://www.quicknode.com/guides/solana-development/transactions/kora
- Octane (self-hosted Solana relayer) — https://github.com/anza-xyz/octane
- Sui Sponsored Transactions — https://docs.sui.io/concepts/transactions/sponsored-transactions
- Ark Protocol — https://ark-protocol.org/
- `docs/superpowers/plans/2026-04-18-sneasel-weavile-threat-model.md`
- `docs/superpowers/plans/2026-04-18-sneasel-ice-fang.md`
