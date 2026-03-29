# IKA dWallet BAM Bridge — Burn-Attest-Mint Cross-Chain Stablecoin

## Problem

SOL sits idle on the IKA dWallet's Solana address. There's no way to use it for SuiNS registrations or purchases on Sui. CCTP v2 isn't on Sui until June 2026. Wormhole adds trust assumptions and complexity. We need a bridgeless cross-chain transfer using only the dWallet as the trust root.

## Core Insight

The IKA dWallet IS the bridge. A single dWallet holds keys on both Solana (ed25519/EdDSA) and Sui (secp256k1/ECDSA). It can sign transactions on both chains atomically. No external bridge, no guardians, no centralized keeper — the 2PC-MPC threshold signature IS the attestation.

## Lexicon

| Term | Meaning |
|------|---------|
| **BAM** | Burn-Attest-Mint — the cross-chain transfer pattern |
| **dWallet** | IKA's programmable multi-chain signing primitive |
| **SKUSD** | The bridge stablecoin (SKI USD) — exists on both Solana and Sui |
| **Burn** | Destroy SKUSD on the source chain |
| **Attest** | The dWallet signature itself IS the attestation (no separate step) |
| **Mint** | Create SKUSD on the destination chain |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    IKA dWallet                           │
│              (2PC-MPC threshold signer)                  │
│                                                         │
│   ed25519 key ──────────────── secp256k1 key            │
│       │                              │                  │
│   Signs Solana txs               Signs Sui txs          │
│       │                              │                  │
│   ┌───▼───┐                    ┌─────▼─────┐            │
│   │Solana │                    │   Sui     │            │
│   │SPL    │                    │   Move    │            │
│   │Token  │                    │   Coin    │            │
│   └───────┘                    └───────────┘            │
│                                                         │
│   Burn SKUSD ─── dWallet signs both ──── Mint SKUSD     │
│   on Solana      atomically              on Sui         │
└─────────────────────────────────────────────────────────┘
```

## How It Works — No Bridge Needed

### The Key Realization

Traditional bridges need an attestation layer (Wormhole guardians, CCTP attesters) because the signer on chain A is different from the signer on chain B. With IKA, **the same dWallet signs on both chains**. The dWallet's multi-chain signature is the proof.

### Flow: SOL → Sui

1. **User has SOL** on their dWallet's Solana address
2. **Swap SOL → USDC** on Solana (Jupiter aggregator, single Solana tx signed by dWallet)
3. **Burn SKUSD on Solana** — the dWallet signs a Solana SPL token burn instruction
4. **Mint SKUSD on Sui** — the dWallet signs a Sui Move call to mint the same amount
5. **Swap SKUSD → SUI** on Sui (DeepBook/Cetus, already have this infrastructure)

Steps 3-4 happen atomically — the Sui Move contract verifies the burn by checking the dWallet's signature authority. Since the same dWallet controls both the Solana burn authority and the Sui mint authority, the signature IS the attestation.

### Why This Is Trustless

- The dWallet uses 2PC-MPC — the user MUST participate in every signature
- IKA's network of nodes provides the other half — no single point of compromise
- The Sui Move contract only mints if the dWallet (mint authority) signs
- The Solana program only burns if the dWallet (burn authority) signs
- No external oracles, no guardian sets, no relayers

## Token Design: SKUSD

### Solana Side (SPL Token)

```
Token: SKUSD
Decimals: 6 (matches USDC)
Mint Authority: dWallet's ed25519 Solana address
Freeze Authority: dWallet's ed25519 Solana address (or none)
```

- Created via `spl-token create-token` with the dWallet address as mint authority
- Burn: standard SPL `burn` instruction (anyone can burn their own tokens)
- Mint: only the dWallet can mint (SPL `mintTo` requires mint authority signature)

### Sui Side (Move Coin)

```move
module skusd::skusd;

use sui::coin::{Self, TreasuryCap};

public struct SKUSD has drop {}

/// Mint — only callable by the dWallet's Sui address (enforced by TreasuryCap ownership)
public entry fun mint(
    treasury_cap: &mut TreasuryCap<SKUSD>,
    amount: u64,
    recipient: address,
    ctx: &mut TxContext,
) {
    coin::mint_and_transfer(treasury_cap, amount, recipient, ctx);
}

/// Burn — anyone can burn their own SKUSD
public entry fun burn(
    treasury_cap: &mut TreasuryCap<SKUSD>,
    coin: Coin<SKUSD>,
) {
    coin::burn(treasury_cap, coin);
}
```

- `TreasuryCap` owned by the dWallet's Sui address (via secp256k1 key)
- Minting requires signing a Sui tx with the dWallet — enforces atomicity with Solana burn

## IKA Signing Flow

Using the existing `@ika.xyz/sdk` v0.3.1 and our `ika-signing.ts` adapter:

### Solana Signing (ed25519/EdDSA)

```typescript
// From chains.ts — Solana uses ed25519
const solanaChain: ChainConfig = {
  curve: IkaCurve.ED25519,
  signatureAlgorithm: SignatureAlgorithm.EdDSA,
  hashScheme: HashScheme.SHA512,
};

