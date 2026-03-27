# IKA Bitcoin Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable native Bitcoin addresses via IKA dWallets — auto-provisioned at sign-in for SuiNS holders, displayed in orange when the BTC network view is selected.

**Architecture:** A gRPC-compatible adapter wraps `SuiGrpcClient` to satisfy the Bluefin 7K aggregator SDK's interface, enabling SUI→IKA swaps in the same PTB as DKG. The server provisions dWallets for SuiNS holders via a keeper keypair. The client derives Bitcoin addresses from the dWallet's secp256k1 public key and renders them when `networkView === 'btc'`.

**Tech Stack:** `@ika.xyz/sdk`, `@bluefin-exchange/bluefin7k-aggregator-sdk`, `@mysten/sui/grpc` (SuiGrpcClient), `@noble/hashes` (Bitcoin address derivation)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/server/grpc-7k-adapter.ts` | **NEW** — Adapter wrapping `SuiGrpcClient` to satisfy 7K SDK's expected `SuiClient` interface (4 methods) |
| `src/server/ika-provision.ts` | **NEW** — Server-side DKG provisioning: SuiNS gate check, SUI→IKA swap via 7K, DKG call, BTC address derivation |
| `src/server/index.ts` | **MODIFY** — Add `/api/ika/provision` endpoint, add SuiNS gate to `/api/sponsor-gas` |
| `src/client/ika.ts` | **MODIFY** — Add `getBtcAddress()` that derives a Bitcoin address from dWallet public output |
| `src/ui.ts` | **MODIFY** — When `networkView === 'btc'`, show BTC address in orange, swap explorer link to mempool.space |
| `src/ski.ts` | **MODIFY** — Auto-trigger DKG provisioning at sign-in when user has SuiNS + no dWallet |

---

### Task 1: gRPC → 7K Adapter

The Bluefin 7K aggregator SDK calls `setSuiClient(client)` and expects 4 methods with JSON-RPC-shaped responses. `SuiGrpcClient` has equivalent methods but with different response shapes. This adapter bridges the gap — no JSON-RPC dependency.

**Files:**
- Create: `src/server/grpc-7k-adapter.ts`

- [ ] **Step 1: Create the adapter module**

```ts
// src/server/grpc-7k-adapter.ts
//
// Wraps SuiGrpcClient to satisfy the @bluefin-exchange/bluefin7k-aggregator-sdk's
// expected SuiClient interface. The SDK uses duck typing (no instanceof checks),
// so we only need to implement the 4 methods it actually calls.

import { SuiGrpcClient } from '@mysten/sui/grpc';

/**
 * Shape the 7K SDK expects from getCoins() responses.
 * Maps from gRPC listCoins() which returns { objects, cursor, hasNextPage }.
 */
interface CoinStruct {
  coinObjectId: string;
  balance: string;
  coinType: string;
  digest: string;
  version: string;
}

/**
 * Create an adapter that wraps a SuiGrpcClient and exposes the methods
 * the Bluefin 7K aggregator SDK expects.
 */
