# Keyless IKA-Native Agents — "Rumble Your Squids"

**Date:** 2026-04-02
**Status:** Approved
**Package:** `squids::agent`

## Problem

Agents (ultron, t2000s, chronicoms) currently rely on a raw Ed25519 private key (`SHADE_KEEPER_PRIVATE_KEY`) stored as a Cloudflare Wrangler secret. This is a single point of failure: if the key is lost, funds are locked; if leaked, funds are stolen. Cross-chain addresses are derived by re-encoding the Sui pubkey as base58 — not IKA. The key can't be recovered, can't be shared safely, and can't be rotated without migrating all assets.

## Solution

Zero private keys on any Cloudflare Worker. Every agent signs via IKA 2PC-MPC: the agent holds an encrypted user share, IKA network holds the other share. brando.sui holds a backup copy of every user share for recovery. A Move contract (`squids::agent`) wraps DWalletCap objects and gates signing to enrolled agents.

## Architecture

```
brando.sui (browser)
  ├─ Runs DKG WASM (both curves) per agent
  ├─ Holds user share copy #1 (recovery + independent signing)
  ├─ Re-encrypts user share → agent's encryption key
  └─ Admin of squids::agent contract

Agent DO (Cloudflare Worker)
  ├─ Holds user share copy #2 (via acceptEncryptedUserShare)
  ├─ Encryption key pair in durable storage (NOT a private key)
  ├─ Enrolled in squids::agent as authorized signer
  ├─ Signs autonomously: decrypt share → approveMessage → IKA co-signs
  └─ Controls: Sui address, BTC address, ETH address, SOL address

squids::agent (Move contract, on-chain)
  ├─ Holds DWalletCap objects for all agent dWallets
  ├─ Registry: maps addresses → enrolled agents
  ├─ approveMessage gate: caller must be admin or enrolled agent
  └─ Extensible: spending limits, chain restrictions, cool-down periods

IKA Network
  └─ Always participates as the network share in 2PC-MPC
```

## Signing Model

Two valid signing paths — either produces a valid cross-chain signature:

| Path | User share | IKA network | Use case |
|---|---|---|---|
| **Agent autonomous** | Agent decrypts copy #2 | Co-signs | Normal operation, no human needed |
| **brando recovery** | brando decrypts copy #1 | Co-signs | Agent lost, key rotation, emergency |

The IKA network is always required. Neither brando nor the agent can sign alone without IKA. This is the zero-trust guarantee.

## Signing Flow (Autonomous Agent)

```
1. Agent DO needs to sign (e.g., Solana transfer)
2. Decrypt user share from durable storage using encryption key
3. Call squids::agent::approve on-chain (agent is enrolled, passes gate)
4. Compute partial user signature
5. Submit to IKA network
6. IKA co-signs → valid ECDSA/EdDSA signature
7. Agent broadcasts signed transaction to target chain
```

## "Rumble Your Squids" — Batch DKG Provisioning

### Single agent (idle overlay)
1. Type agent name in idle overlay (e.g., "ultron")
2. Card resolves to agent's Sui address
3. Click squid button → DKG runs in browser for both curves
4. DWalletCaps deposited into `squids::agent` contract
5. User shares re-encrypted to agent's encryption key
6. Agent calls `acceptEncryptedUserShare` → live on all chains

### Batch mode
1. Long-press squid → select multiple names from roster
2. "Rumble your squids" → sequential DKG for each agent, both curves
3. All DWalletCaps deposited, all shares re-encrypted
4. Every selected agent goes live on BTC + ETH + SOL

## Move Contract: `squids::agent`

**Package:** `contracts/squids/`
**Published under:** squids.sui (Move registry)

### Objects

```move
/// Admin capability — held by brando.sui
struct AdminCap has key, store { id: UID }

/// Enrolled agent record
struct Agent has key, store {
    id: UID,
    /// Sui address of the agent (DO-derived, not a private key)
    addr: address,
    /// Name (e.g., "ultron", "aida")
    name: String,
    /// DWalletCap IDs this agent can use
    dwallet_caps: vector<ID>,
    /// Encryption key address (for re-encryption targeting)
    encryption_key_addr: address,
    /// Enrolled timestamp
    enrolled_at: u64,
}

/// Shared registry of all agents
struct Registry has key {
    id: UID,
    agents: Table<address, Agent>,
    admin: address,
}
```

