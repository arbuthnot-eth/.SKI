/**
 * SUIAMI server-side verification.
 *
 * Verifies a SUIAMI proof token by checking:
 * 1. Token format and freshness (within 5 minutes)
 * 2. NFT ownership on-chain (caller owns the SuiNS registration)
 * 3. Name match (NFT domain_name matches claimed name)
 */

import type { SuiamiMessage } from './index.js';

export interface VerifyResult {
  valid: boolean;
  ownershipVerified: boolean;
  nameVerified: boolean;
  onChainError?: string;
  suiami?: string;
  ski?: string;
  address?: string;
  nftId?: string;
  timestamp?: number;
  signature?: string;
}

export interface VerifyOptions {
  /** GraphQL endpoint. Defaults to mainnet. */
  graphqlUrl?: string;
  /** Max age in ms. Defaults to 5 minutes. */
  maxAgeMs?: number;
  /** Max future tolerance in ms. Defaults to 30 seconds. */
  maxFutureMs?: number;
}

const DEFAULT_GQL = 'https://graphql.mainnet.sui.io/graphql';

/** Verify a SUIAMI proof token. Works in any JS runtime (Node, Deno, CF Workers, Bun). */
export async function verify(token: string, opts?: VerifyOptions): Promise<VerifyResult> {
  const gqlUrl = opts?.graphqlUrl ?? DEFAULT_GQL;
  const maxAge = opts?.maxAgeMs ?? 5 * 60 * 1000;
  const maxFuture = opts?.maxFutureMs ?? 30_000;

  if (!token?.startsWith('suiami:')) return { valid: false, ownershipVerified: false, nameVerified: false, onChainError: 'Invalid token format' };

  const body = token.slice(7);
  const dotIdx = body.lastIndexOf('.');
  if (dotIdx < 0) return { valid: false, ownershipVerified: false, nameVerified: false, onChainError: 'Malformed token' };

  let message: SuiamiMessage;
  let signature: string;
  try {
    const msgB64 = body.slice(0, dotIdx);
    signature = body.slice(dotIdx + 1);
    message = JSON.parse(atob(msgB64));
  } catch {
    return { valid: false, ownershipVerified: false, nameVerified: false, onChainError: 'Parse error' };
  }

  if (!message.suiami || !(message.sui) || !message.nftId) {
    return { valid: false, ownershipVerified: false, nameVerified: false, onChainError: 'Missing required fields' };
  }

  const age = Date.now() - (message.timestamp ?? 0);
  if (age > maxAge || age < -maxFuture) {
    return { valid: false, ownershipVerified: false, nameVerified: false, onChainError: 'Token expired or future-dated' };
  }

  let ownershipVerified = false;
  let nameVerified = false;
  let onChainError: string | undefined;

  try {
    const res = await fetch(gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($id: SuiAddress!) {
          object(address: $id) {
            owner { __typename ... on AddressOwner { address { address } } }
            asMoveObject { contents { type { repr } json } }
          }
        }`,
        variables: { id: message.nftId },
      }),
    });
    const gql = await res.json() as {
      data?: { object?: {
        owner?: { __typename?: string; address?: { address?: string } };
        asMoveObject?: { contents?: { type?: { repr?: string }; json?: Record<string, unknown> } };
      } };
    };

    const obj = gql?.data?.object;
    const ownerAddr = obj?.owner?.__typename === 'AddressOwner' ? (obj.owner.address?.address ?? '') : '';
    const norm = (a: string) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    ownershipVerified = !!ownerAddr && norm(ownerAddr) === norm(message.sui);

    const objType = obj?.asMoveObject?.contents?.type?.repr ?? '';
    if (!objType.includes('suins_registration::SuinsRegistration') && !objType.includes('SubDomainRegistration')) {
      onChainError = 'Object is not a SuiNS registration NFT';
      ownershipVerified = false;
    }

    const fields = obj?.asMoveObject?.contents?.json ?? {};
    const nftName = ((fields.domain_name ?? fields.name ?? '') as string).replace(/\.sui$/, '');
    const claimedName = message.suiami.replace(/^I am /, '');
    nameVerified = nftName === claimedName;
  } catch {
    onChainError = 'On-chain verification failed (RPC error)';
  }

  return {
    valid: ownershipVerified && nameVerified,
    ownershipVerified,
    nameVerified,
    onChainError,
    suiami: message.suiami,
    ski: message.ski,
    address: message.sui,
    nftId: message.nftId,
    timestamp: message.timestamp,
    signature,
  };
}
