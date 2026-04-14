# Magneton Decision Ledger

**Living document.** Captures architectural decisions for Magneton → Magnezone (#151) and the on-the-fly terminology brando coins while we drill through them. Companion to the design spec at `2026-04-14-magneton-magnezone-thunder-relay.md`.

Rules:
- Every decision gets an entry. Status moves pending → in-discussion → decided → (maybe) superseded.
- Every new term brando names on the fly gets a glossary entry *immediately*, before we use it anywhere else.
- One-way doors (things we can't retrofit) are called out explicitly and drilled first.

---

## Glossary — brando's terminology

| Term | Definition | Where it applies |
|---|---|---|
| **Prismoid** | The identity vessel. A Move object wrapping IKA dWallet(s) that carries the SuiNS name and all cross-chain squids. Root of identity; transferable atomically. Disambiguates from existing **Prisms** (rich encrypted transaction vehicle) — a Prismoid *emits* Prisms. Same prism-metaphor family: one beam in, spectrum out. | Decision 1 |
| **squid** | A single chain-capable appendage of a Prismoid. One squid per curve/chain the Prismoid can touch (BTC, SOL, EVM, Sui, …). Each squid is a dWallet derivation. A Prismoid with multiple squids can do **cross-chain multi-sig** — several squids cooperating on one signature. "Rumble your squids" = the DKG ceremony that provisions them. | Decision 1, 2 |
| **suiami** | **SUI-AUTH-MSG-ID.** The authenticated message-identity credential — a tamper-evident proof of ownership of a Prismoid + its SuiNS name + its squids, stamped with country metadata at minting time. Carrying someone's suiami = trusting them as an inka. Package: `suiami@2.0.0` on npm (latest live), `2.0.1` pending publish, repo github.com/arbuthnot-eth/SUIAMI, maintainer atlas.sui. Magneton extends this package rather than creating a new one. | Decision 1, 2, 4 |
| **opening** | The first scribe entry between two Prismoids that opens a storm. Replaces the words "initiate" and "bootstrap." A Prismoid *opens* a storm by having ultron scribe its first thunder into both parties' chronicoms. | Decision 2 |
| **scribe** (verb) | The default write operation for both **thunders** (messages) and **prisms** (rich encrypted transactions). Every thunder *and* every prism is scribed by ultron into both Prismoids' chronicoms, which write through to the timestream. Default mode is deniable for thunders — symmetric MAC, no third-party-verifiable signature. Prisms carry their own ZK proofs. The scribe pipeline is unified: one substrate for messaging history and transaction history. | Decision 2 |
| **inscribe** (verb) | The opt-in non-repudiable variant. To *inscribe* a thunder or a prism = attach a squid signature over the entry's hash, making it permanently third-party-verifiable in the timestream. From Latin *inscribere*, "to write upon/in." Used for payments, contracts, public statements — any entry where the sender wants proof. Signal cannot do this for messages; suiami can do it for both messages and transactions, in one substrate. | Decision 2 |
| **inscription** | A thunder or prism that has been inscribed. Permanent, verifiable, attached to the timestream forever. Plural: inscriptions. | Decision 2 |
| **chronicom** | Per-Prismoid Durable Object. Originally a thunder-count cache; now extended to carry the **suiamis you trust** (your inka set), the per-storm scribed thunders, *and* the prisms exchanged with each Prismoid. The chronicom is the writer-cache that holds your unified view of every storm and every transaction you participate in. | Decision 2, 3, 4 |
| **timestream** | The temporal substrate (`TimestreamAgent` DO + on-chain commitment layer) that all chronicoms write through to. Holds the authoritative time-ordered ledger of scribed entries — **both thunders and prisms** — between Prismoids. Replaces the conceptual "suiami cache" / "inkwell" framing — the timestream **is** the unified messaging-and-transaction cache. | Decision 2, 3, 6 |
| **sibyl** | The oracle. Already exists in the project; in Magneton's context she reads the timestream to score trust, predict spam, and signal inka-eligibility. Sibyl conducts chronicoms via satellites (existing pattern). | Decision 4 |
| **chronicle** | The accumulated record between two Prismoids in their shared chronicom. "Their chronicle goes back six months." Lowercase, just prose flavor — not a separate entity. | Decision 4 |
| **inka** | **Someone whose suiami you carry.** Possession-based, not behavior-based: the moment your chronicom holds another Prismoid's suiami credential, they're an inka. Same-country Full SKI Pass holders auto-share suiamis through ultron (see Decision 4) and are inkas by default. Cross-country relationships earn it through scribed thunders or sent prisms. The opposite of strangers. | Decision 4 |
| **inkas** | Plural of inka. **Use this form even when slightly stretching grammar** — `inkas.sui` is registerable for $10/yr (5+ char rule); `inka.sui` would be $100/yr (4-char). | Decision 4 |
| **strangers** | Any Prismoid whose suiami you do not carry. Default state for first contact. Gated by SKI Pass per Decision 4. | Decision 4 |
| **SKI Pass** | A roster of credentials per SuiNS name: an NFT + a group of squids (secp256k1 + ed25519 IKA dWallets), bound together by the name. Auto-minted on first key-in. Includes Cloudflare country metadata. Comes in two tiers: **Full SKI Pass** (default for primary country, full inka country-pool access) and **Temporary SKI Pass** (any new country until upgraded by either multi-keyin-over-time or by sending a Prism worth a threshold to ultron). Doesn't expire unless the holder doesn't key in for **3 years**. Ultron grants knowledge of SKI Pass info anonymously. | Decision 4 |
| **Full SKI Pass** | The default tier. Granted on first key-in for the primary country. Country-pool inkas are derived from this set. | Decision 4 |
| **Temporary SKI Pass** | Issued when a user keys in from a new country. Records the country of origin but does not grant country-pool inka rights until upgraded. Two upgrade paths: (a) accumulate sufficient key-ins from that country over time, or (b) send a Prism worth a threshold amount to ultron. | Decision 4 |
| **Thunder** (the network) | The Magneton topology. Every *thunder* (lowercase — a single message) passes through ultron via double-envelope: outer to ultron, inner to the recipient's squid. Ultron is a keyless blind relay: sees who, never what. Uppercase **Thunder** = the relay network; lowercase **thunder** = a single message travelling through it. Do not say "hub-and-spoke," "swish," or modify with "pure." | Decision 3 |
| **thunder-ultron storm** | The auto-created per-Prismoid storm to ultron that serves as the relay pipe for all other storms. Shipped in Magneton Lv.10. | Decision 3 |
| **Magnezone** | The evolved form of Magneton — onion mixnet + cover traffic. Target end state, not v1. | Roadmap |
| ~~dWallet-backed SuiNS~~, ~~facet~~, ~~ratchet~~, ~~initiate~~, ~~activate~~, ~~ink (verb)~~, ~~inkwell~~, ~~encaust~~, ~~encausted~~, ~~encaustum~~, ~~inkling~~, ~~inkle~~, ~~suiami cache~~, ~~hub-and-spoke~~, ~~swish~~, ~~pure (modifier)~~, ~~dry/wet~~ | *Superseded or rejected.* "dWallet-backed SuiNS" → **Prismoid**. "facet" → **squid**. "ratchet" / "suiami cache" → **timestream** + **chronicom**. "initiate" / "inkling" → **opening**. "activate" → **scribe** (verb). "ink" / "encaust" → **inscribe**. "inkwell" → **timestream**. "hub-and-spoke" / "swish" / "pure" → just **Thunder**. "dry/wet" / "inkblot" → never adopted. | — |

*Add new terms here the moment brando coins them. Don't wait.*

---

## First-principles drilling order

From the architect agent's analysis. **Do not skip ahead** — later decisions depend on earlier ones, and 1–3 are one-way doors.

1. **Identity Primitive** — what IS a Magneton participant? (blocks everything)
2. **Sender Authenticity** — how does the recipient know who sent a thunder? (one-way door — can't retrofit signatures later)
3. **Storm Topology** — Thunder via ultron, direct, or hybrid?
4. **Spam Control** — inkas vs strangers; what does a stranger have to do to get through?
5. **Delivery Model** — WebSocket push (CF DO hibernatable) vs poll
6. **Forward Secrecy Rotation** — when do we rotate storm keys, and what happens to in-flight thunders?
7. **Cross-Chain Delivery** — how does a BTC/SOL/ETH identity receive a thunder?

Critical path: **1, 2, 3 must be nailed before ANY code.** 4–7 can be iterated.

---

## Decision Ledger

### Decision 1 — Identity Primitive
**Status:** ✅ decided 2026-04-14
**One-way door:** YES

**Question:** What is the canonical identifier of a Magneton participant?

**Options considered:**
- (a) SuiNS name alone
- (b) Sui address alone
- (c) IKA dWallet ID alone
- (d) **Hybrid — dWallet-backed SuiNS**

**brando's call: (d) Hybrid — Prismoid as root, SuiNS name as facet.**

**Evolution of the framing (two corrections in sequence):**
1. First pass had Roster as the cross-chain lookup. brando: make SuiNS itself cross-chain by hanging dWallets off the name as dynamic fields. No Roster hop.
2. Second pass flipped containment: the dWallet object is the sovereign vessel, the SuiNS name lives *inside* it. New term coined: **Prismoid** — the vessel — and **facet** — each chain-address face. Disambiguates from existing **Prisms** (transaction vehicle); a Prismoid *emits* Prisms. Same refraction metaphor.

**What this means architecturally:**
- A Magneton participant is a Prismoid. Canonical reference is the Prismoid object ID.
- The Prismoid wraps an IKA dWallet (or set of dWallets — one per curve as needed: secp256k1 for BTC/EVM, ed25519 for SOL/Sui).
- The SuiNS name (`brando.sui`) is a facet of the Prismoid — the human-readable face.
- Chain addresses (BTC / EVM / SOL / Sui) are facets derived from the dWallet(s) inside the Prismoid.
- Transferring identity = transferring one Prismoid object. Name + all chain addresses + attached state move atomically.
- First-commandment compliant: every cross-chain address IS an IKA dWallet derivation, never a re-encoded keypair.
- Roster becomes an index (name → Prismoid ID), not source of truth.

**Depends on:** nothing
**Blocks:** 2, 3, 4, 7 — now unblocked, all downstream decisions assume dWallet-backed SuiNS as the identity primitive.

**Downstream implications to carry forward:**
- Decision 2 (sender auth) — can sign with any dWallet under the name, or with the SuiNS-owning Sui keypair. Cross-chain verification falls out of dWallet signatures.
- Decision 3 (topology) — ultron relay can route by SuiNS name; cross-chain routing reads the dynamic field for the target chain.
- Decision 7 (cross-chain delivery) — collapses dramatically. No Roster lookup. The name already knows all its addresses.

---

### Decision 2 — Sender Authenticity
**Status:** ✅ decided 2026-04-14
**One-way door:** YES

**Canonical sentence (brando, 2026-04-14, after the bestiary refocus):**
> **A Prismoid opens a storm with its squids. Each thunder — and each prism — is scribed by ultron into both Prismoids' chronicoms, the chronicoms write through to the timestream, and sibyl reads the timestream to score trust — turning strangers into inkas as each carries the other's suiami.**

**Decision:** Implemented on top of the existing **`suiami`** npm package (`SUI-AUTH-MSG-ID`, v2.0.0 live, v2.0.1 pending). Magneton extends suiami rather than forking. The operational vocabulary uses the existing project bestiary (chronicom, timestream, sibyl) — no parallel ink-vocabulary was manufactured.

**Layers:**

1. **Opening** — the first squid-sign between two Prismoids. The squid used matches the recipient's native chain (BTC recipient → secp256k1 squid; SOL recipient → ed25519 squid). Costs 2PC-MPC latency *once per storm*. The opening is scribed into both chronicoms and written through to the timestream as the anchor of the relationship. Any chain's verifier can independently check it.

2. **Scribing** — every thunder *and* every prism after the opening. Ultron scribes each entry into both Prismoids' chronicoms. The chronicoms write through to the timestream. Default mode for thunders is deniable (symmetric MAC, derived from the opening anchor via KDF). Prisms carry their own ZK proofs. Forward-secret, post-compromise-secure, and **the state is visible to both parties** through the shared chronicom, not desynced across devices.

3. **Inscribing (opt-in, per-entry)** — sender can attach a squid signature over the entry's hash, making it non-repudiable and third-party-verifiable forever. Default is deniable; sender flips to inscribed when they want proof (payments, contracts, public statements). **Signal cannot do this for messages** — Signal is deniable-only. Suiami can do it for both messages *and* transactions, in one substrate.

4. **Rotation** — the Prismoid emits a rotate event on-chain, scribing a new anchor into the timestream. Grace window where both anchors decrypt. Proactive, not reactive-via-traffic.

**Why this beats Signal specifically:**
- No out-of-band safety numbers — the Prismoid IS the on-chain anchor.
- Cross-chain native — the opening squid matches the recipient's chain.
- Deniability *and* non-repudiation, per-entry choice (Signal: deniable only).
- Proactive rotation via on-chain publish.
- Multi-device = Prismoid ownership, not N separate identity keys.
- The relationship state is **visible** to both parties through the shared chronicom + timestream, instead of desynced double-ratchet structs on two devices.
- **One substrate for messages and money.** Signal does messages. Magneton does messages and transactions in the same scribe pipeline. Trust scores from sibyl can read both.

**Cost model:**
- New storm: one 2PC-MPC signature (seconds, one time).
- Every subsequent thunder/prism: symmetric MAC, ms.
- Inscribed entry: one extra squid signature, opt-in.
- Sui writes: timestream commits are batched / commitment-based to keep gas sane (design TBD — tracked as open question).

**Package strategy:**
- Extend `suiami` rather than create a new package. The opening + scribe + inscribe layer is added as new exports.
- Target: future `suiami@2.x` adds `open()`, `scribe()`, `inscribe()`, `verify()` matching the bestiary.
- SKI consumes via normal npm dependency. Magneton becomes the first SKI feature that imports from published suiami instead of internal code.
- Third parties can audit/use the crypto package in isolation.

**Do not say "ratchet" anywhere in code, comments, or docs.** The concept is *suiami cache*. If you feel the urge to type "ratchet," type "activate" (verb) or "suiami state" (noun).

**Depends on:** 1 ✅
**Blocks:** 3, 6 — now unblocked.

---

### Decision 3 — Storm Topology
**Status:** ✅ decided 2026-04-14

**Decision:** **Thunder through ultron via double-envelope.** Rejects direct P2P and hybrid.

**Shipped substrate:** Lv.10 already auto-creates `thunder-ultron` storm per Prismoid on connect (src/ui.ts). The pipes are laid.

**Mechanics:**
- **Outer envelope:** encrypted to ultron, contains `{ recipient_prismoid, inner_ciphertext }`. Ultron reads this to know where to route.
- **Inner envelope:** encrypted to the recipient's squid. Ultron **cannot** decrypt it. Only the recipient can.
- **Ultron is a keyless blind relay.** It knows *who talks to who* but not *what they say*. First commandment holds.

**Why Thunder wins (this is the README pitch):**

| Decision | How B unlocks it |
|---|---|
| **4 — Spam Control (inkas vs strangers)** | Enforcement at one point (ultron), not N client implementations. Strangers see the toll prompt once, at ultron, before ultron agrees to route. Inkas pass through. Zero client trust needed. |
| **5 — Delivery Model** | One WS connection per Prismoid, to ultron, reused for all traffic. Cloudflare DO hibernatable WebSockets are free when idle. Already wired (`subscribeThunderStream` at `src/client/thunder-stack.ts:1416`). |
| **6 — Forward Secrecy Rotation** | Single write path. Ultron watches Prismoid rotation events and flips storm anchors. No multi-device desync — the anchor lives on-chain in the suiami cache. |
| **7 — Cross-Chain Delivery** | Collapses entirely. Ultron has its own dWallets (ed25519, secp256k1) and can emit chain-specific notifications (SOL memo, EVM event, BTC OP_RETURN) when the recipient has no SKI client. The non-Sui recipient never installs anything. |
| **Magnezone evolution** | Uniform traffic is the *precondition* for onion mixing and cover traffic. Hybrid C would permanently close this door. |

**Rejected alternatives:**
- **(A) Pure direct P2P** — leaks graph metadata to any passive observer, can't do cross-chain, forces per-client spam enforcement, has no single rotation write path.
- **(C) Hybrid (direct for inkas, ultron for strangers/cross-chain)** — **trap.** Two codepaths doubles bug surface, bifurcates spam enforcement, halves cover-traffic coverage, and kills Magnezone evolution. The "latency win" from direct is tens of milliseconds — real, not worth it.

**Cost accepted:**
- Ultron becomes mission-critical for delivery. Mitigation: ultron is already on CF DO (multi-region, hibernatable). Failure mode is "retry," not data loss.
- Ultron sees traffic *volume* even without content. Mitigation: flat-rate batching now, cover traffic in Magnezone.
- One extra hop (~20-50ms). Imperceptible for messaging.

**Depends on:** 1 ✅, 2 ✅
**Blocks:** 4, 5, 6, 7 — **all unblocked**.

---

### Decision 4 — Spam Control (inkas vs strangers)
**Status:** ✅ partially decided 2026-04-14 (sub-questions 4c, 4d delegated to GH issues)

**Question:** What does a stranger have to do to deliver a thunder? What do inkas bypass?

**The reframe (brando, 2026-04-14):**
> "the user can complete any of the paths easily and automatically just by virtue of visiting and keying-in. the user should use their ski pass which is granted as a suiami that includes the cloudflare cf location information country specifically"

This collapses the entire stranger-gate tree. Tolls, PoW, invites, and tiered combinations all become unnecessary for anyone who's an SKI user, because **being an SKI user is the gate**. Visiting sui.ski and keying in mints a SKI Pass automatically, in the same flow, with zero added friction.

---

#### Decision 4a — The gate
**Decision: SKI Pass.** A single tier. To send a thunder through ultron, you need a SKI Pass. Strangers to SKI fix that in 10 seconds by visiting sui.ski and keying in. There is no toll, no PoW, no invite gate.

**SKI Pass mechanics (per brando 2026-04-14):**
- A SKI Pass is **a roster of credentials per SuiNS name**: an NFT + a group of squids (secp256k1 + ed25519 IKA dWallets).
- Bound together by the SuiNS name; networked through it.
- Auto-minted on first key-in, no separate flow.
- Records the **Cloudflare country header** (`cf-ipcountry`) at minting time as an attested field inside the suiami credential.
- **Ultron grants knowledge of SKI Pass info anonymously** — verifiers can ask "does ralph.sui have a valid SKI Pass?" and get yes/no without ultron leaking which squids, which country, or any other internal detail.
- **No expiry** unless the holder doesn't key in for **3 years**, at which point the Pass lapses.

#### Decision 4b — Country binding and Pass tiers
**Decision: two tiers.** When a user keys in from a new country (different from their established country), ultron mints a **fresh SKI Pass marked Temporary**.

- **Full SKI Pass** — the default. Granted on first key-in for the primary country. Holders are auto-inkas with everyone else holding a Full SKI Pass *in the same country*.
- **Temporary SKI Pass** — issued for any new country the user keys in from. Records the country of origin but does **not** grant country-pool inka rights or full Pass status.

**Two upgrade paths from Temporary → Full:**
1. Accumulate sufficient key-ins from that country over time (anti-VPN-flapping by construction; a one-shot VPN exit doesn't promote).
2. Send a **Prism worth a threshold amount to ultron** — economic commitment as proof of stay. This ties the existing **Prisms** transaction vehicle into identity verification — neat reuse of an existing primitive.

The temporary tier records the new country regardless of upgrade status (so ultron can rate-limit, score abuse, etc.) — it just doesn't *trust* the new country until upgraded.

#### Decision 4c — Sanctioned-jurisdiction policy
**Status: delegated to GH issue + agent swarm.** What does ultron do at SKI Pass mint time when CF says the requesting country is OFAC-sanctioned, MiCA-restricted, or otherwise legally complicated? Options range from "mint flagged-but-functional" to "refuse to mint" to "mint normally and handle compliance at the iUSD/transaction layer." This needs compliance, technical, and UX angles weighed together. See `gh issue` filed 2026-04-14 (link in this doc once filed).

#### Decision 4d — Cross-chain stranger Pass bootstrapping
**Status: delegated to GH issue + agent swarm.** A pure BTC/SOL/ETH user with no Sui wallet wants to thunder a SuiNS name (e.g. via a memo or OP_RETURN that hits ultron's chain watcher). They have no SKI Pass because they never keyed in. Options range from "auto-derive a stub Pass via IKA from their inbound chain" to "bounce them with a key-in URL" to "accept in-band toll from their chain in lieu of a Pass." See `gh issue` filed 2026-04-14.

#### Decision 4e — The inka graph
**Decision: inkas live in your chronicom as the suiamis you carry.** Two-tier composition:

1. **Country-pool inkas** *(automatic)* — Anyone holding a Full SKI Pass for the same country as you is automatically an inka. Ultron derives this set on the fly from the Pass roster — no per-pair Merkle leaves needed for country pool. This is the high-volume cheap path: same-country = trusted by default.

2. **Custom inkas** *(earned)* — Cross-country relationships and explicit additions live as a **Merkle commitment on-chain**, with the leaves (the actual carried suiamis) held in your chronicom. This preserves privacy (your full inka set is never public) while letting any verifier check inclusion via a Merkle proof.

**Total inka set** = country-pool ∪ custom-inkas.

**How "carrying a suiami" actually works:**
- When you scribe a thunder with someone or send/receive a prism with them, your chronicom pulls a copy of their suiami (with your consent, implicit by the act of engaging) into its local store.
- That suiami is what you "carry." The act of carrying = trust. Strangers → inkas is the moment your chronicom commits their suiami.
- For country-pool inkas, ultron pre-shares the suiami set anonymously when you key in, so you immediately carry every Full SKI Pass holder in your country.

**Recipient-side override:** A recipient can set their own minimum gate stricter than the default — e.g., "only inkas, no Pass-only strangers." Public accounts can set it looser — "anyone with a Pass, no inka requirement." Ultron enforces whichever the recipient set.

---

**Depends on:** 1 ✅, 2 ✅, 3 ✅
**Blocks:** nothing downstream — Decisions 5, 6, 7 can proceed in parallel with the 4c/4d issue resolution.

---

### Decision 5 — Delivery Model
**Status:** pending (substrate available)

**Question:** Push (WebSocket) or pull (poll)?

Substrate: CF DO hibernatable WS fully wired. `subscribeThunderStream` at `src/client/thunder-stack.ts:1416`, `TimestreamAgent._broadcast` at line 104. Hibernatable = free when idle.

**Options:**
- **(a) WS push as primary, poll as fallback** — low latency, low cost idle. Reconnect/resume needed on flaky nets.
- **(b) Poll only** — simpler, already working, higher latency.

**Depends on:** 3
**Blocks:** 6

**brando's call:** _TBD (strong lean toward (a) given substrate)_

---

### Decision 6 — Forward Secrecy Rotation
**Status:** pending

**Question:** When and how do storm keys rotate? What happens to in-flight thunders during rotation?

Substrate: `rotateStormKey` at `src/client/thunder-stack.ts:1609` exists.

**Options for trigger:**
- Time-based (every N hours/days)
- Volume-based (every N thunders)
- Event-based (membership change, explicit request)
- Signal-based (suspected compromise)

**In-flight handling:**
- Grace window where both old + new keys decrypt
- Hard cutover — in-flight may be lost
- Re-wrap outstanding ciphertext under new key

**Depends on:** 2, 5
**Blocks:** nothing downstream

**brando's call:** _TBD_

---

### Decision 7 — Cross-Chain Delivery
**Status:** pending — the killer feature

**Question:** How does a BTC/SOL/ETH identity receive a thunder?

Substrate: ultron has two dWallets (ed25519 `0x1a5e6b…`, secp256k1 `0xbb8bce…`). `getCrossChainStatus` at `src/client/ika.ts:661`. Roster v2 maps SuiNS → cross-chain addresses.

**Options:**
- **(a) All cross-chain delivery via ultron relay** — recipient doesn't need SKI client if we post to a chain-specific inbox (e.g. memo on Solana). Metadata-rich.
- **(b) IKA dWallet as the identity** — recipient's dWallet public_output decrypts; works anywhere that can verify IKA.
- **(c) Seal-encrypted Walrus blob keyed to dWallet sig** — recipient proves dWallet ownership to Seal servers, gets blob key.

**Depends on:** 1, 2, 3
**Blocks:** nothing

**brando's call:** _TBD_

---

## Open questions (unlisted)

- Do we want deniability? (recipient can prove a thunder to a third party vs. cannot)
- Do we want read receipts? (they break deniability)
- Does ultron earn iUSD per-relay? How is that priced?
- What's the Magneton → Magnezone trigger? (traffic volume, explicit user opt-in, time?)

---

## Implementation checklist (populated as decisions land)

- [x] Lv.10 Thunder Wave — auto-create thunder-ultron storm on connect (#153, shipped)
- [ ] Lv.20 — Identity primitive resolver (blocked on Decision 1)
- [ ] Lv.30 — Signed inner cipher (blocked on Decision 2)
- [ ] Lv.40 — Double-envelope send path (blocked on Decisions 2, 3)
- [ ] Lv.50 — Stranger toll enforcement (blocked on Decision 4)
- [ ] Lv.60 — WS push delivery (blocked on Decision 5)
- [ ] Magnezone evolution — onion mixnet + cover traffic

---

*Last updated: 2026-04-14 — document created, glossary seeded with `inkas`, decisions 1–7 drafted pending brando's calls.*
