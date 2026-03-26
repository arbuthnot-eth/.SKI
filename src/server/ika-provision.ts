/**
 * Server-side dWallet provisioning for SuiNS holders.
 *
 * Flow:
 *   1. Check if user already has a dWallet (skip if so)
 *   2. Build a sponsored PTB: swap SUI→IKA + DKG request
 *      - sender = user (owns the resulting DWalletCap)
 *      - gasOwner = keeper (pays gas + provides SUI for IKA swap)
 *   3. Keeper signs as gas sponsor
 *   4. Return tx bytes + sponsor sig to client
 *   5. Client signs as user, submits with both sigs
 *
 * The user ends up owning the DWalletCap directly — no transfer needed.
 */

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  IkaClient, IkaTransaction, getNetworkConfig,
  Curve, UserShareEncryptionKeys,
  createRandomSessionIdentifier, prepareDKGAsync,
} from '@ika.xyz/sdk';
import { createGrpc7kAdapter } from './grpc-7k-adapter.js';

const IKA_TYPE = '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
const SUI_TYPE = '0x2::sui::SUI';
const _7K_API = 'https://aggregator.api.sui-prod.bluefin.io';

export interface ProvisionResult {
  success: boolean;
  /** base64-encoded transaction bytes for the client to sign */
  txBytes?: string;
  /** Keeper's gas sponsor signature */
  sponsorSig?: string;
  /** If already provisioned, the existing dWallet ID */
  dwalletId?: string;
  error?: string;
}

/**
 * Get a swap quote from the 7K aggregator REST API (no SDK dependency).
 */
async function get7kQuote(tokenIn: string, tokenOut: string, amountIn: string) {
  const params = new URLSearchParams({
    amount: amountIn,
    from: tokenIn,
    to: tokenOut,
    sources: 'cetus,aftermath,turbos,deepbook_v3,bluefin,flowx,flowx_v3',
  });
  const res = await fetch(`${_7K_API}/v3/quote?${params}`);
  if (!res.ok) throw new Error(`7K quote failed: ${await res.text()}`);
  return res.json();
}

/**
 * Build a sponsored DKG provisioning transaction.
 *
 * The transaction is built with:
 *   - sender = userAddress (will own the DWalletCap)
 *   - gasOwner = keeperAddress (pays gas)
 *
 * Returns the tx bytes (base64) and keeper's sponsor signature.
 * The client must sign as the user and submit with both signatures.
 */
export async function buildProvisionTx(
  userAddress: string,
  keeperPrivateKey: string,
): Promise<ProvisionResult> {
  const keypair = Ed25519Keypair.fromSecretKey(keeperPrivateKey);
  const keeperAddress = keypair.toSuiAddress();

  // Set up gRPC client + adapter (no JSON-RPC)
  const grpc = new SuiGrpcClient({ network: 'mainnet', baseUrl: 'https://fullnode.mainnet.sui.io:443' });
  const adapter = createGrpc7kAdapter(grpc);

  // Set up IKA client
  const config = getNetworkConfig('mainnet');
  const ikaClient = new IkaClient({ config, suiClient: adapter as any });

  // Check if user already has a dWallet
  const existing = await ikaClient.getOwnedDWalletCaps(userAddress, undefined, 1);
  if (existing.dWalletCaps.length > 0) {
    return { success: true, dwalletId: existing.dWalletCaps[0].dwallet_id };
  }

  // Prepare DKG crypto (WASM) — deterministic seed per user
  const curve = Curve.SECP256K1;
  const seed = new TextEncoder().encode(`ski:dwallet:${userAddress}`);
  const userShareEncryptionKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);
  const sessionIdentifier = createRandomSessionIdentifier();
  const dkgInput = await prepareDKGAsync(
    ikaClient, curve, userShareEncryptionKeys, sessionIdentifier, userAddress,
  );

  // Get network encryption key
  const encKey = await ikaClient.getLatestNetworkEncryptionKey();

  // Fetch keeper's gas coins for sponsorship
  const keeperCoins = await grpc.listCoins({ owner: keeperAddress, coinType: '0x2::sui::SUI' });
  if (!keeperCoins.objects.length) {
    return { success: false, error: 'Keeper has no SUI for gas' };
  }

  // Build the PTB
  const tx = new Transaction();
  tx.setSender(userAddress);
  tx.setGasOwner(keeperAddress);
  tx.setGasPayment(keeperCoins.objects.slice(0, 3).map(c => ({
    objectId: c.objectId,
    version: c.version,
    digest: c.digest,
  })));

  // TODO: Swap SUI→IKA in same PTB once 7K SDK v2 compat is resolved.
  // For now, the keeper must hold IKA tokens.
  // The IKA coin will be fetched from the keeper's balance.
  const keeperIkaCoins = await grpc.listCoins({ owner: keeperAddress, coinType: IKA_TYPE });
  if (!keeperIkaCoins.objects.length) {
    return { success: false, error: 'Keeper has no IKA tokens for DKG fee' };
  }

  // Split coins for DKG fees (from keeper's coins, transferred to user in the PTB)
  const ikaCoin = tx.object(keeperIkaCoins.objects[0].objectId);
  const suiCoin = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000)]); // 0.1 SUI

  // DKG request — user is the sender, so DWalletCap goes to them
  const ikaTx = new IkaTransaction({ ikaClient, transaction: tx, userShareEncryptionKeys });
  await ikaTx.registerEncryptionKey({ curve });

  const [dWalletCap] = await ikaTx.requestDWalletDKG({
    curve,
    dkgRequestInput: dkgInput,
    sessionIdentifier: ikaTx.registerSessionIdentifier(sessionIdentifier),
    ikaCoin,
    suiCoin,
    dwalletNetworkEncryptionKeyId: encKey.id,
  });

  // DWalletCap stays with the sender (user) — no transfer needed

  // Build and sign as gas sponsor
  const txBytes = await tx.build({ client: grpc as any });
  const { signature: sponsorSig } = await keypair.signTransaction(txBytes);

  // Return base64 tx bytes + sponsor sig for the client to co-sign
  const b64 = btoa(String.fromCharCode(...txBytes));

  return {
    success: true,
    txBytes: b64,
    sponsorSig,
  };
}