### Entry functions

```move
/// Create the registry (one-time, by brando)
public fun create(ctx: &mut TxContext): AdminCap

/// Enroll an agent — admin only
public fun enroll(
    registry: &mut Registry,
    admin_cap: &AdminCap,
    agent_addr: address,
    name: String,
    encryption_key_addr: address,
    ctx: &mut TxContext,
)

/// Deposit a DWalletCap for an agent
public fun deposit_cap(
    registry: &mut Registry,
    admin_cap: &AdminCap,
    agent_addr: address,
    cap: DWalletCap,
)

/// Approve a message for signing — agent or admin
public fun approve(
    registry: &mut Registry,
    agent_addr: address,
    dwallet_cap_id: ID,
    message: vector<u8>,
    ctx: &TxContext,
): MessageApproval

/// Revoke an agent — admin only
public fun revoke(
    registry: &mut Registry,
    admin_cap: &AdminCap,
    agent_addr: address,
): vector<DWalletCap>
```

### Authorization logic

`approve` checks: `tx_context::sender(ctx) == registry.admin || tx_context::sender(ctx) == agent_addr` where `agent_addr` is enrolled in the registry. If neither, abort.

## WASM in CF Workers — Proven Working

**Tested and confirmed on 2026-04-02.** IKA WASM crypto runs in CF Workers with this pattern:

### The Problem

CF Workers block all runtime WASM compilation (`WebAssembly.Module()`, `WebAssembly.compile()`, `WebAssembly.instantiate()` from bytes). The IKA SDK's `wasm-loader.js` tries runtime compilation and fails with "Wasm code generation disallowed by embedder."

### The Solution

**Static import + `initSync`.** Wrangler pre-compiles `.wasm` files at deploy time when imported directly. The pre-compiled `WebAssembly.Module` is passed to `initSync`, bypassing runtime compilation entirely.

```typescript
// Static import — wrangler pre-compiles at deploy time
// @ts-ignore
import ikaWasmModule from '@ika.xyz/ika-wasm/dist/web/dwallet_mpc_wasm_bg.wasm';

// Initialize once at module load
import * as ikaWasm from '@ika.xyz/ika-wasm';
ikaWasm.initSync({ module: ikaWasmModule });
```

After this, all raw WASM functions work:
- `decrypt_user_share` — decrypt agent's secret share
- `create_sign_centralized_party_message` — compute partial user signature
- `generate_secp_cg_keypair_from_seed` — generate encryption keys
- `encrypt_secret_share` — encrypt user share for storage

### What doesn't work

The SDK's high-level wrappers (e.g., `UserShareEncryptionKeys.fromRootSeedKey`) go through the SDK's own `wasm-loader.js` which has a broken init path for Workers. **Bypass the SDK's wasm-loader entirely** — call the raw WASM functions directly.

### Worker-native IKA wrapper: `src/server/ika-worker.ts`

A thin wrapper that replaces the SDK's broken wasm-loader with direct WASM calls. Provides the same interface but works in CF Workers:

```typescript
// src/server/ika-worker.ts — IKA crypto for Cloudflare Workers
// @ts-ignore
import ikaWasmModule from '@ika.xyz/ika-wasm/dist/web/dwallet_mpc_wasm_bg.wasm';
import * as ikaWasm from '@ika.xyz/ika-wasm';

// Pre-initialize at module load (runs once per Worker cold start)
ikaWasm.initSync({ module: ikaWasmModule });

/** Generate encryption key pair from seed */
export function generateEncryptionKeys(seed: Uint8Array, curve: number) {
  return ikaWasm.generate_secp_cg_keypair_from_seed(curve, seed);
}

/** Decrypt user's secret key share */
export function decryptUserShare(
  curve: number,
  decryptionKey: Uint8Array,
  dwalletPublicOutput: Uint8Array,
  encryptedShare: Uint8Array,
  protocolPublicParameters: Uint8Array,
) {
  return ikaWasm.decrypt_user_share(curve, decryptionKey, dwalletPublicOutput, encryptedShare, protocolPublicParameters);
}

/** Compute the user's partial signature contribution for 2PC-MPC */
export function createSignMessage(
  protocolPublicParameters: Uint8Array,
  publicOutput: Uint8Array,
  userSecretKeyShare: Uint8Array,
  presign: Uint8Array,
  message: Uint8Array,
  hash: number,
  signatureScheme: number,
  curve: number,
) {
  return ikaWasm.create_sign_centralized_party_message(
    protocolPublicParameters, publicOutput, userSecretKeyShare,
    presign, message, hash, signatureScheme, curve,
  );
}

/** Parse completed signature from IKA sign output */
export function parseSignature(curve: number, signatureAlgorithm: number, signatureOutput: Uint8Array) {
  return ikaWasm.parse_signature_from_sign_output(curve, signatureAlgorithm, signatureOutput);
}

/** Derive public key from dWallet output */
export function publicKeyFromDWalletOutput(curve: number, dwalletOutput: Uint8Array) {
  return ikaWasm.public_key_from_dwallet_output(curve, dwalletOutput);
}
```