export function createGrpc7kAdapter(grpc: SuiGrpcClient) {
  return {
    // ── getCoins ──────────────────────────────────────────────────
    // 7K calls: client.getCoins({ owner, coinType, cursor, limit })
    // Expects: { data: CoinStruct[], nextCursor, hasNextPage }
    // gRPC has: listCoins({ owner, coinType, cursor, limit })
    // Returns: { objects: Coin[], cursor, hasNextPage }
    async getCoins(params: {
      owner: string;
      coinType: string;
      cursor?: string;
      limit?: number;
    }) {
      const result = await grpc.listCoins({
        owner: params.owner,
        coinType: params.coinType,
        cursor: params.cursor ?? undefined,
      });
      return {
        data: result.objects.map((c): CoinStruct => ({
          coinObjectId: c.objectId,
          balance: c.balance,
          coinType: c.type,
          digest: c.digest,
          version: c.version,
        })),
        nextCursor: result.cursor,
        hasNextPage: result.hasNextPage,
      };
    },

    // ── getOwnedObjects ──────────────────────────────────────────
    // 7K calls: client.getOwnedObjects({ owner, cursor, limit, filter, options })
    // Expects: { data: SuiObjectResponse[], nextCursor, hasNextPage }
    // gRPC has: listOwnedObjects({ owner, type, cursor, limit, include })
    async getOwnedObjects(params: {
      owner: string;
      cursor?: string;
      limit?: number;
      filter?: { StructType?: string };
      options?: { showContent?: boolean; showType?: boolean };
    }) {
      const result = await grpc.listOwnedObjects({
        owner: params.owner,
        type: params.filter?.StructType,
        cursor: params.cursor ?? undefined,
        limit: params.limit ?? undefined,
        include: {
          content: params.options?.showContent,
        },
      });
      return {
        data: result.objects.map((o) => ({
          data: {
            objectId: o.objectId,
            version: o.version,
            digest: o.digest,
            type: o.type,
            content: o.content,
          },
        })),
        nextCursor: result.cursor,
        hasNextPage: result.hasNextPage,
      };
    },

    // ── dryRunTransactionBlock ────────────────────────────────────
    // 7K calls: client.dryRunTransactionBlock({ transactionBlock: Uint8Array })
    // Expects: { effects: { status: { status }, gasUsed: { computationCost, storageCost, storageRebate } } }
    // gRPC has: simulateTransaction({ transaction: Uint8Array, include: { effects: true } })
    async dryRunTransactionBlock(params: { transactionBlock: Uint8Array }) {
      const result = await grpc.simulateTransaction({
        transaction: params.transactionBlock,
        include: { effects: true },
      });
      const tx = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
      const effects = tx?.effects;
      return {
        effects: {
          status: {
            status: effects?.status === 'success' ? 'success' : 'failure',
          },
          gasUsed: {
            computationCost: effects?.gasUsed?.computationCost ?? '0',
            storageCost: effects?.gasUsed?.storageCost ?? '0',
            storageRebate: effects?.gasUsed?.storageRebate ?? '0',
          },
        },
      };
    },

    // ── devInspectTransactionBlock ────────────────────────────────
    // 7K calls: client.devInspectTransactionBlock({ sender, transactionBlock: Transaction })
    // Same return shape as dryRunTransactionBlock.
    // We build the tx bytes first, then simulate.
    async devInspectTransactionBlock(params: {
      sender: string;
      transactionBlock: { build: (opts: any) => Promise<Uint8Array> } | Uint8Array;
    }) {
      let txBytes: Uint8Array;
      if (params.transactionBlock instanceof Uint8Array) {
        txBytes = params.transactionBlock;
      } else {
        txBytes = await params.transactionBlock.build({ client: grpc });
      }
      const result = await grpc.simulateTransaction({
        transaction: txBytes,
        include: { effects: true },
      });
      const tx = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
      const effects = tx?.effects;
      return {
        effects: {
          status: {
            status: effects?.status === 'success' ? 'success' : 'failure',
          },
          gasUsed: {
            computationCost: effects?.gasUsed?.computationCost ?? '0',
            storageCost: effects?.gasUsed?.storageCost ?? '0',
            storageRebate: effects?.gasUsed?.storageRebate ?? '0',
          },
        },
      };
    },

    // ── Pass-through for tx.build({ client }) ────────────────────
    // Transaction.build() calls client.resolveTransactionPlugin() internally.
    // SuiGrpcClient implements this, so we delegate directly.
    resolveTransactionPlugin: () => grpc.resolveTransactionPlugin(),
  };
}
```

- [ ] **Step 2: Verify the adapter builds**

Run: `bun build src/server/grpc-7k-adapter.ts --outdir /tmp/test-build --target node`
Expected: Builds without errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/grpc-7k-adapter.ts
git commit -m "feat(ika): gRPC adapter for Bluefin 7K aggregator SDK"
```

---

### Task 2: SuiNS Ownership Gate

Add a SuiNS registration NFT ownership check to `/api/sponsor-gas` and create a reusable helper for it. Also used by the DKG provisioning endpoint later.

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Add the SuiNS ownership check helper**

Add this above the `/api/sponsor-gas` route in `src/server/index.ts`:

