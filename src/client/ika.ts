/**
 * Client-side Ika dWallet integration.
 *
 * Checks for existing dWallet capabilities owned by the connected address
 * and reports cross-chain status. The actual DKG provisioning requires
 * IKA + SUI coins and runs through IkaTransaction on the server.
 */

import { IkaClient, getNetworkConfig } from '@ika.xyz/sdk';
import type { DWalletCap } from '@ika.xyz/sdk';

let ikaClient: IkaClient | null = null;

function getClient(): IkaClient {
  if (!ikaClient) {
    // Dynamic import of SuiClient — Ika SDK expects @mysten/sui/client SuiClient
    // which may be re-exported or aliased in @mysten/sui v2
    const config = getNetworkConfig('mainnet');

    // Lazy-init with a fetch-only client for read operations
    ikaClient = new IkaClient({
      config,
      suiClient: {
        getObject: async (params: { id: string; options?: object }) => {
          const res = await fetch('https://fullnode.mainnet.sui.io:443', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'sui_getObject',
              params: [params.id, params.options || { showContent: true, showBcs: true }],
            }),
          });
          const json = await res.json();
          return json.result;
        },
        multiGetObjects: async (params: { ids: string[]; options?: object }) => {
          const res = await fetch('https://fullnode.mainnet.sui.io:443', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'sui_multiGetObjects',
              params: [params.ids, params.options || { showContent: true, showBcs: true }],
            }),
          });
          const json = await res.json();
          return json.result;
        },
        getOwnedObjects: async (params: {
          owner: string;
          filter?: object;
          cursor?: string;
          limit?: number;
          options?: object;
        }) => {
          const res = await fetch('https://fullnode.mainnet.sui.io:443', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'suix_getOwnedObjects',
              params: [
                params.owner,
                { filter: params.filter, options: params.options || { showContent: true, showBcs: true } },
                params.cursor || null,
                params.limit || 50,
              ],
            }),
          });
          const json = await res.json();
          return json.result;
        },
        getDynamicFields: async (params: { parentId: string; cursor?: string; limit?: number }) => {
          const res = await fetch('https://fullnode.mainnet.sui.io:443', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'suix_getDynamicFields',
              params: [params.parentId, params.cursor || null, params.limit || 50],
            }),
          });
          const json = await res.json();
          return json.result;
        },
      } as any,
    });
  }
  return ikaClient;
}

/**
 * Check if the user has any existing dWallet capabilities.
 * Returns the first dWallet cap found, or null.
 */
export async function checkExistingDWallets(address: string): Promise<{
  hasDWallet: boolean;
  caps: DWalletCap[];
  count: number;
}> {
  try {
    const client = getClient();
    const result = await client.getOwnedDWalletCaps(address, undefined, 10);
    return {
      hasDWallet: result.dWalletCaps.length > 0,
      caps: result.dWalletCaps,
      count: result.dWalletCaps.length,
    };
  } catch {
    // Ika network may not be reachable
    return { hasDWallet: false, caps: [], count: 0 };
  }
}

/**
 * Get cross-chain wallet info for display.
 */
export interface CrossChainStatus {
  ika: boolean;
  dwalletCount: number;
  dwalletId: string;
}

export async function getCrossChainStatus(address: string): Promise<CrossChainStatus> {
  const { hasDWallet, caps, count } = await checkExistingDWallets(address);
  return {
    ika: hasDWallet,
    dwalletCount: count,
    dwalletId: hasDWallet && caps[0] ? caps[0].dwallet_id : '',
  };
}
