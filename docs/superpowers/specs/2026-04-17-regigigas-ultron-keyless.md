# Regigigas — Ultron Keyless Rumble via IKA Encrypted User Share

**Issue:** #170
**Status:** Draft, awaiting user decision on bootstrap path
**Depends on:** Probopass #169 (fromSecretKey choke point — landed 2026-04-17)

## Goal

Retire `SHADE_KEEPER_PRIVATE_KEY` / `ULTRON_PRIVATE_KEY` as a raw Ed25519 secret on the Cloudflare Worker. Replace with:

- **User share** encrypted to a server-held **Authentication Key** (CF Secret, encryption-only).
- **IKA dWallet** holding ultron's public key via imported-key ed25519 DKG.
- DO signing: `ultronKeypair(env)` internally decrypts the share + co-signs with IKA network per-request.

First Commandment satisfied: no raw signing key on the Worker; co-signing requires brando.sui's encryption authority + IKA threshold.

## Prereqs

- IKA SDK: `prepareImportedKeyDWalletVerification(ikaClient, Curve.ED25519, ...)` — shipped (`reference_ika_imported_key_ed25519.md`).
- Imported-key path preserves ultron's existing address `0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3` — no name migration.
- Probopass Magnet Bomb done: all ultron signing funnels through `ultronKeypair(env)`, so the raw→IKA swap is one line inside `src/server/ultron-key.ts`.

## The fork: how does brando's browser obtain the raw ed25519 key for the DKG ceremony?

**Path A — One-shot bootstrap endpoint.**
A server endpoint that, when authenticated with a fresh `x-ultron-sig`, returns the raw bech32 to brando's browser, then unbinds the secret so the endpoint can never fire again. Pros: preserves the existing address end-to-end. Cons: key transits the network once (TLS); the endpoint must be genuinely one-shot (atomic env mutation) or it's a permanent back-door.

**Path B — Rotate, then rumble.**
Run `scripts/rotate-ultron.ts` (new; mirrors `scripts/rotate-ens-signer.ts`) to generate a fresh key locally, write the new secret to the Worker, **then** immediately run DKG from brando's browser with that fresh key. Retire the old keeper secret after sweep completes. Pros: no network-side exposure of the new key; we actually hold it during the ceremony. Cons: ultron's address changes — downstream references (docs, memory, any hardcoded `0xa84c...` constants) need updating.

**Recommendation:** Path B. Address churn is a one-pass sweep; a one-shot bootstrap endpoint is too tempting a permanent hole. The "imported-key preserves address" guarantee isn't free if the bootstrap is a liability.

## Path B — implementation shape

1. **`scripts/rotate-ultron.ts`** — generate ed25519 bech32, `wrangler secret put ULTRON_PRIVATE_KEY` over stdin, print ultron's new Sui address only. Delete `SHADE_KEEPER_PRIVATE_KEY` binding last.
2. **Browser rumble flow** (extend `src/ski.ts` `whelm()` pattern — `rumbleUltron(rawKey)`).
   - Run `prepareImportedKeyDWalletVerification(ikaClient, Curve.ED25519, rawKeyBytes, ...)`.
   - Encrypt resulting user share to an Authentication Key held by brando.sui (derived from a known encryption key; optionally re-encrypt to a second server-side Auth Key for Ultron's DO signing path).
   - Publish the encrypted share + DWalletCap to on-chain (SUIAMI roster entry for ultron.sui).
3. **New secret: `ULTRON_AUTH_KEY_BECH32`** — encryption key (not a signing key) held by the Worker. Decrypts ultron's user share in the DO before co-signing with IKA network. Rotation policy: every N days, re-encrypt share to fresh Auth Key.
4. **`ultronKeypair(env)` swap** — internally:
   - Read `ULTRON_AUTH_KEY_BECH32`, load encrypted share from durable storage (or IKA chain state).
   - Decrypt share, construct IKA signing context, return an object matching the existing `Ed25519Keypair`-shaped surface (`.sign(bytes)`, `.signTransaction(bytes)`, `.getPublicKey().toSuiAddress()`). Internally these route to `ikaClient.core.sign()` + the DWalletCap threshold.
5. **Parallel-run** — keep the raw key path in `ultronKeypair()` behind `env.ULTRON_IKA_RUMBLED !== 'true'`. Flip the flag once DO signing has been verified end-to-end on mainnet with a low-stakes tx.
6. **Retire** — after N days of parallel operation with zero `ULTRON_IKA_RUMBLED=false` falls-through, delete the raw `ULTRON_PRIVATE_KEY` binding. Done.

## Address-churn sweep (Path B)

Places to update after rotation:
- `contracts/shade/` — keeper address constants (if any).
- `public/suiami-identity.html` — ultron address mention(s).
- Memory: `project_ultron.md`, CLAUDE.md "Keeper wallet (0xa84c...)" references.
- Docs: `docs/superpowers/handoff-*` that pin the old address.
- `src/server/agents/shade-executor.ts` — if any hardcoded ultron address (use `ultronAddress(env)` dynamically).

One commit per sweep slice, keep Pokemon-move cadence.

## Open questions (decide before execution)

1. **Path A or Path B?** Recommend B.
2. **Single Auth Key or tiered?** Single = simpler; tiered = brando's Auth Key for ceremonial ops, DO Auth Key for per-request signing, refreshable.
3. **Rotate cadence for Auth Key?** Every 90 days? Every release? On-demand?
4. **Parallel-run window length?** Recommend ≥7 days on mainnet before retiring raw secret.

## Exit criteria

- No `ULTRON_PRIVATE_KEY` / `SHADE_KEEPER_PRIVATE_KEY` bindings on the Worker.
- `wrangler secret list` shows only encryption keys, never signing keys.
- Ultron signs a live mainnet tx via IKA co-signing, verified on Suiscan.
- Memory updated: First Commandment satisfied end-to-end for ultron.
