/**
 * UltronSigningAgent — Durable Object that hosts the IKA WASM runtime
 * so ultron can eventually sign Solana/BTC/ETH txs autonomously using
 * its own dWallets, without any browser in the loop.
 *
 * This file is currently a SPIKE — the single purpose is to prove the
 * two feasibility claims from project_ultron_do_signing:
 *   1. The .wasm binary loads + initializes inside a Worker DO runtime
 *      (all host imports are Workers-safe).
 *   2. A pure-crypto exported function (`generate_secp_cg_keypair_from_seed`)
 *      can be invoked end-to-end with no browser-specific bindings.
 *
 * Once the spike runs green on mainnet, the real signing flow (read
 * dWallet → presign PTB → decrypt user share → centralized sign → submit)
 * can be layered on top using the same initSync path.
 */

import { Agent } from 'agents';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import {
  IkaClient,
  IkaTransaction,
  UserShareEncryptionKeys,
  Curve,
  getNetworkConfig,
} from '@ika.xyz/sdk';

// The .js bindings are pure ES module — they export `initSync(module)`
// + every cryptographic function. We skip the default export (`__wbg_init`)
// because that path expects a browser loader via `import.meta.url`. Workers
// go through `initSync` with a pre-compiled WebAssembly.Module instead.
import {
  initSync,
  generate_secp_cg_keypair_from_seed,
} from '@ika.xyz/ika-wasm/web';

// Ultron's dWallets from the Registeel Lock-On DKG ceremonies. Both curves
// are provisioned — ed25519 for SOL, secp256k1 for BTC/ETH. Hardcoded
// because the DWalletCaps are static; any change would require a fresh DKG.
//
// Lookup recipe for refreshing these after a re-DKG:
//   1. Query ultron's owned DWalletCap objects (type matches
//      <ikaDwallet2pcMpcOriginalPackage>::coordinator_inner::DWalletCap)
//   2. Each cap's `dwallet_id` field points at the dwallet object
//   3. The dwallet's `encrypted_user_secret_key_shares.id` table holds
//      a single dynamic field pointing at the encrypted share object
//   4. `previousTransaction` on the dwallet object is the DKG tx digest
//      that carries the DWalletDKGRequestEvent with user_public_output
interface DWalletSpec {
  dwalletId: string;
  encryptedShareId: string;
  dkgDigest: string;
}
const ULTRON_DWALLETS: Record<'ed25519' | 'secp256k1', DWalletSpec> = {
  ed25519: {
    dwalletId: '0x1a5e6b22b81cd644e15314b451212d9cadb6cd1446c466754760cc5a65ac82a9',
    encryptedShareId: '0x960914d549e3511d552d15930ac03c9d6c073bf61fb9291b1bc8b2e3d6231252',
    dkgDigest: '9dP8g9v3m7DG4XnGWcWEYyqqSNCAS2DnMWeEAz1Sdx5d',
  },
  secp256k1: {
    dwalletId: '0xbb8bce5447722a4c6f5f64618164d8420551dfdbc7605afe279a85de1ebb6acb',
    encryptedShareId: '0x9a6519576f74ca93b43000534249f00168b06e41bf8456fa46ce3fe52db6183d',
    dkgDigest: '38NwvhPrP911FBJgQsVMmCE6jhufWCCzpxubwY8CTaDy',
  },
};
// Legacy shims so existing call sites in this file keep working until
// we sweep them all to use ULTRON_DWALLETS[curve].
const ULTRON_ED25519_DWALLET_ID = ULTRON_DWALLETS.ed25519.dwalletId;
const ULTRON_ED25519_ENCRYPTED_SHARE_ID = ULTRON_DWALLETS.ed25519.encryptedShareId;
const ULTRON_ED25519_DKG_DIGEST = ULTRON_DWALLETS.ed25519.dkgDigest;

// Public salt suffixes for deterministic seed derivation. MUST match the
// values in src/server/index.ts /api/cache/rumble-ultron-seed exactly,
// otherwise the encryption keys we derive here won't decrypt the share
// that was encrypted with the browser-side seed.
const SEED_PREFIX_ED25519 = 'ultron-dkg:ed25519:';
const SEED_PREFIX_SECP256K1 = 'ultron-dkg:secp256k1:';

// Mysten's GraphQL endpoint — the First Commandment compliant transport.
// GraphQL supports reads (.core surface) AND tx submission (executeTransaction)
// AND tx lookup by digest, so it fully replaces the JSON-RPC path that
// Porygon Psybeam is retiring. gRPC would be the ideal transport but doesn't
// work in Cloudflare Workers (no HTTP/2 bidi streaming); GraphQL is the
// next-best fit and has no April-2026 sunset.
const SUI_GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';