// Sign a Solana burn transaction with the dWallet
const burnTx = buildSolanaBurnTx(amount, userTokenAccount);
const burnSig = await ikaSigning.requestSignature({
  dwalletCapId: dWallet.capId,
  message: burnTx.serializeMessage(),
  curve: IkaCurve.ED25519,
  signatureAlgorithm: SignatureAlgorithm.EdDSA,
  hashScheme: HashScheme.SHA512,
  ...presignParams,
});
```

### Sui Signing (secp256k1/ECDSA)

```typescript
// The same dWallet also has a secp256k1 key for Sui
const mintTx = buildSuiMintTx(amount, recipient);
const mintSig = await ikaSigning.requestSignature({
  dwalletCapId: dWallet.capId,
  message: mintTx.digest(),
  curve: IkaCurve.SECP256K1,
  signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
  hashScheme: HashScheme.KECCAK256,
  ...presignParams,
});
```

### Atomicity

Both signatures use the same dWallet. The 2PC-MPC ceremony requires user participation for EACH signature. The user signs both in sequence:

1. User approves Solana burn → dWallet produces ed25519 signature
2. User approves Sui mint → dWallet produces secp256k1 signature
3. Submit Solana burn tx
4. Submit Sui mint tx

If step 3 succeeds but step 4 fails, the user can retry step 4 — the dWallet still has authority to mint. The burn is irreversible but the mint can be retried.

## BAM Without Bridging — The IKA Way

### What Makes This Different

Traditional bridges:
```
Chain A → Lock/Burn → [Bridge Attestation Layer] → Mint/Unlock → Chain B
                      ↑ trust assumption here
```

IKA BAM:
```
Chain A → Burn (dWallet signs) → Mint (same dWallet signs) → Chain B
          ↑ same signer, no bridge needed
```

The "attestation" is implicit — if the same dWallet signed both the burn and the mint, and the dWallet's key is the mint authority on both chains, the cross-chain transfer is valid by construction.

### BAM Events (Sui-side)

For auditability, the Sui Move contract emits BAM events:

```move
public struct BAMBurn has copy, drop {
    source_chain: String,     // "solana"
    amount: u64,
    source_tx_hash: vector<u8>, // Solana tx signature
    dwallet_id: address,
}

public struct BAMMint has copy, drop {
    dest_chain: String,       // "sui"
    amount: u64,
    recipient: address,
    dwallet_id: address,
}
```

These events create an on-chain audit trail linking burns to mints. Anyone can verify the 1:1 correspondence by scanning events.

## Implementation Plan

### Phase 1: SKUSD Token Deployment
1. Deploy SKUSD Move module on Sui (TreasuryCap to dWallet address)
2. Create SKUSD SPL token on Solana (mint authority = dWallet ed25519 address)
3. Initial supply: 0 on both chains (mint-on-demand)

### Phase 2: SOL → SKUSD on Solana
1. User swaps SOL → USDC on Solana via Jupiter (dWallet signs Solana tx)
2. User deposits USDC to mint SKUSD (or SKUSD is backed 1:1 by USDC in a vault)

### Phase 3: BAM Transfer
1. Burn SKUSD on Solana (dWallet ed25519 signature)
2. Mint SKUSD on Sui (dWallet secp256k1 signature)
3. Both signed via IKA 2PC-MPC ceremony

### Phase 4: SKUSD → SUI on Sui
1. Swap SKUSD → SUI on DeepBook/Cetus (existing swap infrastructure)
2. SUI available for SuiNS registrations, gas, etc.

### Phase 5: Reverse (Sui → Solana)
1. Burn SKUSD on Sui (anyone can burn their own coins)
2. Mint SKUSD on Solana (dWallet ed25519 signs SPL mintTo)
3. Swap SKUSD → SOL on Solana

## Prerequisites

- [ ] IKA ed25519 dWallet with Solana address (already have this)
- [ ] IKA secp256k1 dWallet with Sui address (already have this)
- [ ] Presign pool for both curves (need to implement pooling)
- [ ] Solana transaction builder (SPL token instructions)
- [ ] Jupiter aggregator integration (SOL ↔ USDC on Solana)
- [ ] SKUSD Move module deployed on Sui
- [ ] SKUSD SPL token created on Solana
- [ ] DeepBook/Cetus pool for SKUSD (or route through USDC)

## CCTP v2 Note

Circle CCTP v2 arrives on Sui by June 2026. Once live, USDC can move natively between Solana and Sui via CCTP. At that point:
- SKUSD becomes unnecessary for USDC bridging
- The BAM pattern remains useful for non-USDC assets
- The dWallet bridge can handle ANY token, not just Circle-approved stablecoins

## Security Considerations

- **dWallet compromise**: Requires compromising BOTH the user AND the IKA network (2PC-MPC)
- **Supply integrity**: Total SKUSD across both chains must equal total backing. BAM events enable verification.
- **Solana finality**: Wait for Solana tx confirmation before minting on Sui (~400ms slot time, ~32 slot finality)
- **Replay protection**: Each BAM transfer includes the Solana tx signature as a nonce — Sui contract rejects duplicate mints
- **No wrapped tokens**: SKUSD is native on both chains, not wrapped. Burn destroys, mint creates.

## References

- [IKA Documentation](https://docs.ika.xyz)
- [IKA SDK README](node_modules/@ika.xyz/sdk/README.md) — v0.3.1
- [IKA 2PC-MPC Paper](https://ika.xyz/blog/ika-2pc-mpc-redefines-mpc)
- [IKA EdDSA Expansion](https://bitcoinethereumnews.com/tech/ika-expands-native-support-to-solana-zcash-and-others-with-eddsa-signatures/)
- [Circle CCTP v2 Timeline](https://www.circle.com/blog/cctp-version-updates) — Sui by H1 2026
- [SKI Existing IKA Integration](src/client/ika.ts, src/client/ika-signing.ts, src/client/chains.ts)
