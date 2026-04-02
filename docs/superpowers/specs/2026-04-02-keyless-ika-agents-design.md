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
// GET /api/agent/<name>/encryption-key
async getEncryptionKeyAddress(): Promise<string> {
    const seed = new Uint8Array(this.state.encryptionSeed);
    const keys = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);
    return keys.encryptionKeyAddress;
}
```

### New: IKA signing (replaces keypair signing)

```typescript
// Sign a message using IKA 2PC-MPC — no private key needed
async signWithIka(message: Uint8Array, chain: string): Promise<Uint8Array> {
    const seed = new Uint8Array(this.state.encryptionSeed);
    const keys = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);
    const userShare = await keys.decryptUserShare(this.state.encryptedShareId);

    // Approve via squids::agent on-chain
    // ... build PTB calling squids::agent::approve
    // ... submit partial user signature to IKA
    // ... receive co-signed result
    return signature;
}
```

### Removed

- `SHADE_KEEPER_PRIVATE_KEY` — deleted from Env interface and Wrangler secrets
- `Ed25519Keypair.fromSecretKey()` — all instances replaced with `signWithIka()`
- Raw Solana address derivation from Sui pubkey — replaced with IKA ed25519 dWallet address

## Browser DKG Proxy Flow

The DKG WASM can't run in CF Workers. brando's browser does the computation:

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

## Security Properties

- **No private key exists anywhere** — not in Workers, not in Wrangler secrets, not in durable storage
- **Encryption key ≠ signing key** — the seed in durable storage only decrypts the user share. It cannot produce a signature alone
- **IKA network is always required** — even if an agent's encryption seed leaks, the attacker also needs the IKA network to co-sign
- **brando can revoke** — remove agent from registry, extract DWalletCaps. Agent can no longer approve messages
- **User share re-encryption is one-way** — re-encrypting to an agent doesn't give the agent access to brando's copy, and vice versa
- **On-chain authorization** — every `approve` call is a Sui transaction. Tamper-evident, publicly auditable
