# IKA dWallets, Multi-Chain Cryptography & Quantum Resistance

## Overview

SKI uses [IKA](https://docs.ika.xyz) (formerly dWallet Network) to give users native cross-chain addresses — real Bitcoin, Ethereum, and Solana addresses controlled by Sui smart contracts through 2PC-MPC threshold signing. No bridges, no wrapping, no custodians.

This document covers the cryptographic foundations, how the signature schemes differ across chains, and how Sui's architecture — combined with IKA's modular design — positions users for a smooth transition to post-quantum cryptography.

---

## Signature Schemes by Chain

### secp256k1 (Bitcoin + EVM)

One secp256k1 dWallet covers Bitcoin and all EVM chains because they share the same curve:

| Chain | Algorithm | Hash | Address Derivation |
|-------|-----------|------|--------------------|
| Bitcoin | ECDSA / Taproot (BIP-340) | SHA-256 | RIPEMD160(SHA256(pubkey)) → bech32 |
| Ethereum | ECDSA | Keccak-256 | Last 20 bytes of keccak256(uncompressed[1:]) |
| Base, Polygon, Arbitrum, Optimism | ECDSA | Keccak-256 | Same as Ethereum |

- **Public key**: 33 bytes compressed (02/03 prefix + 32-byte x-coordinate)
- **Signature**: 64-byte (r, s) pair
- **IKA curve**: `Curve.SECP256K1`

### ed25519 (Solana)

Solana requires a separate ed25519 dWallet — different curve, different DKG ceremony:

| Chain | Algorithm | Hash | Address Derivation |
|-------|-----------|------|--------------------|
| Solana | EdDSA | SHA-512 (internal) | base58(raw 32-byte pubkey) |

- **Public key**: 32 bytes (y-coordinate with sign bit)
- **Signature**: 64-byte EdDSA signature (deterministic — no random nonce)
- **IKA curve**: `Curve.ED25519`

### Key Difference

secp256k1 uses **ECDSA** with random nonces. ed25519 uses **EdDSA** with deterministic nonces derived from the message + key. EdDSA's determinism eliminates an entire class of nonce-reuse attacks that have historically plagued ECDSA implementations.

A user who wants both BTC and SOL addresses needs **two dWallets** (two DKG ceremonies). The secp256k1 dWallet covers BTC + 6 EVM chains. The ed25519 dWallet covers Solana.

---

## Quantum Vulnerability

Both secp256k1 and ed25519 are vulnerable to **Shor's algorithm** — a quantum algorithm that solves the discrete logarithm problem in polynomial time. A sufficiently powerful quantum computer could derive private keys from public keys on any of these chains.

### Impact by Chain

| Chain | Scheme | Quantum Risk | Migration Difficulty |
|-------|--------|-------------|---------------------|
| **Bitcoin** | secp256k1 ECDSA | High — public keys exposed after first spend | Hard — no native scheme-switching mechanism |
| **Ethereum** | secp256k1 ECDSA | High — same exposure model | Hard — requires account abstraction or protocol changes |
| **Solana** | ed25519 EdDSA | High — but RFC 8032 enables backward-compatible migration | Moderate — Mysten Labs research shows a path |
| **Sui** | Multi-scheme (flag byte) | **Designed for this** — add new scheme via flag byte | Easy — no hard fork, no address migration |

### Timeline

Expert consensus places cryptographically relevant quantum computers at **10–20 years out**, though this forecast carries significant uncertainty. 24 of the top 26 blockchain protocols currently rely on quantum-vulnerable signature schemes.

---

## Mysten Labs' Post-Quantum Research

### "Post-Quantum Readiness in EdDSA Chains" (2025)

**Paper**: [ePrint 2025/1368](https://eprint.iacr.org/2025/1368)
**Authors**: Foteini Baldimtsi, Konstantinos Chalkias, Arnab Roy (Mysten Labs)

This paper describes **the first backward-compatible quantum-safe upgrade path for EdDSA blockchain wallets**. Key contributions:

1. **No address changes** — Users can migrate to quantum-resistant signatures while keeping their existing addresses and funds.
2. **No hard fork** — The upgrade is backward-compatible at the protocol level.
3. **Proof of seed ownership** — Users prove they control their account's seed without revealing the seed or private key, then transition to a new quantum-safe scheme.
4. **Multi-chain applicability** — Covers Sui, Solana, Near, Stellar, and Cosmos (all EdDSA chains).

### Sui's Cryptographic Agility

Sui was built from the ground up for **signature scheme flexibility**. The architecture uses a flag-byte prefix on all signatures:

```
serialized_signature = flag || sig || pk

flag bytes:
  0x00 = Ed25519
  0x01 = Secp256k1
  0x02 = Secp256r1
  0x03 = Multisig
  0x04 = (reserved for post-quantum)
```

Addresses are derived scheme-agnostically:

```
address = BLAKE2b-256([flag_byte] || public_key)
```

Adding a post-quantum scheme (e.g., CRYSTALS-Dilithium, FALCON, SPHINCS+) requires only:
1. A new flag byte value
2. A verification function implementation
3. **No hard fork. No address migration. No disruption to existing users.**

This is a direct architectural advantage over Bitcoin and Ethereum, which would require far more disruptive protocol changes.

### NIST Post-Quantum Candidates Under Consideration

| Scheme | Type | Signature Size | Notes |
|--------|------|---------------|-------|
| CRYSTALS-Dilithium | Lattice-based | ~2.4 KB | Practical for high-throughput chains |
| FALCON | Lattice-based | ~666 B | Smaller sigs, more complex implementation |
| SPHINCS+ | Hash-based | ~8–49 KB | Stateless, conservative security assumptions |

---

## How IKA Fixes This

IKA's architecture is uniquely positioned for the quantum transition:

### 1. Modular Per-Curve DKG

Each dWallet is created for a specific curve via a separate DKG ceremony. When post-quantum curves are standardized, IKA can add support for new curves (e.g., lattice-based schemes) without modifying or invalidating existing dWallets.

```
Today:
  dWallet A (secp256k1) → BTC + ETH + EVM chains
  dWallet B (ed25519)   → Solana

Future:
  dWallet A (secp256k1) → BTC + ETH (legacy, still works)
  dWallet B (ed25519)   → Solana (legacy, still works)
  dWallet C (dilithium) → Post-quantum signing for all chains that adopt it
```

Users migrate at their own pace. Old dWallets remain functional until the chains themselves deprecate vulnerable schemes.

### 2. Sui-Native Security Governance

Because IKA dWallets are governed by Sui smart contracts, the signing policy (who can sign, under what conditions) is enforced on-chain by Sui. When Sui adopts post-quantum authentication:

- The **user's Sui account** is protected by Sui's post-quantum signature scheme
- The **dWallet's signing policy** is enforced by Sui's post-quantum-secured consensus
- The **cross-chain signature** remains whatever the target chain requires (secp256k1 for BTC, ed25519 for SOL)

This means even if Bitcoin or Solana haven't yet adopted post-quantum schemes, the **authorization layer** (Sui) is already quantum-safe. An attacker would need to break both Sui's post-quantum authentication AND IKA's 2PC-MPC protocol.

### 3. 2PC-MPC Threshold Security

IKA's 2PC-MPC protocol provides an additional security layer:

- **Non-collusive** — Neither the user nor the network alone can produce a valid signature
- **100+ mainnet operators** — Byzantine fault tolerance with threshold signing
- **Key shares are never combined** — The full private key never exists in any single location

Even if a quantum attacker could theoretically break the underlying curve, they would need to compromise both the user's share AND a threshold of network operators simultaneously — a significantly harder attack than breaking a single key.

### 4. Smooth Migration Path

When chains adopt post-quantum schemes:

1. IKA adds `Curve.DILITHIUM` (or equivalent) to its SDK
2. Users run a new DKG ceremony for the post-quantum curve
3. New dWallet generates addresses compatible with the target chain's post-quantum scheme
4. Old dWallets continue to function for legacy transactions
5. Users transfer funds from old addresses to new post-quantum addresses at their convenience

No emergency migration. No fund lockups. No coordination problems.

---

## References

- [Post-Quantum Readiness in EdDSA Chains (ePrint 2025/1368)](https://eprint.iacr.org/2025/1368)
- [Securing Sui in the Quantum Computing Era](https://blog.sui.io/post-quantum-computing-cryptography-security/)
- [Cryptography in Sui: Agility](https://www.mystenlabs.com/blog/cryptography-in-sui-agility)
- [Sui and the Blockchain Quadlemma (Dr. Kostas Chalkias)](https://www.ccn.com/education/crypto/sui-blockchain-quadlemma-quantum-safety-ai-zk-tunnels-kostas-chalkias-explained/)
- [IKA Documentation](https://docs.ika.xyz)
- [NIST Post-Quantum Cryptography Standards](https://csrc.nist.gov/projects/post-quantum-cryptography)