// Wrangler treats .wasm imports inside the src/ tree as
// `WebAssembly.Module` at build time via the CompiledWasm rule in
// wrangler.jsonc. The binary is ~3.4 MB — well under the Worker
// size limit. It's copied into src/server/wasm/ from node_modules by
// the build script so wrangler's bundler can see it (node_modules
// imports don't flow through the rules).
import wasmModule from '../wasm/dwallet_mpc_wasm_bg.wasm';

interface Env {
  SHADE_KEEPER_PRIVATE_KEY?: string;
}

interface UltronSigningState {
  // Empty for the spike — the real DO will cache protocolPP, decrypted
  // share material, and last-seen reconfig epoch here.
  lastSpikeAt?: number;
  lastSpikeOk?: boolean;
}

let _wasmInitialized = false;

/**
 * Lazy init — only pay the WebAssembly.Instance setup cost once per
 * DO activation, not on every invocation. `initSync` is idempotent at
 * the wasm-bindgen layer but we guard locally so the second caller
 * doesn't repeat the Module→Instance construction.
 */
function ensureWasmReady(): void {
  if (_wasmInitialized) return;
  initSync({ module: wasmModule as unknown as WebAssembly.Module });
  _wasmInitialized = true;
}

let _ikaClient: IkaClient | null = null;
let _suiGraphQL: SuiGraphQLClient | null = null;

/**
 * Lazy init the IkaClient wrapping a SuiGraphQLClient. Stays cached for
 * the DO's lifetime so subsequent signing calls reuse the same client
 * (avoids the ~200 ms handshake cost per request).
 *
 * IkaClient's SDK reaches for five methods on `client.core.*`: getObject,
 * getObjects, listOwnedObjects, listDynamicFields, simulateTransaction.
 * SuiGraphQLClient exposes all five via `GraphQLCoreClient` with identical
 * signatures to SuiJsonRpcClient's core, so the swap is a drop-in.
 */
async function getIkaClient(): Promise<{ ika: IkaClient; sui: SuiGraphQLClient }> {
  if (_ikaClient && _suiGraphQL) return { ika: _ikaClient, sui: _suiGraphQL };
  const config = getNetworkConfig('mainnet');
  const sui = new SuiGraphQLClient({ url: SUI_GRAPHQL_URL, network: 'mainnet' });
  const ika = new IkaClient({ config, suiClient: sui as never });
  await ika.initialize();
  _ikaClient = ika;
  _suiGraphQL = sui;
  return { ika, sui };
}

/**
 * Derive the deterministic 32-byte encryption seed for ultron's dWallet
 * of the given curve. MUST match /api/cache/rumble-ultron-seed exactly
 * — any divergence breaks decryption of the existing encrypted share.
 */
async function deriveUltronSeed(
  keeperPrivateKey: string,
  ultronAddress: string,
  curve: 'ed25519' | 'secp256k1',
): Promise<Uint8Array> {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const prefix = curve === 'ed25519' ? SEED_PREFIX_ED25519 : SEED_PREFIX_SECP256K1;
  const keeperBytes = new TextEncoder().encode(keeperPrivateKey);
  const saltBytes = new TextEncoder().encode(`${prefix}${ultronAddress}`);
  const seedInput = new Uint8Array(keeperBytes.length + saltBytes.length);
  seedInput.set(keeperBytes, 0);
  seedInput.set(saltBytes, keeperBytes.length);
  return sha256(seedInput);
}

