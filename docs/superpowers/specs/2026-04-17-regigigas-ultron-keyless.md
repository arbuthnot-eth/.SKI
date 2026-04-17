# Regigigas — Ultron Keyless Rumble via IKA Encrypted User Share

**Issue:** #170
**Status:** Path B chosen — awaiting rotation run
**Depends on:** Probopass #169 (fromSecretKey choke point — landed 2026-04-17)

## Goal

Retire `SHADE_KEEPER_PRIVATE_KEY` / `ULTRON_PRIVATE_KEY` as a raw Ed25519 secret on the Cloudflare Worker. Replace with:

- **User share** encrypted to a server-held **Authentication Key** (CF Secret, encryption-only).
- **IKA dWallet** holding Ultron's public key via imported-key ed25519 DKG.
- DO signing: `ultronKeypair(env)` internally decrypts the share + co-signs with IKA network per-request.

First Commandment satisfied: no raw signing key on the Worker; co-signing requires brando.sui's encryption authority + IKA threshold.

## Prereqs

- IKA SDK: `prepareImportedKeyDWalletVerification(ikaClient, Curve.ED25519, ...)` — shipped (`reference_ika_imported_key_ed25519.md`).
- Probopass Magnet Bomb done: all Ultron signing funnels through `ultronKeypair(env)`, so the raw→IKA swap is one line inside `src/server/ultron-key.ts`.

## Approach — Path B (rotate, sweep, repoint, then rumble)

1. **`scripts/rotate-ultron.ts`** — generate Ed25519 bech32 locally, `wrangler secret put ULTRON_PRIVATE_KEY` over stdin, print Ultron's new Sui address only. **Do NOT delete `SHADE_KEEPER_PRIVATE_KEY` yet** — the old address still holds assets + owns ultron.sui.
2. **Asset sweep** (signed with the old key via legacy `ultronKeypair()` reading `SHADE_KEEPER_PRIVATE_KEY` as fallback) — one PTB per coin type from old address → new address. Covers SUI (keep a tiny gas reserve for later cleanup tx), NS, IKA, iUSD, USDC, any iUSD SPL balances, plus DWalletCaps + IOU ownership transfers.
3. **Repoint ultron.sui** — `suinsTx.setTargetAddress({ nft: ultronSui, address: newUltronAddr })` + `suinsTx.setDefault('ultron.sui')` from the old address, so reverse-resolve and any `chainAt('sui@ultron')` flow resolves to the new address.
4. **Address-ref sweep** in code/docs/memory — see section below.
5. **Re-encrypt ceremony** (Path B.2 — DO-driven, IKA-native). This is the keystone, preserves all cross-chain addresses (BTC/ETH/SOL) + DWalletCaps:
   - IKA SDK ships `IkaTransaction.requestReEncryptUserShareFor({ dWallet, destinationEncryptionKeyAddress, sourceSecretShare, sourceEncryptedUserSecretKeyShare, ikaCoin, suiCoin })` — a native primitive (two overloads, the plaintext variant is the one we use).
   - Per dWallet (ed25519 + secp256k1 — two ceremonies):
     1. Derive OLD `UserShareEncryptionKeys` from `sha256(SHADE_KEEPER_PRIVATE_KEY ‖ "ultron-dkg:<curve>:<oldUltronAddr>")`.
     2. Derive NEW `UserShareEncryptionKeys` from `sha256(ULTRON_PRIVATE_KEY ‖ "ultron-dkg:<curve>:<newUltronAddr>")`. **NEW's encryption key address is NOT the same as new Ultron's Sui address** — it's derived from the encryption-keys keypair. Compute it explicitly.
     3. **Register NEW's encryption key** on-chain if not already published (one-time per curve).
     4. Fetch source `EncryptedUserSecretKeyShare` object + `ZeroTrustDWallet` via `ikaClient.getObject` / `getDWallet`.
     5. Decrypt source plaintext via `UserShareEncryptionKeys.decryptUserShare(dWallet, encShare, protocolPP)` with OLD keys. Verify via `verifyUserShare`.
     6. Build PTB:
        - `ikaTx.requestReEncryptUserShareFor({ dWallet, destinationEncryptionKeyAddress: NEW_ENC_KEY_ADDR, sourceSecretShare: plaintext, sourceEncryptedUserSecretKeyShare: sourceShare, ikaCoin, suiCoin })`
        - `tx.transferObjects([dwalletCap], newUltronAddr)` — DWalletCap transfer in the same atomic tx.
     7. Sign with OLD Ultron keypair (owner of source share + cap). Submit.
     8. NEW Ultron accepts the re-encrypted share (separate tx, signed by new keypair, via `acceptEncryptedUserShare` flow).
6. **`ultronKeypair(env)` swap** — internally:
   - Read `ULTRON_PRIVATE_KEY`, derive the NEW seed (new address + new keeper key).
   - `UserShareEncryptionKeys.fromRootSeedKey(newSeed, curve)` + `decryptUserShare` on the now-re-encrypted on-chain share → plaintext.
   - Construct IKA signing context. Return an object matching the existing `Ed25519Keypair`-shaped surface so call sites don't change.
7. **Parallel-run** — keep the raw key path available behind `env.ULTRON_IKA_RUMBLED !== 'true'`. Flip the flag once DO signing has been verified end-to-end on mainnet with a low-stakes tx.
8. **Retire** — only after ceremony success + parallel-run window with zero fall-through, delete `SHADE_KEEPER_PRIVATE_KEY`. `ULTRON_PRIVATE_KEY` stays (it's the seed source for new share decryption; we can't delete it without a further rumble).

## DO method parameterization (repeatability)

`UltronSigningAgent._planReEncryptForNewOwner` / `_executeReEncryptForNewOwner` are parameterized on `{ fromEnvName, toEnvName, curve, dwalletId, encryptedShareId }` from day one. After the first live execution for Ultron, the same method rumbles any future agent (t2000s, chronicoms, chevallier) by passing different env names and DWalletCap spec — no per-agent forks.

## Address-churn sweep (Path B)

Ultron's address changes because imported-key DKG derives a fresh dWallet address from the new private key. Places to update after rotation:

- `public/suiami-identity.html` — Ultron address mentions.
- Memory: `project_ultron.md`, CLAUDE.md Ultron wallet references.
- Docs: `docs/superpowers/handoff-*` that pin the old address.
- `src/server/agents/shade-executor.ts` — if any hardcoded Ultron address (use `ultronAddress(env)` dynamically).

One commit per sweep slice, keep Pokemon-move cadence.

## Open questions (decide before execution)

1. **Single Auth Key or tiered?** Single = simpler; tiered = brando's Auth Key for ceremonial ops, DO Auth Key for per-request signing, refreshable.
2. **Auth Key rotation cadence?** Every 90 days? Every release? On-demand?
3. **Parallel-run window length?** Recommend ≥7 days on mainnet before retiring raw secret.

## Exit criteria

- No `ULTRON_PRIVATE_KEY` / `SHADE_KEEPER_PRIVATE_KEY` bindings on the Worker.
- `wrangler secret list` shows only encryption keys, never signing keys.
- Ultron signs a live mainnet tx via IKA co-signing, verified on Suiscan.
- Memory updated: First Commandment satisfied end-to-end for Ultron.
