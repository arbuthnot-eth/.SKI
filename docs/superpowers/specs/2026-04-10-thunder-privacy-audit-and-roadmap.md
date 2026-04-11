# Thunder Privacy Audit & Metadata Roadmap

**Date:** 2026-04-10
**Branch at time of writing:** `feat/thunder-messaging-stack`
**Deployed version:** dotski `12700790-4a3b-4c51-9378-8f94a14d6017`
**Author context:** follow-up after an audit comparing our implementation against `github.com/MystenLabs/sui-stack-messaging`. The audit concluded that our crypto was at parity with upstream, that we had two active plaintext leaks in the client, and that metadata privacy was unchanged from upstream. The leaks have been fixed and deployed; the metadata work has not been started. This spec exists so the next session can pick up cleanly.

---

## 1. What Thunder actually is today

Thunder is a thin wrapper around `@mysten/sui-stack-messaging` with our own relayer backend. The source of truth is `src/client/thunder-stack.ts`.

- **Encryption:** Seal 2-of-3 threshold DEK + AES-GCM envelope. Identical to upstream.
- **Key servers:** Overclock, Studio Mirai, H2O Nodes (mainnet, open/free mode). NodeInfra excluded due to broken CORS (duplicate `Access-Control-Allow-Origin` header).
- **Relayer:** `TimestreamAgent` Cloudflare Durable Object, one instance per `groupId`. Speaks HTTP to `/api/timestream/:groupId/*`. Replaces Mysten's reference HTTP relayer.
- **On-chain anchor:** `PermissionedGroup<Messaging>` from the upstream Move package, stored as a shared object. Used only for key-version history and membership, not for message storage.
- **Identity:** SuiNS names (`alice.sui`) resolved via `SuinsClient.getNameRecord` → target address or NFT owner.
- **Session keys:** Cached in the SDK, seeded by a personal-message signature through `DappKitSigner`. Default 30-minute TTL.
- **Global SUIAMI Storm:** `0xfe23aad02ff15935b09249b4c5369bcd85f02ce157f54f94a3e7cc6dfa10a6e8`, UUID `suiami-global`. Public identity directory. By design, joining is a public act.

**Stripped on 2026-04-10:** `contracts/storm/sources/storm.move` and `docs/thunder-hybrid.md` previously described a **different, not-yet-wired architecture** (ECDH-derived storm IDs, on-chain Signal struct, purge/strike/sweep, economic fees). That architecture was deployed to mainnet as package `0xa3ed4fdf1369313647efcef77fd577aa4b77b50c62e5c5e29d4c383390cdf942` but never wired into the client. The source tree was removed in this session to prevent the next developer from accidentally reviving it as "the current direction." The on-chain package still exists but is unused and unreferenced from `src/`. Do not resurrect the hybrid/ECDH architecture without an explicit product decision — the live Thunder path is the upstream SDK with a custom relayer, and that is the direction to build on.

---

## 2. The three fixes that shipped on 2026-04-10

All three are in `src/client/thunder-stack.ts` on the deployed `feat/thunder-messaging-stack` branch.

### 2.1 Plaintext fallback removed

**Before:** the main `sendThunder` encrypt path had a `try { encrypt() } catch { encryptedText = msgBytes }` branch. If Seal encryption failed for any reason — the most common being "Storm just created in the same PTB, key version not yet queryable" — the code silently sent raw plaintext, labeled it as `encryptedText`, and stamped `keyVersion: '0'`. The TimestreamAgent DO stored cleartext indistinguishable from real ciphertext.

**After:** the fallback branch is gone. The encrypt call now goes through a new helper:

```ts
async function encryptWithRetry(
  groupId: string,
  data: Uint8Array,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: bigint }> {
  const client = getThunderClient();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await client.messaging.encryption.encrypt({ uuid: groupId, data });
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`Thunder encrypt failed after 5 attempts: ${String(lastErr)}`);
}
```

5×500ms retries absorb the "fresh Storm" race. If every attempt fails, the send itself fails. Cleartext never reaches the DO.

### 2.2 Transfer notes encrypted

