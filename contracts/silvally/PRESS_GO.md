# Silvally — Press-Go (mainnet-direct spike runbook)

Tomorrow's one-shot: publish to mainnet, provision a purpose-built dWallet,
prove `delegate_approve_spike` works against the real IKA network.
No throwaway gas — the dWallet you provision here becomes the first real
Crowd's cap.

## Pre-flight (confirm before pressing go)

- [ ] WaaP wallet connected, holds >1 SUI + >10 IKA (for Rumble + publish gas)
- [ ] `sui client active-env` points at mainnet
- [ ] Clean `git status` — uncommitted shim edits would break publish verification
- [ ] `cd contracts/silvally && sui move build` passes (currently does: M2 Bulk Up)

## Step 1 — Publish `silvally` to mainnet

```bash
cd contracts/silvally
sui client publish --gas-budget 300000000 --skip-dependency-verification
```

`--skip-dependency-verification` is load-bearing: the `ika_shim` local
package does NOT byte-match the real IKA bytecode (it's intentionally
a header-only shim). The linker will still resolve `approve_message` to
the real on-chain fn via `published-at = 0xdd24c627...` in `ika_shim/Move.toml`.

**Success signal:** publish returns a new `silvally` package id. Save it.

**Failure signals + fallback:**
- "dependency version mismatch" → the shim signature is wrong; `sui move disassemble` the real IKA coordinator module and regenerate the shim from actual bytecode.
- "unresolved function `approve_message`" → the package layout changed; re-run the SDK-grep that produced the current signatures (`grep -A 20 "approve_message" node_modules/@ika.xyz/sdk/dist/esm/generated/ika_dwallet_2pc_mpc/coordinator.d.ts`).

## Step 2 — Rumble one dWallet for `crowds.sui`

Use the existing `rumble()` in `src/ski.ts` (browser flow), or the
equivalent DKG ceremony via `@ika.xyz/sdk` in a node script.

```ts
import { IkaClient, IkaTransaction, Curve } from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';

const tx = new Transaction();
const ikaTx = new IkaTransaction({ ikaClient, transaction: tx, userShareEncryptionKeys });

const dWalletCap = ikaTx.requestDWalletDKG({
  curve: Curve.SECP256K1,
  dkgRequestInput: /* prepared via cryptography helpers */,
  sessionIdentifier,
  dwalletNetworkEncryptionKeyId: /* mainnet config */,
  ikaCoin: /* split */,
  suiCoin: tx.gas,
});

// After DKG completes on-chain, acceptEncryptedUserShare + registerEncryptionKey
// as in the existing project Rumble flow.
```

**Success signal:** a `DWalletCap` object id on mainnet, owned by the user's
address, with `dwallet_id` pointing to a newly-created dWallet.

## Step 3 — `init_policy` with the new DWalletCap

```ts
import { Transaction } from '@mysten/sui/transactions';

const tx = new Transaction();
const [ownerCap] = tx.moveCall({
  target: `${SILVALLY_PKG}::dwallet_subname_policy::init_policy`,
  arguments: [
    tx.object(DWALLET_CAP_ID),
    tx.pure.u64(100n),              // max_subnames
    tx.pure.u64(Date.now() + 365*24*60*60*1000), // expiration_ms = now + 1yr
  ],
});
tx.transferObjects([ownerCap], ACTIVE_ADDRESS);
await signAndExecute(tx);
```

**Success signal:** `PolicyCreated` event emitted, new shared `SubnamePolicy`
object id captured, `OwnerCap` transferred to you.

## Step 4 — The spike: delegate_approve_spike → requestSign

This is the load-bearing test. If the MessageApproval from our shared-object-
borrowed DWalletCap is honored by `request_sign`, Silvally is PROVEN.

```ts
const tx = new Transaction();
const ikaTx = new IkaTransaction({ ikaClient, transaction: tx, userShareEncryptionKeys });

// 1. Spike: get a MessageApproval via our policy module
const message = new Uint8Array(32).fill(0x42); // any 32 bytes
const [approval] = tx.moveCall({
  target: `${SILVALLY_PKG}::dwallet_subname_policy::delegate_approve_spike`,
  arguments: [
    tx.object(POLICY_ID),
    tx.object(IKA_COORDINATOR_ID),  // 0x5ea59bce034008a006425df777da925633ef384ce25761657ea89e2a08ec75f3
    tx.pure(bcs.vector(bcs.u8()).serialize(message)),
    tx.object(SUI_CLOCK),
  ],
});

// 2. Presign
const [presignCap] = ikaTx.requestPresign({ dWallet, signatureAlgorithm, ikaCoin, suiCoin });
const verifiedPresignCap = ikaTx.verifyPresignCap({ unverifiedPresignCap: presignCap });

// 3. Sign using the policy-produced approval
await ikaTx.requestSign({
  dWallet,
  messageApproval: approval,        // <-- from our policy, not from approveMessage()
  hashScheme: Hash.KECCAK256,
  verifiedPresignCap,
  presign,
  encryptedUserSecretKeyShare,
  message,
  signatureScheme: SignatureAlgorithm.ECDSASecp256k1,
  ikaCoin, suiCoin,
});

await signAndExecute(tx);
```

**Success signal:** Signature returned. Verify off-chain via `secp256k1` lib.
Pattern PROVEN.

**Failure signals + fallbacks:**
- IKA coordinator rejects the approval with "invalid approval source" →
  the network does gate approvals by caller type. Pivot to escrow fallback:
  owner re-encrypts user-share to the Crowd's IKA agent key; Move-side
  allowlist gates SDK fetch. Ugly but First-Commandment-compliant.
- Transaction aborts inside `approve_message` with an unfamiliar code →
  `sui client tx-block <digest>` to get the abort, decode against real
  IKA source (disassemble coordinator module).

## Step 5 — Use it as the first Crowd

If step 4 passed, `crowds.sui` / the dWallet you provisioned IS the first
Crowd. Don't retire it. Attach the first disc:
- `initial_disc = { max_subnames: 100, expiration_ms: event_end }`
- Offer it to members via existing `/rumble` UI flow.

## Rollback plan

All of Silvally lives in one new package. If the whole pattern proves
non-viable, abandon the package — the dWallet you provisioned in Step 2
still works as a normal IKA dWallet for non-Crowds use.

## Time estimate

- Step 1 publish: ~2 min
- Step 2 Rumble: ~5–10 min (DKG ceremony)
- Step 3–4 init + spike: ~2 min
- Total press-go: ~15 min on a fresh brain