```ts
// ── SuiNS ownership gate ────────────────────────────────────────────

const SUINS_REGISTRATION_TYPE = '0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration';
const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

/** Check if an address owns at least one SuiNS registration NFT. */
async function hasSuinsNft(address: string): Promise<boolean> {
  try {
    const res = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($owner:SuiAddress!,$type:String!){
          address(address:$owner){
            objects(filter:{type:$type},first:1){
              nodes{ address }
            }
          }
        }`,
        variables: { owner: address, type: SUINS_REGISTRATION_TYPE },
      }),
    });
    const json = await res.json() as {
      data?: { address?: { objects?: { nodes?: unknown[] } } };
    };
    return (json?.data?.address?.objects?.nodes?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Add SuiNS gate to `/api/sponsor-gas`**

Modify the existing `/api/sponsor-gas` handler to accept `senderAddress` and check SuiNS ownership:

```ts
app.post('/api/sponsor-gas', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Gas sponsorship not configured' }, 503);

  try {
    const { txBytes, senderAddress } = await c.req.json<{ txBytes: string; senderAddress?: string }>();
    if (!txBytes) return c.json({ error: 'Missing txBytes' }, 400);

    // SuiNS gate: require sender to own a SuiNS registration NFT
    if (senderAddress) {
      const hasNft = await hasSuinsNft(senderAddress);
      if (!hasNft) return c.json({ error: 'SuiNS name required for gas sponsorship' }, 403);
    }

    const keypair = Ed25519Keypair.fromSecretKey(key);
    const bytes = Uint8Array.from(atob(txBytes), ch => ch.charCodeAt(0));
    const { signature } = await keypair.signTransaction(bytes);

    return c.json({ sponsorSig: signature, sponsorAddress: keypair.toSuiAddress() });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
```

- [ ] **Step 3: Update client caller to pass `senderAddress`**

In `src/ui.ts`, the `signAndExecuteSponsoredTx` function calls `/api/sponsor-gas`. Update it to include the sender address:

```ts
// In signAndExecuteSponsoredTx, update the fetch body:
const ws = getState();
const res = await fetch('/api/sponsor-gas', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ txBytes: b64, senderAddress: ws.address }),
});
```

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts src/ui.ts
git commit -m "feat(sponsor): gate gas sponsorship behind SuiNS NFT ownership"
```

---

### Task 3: Bitcoin Address Derivation from dWallet

Add a function to `src/client/ika.ts` that takes a dWallet's secp256k1 public output and derives a native SegWit (bech32) Bitcoin address.

**Files:**
- Modify: `src/client/ika.ts`

- [ ] **Step 1: Install `@noble/hashes` (if not already present)**

Run: `bun add @noble/hashes`

This is a zero-dependency, audited crypto library. We need `sha256` and `ripemd160` for Bitcoin address derivation, plus `bech32` for encoding.

- [ ] **Step 2: Add BTC address derivation to `src/client/ika.ts`**

Add these imports and functions after the existing code:

```ts
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bech32 } from '@scure/base';
import { publicKeyFromDWalletOutput, Curve } from '@ika.xyz/sdk';

/**
 * Derive a native SegWit (bech32) Bitcoin address from a dWallet's public output.
 *
 * Flow:
 *   1. Extract compressed secp256k1 pubkey from dWallet output (via IKA WASM)
 *   2. SHA256 → RIPEMD160 = pubkey hash (Hash160)
 *   3. Encode as bech32 witness v0 program → bc1q... address
 */
export async function deriveBtcAddress(publicOutput: Uint8Array): Promise<string> {
  // 1. Get raw compressed public key (33 bytes) from dWallet output
  const bcsEncodedKey = await publicKeyFromDWalletOutput(Curve.SECP256K1, publicOutput);
  // BCS encodes a vector<u8> with a ULEB128 length prefix. For 33 bytes, prefix is 1 byte (0x21).
  const rawPubkey = bcsEncodedKey.length === 33 ? bcsEncodedKey : bcsEncodedKey.slice(bcsEncodedKey.length - 33);

  // 2. Hash160 = RIPEMD160(SHA256(pubkey))
  const hash160 = ripemd160(sha256(rawPubkey));

  // 3. Encode as bech32 witness v0 program (P2WPKH → bc1q...)
  const words = bech32.toWords(hash160);
  words.unshift(0); // witness version 0
  return bech32.encode('bc', words);
}

/**
 * Get the Bitcoin address for the user's dWallet, if one exists.
 * Returns null if no active dWallet is found.
 */