**Before:** when a Thunder included a coin transfer, the client posted a human-readable `"$X sent"` note to the DO as `btoa(TextEncoder().encode(note))` with `keyVersion: '0'`. Anyone reading the DO saw amounts in the clear.

**After:** the transfer-note path also calls `encryptWithRetry(groupId, noteBytes)` and sends the real envelope. Same retry guarantees. Failed encrypt on the note now throws instead of leaking. Acceptable tradeoff: a rare failed transfer-note write is better than a consistent amount leak.

### 2.3 Seal key-server verification enabled

**Before:** `createSuiStackMessagingClient(..., { seal: { serverConfigs, verifyKeyServers: false } })`. The SDK skipped attestation of the three key servers.

**After:** `verifyKeyServers: true`. The Seal SDK now fetches the on-chain KeyServer objects on first `encrypt()` and verifies their signatures against the pinned object IDs. If any of the three IDs is stale, the first call will throw — fail-closed, which is correct. The three IDs were **not** independently re-verified against `https://seal-docs.wal.app/UsingSeal` in this session; if runtime verification errors appear, confirm the IDs there and update `SEAL_SERVERS` at `src/client/thunder-stack.ts:35-39`.

### 2.4 Cosmetic cleanup

The comment above `SEAL_SERVERS` previously said "Overclock, NodeInfra, Studio Mirai" but the code had H2O Nodes as the third entry (NodeInfra was removed for the CORS issue). Comment and three memory files (`MEMORY.md`, `project_thunder.md`, `project_suiami_reciprocal.md`) now agree with the code.

---

## 3. What "private and innovative E2EE" does NOT mean today

The original audit question was whether our Thunder implementation is more private and more innovative than upstream `sui-stack-messaging`. The honest answer after the fixes:

**Content confidentiality:** at parity with upstream. As strong as Seal 2-of-3 threshold + AES-GCM allows. No client-side plaintext side-channels remain (post-fixes).

**Metadata privacy:** at parity with upstream. Which is to say, **weak**. The following are all visible to the TimestreamAgent DO operator (us) and to anyone with read access to the DO's storage:

- `senderAddress` — every message sent carries it in the POST body.
- `groupId` — the conversation identifier. For 1:1 conversations this is deterministic from the participant pair (via `derive.resolveGroupRef`).
- Message `order`, `createdAt`, `updatedAt` timestamps, and total count.
- Delivery patterns: who sends how much, how often, at what time of day, burstiness, inter-message intervals.
- Participant membership: the DO's `add-participant` endpoint stores the list of addresses in the group.

Crucially, a passive observer of the DO's storage can reconstruct the entire social graph of Thunder users, even though they cannot read a single message body. That is the exact threat model Signal/Session/SimpleX spend most of their engineering effort defeating, and we do essentially none of it.

**Innovation:** at parity with upstream on the E2EE primitive itself. Our novelties live one layer up:

- SuiNS-as-identity, single-PTB first-contact (Storm create + transfer + SUIAMI roster in one sig).
- Cloudflare DO relayer colocated with the rest of the Thunderstorm stack.
- Planned on-chain Storm contract with purge/strike economics and iUSD mint-on-read (`docs/thunder-hybrid.md`, not wired).
- Planned IKA dWallet cross-chain extension via Storm (`project_storm.md`, not wired).

None of those are cryptographic innovations. They are UX and economic wrappers around a standard Seal envelope.

**Trust model gotchas to state out loud:**

- 2 of 3 colluding Seal key servers can decrypt everything. That's the threshold floor we picked.
- Session keys cached in the browser are bearer credentials. Anyone with XSS on `sui.ski` or access to the user's browser context can impersonate the user for up to 30 minutes.
- `verifyKeyServers: true` protects against a malicious/swapped key server object, not against compromise of a legitimate key server's hosting infrastructure.
- The DO is a single operator (Cloudflare account we control). A subpoena or account takeover exposes the full metadata history.

---

## 4. Roadmap to close the metadata gap

Ordered roughly by value-per-unit-work. Each item is independent and can be shipped on its own.

### Phase 1 — low-hanging metadata hygiene (days, not weeks)