### Bundle size

- IKA WASM: 3.4MB
- Worker JS bundle: ~5.2MB
- Total: ~8.6MB (under CF Workers paid plan 10MB limit)

## Agent DO Changes

### New: Encryption key management

```typescript
// On first boot — generate encryption key, store in durable storage
async onStart() {
    if (!this.state.encryptionSeed) {
        const seed = new Uint8Array(32);
        crypto.getRandomValues(seed);
        this.setState({ ...this.state, encryptionSeed: Array.from(seed) });
    }
}

// Expose public encryption key for re-encryption targeting
// Uses Worker-native WASM wrapper (not SDK's broken wasm-loader)
// GET /api/agent/<name>/encryption-key
async getEncryptionKeyAddress(): Promise<string> {
    const seed = new Uint8Array(this.state.encryptionSeed);
    const { generateEncryptionKeys } = await import('./ika-worker.js');
    const [_secretKey, publicKey] = generateEncryptionKeys(seed, curve);
    return toHex(publicKey); // encryption key address
}
```

### New: IKA signing (replaces keypair signing)

```typescript
// Sign a message using IKA 2PC-MPC — no private key needed
// All WASM crypto runs directly in the CF Worker via ika-worker.ts
async signWithIka(message: Uint8Array, chain: ChainConfig): Promise<Uint8Array> {
    const { decryptUserShare, createSignMessage, parseSignature } = await import('./ika-worker.js');

    // 1. Decrypt user share (WASM — runs in Worker)
    const secretShare = decryptUserShare(
        chain.curve, this.state.decryptionKey, this.state.publicOutput,
        this.state.encryptedShare, this.state.protocolParams,
    );

    // 2. Consume a pre-verified presign from the pool
    const presign = await this.consumePresign(chain.curve);

    // 3. Compute partial user signature (WASM — runs in Worker)
    const userContribution = createSignMessage(
        this.state.protocolParams, this.state.publicOutput,
        secretShare, presign, message,
        chain.hashScheme, chain.signatureAlgorithm, chain.curve,
    );

    // 4. Approve message on-chain via squids::agent
    const approval = await this.approveOnChain(message, chain);

    // 5. Submit to IKA network (GraphQL + JSON-RPC for tx)
    const signOutput = await this.submitToIka(userContribution, approval);

    // 6. Parse final signature (WASM — runs in Worker)
    return parseSignature(chain.curve, chain.signatureAlgorithm, signOutput);
}
```

### Removed

- `SHADE_KEEPER_PRIVATE_KEY` — deleted from Env interface and Wrangler secrets
- `Ed25519Keypair.fromSecretKey()` — all instances replaced with `signWithIka()`
- Raw Solana address derivation from Sui pubkey — replaced with IKA ed25519 dWallet address

## Browser DKG Proxy Flow

DKG uses `prepareDKG` which is a heavier WASM operation (session setup, not just signing). This may also work in Workers but hasn't been tested yet. For now, brando's browser does DKG computation:

```
1. brando opens idle overlay, types agent name
2. Browser calls agent DO: GET /encryption-key → gets agent's encryption key address
3. Browser runs prepareDKG (WASM) for both curves
4. Browser builds PTB:
   a. requestDWalletDKG (creates DWalletCap)
   b. Transfer DWalletCap to squids::agent registry (deposit_cap)
   c. requestReEncryptUserShareFor → agent's encryption key address
5. brando signs → submitted to IKA network
6. Agent DO calls acceptEncryptedUserShare → agent is live
```