export async function getBtcAddress(address: string): Promise<string | null> {
  try {
    const { hasDWallet, caps } = await checkExistingDWallets(address);
    if (!hasDWallet || !caps[0]) return null;

    const client = getClient();
    const dWallet = await client.getDWallet(caps[0].dwallet_id);
    const publicOutput = dWallet?.state?.Active?.public_output;
    if (!publicOutput) return null;

    return deriveBtcAddress(new Uint8Array(publicOutput));
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Export the new function from CrossChainStatus**

Update the `getCrossChainStatus` function to also return the BTC address:

```ts
export interface CrossChainStatus {
  ika: boolean;
  dwalletCount: number;
  dwalletId: string;
  btcAddress: string;
}

export async function getCrossChainStatus(address: string): Promise<CrossChainStatus> {
  const { hasDWallet, caps, count } = await checkExistingDWallets(address);
  let btcAddress = '';
  if (hasDWallet && caps[0]) {
    try {
      const client = getClient();
      const dWallet = await client.getDWallet(caps[0].dwallet_id);
      const publicOutput = dWallet?.state?.Active?.public_output;
      if (publicOutput) {
        btcAddress = await deriveBtcAddress(new Uint8Array(publicOutput));
      }
    } catch {}
  }
  return {
    ika: hasDWallet,
    dwalletCount: count,
    dwalletId: hasDWallet && caps[0] ? caps[0].dwallet_id : '',
    btcAddress,
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add src/client/ika.ts package.json bun.lockb
git commit -m "feat(ika): derive Bitcoin bech32 address from dWallet public key"
```

---

### Task 4: UI — BTC Address Display in Orange

When `networkView === 'btc'`, replace the Sui hex address with the Bitcoin address, style it orange, and swap the explorer link to mempool.space.

**Files:**
- Modify: `src/ui.ts`

- [ ] **Step 1: Add `btcAddress` to AppState**

In the `AppState` interface and default state (around line 144):

```ts
export interface AppState {
  sui: number;
  usd: number | null;
  stableUsd: number;
  nsBalance: number;
  suinsName: string;
  ikaWalletId: string;
  btcAddress: string;      // ← ADD
  skiMenuOpen: boolean;
  copied: boolean;
  splashSponsor: boolean;
}

const app: AppState = {
  sui: 0,
  usd: null,
  stableUsd: 0,
  nsBalance: 0,
  suinsName: '',
  ikaWalletId: '',
  btcAddress: '',          // ← ADD
  skiMenuOpen: (() => { try { return localStorage.getItem('ski:lift') === '1'; } catch { return false; } })(),
  copied: false,
  splashSponsor: false,
};
```

- [ ] **Step 2: Modify the address row in the SKI menu**

In the `renderSkiMenu` function (around line 4623-4876), update the address row to be network-aware. Find the block that builds `scanUrl` and `addrShort`:

Replace:
```ts
  const scanUrl = `https://suiscan.xyz/mainnet/account/${ws.address}`;

  const addrShort = truncAddr(ws.address);
```

With:
```ts
  const isBtcView = networkView === 'btc' && app.btcAddress;
  const displayAddr = isBtcView ? app.btcAddress : ws.address;
  const scanUrl = isBtcView
    ? `https://mempool.space/address/${app.btcAddress}`
    : `https://suiscan.xyz/mainnet/account/${ws.address}`;
  const explorerTitle = isBtcView ? 'View on Mempool' : 'View on Suiscan';

  const addrShort = truncAddr(displayAddr);
```

- [ ] **Step 3: Update the address banner rendering**

Find the address row HTML (around line 4871-4877). Replace:

```html
<div class="wk-dd-address-row">
  <div id="wk-network-select" class="wk-dd-network-select"></div>
  <button class="wk-dd-address-banner${app.copied ? ' copied' : ''}" id="wk-dd-copy" type="button" title="${esc(ws.address)}">
    <span class="wk-dd-address-text">${esc(app.copied ? 'Copied! \u2713' : addrShort)}</span>
  </button>
  <a href="${esc(scanUrl)}" target="_blank" rel="noopener" class="wk-dd-explorer-btn" title="View on Suiscan">\u2197</a>
</div>
```

With:

```html
<div class="wk-dd-address-row">
  <div id="wk-network-select" class="wk-dd-network-select"></div>
  <button class="wk-dd-address-banner${app.copied ? ' copied' : ''}${isBtcView ? ' wk-dd-address-banner--btc' : ''}" id="wk-dd-copy" type="button" title="${esc(displayAddr)}">
    <span class="wk-dd-address-text">${esc(app.copied ? 'Copied! \u2713' : addrShort)}</span>
  </button>
  <a href="${esc(scanUrl)}" target="_blank" rel="noopener" class="wk-dd-explorer-btn" title="${esc(explorerTitle)}">\u2197</a>
</div>
```

- [ ] **Step 4: Update the copy handler to copy the correct address**

Find `menuCopyAddress` (the click handler for `#wk-dd-copy`). Update it to copy the BTC address when in BTC view:

```ts
function menuCopyAddress() {
  const isBtcView = networkView === 'btc' && app.btcAddress;
  const addr = isBtcView ? app.btcAddress : getState().address;
  if (!addr) return;
  navigator.clipboard.writeText(addr).then(() => {
    app.copied = true;
    render();
    setTimeout(() => { app.copied = false; render(); }, 1500);
  }).catch(() => {});
}
```

- [ ] **Step 5: Update the QR code to encode the BTC address**

Find the QR rendering section. When `isBtcView`, the QR should encode the Bitcoin address. In the QR data attribute (around line 4883):

Replace:
```html
<div class="wk-qr-content-qr" id="wk-addr-qr" title="${esc(ws.address)}"></div>
```

With:
```html
<div class="wk-qr-content-qr" id="wk-addr-qr" title="${esc(displayAddr)}" data-qr-addr="${esc(displayAddr)}"></div>
```

- [ ] **Step 6: Add orange BTC styling**

Find the existing CSS injection point (the `<style>` block in `initUI` or inline styles). Add:

```css
.wk-dd-address-banner--btc .wk-dd-address-text {
  color: #f7931a;
}
.wk-dd-address-banner--btc {
  border-color: #f7931a;
}
```

If styles are injected via JS (search for where other `.wk-dd-` styles are defined), add the rule in the same place.

- [ ] **Step 7: Re-render on network switch**

In the network select click handler (around line 4920), ensure `render()` is called after switching networks so the address row updates:

```ts
if (opt?.dataset.network) {
  networkView = opt.dataset.network as 'sui' | 'btc';
  try { localStorage.setItem('ski:network-pref', networkView); } catch {}
  _networkSelectOpen = false;
  _renderNetworkSelect();
  render(); // ← ensure full re-render to update address row
  return;
}
```

- [ ] **Step 8: Commit**

```bash
git add src/ui.ts
git commit -m "feat(ui): show BTC address in orange when Bitcoin network selected"
```

---

### Task 5: Server-Side DKG Provisioning Endpoint

Create the `/api/ika/provision` endpoint that:
1. Checks SuiNS ownership (gate)
2. Checks if user already has a dWallet (skip if so)
3. Swaps SUI→IKA via 7K aggregator in the same PTB
4. Runs DKG to create a dWallet
5. Returns the dWallet ID and derived BTC address

**Files:**
- Create: `src/server/ika-provision.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Install dependencies**

Run: `bun add @bluefin-exchange/bluefin7k-aggregator-sdk @scure/base`

Note: `@ika.xyz/sdk` is already installed. `@pythnetwork/pyth-sui-js` is a peer dep of the 7K SDK.

- [ ] **Step 2: Create the provisioning module**

```ts
// src/server/ika-provision.ts
//
// Server-side dWallet provisioning for SuiNS holders.
// Keeper pays SUI gas + swaps SUI→IKA in the same PTB as DKG.

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  IkaClient, IkaTransaction, getNetworkConfig,
  Curve, UserShareEncryptionKeys,
  createRandomSessionIdentifier, prepareDKGAsync,
  publicKeyFromDWalletOutput,
} from '@ika.xyz/sdk';
import { getQuote, buildTx, setSuiClient } from '@bluefin-exchange/bluefin7k-aggregator-sdk';
import { createGrpc7kAdapter } from './grpc-7k-adapter.js';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bech32 } from '@scure/base';