**P1.1 — Strip sender address from the wire.** The DO already authenticates incoming WebSocket / HTTP connections via a signed challenge (per `docs/thunder-hybrid.md`). Once we trust the connection-level identity, the per-message `senderAddress` field in the POST body is redundant and harmful. Drop it. Have the DO derive the sender from the authenticated connection and tag the stored message server-side. Result: a passive reader of DO storage sees only group membership, not per-message authorship within a group.

**P1.2 — Pad message sizes.** All Thunder messages should be padded to fixed buckets (e.g. 256 / 1024 / 4096 bytes) before Seal encryption. Current AES-GCM leaks exact plaintext length. A "hey" and a "$7,770,000 transfer inbound" are distinguishable on the wire by size alone. Padding is ~2 lines of code and kills that channel.

**P1.3 — Jitter timestamps.** The DO currently stores `createdAt` with millisecond precision. Round to the nearest 10 seconds on ingest and add uniform jitter. Message ordering is preserved via the monotonic `order` field; absolute timing becomes fuzzy. Trivial and worth doing.

**P1.4 — Encrypt attachments' metadata.** Transfer notes are now encrypted (§2.2), but any future Walrus blob IDs attached to messages will leak as plaintext references unless wrapped in the envelope. Audit the SDK's `attachments` path and make sure blob IDs go inside the Seal envelope, not next to it.

### Phase 2 — break the social-graph leak (weeks)

**P2.1 — Sealed sender.** Borrow Signal's sealed-sender construction. The sender encrypts their identity certificate to the recipient's pubkey and includes it inside the Seal envelope. The DO sees only "someone authorized is writing to `groupId`" but not which member. Requires:

- A per-member identity cert signed by something the recipient can verify (likely the SuiNS NFT owner's Ed25519 pubkey, fetched from GraphQL).
- A way for the DO to rate-limit without knowing the sender — probably anonymous tokens (Privacy Pass / Trust Tokens) issued once per session after a signed challenge.
- A fallback for group messages with >2 participants.

This is the single largest privacy win. Worth its own design doc before implementation.

**P2.2 — Deterministic group IDs are a liability.** Today `derive.resolveGroupRef` computes `groupId` from the participant pair, so observing a `groupId` in DO traffic reveals who is talking to whom even without any membership enumeration. Switch to random UUIDs stored in an encrypted per-user index (Seal-encrypted, itself stored in another DO or Walrus). The user's client maintains a local map of `{counterparty → groupId}`; the wire never carries the counterparty.

**P2.3 — Membership list encryption.** The DO's `add-participant` endpoint stores raw Sui addresses per group. Wrap the membership list in Seal so only current members can read it, and have the DO enforce "you can add a participant only if you are already in the group" via zk-proof or a signed capability from an existing member. Tricky — may need a dedicated Move module.

### Phase 3 — reduce single-operator trust (months)

**P3.1 — Multiple relayers with client-side fan-in.** Instead of one DO per conversation, split each conversation across N DOs (different Cloudflare accounts or even different providers). The client writes every message to a randomly chosen subset; the client reads by polling all of them and deduplicating. Any single operator sees only a fraction of traffic. Doesn't help against global passive adversaries, but raises the cost of single-point-of-failure attacks.

**P3.2 — Decentralized relayer set.** Longer term: run the relayer as a libp2p pubsub mesh, or anchor it on Walrus + on-chain pointers (the `PayloadLocation::WalrusQuilt` design in `project_storm.md` §Storm PayloadLocation Design is already half this idea). The DO becomes optional accelerated delivery, not the source of truth. Content-addressed storage + Seal envelope means no single operator can withhold or enumerate messages.

**P3.3 — Onion-routed delivery.** Route sends through a chain of 2-3 relayers, each only knowing the next hop. Sphinx packet format. This is Signal's sealed sender combined with mix networking. High engineering cost, highest privacy ceiling. Only worth doing if Thunder becomes a target.

### Phase 4 — formal verification and threat model (ongoing)

**P4.1 — Write down the threat model.** We don't have one. Minimum viable version: table of adversary capabilities (passive wire, active MITM, DO operator, Seal server collusion, key server collusion, subpoena, XSS, lost device) × targets (message content, participant identity, group membership, timing, existence-of-conversation). Fill in the cells with "defended / at risk / out of scope". Ship in `docs/superpowers/specs/`.

**P4.2 — External review.** Once P1 is done and P2.1 (sealed sender) is designed, ask a Mysten or Seal engineer to sanity-check the envelope and the key-server verification path. We use their SDK; they should have opinions on whether we're holding it right.

**P4.3 — Abuse prevention without identity.** Anything that hides the sender also makes spam and harassment harder to stop. Before shipping P2.1, design the abuse-reporting path — probably recipient-side reporting with zero-knowledge proofs of authorized group membership.

---

## 5. File / line pointers for the next session

Last edited on 2026-04-10. These are the files and regions the next session should know about. **Verify line numbers before editing** — they drift.

- `src/client/thunder-stack.ts`
  - `SEAL_SERVERS` const + comment: near line 33-39.
  - `verifyKeyServers: true` config: near line 84.
  - `sendThunder` function: approximately lines 240-400.
  - Transfer-note encryption: near line 339-356.
  - Main encrypt path: near line 366-383.
  - `encryptWithRetry` helper: added in the same file, near line 385-405.

- `src/server/agents/timestream.ts` — the `TimestreamAgent` DO. Not audited in depth during this session; needs its own pass for sender-address-on-wire (§P1.1), timestamp jitter (§P1.3), and authenticated-connection refactor.

- ~~`contracts/storm/sources/storm.move`~~ — **deleted 2026-04-10.** Was the aspirational on-chain ECDH Storm contract. Published to mainnet (`0xa3ed4fdf...cdf942`) but never referenced from `src/`. Removed to prevent accidental revival.

- ~~`docs/thunder-hybrid.md`~~ — **deleted 2026-04-10.** Was the design doc for a two-tier relay + economic Storm architecture that contradicted the live SDK-based implementation. Removed.

- Memory index: `/home/brandon/.claude/projects/-home-brandon-Dev-Sui-Dev-Projects-SKI/memory/MEMORY.md`. Relevant entries: Thunder, Storm, project_thunder.md, project_storm.md, project_suiami_reciprocal.md. All updated on 2026-04-10 to reflect the correct Seal server trio (Overclock, Studio Mirai, H2O Nodes).

---

## 6. What to tell the user before touching any of this

1. **The live fix is good for content confidentiality but not for metadata.** Don't let "we fixed the plaintext leaks" become "Thunder is now private." Those are different claims.
2. **Phase 1 items are cheap and should be batched into one PR.** Padding, jitter, sender-address strip, attachment metadata audit. Half a day of work, disproportionate impact.
3. **Phase 2.1 (sealed sender) needs its own design doc before any code.** It touches auth, rate limiting, group membership, and the DO schema simultaneously.
4. **The storm.move contract has been deleted from the source tree** (see §2.4 stripping note). The on-chain package at `0xa3ed4fdf...cdf942` still exists but is unreferenced and unused. Do not reimport it or rebuild against it without an explicit product decision.
5. **Do not regress §2.1-2.3.** Any PR touching `encryptWithRetry`, `SEAL_SERVERS`, `verifyKeyServers`, or the transfer-note path should be reviewed against this spec. The plaintext fallback footgun is easy to reintroduce by accident ("just add a try/catch around the encrypt call so it doesn't fail the send"). Don't.

---

## 7. Acceptance criteria for "Thunder is actually private"

Use this as a self-check before claiming metadata privacy is solved.

- [ ] A passive reader of TimestreamAgent DO storage cannot determine which member of a group sent any given message. (Sealed sender.)
- [ ] A passive reader of TimestreamAgent DO storage cannot determine the participant pair of a 1:1 conversation from the `groupId` alone. (Non-derivable group IDs.)
- [ ] Message size buckets do not distinguish a "hey" from a "$7M transfer notice." (Padding.)
- [ ] Timing of individual messages is fuzzed to at least ±5 seconds on the wire. (Jitter.)
- [ ] A single Cloudflare account compromise does not reveal the full metadata history of any conversation. (Multi-relayer fan-in, or content-addressed storage.)
- [ ] The threat model is written down and every adversary row has a defended/at-risk/out-of-scope label. (§P4.1.)
- [ ] An external reviewer has signed off on the envelope and key-server verification path. (§P4.2.)
- [ ] Abuse reporting works without deanonymizing senders. (§P4.3.)

Until all eight boxes are checked, the honest marketing claim is "Thunder's message content is E2EE via Seal 2-of-3 threshold, with novel UX and economic layers on top." That is already a true and useful thing to say. It is not "Signal-grade private messaging."

---

## 8. Alignment with upstream `@mysten/sui-stack-messaging` features

The upstream SDK (version `0.0.2` installed as of 2026-04-10) advertises a specific feature set. This section catalogs which features we actually use, which we use partially, and which we don't — so nobody mistakes "upstream supports X" for "we do X."

### 8.1 Terminology / nomenclature notes

- **Factory function:** upstream dist exports `createSuiStackMessagingClient` from `dist/factory.mjs` / `dist/index.mjs`. Older docs and some quickstart snippets reference `createMessagingGroupsClient` — that name is **not** present in the installed package. Our code at `thunder-stack.ts:83` uses the correct current name. If upstream docs disagree with the installed `.d.mts` files, trust the `.d.mts`.
- **Package config constants** the SDK exports that we currently don't import but may want to: `MAINNET_SUI_STACK_MESSAGING_PACKAGE_CONFIG`, `MAINNET_SUINS_CONFIG`, `DEFAULT_HTTP_TIMEOUT`, `DEK_LENGTH`, `NONCE_LENGTH`, `METADATA_SCHEMA_VERSION`.

### 8.2 Feature-by-feature alignment

| Upstream feature | Our status | Where |
|---|---|---|
| Composable SDK (client extension pattern) | Used | `createSuiStackMessagingClient(gqlClient, opts)` at `thunder-stack.ts:83-98` |
| Pluggable transport (`RelayerTransport` interface) | Used — custom impl | `TimestreamRelayer` class at `thunder-stack.ts:127-227` swapped in via `relayer: { transport: new TimestreamRelayer() }` at line 94 |
| AES-256-GCM + Seal-managed keys, relayer never sees plaintext | **Enforced as of 2026-04-10.** `encryptWithRetry` has no plaintext fallback; transfer notes also encrypted | `thunder-stack.ts:385-405`, `339-356`, `366-383` |
| Per-message wallet signatures (`verifyMessageSender`, `VerifyMessageSenderParams`) | **Partial — wired but not enforced.** We pass `signature: params.messageSignature \|\| ''` (empty if absent) and hardcode `senderVerified: false` on read | `thunder-stack.ts:138, 190, 453` |
| File attachments (`AttachmentsManager`, `WalrusHttpStorageAdapter`) | **Not supported in our transport.** `fetchMessages` and `fetchMessage` return `attachments: []` unconditionally. No attachment upload path | `thunder-stack.ts:163, 177` |
| Real-time subscriptions (AsyncIterable) | Partial — we poll every 3s in `TimestreamRelayer.subscribe` instead of true push. SDK's top-level `client.messaging.subscribe` is only used by `subscribeThunders`, which ultimately calls our polling transport | `thunder-stack.ts:206-226, 489-512` |
| Manual DEK rotation (`RotateEncryptionKeyOptions`) | Not used | — |
| Atomic remove-member-and-rotate (`RemoveMembersAndRotateKeyOptions`) | Not used | — |
| Group lifecycle: create / archive / leave (`ArchiveGroupCallOptions`, `LeaveCallOptions`) | Only create used (`createAndShareGroup` in PTB) | `thunder-stack.ts:306-311, 524-528` |
| Batch member management / permission control | Not used. SUIAMI roster piggybacks on-chain but bypasses the SDK's member APIs | `thunder-stack.ts:315-317` |
| Cross-device recovery from Walrus (`RecoveryTransport`, `RecoverMessagesOptions`) | Not used. Our history lives in the TimestreamAgent DO, not in Walrus | — |
| Custom Seal policies (`SealPolicy`, `DefaultSealPolicy`) | Using default. No app-specific policy override | — |
| UUID-based deterministic addressing | Used. `GLOBAL_SUIAMI_STORM_UUID = 'suiami-global'`, `derive.resolveGroupRef` | `thunder-stack.ts:30, 284` |
| SuiNS integration (`SetSuinsReverseLookupCallOptions`, `MAINNET_SUINS_CONFIG`) | Not used — we roll our own SuiNS lookup via `@mysten/suins` | `thunder-stack.ts:549-587` |
| On-chain group metadata k/v store (`InsertGroupDataCallOptions`) | Not used | — |
| Session keys (`SessionKeyConfig`) | Used via `DappKitSigner`, seeded by personal-message signature. SDK default 30-min TTL | `thunder-stack.ts:76-93` |
| Sender verification helper (`verifyMessageSender`, `buildCanonicalMessage`, `buildMessageAad`) | Not imported or called | — |

### 8.3 What this table tells the next session

Two categories of work fall out of this honestly:

**Enforcement debt** — features we ship with a broken or no-op path that pretends to support them:

1. **Sender verification is empty-stringed.** Fix: either compute a real per-message signature in `sendThunder` before calling the transport (sign over `buildCanonicalMessage({ groupId, text, order, ... })` with the session key), store it in the DO, and actually call `verifyMessageSender` when reading in `getThunders`. Or: explicitly document that Thunder does not use per-message sender verification and remove the empty-string field to stop pretending. The current in-between state is the worst option.
2. **Attachments are silently dropped on read.** Fix: either wire `WalrusHttpStorageAdapter` through our transport's `fetchMessages` so attachments round-trip, or surface a hard error when a stored message has non-empty attachments that our transport cannot return. Silent `[]` is bad.
3. **Polling subscribe is not real-time.** Fix: upgrade `TimestreamRelayer.subscribe` to a WebSocket against the DO (DOs support WebSockets natively). 3-second polling is correct for a prototype, wrong for "real-time subscriptions" marketing.

**Unused capability** — features upstream offers that we could plug in for immediate wins:

1. **Key rotation.** Right now `keyVersion` is effectively static per group. `RotateEncryptionKeyOptions` gives us forward secrecy against compromised past DEKs. Cheap to wire once session keys and membership are stable.
2. **Cross-device recovery via `RecoveryTransport`.** Today history is pinned to whoever controls the TimestreamAgent DO. If we adopted upstream's Walrus recovery path, a user could re-sync their whole Thunder history from Walrus on a new device without trusting us. This is a partial answer to §P3.2 (decentralized relayer set) and a significant privacy posture improvement on its own.
3. **Custom `SealPolicy`.** The default policy is "members of the `PermissionedGroup` can decrypt." A custom policy could require (a) SUIAMI proof, (b) an iUSD balance, (c) NFT ownership, (d) IKA dWallet signature — enabling the token-gated and identity-gated modes the rest of the SKI stack is built around. This is probably the single most "innovative" thing we could build on top of upstream without rewriting the E2EE primitive.
4. **Group metadata k/v store.** On-chain application data attached to a Storm. Candidates: Chronicom thunder-count snapshots, Quest state, Prism attachments, t2000 channel config.

### 8.4 Summary for the replacement

Our composition against the upstream SDK is **structurally correct**: we use the documented factory, the documented transport interface, the documented session-key config, the documented group-create PTB, and the documented UUID addressing. The 2026-04-10 fixes close the content-plaintext gap that was violating the SDK's "relayer never sees plaintext" guarantee. What remains is:

- one genuine security gap (sender verification wired-but-empty),
- one silent data-loss path (attachments return `[]`),
- one marketing/reality gap (real-time = polling),
- and a list of upstream features we're not using that would measurably improve privacy, resilience, or product differentiation if adopted.

Everything in this table should be re-verified against the then-current `src/client/thunder-stack.ts` before acting — line numbers drift, and upstream may have shipped new major versions.