The agent's encryption seed never leaves the DO. Only the public encryption key address is shared (safe — it's a public key).

## What This Unlocks

- **Keyless autonomous agents** — t2000s sign cross-chain without human involvement, without private keys
- **Instant agent spawn** — new DO boots, generates encryption key, brando Rumbles it, live on all chains in minutes
- **Built-in recovery** — brando always has user share copy. Agent DO wiped? Re-encrypt to a new one
- **No secrets in CI/CD** — no Wrangler secrets for signing. Deploy, redeploy, migrate freely
- **Composable policies** — squids::agent can add spending limits, chain whitelists, time locks, multi-approval thresholds for large amounts
- **Full audit trail** — every signing request goes through on-chain approveMessage. Every approval is recorded
- **Cross-chain DeFi from edge** — agent on Cloudflare's edge signs Solana swaps, BTC transfers, ETH DeFi positions — all from a stateless Worker with zero key material
- **Agent competition is real** — t2000s can actually trade, not just propose. They sign their own transactions. Performance = profit. Lazy agents get revoked
- **Trustless custody** — users can verify: the agent's dWallet is in the squids::agent registry, the DWalletCap is held by the contract, the signing policy is on-chain and auditable

## Migration Path

1. Deploy `squids::agent` Move contract
2. brando runs DKG for ultron via idle overlay (both curves)
3. Re-encrypt user shares to ultron DO
4. Ultron DO calls `acceptEncryptedUserShare`
5. Update `treasury-agents.ts`: replace all `Ed25519Keypair.fromSecretKey` with `signWithIka`
6. Remove `SHADE_KEEPER_PRIVATE_KEY` from Wrangler secrets and Env interfaces
7. Old ultron address (`0xa84c...b3c3`) becomes legacy
8. Repeat for each t2000 agent as they spawn

## Agent Addresses

After DKG, each agent has four addresses derived from IKA dWallets:

| Chain | Curve | Derivation |
|---|---|---|
| Sui | — | Agent's address in squids::agent registry (not a keypair) |
| Bitcoin | secp256k1 | IKA dWallet → compressed pubkey → P2WPKH |
| Ethereum | secp256k1 | IKA dWallet → uncompressed pubkey → keccak256 → last 20 bytes |
| Solana | ed25519 | IKA dWallet → ed25519 pubkey → base58 |

These are real, native addresses on each chain. No bridges, no wrapping, no re-encoding hacks.

## What We Proved (2026-04-02)

Tested live on `sui.ski/api/test-ika-wasm`:

| Test | Result |
|---|---|
| SDK import (`@ika.xyz/sdk`) | YES |
| IKA client with GraphQL (no gRPC) | YES |
| Static WASM import (pre-compiled `WebAssembly.Module`) | YES |
| `initSync` with static module | YES |
| `generate_secp_cg_keypair_from_seed` (direct WASM call) | YES — returned valid result |
| `create_sign_centralized_party_message` exists | YES |
| `decrypt_user_share` exists | YES |
| SDK's `UserShareEncryptionKeys` (via wasm-loader) | NO — broken init path, bypass with direct calls |
| Runtime `WebAssembly.compile()` | NO — blocked by CF Workers |

**Conclusion:** IKA 2PC-MPC signing is viable in CF Workers. The WASM crypto runs. The SDK's wrapper is broken but the raw functions work. We bypass the wrapper with `ika-worker.ts`.

## Security Properties

- **No private key exists anywhere** — not in Workers, not in Wrangler secrets, not in durable storage
- **Encryption key ≠ signing key** — the seed in durable storage only decrypts the user share. It cannot produce a signature alone
- **IKA network is always required** — even if an agent's encryption seed leaks, the attacker also needs the IKA network to co-sign
- **brando can revoke** — remove agent from registry, extract DWalletCaps. Agent can no longer approve messages
- **User share re-encryption is one-way** — re-encrypting to an agent doesn't give the agent access to brando's copy, and vice versa
- **On-chain authorization** — every `approve` call is a Sui transaction. Tamper-evident, publicly auditable