const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
const SUI_TYPE = '0x2::sui::SUI';

interface ProvisionResult {
  success: boolean;
  dwalletId?: string;
  btcAddress?: string;
  error?: string;
}

/**
 * Provision a dWallet for a user address.
 * The keeper pays all fees (SUI gas + IKA via swap).
 */
export async function provisionDWallet(
  userAddress: string,
  keeperPrivateKey: string,
): Promise<ProvisionResult> {
  const keypair = Ed25519Keypair.fromSecretKey(keeperPrivateKey);
  const keeperAddress = keypair.toSuiAddress();

  // Set up gRPC client + 7K adapter
  const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' });
  const adapter = createGrpc7kAdapter(grpc);
  setSuiClient(adapter as any);

  // Set up IKA client
  const config = getNetworkConfig('mainnet');
  const ikaClient = new IkaClient({ config, suiClient: adapter as any });

  // Check if user already has a dWallet
  const existing = await ikaClient.getOwnedDWalletCaps(userAddress, undefined, 1);
  if (existing.dWalletCaps.length > 0) {
    // Already provisioned — derive BTC address and return
    const cap = existing.dWalletCaps[0];
    const dWallet = await ikaClient.getDWallet(cap.dwallet_id);
    const publicOutput = dWallet?.state?.Active?.public_output;
    if (publicOutput) {
      const btcAddr = await deriveBtcAddressFromOutput(new Uint8Array(publicOutput));
      return { success: true, dwalletId: cap.dwallet_id, btcAddress: btcAddr };
    }
    return { success: true, dwalletId: cap.dwallet_id, btcAddress: '' };
  }

  // Prepare DKG crypto (WASM)
  const curve = Curve.SECP256K1;
  const seed = new TextEncoder().encode(`ski:dwallet:${userAddress}`);
  const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);
  const sessionIdentifier = createRandomSessionIdentifier();
  const dkgInput = await prepareDKGAsync(
    ikaClient, curve, userShareEncryptionKeys, sessionIdentifier, keeperAddress,
  );

  // Get network encryption key
  const encKey = await ikaClient.getLatestNetworkEncryptionKey();

  // Build the PTB: swap SUI→IKA + DKG request
  const tx = new Transaction();
  tx.setSender(keeperAddress);

  // Step A: Swap SUI→IKA for the DKG fee
  // Use a conservative amount (e.g., 0.5 SUI worth of IKA — can be tuned)
  const swapAmountMist = '500000000'; // 0.5 SUI
  const quote = await getQuote({
    tokenIn: SUI_TYPE,
    tokenOut: IKA_TYPE,
    amountIn: swapAmountMist,
  });

  const swapResult = await buildTx({
    quoteResponse: quote,
    accountAddress: keeperAddress,
    slippage: 0.03, // 3% slippage for small swaps
    commission: { partner: keeperAddress, commissionBps: 0 },
    extendTx: { tx, coinIn: tx.gas },
  });

  // Step B: DKG request using the swapped IKA coin + SUI from gas
  const ikaTx = new IkaTransaction({ ikaClient, transaction: tx, userShareEncryptionKeys });
  await ikaTx.registerEncryptionKey({ curve });

  const suiCoinForDkg = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000)]); // 0.1 SUI for DKG fee

  const [dWalletCap] = await ikaTx.requestDWalletDKG({
    curve,
    dkgRequestInput: dkgInput,
    sessionIdentifier: ikaTx.registerSessionIdentifier(sessionIdentifier),
    ikaCoin: swapResult?.coinOut ?? tx.gas, // IKA from swap
    suiCoin: suiCoinForDkg,
    dwalletNetworkEncryptionKeyId: encKey.id,
  });

  // Transfer the DWalletCap to the user
  tx.transferObjects([dWalletCap], tx.pure.address(userAddress));

  // Sign and execute
  const txBytes = await tx.build({ client: grpc as any });
  const { signature } = await keypair.signTransaction(txBytes);
  const result = await grpc.executeTransaction({
    transaction: txBytes,
    signatures: [signature],
  });

  if (!result.digest) {
    return { success: false, error: 'Transaction failed' };
  }

  // Wait for the dWallet to become active (poll)
  // The DKG is async — the dWallet won't be immediately active.
  // Return the cap info and let the client poll for the BTC address.
  return {
    success: true,
    dwalletId: 'pending', // DKG is async, client should poll getCrossChainStatus
    btcAddress: '',
  };
}