export class UltronSigningAgent extends Agent<Env, UltronSigningState> {
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/wasm-spike') || url.searchParams.has('wasm-spike')) {
      const result = await this._wasmSmokeTest();
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/read-dwallet') || url.searchParams.has('read-dwallet')) {
      const curve = (url.searchParams.get('curve') ?? 'ed25519') as 'ed25519' | 'secp256k1';
      const result = await this._readUltronDWallet(curve);
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname.endsWith('/accept-share') || url.searchParams.has('accept-share')) {
      const curve = (url.searchParams.get('curve') ?? 'ed25519') as 'ed25519' | 'secp256k1';
      const result = await this._acceptUltronShare(curve);
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'Unknown route' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * Increment A of the signing flow: read ultron's ed25519 dWallet via
   * JSON-RPC + IkaClient. Proves the transport path works — if this
   * returns the dWallet in the Active state, every subsequent signing
   * step (presign, sign, poll) uses the same client surface.
   */
  private async _readUltronDWallet(curve: 'ed25519' | 'secp256k1' = 'ed25519'): Promise<{
    ok: boolean;
    error?: string;
    dwalletId?: string;
    state?: string;
    publicOutputLength?: number;
    encryptedUserShareCount?: number;
    curve?: number;
    requestedCurve?: string;
    durationMs: number;
  }> {
    const t0 = Date.now();
    try {
      const { ika } = await getIkaClient();
      const spec = ULTRON_DWALLETS[curve];
      const dwallet = await ika.getDWallet(spec.dwalletId);
      const dw = dwallet as unknown as Record<string, unknown> & {
        state?: Record<string, unknown>;
        encrypted_user_secret_key_shares?: { size?: number | string };
        curve?: number;
      };
      const stateKeys = dw.state ? Object.keys(dw.state) : [];
      const activeInner = (dw.state as { Active?: { public_output?: number[] } } | undefined)?.Active;
      const publicOutput = activeInner?.public_output
        ?? (dw.state as { public_output?: number[] } | undefined)?.public_output;
      const publicOutputLength = Array.isArray(publicOutput) ? publicOutput.length : 0;
      const sharesSize = dw.encrypted_user_secret_key_shares?.size;
      const encryptedUserShareCount = typeof sharesSize === 'string' ? Number(sharesSize) : (sharesSize ?? 0);
      const state = publicOutputLength > 0 ? 'Active' : (stateKeys[0] ?? 'Unknown');
      return {
        ok: true,
        dwalletId: spec.dwalletId,
        state,
        publicOutputLength,
        encryptedUserShareCount,
        curve: dw.curve,
        requestedCurve: curve,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { ok: false, error, durationMs: Date.now() - t0 };
    }
  }

  /**
   * Smoke test: ensure the WASM loads, all host imports bind, and a
   * pure-crypto function runs to completion without throwing. Returns
   * shape + keys of the keypair so we can verify it's not a degenerate
   * empty object.
   *
   * Curve 0 = secp256k1 (per IKA's curve enum). The seed is a fixed
   * 32-byte test vector so repeated calls are deterministic and we
   * can diff output across deploys if something regresses.
   */
  private async _wasmSmokeTest(): Promise<{
    ok: boolean;
    error?: string;
    keypairShape?: string;
    keypairKeys?: string[];
    durationMs: number;
  }> {
    const t0 = Date.now();
    try {
      ensureWasmReady();

      // Fixed 32-byte test vector: 0x01 0x02 0x03 … 0x20. Never used
      // for anything real — if someone sees this in a wallet they'll
      // know something is badly wrong.
      const seed = new Uint8Array(32);
      for (let i = 0; i < 32; i++) seed[i] = i + 1;

      const result = generate_secp_cg_keypair_from_seed(0, seed);
      const keys = result && typeof result === 'object' ? Object.keys(result) : [];

      const durationMs = Date.now() - t0;
      this.setState({
        ...this.state,
        lastSpikeAt: Date.now(),
        lastSpikeOk: true,
      });
      return {
        ok: true,
        keypairShape: typeof result,
        keypairKeys: keys,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.setState({
        ...this.state,
        lastSpikeAt: Date.now(),
        lastSpikeOk: false,
      });
      return { ok: false, error, durationMs };
    }
  }

  /**
   * Increment B: accept ultron's encrypted user share to transition the
   * dWallet from AwaitingKeyHolderSignature → Active.
   *
   * Uses the deterministic seed (same one /api/cache/rumble-ultron-seed
   * exposed to the browser during DKG) to reconstruct the
   * UserShareEncryptionKeys. Then builds a PTB via IkaTransaction
   * that calls acceptEncryptedUserShare, signs with ultron's Ed25519
   * keypair, and submits via JSON-RPC.
   *
   * After this lands, requestPresign + requestSign can chain normally
   * on the Active dWallet — the signing flow is just a PTB composition.
   */
  private async _acceptUltronShare(curve: 'ed25519' | 'secp256k1' = 'ed25519'): Promise<{
    ok: boolean;
    error?: string;
    digest?: string;
    stateBefore?: string;
    stateAfter?: string;
    curve?: string;
    durationMs: number;
  }> {
    const t0 = Date.now();
    try {
      if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
        return { ok: false, error: 'SHADE_KEEPER_PRIVATE_KEY not configured', durationMs: Date.now() - t0 };
      }

      ensureWasmReady();

      const spec = ULTRON_DWALLETS[curve];
      const ikaCurve = curve === 'ed25519' ? Curve.ED25519 : Curve.SECP256K1;

      // Ultron's Sui address — derived from the keeper keypair.
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const ultronAddress = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());

      // Reconstruct the same deterministic seed the browser used during DKG.
      // Critical: the seed prefix ("ultron-dkg:ed25519:" or "ultron-dkg:secp256k1:")
      // MUST match the browser path EXACTLY, otherwise the derived encryption
      // key won't decrypt the share that was encrypted during DKG.
      const seed = await deriveUltronSeed(
        this.env.SHADE_KEEPER_PRIVATE_KEY,
        ultronAddress,
        curve,
      );
      const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, ikaCurve);

      const { ika, sui } = await getIkaClient();

      // Read the dWallet as whatever-state. It's in AwaitingKeyHolderSignature
      // right now; the SDK's typed getters cast it as ZeroTrustDWallet so we
      // can feed it into acceptEncryptedUserShare directly.
      const dwallet = await ika.getDWallet(spec.dwalletId);
      const dwAny = dwallet as unknown as Record<string, unknown> & {
        state?: Record<string, unknown>;
      };
      const stateKeys = dwAny.state ? Object.keys(dwAny.state) : [];
      const stateBefore = stateKeys[0] ?? 'Unknown';

      // `acceptEncryptedUserShare` wants the *user's* public output from
      // the centralized DKG step, NOT the decentralized/network output
      // stored on-chain in the dWallet state. The user output was emitted
      // in the DKG tx's DWalletDKGRequestEvent as `event_data.user_public_output`
      // — 232 bytes for ed25519, larger for secp256k1. Pull it via GraphQL
      // getTransaction with events included.
      //
      // The SDK warns that `event.json` shape can differ between JSON-RPC
      // and GraphQL so we defensively check both nested (`event_data.*`)
      // and flat layouts. If neither works we bail loudly.
      const txResult = await sui.core.getTransaction({
        digest: spec.dkgDigest,
        include: { events: true },
      });
      const txInner = txResult.$kind === 'Transaction'
        ? txResult.Transaction
        : txResult.FailedTransaction;
      const events = txInner?.events ?? [];
      type DkgPayload = {
        dwallet_id?: string;
        user_public_output?: number[] | Uint8Array;
      };
      type DkgEventJson = DkgPayload & { event_data?: DkgPayload };
      const dkgEvent = events.find((e) => {
        const typeStr = e.eventType ?? '';
        if (!typeStr.includes('DWalletDKGRequestEvent')) return false;
        const json = (e.json ?? {}) as DkgEventJson;
        const dwalletId = json.event_data?.dwallet_id ?? json.dwallet_id;
        return dwalletId === spec.dwalletId;
      });
      if (!dkgEvent) {
        return {
          ok: false,
          error: `DWalletDKGRequestEvent not found in tx ${spec.dkgDigest}`,
          stateBefore,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      const dkgJson = (dkgEvent.json ?? {}) as DkgEventJson;
      const userPublicOutputRaw = dkgJson.event_data?.user_public_output ?? dkgJson.user_public_output;
      if (!userPublicOutputRaw || (Array.isArray(userPublicOutputRaw) && userPublicOutputRaw.length === 0)) {
        return {
          ok: false,
          error: `user_public_output not found in DKG event for tx ${spec.dkgDigest}`,
          stateBefore,
          curve,
          durationMs: Date.now() - t0,
        };
      }
      const userPublicOutput = userPublicOutputRaw instanceof Uint8Array
        ? userPublicOutputRaw
        : new Uint8Array(userPublicOutputRaw);

      // Build the accept PTB via IkaTransaction.
      const tx = new Transaction();
      tx.setSender(ultronAddress);
      const ikaTx = new IkaTransaction({
        ikaClient: ika,
        transaction: tx,
        userShareEncryptionKeys,
      });
      await ikaTx.acceptEncryptedUserShare({
        dWallet: dwallet as never,
        userPublicOutput,
        encryptedUserSecretKeyShareId: spec.encryptedShareId,
      });

      // Build, sign with ultron's Ed25519 Sui keypair (the sender on Sui
      // is always ed25519 — curve here refers to the *dWallet*, not the
      // Sui tx signer), submit via GraphQL.
      const txBytes = await tx.build({ client: sui as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const execResult = await sui.core.executeTransaction({
        transaction: txBytes,
        signatures: [signature],
      });
      const execInner = execResult.$kind === 'Transaction'
        ? execResult.Transaction
        : execResult.FailedTransaction;
      const digest = execInner?.digest ?? '';

      // Re-read the dwallet to confirm state transition. Give the indexer
      // a moment to catch up — read-after-write can race with tx finality
      // on the read replica regardless of transport.
      await new Promise((r) => setTimeout(r, 2000));
      const after = await ika.getDWallet(spec.dwalletId) as unknown as {
        state?: Record<string, unknown>;
      };
      const stateAfterKeys = after.state ? Object.keys(after.state) : [];
      const stateAfter = stateAfterKeys[0] ?? 'Unknown';

      return {
        ok: true,
        digest,
        stateBefore,
        stateAfter,
        curve,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { ok: false, error, durationMs: Date.now() - t0 };
    }
  }
}
