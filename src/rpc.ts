/**
 * Centralized Sui RPC — racing fan-out across multiple backends.
 *
 * Browser-side: exports a racing `grpcClient` that fans out gRPC-Web
 * calls to multiple fullnodes and returns the fastest response.
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

// ─── Backend URLs ─────────────────────────────────────────────────────

/** gRPC-Web endpoints for browser fan-out */
export const GRPC_BACKENDS: string[] = [
  'https://fullnode.mainnet.sui.io:443',
  'https://rpc-mainnet.suiscan.xyz:443',
];

/** Primary gRPC URL (for SuinsClient and other APIs that need a single client) */
export const grpcUrl = GRPC_BACKENDS[0];

/** GraphQL endpoint (read-only queries — no racing needed, single endpoint) */
export const GQL_URL = 'https://graphql.mainnet.sui.io/graphql';

// ─── Singleton clients ────────────────────────────────────────────────

/** Racing gRPC client — points at the primary backend. Used throughout browser code. */
export const grpcClient = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: grpcUrl,
});

/** GraphQL client for read-only queries */
export const gqlClient = new SuiGraphQLClient({
  url: GQL_URL,
  network: 'mainnet',
});

// ─── Racing transaction execution ─────────────────────────────────────

const BACKEND_TIMEOUT_MS = 5_000;
const RACE_RETRIES = 2;

/** Cached per-backend gRPC clients (avoid re-creating on every call) */
const _grpcClients = new Map<string, SuiGrpcClient>();
function getGrpcClient(url: string): SuiGrpcClient {
  let c = _grpcClients.get(url);
  if (!c) { c = new SuiGrpcClient({ network: 'mainnet', baseUrl: url }); _grpcClients.set(url, c); }
  return c;
}

/**
 * Race transaction execution across all gRPC backends.
 * Uses Promise.any — first success wins, rest ignored.
 * Falls back to JSON-RPC endpoints if all gRPC backends fail.
 */
export async function raceExecuteTransaction(
  txBytes: Uint8Array,
  signatures: string[],
): Promise<{ digest: string; effects?: unknown }> {
  // Phase 1: Race gRPC backends
  for (let attempt = 0; attempt <= RACE_RETRIES; attempt++) {
    try {
      const result = await Promise.any(
        GRPC_BACKENDS.map(async (url) => {
          const client = getGrpcClient(url);
          const res = await Promise.race([
            client.executeTransaction({ transaction: txBytes, signatures }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), BACKEND_TIMEOUT_MS),
            ),
          ]);
          const r = res as Record<string, unknown>;
          const digest = (r.digest as string) ?? '';
          if (!digest) throw new Error('no digest');
          return { digest, effects: r.effects };
        }),
      );
      return result;
    } catch {
      if (attempt === RACE_RETRIES) break;
    }
  }

  // Phase 2: Fall back to JSON-RPC endpoints
  const JSONRPC_FALLBACKS = [
    'https://sui-rpc.publicnode.com',
    'https://sui-mainnet-endpoint.blockvision.org',
    'https://rpc.ankr.com/sui',
    'https://rpc-mainnet.suiscan.xyz:443',
  ];

  const b64 = uint8ToBase64(txBytes);
  let lastErr: unknown;
  for (const url of JSONRPC_FALLBACKS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'sui_executeTransactionBlock',
          params: [b64, signatures, { showEffects: true }, 'WaitForLocalExecution'],
        }),
      });
      const json = await res.json() as {
        result?: { digest?: string; effects?: Record<string, unknown> };
        error?: { message?: string };
      };
      if (json.error) throw new Error(json.error.message ?? 'RPC error');
      const effects = json.result?.effects;
      const status = effects?.status as { status?: string; error?: string } | undefined;
      if (status?.status === 'failure') throw new Error(status.error || 'Transaction failed on-chain');
      return { digest: json.result?.digest ?? '', effects };
    } catch (err) { lastErr = err; }
  }
  throw lastErr ?? new Error('All RPC endpoints failed');
}

function uint8ToBase64(bytes: Uint8Array): string {
  let b = '';
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
  return btoa(b);
}