async function deriveBtcAddressFromOutput(publicOutput: Uint8Array): Promise<string> {
  const bcsEncodedKey = await publicKeyFromDWalletOutput(Curve.SECP256K1, publicOutput);
  const rawPubkey = bcsEncodedKey.length === 33 ? bcsEncodedKey : bcsEncodedKey.slice(bcsEncodedKey.length - 33);
  const hash160 = ripemd160(sha256(rawPubkey));
  const words = bech32.toWords(hash160);
  words.unshift(0);
  return bech32.encode('bc', words);
}
```

- [ ] **Step 3: Add the endpoint to `src/server/index.ts`**

```ts
import { provisionDWallet } from './ika-provision.js';

app.post('/api/ika/provision', async (c) => {
  const key = c.env.SHADE_KEEPER_PRIVATE_KEY;
  if (!key) return c.json({ error: 'Not configured' }, 503);

  try {
    const { address } = await c.req.json<{ address: string }>();
    if (!address) return c.json({ error: 'Missing address' }, 400);

    // SuiNS gate
    const hasNft = await hasSuinsNft(address);
    if (!hasNft) return c.json({ error: 'SuiNS name required' }, 403);

    const result = await provisionDWallet(address, key);
    return c.json(result, result.success ? 200 : 500);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
```

- [ ] **Step 4: Commit**

```bash
git add src/server/ika-provision.ts src/server/index.ts package.json bun.lockb
git commit -m "feat(ika): server-side DKG provisioning with SUI→IKA swap via 7K"
```

---

### Task 6: Auto-Provision at Sign-In

Wire the client to auto-trigger DKG provisioning at sign-in when the user has a SuiNS name but no dWallet.

**Files:**
- Modify: `src/ski.ts`
- Modify: `src/ui.ts` (AppState update)

- [ ] **Step 1: Update `establishSession` in `src/ski.ts`**

Replace the existing Ika check block (lines 151-156) with an expanded version that triggers provisioning:

```ts
  // Check for existing Ika dWallets — if none and user has SuiNS, auto-provision
  loadIka().then(async ({ getCrossChainStatus }) => {
    const status = await getCrossChainStatus(address);
    if (status.ika) {
      updateAppState({ ikaWalletId: status.dwalletId, btcAddress: status.btcAddress });
      return;
    }

    // No dWallet — check if user has a SuiNS name (qualifies for sponsored DKG)
    const suinsName = (() => { try { return localStorage.getItem(`ski:suins:${address}`); } catch { return null; } })();
    if (!suinsName) return; // No SuiNS = no free DKG

    // Trigger server-side provisioning
    try {
      const res = await fetch('/api/ika/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) return;
      const result = await res.json() as { success: boolean; dwalletId?: string; btcAddress?: string };
      if (result.success && result.dwalletId) {
        updateAppState({ ikaWalletId: result.dwalletId, btcAddress: result.btcAddress ?? '' });
      }
      // If dwalletId is 'pending', poll for completion
      if (result.dwalletId === 'pending') {
        const poll = setInterval(async () => {
          const s = await getCrossChainStatus(address);
          if (s.ika && s.btcAddress) {
            clearInterval(poll);
            updateAppState({ ikaWalletId: s.dwalletId, btcAddress: s.btcAddress });
          }
        }, 5000);
        // Stop polling after 2 minutes
        setTimeout(() => clearInterval(poll), 120_000);
      }
    } catch {}
  }).catch(() => {});
```

- [ ] **Step 2: Update session state handler**

In the `connectSession` callback (line 132), also handle `btcAddress`:

```ts
  connectSession(sessionKey, (state) => {
    if (state.suinsName) updateAppState({ suinsName: state.suinsName });
    if (state.ikaWalletId) updateAppState({ ikaWalletId: state.ikaWalletId });
    if ((state as any).btcAddress) updateAppState({ btcAddress: (state as any).btcAddress });
  });
```

- [ ] **Step 3: Clear BTC address on disconnect**

Find where `ikaWalletId` is cleared on disconnect (around line 7146 in `ui.ts`):

```ts
      app.ikaWalletId = '';
      app.btcAddress = '';
```

- [ ] **Step 4: Commit**

```bash
git add src/ski.ts src/ui.ts
git commit -m "feat(ika): auto-provision dWallet at sign-in for SuiNS holders"
```

---

### Task 7: Build and Deploy

**Files:**
- None new — build and deploy the full bundle.

- [ ] **Step 1: Build the browser bundle**

Run: `bun run build`
Expected: Builds successfully to `public/dist/`.

- [ ] **Step 2: Deploy to Cloudflare Workers**

Run: `npx wrangler deploy`
Expected: Deploys successfully.

- [ ] **Step 3: Smoke test**

1. Open sui.ski in browser
2. Connect wallet with a SuiNS name
3. Sign in
4. Switch network selector to BTC
5. Verify: address row shows a `bc1q...` address in orange (if dWallet exists) or shows Sui address while DKG is in progress
6. Verify: explorer link goes to mempool.space
7. Verify: copy button copies the BTC address
8. Switch back to Sui — verify hex address returns

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(ika): IKA Bitcoin integration — SuiNS-gated DKG, BTC addresses, orange UI"
```
