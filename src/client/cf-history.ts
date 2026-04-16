// Porygon — CF edge enrichment client.
//
// Fetches signed CF metadata from the worker, change-detects against
// the tail chunk (so typical users produce 1-3 lifetime chunks, not
// hundreds), Seal-encrypts, uploads to Walrus, and returns the new
// blob ID for inclusion in a roster-write PTB.

import { encryptCfChunkToWalrus, decryptCfChunkForAddress } from './suiami-seal.js';

export interface CfFields {
  country: string;
  asn: number;
  threatScore: number;
  ipHash: string;
  colo: string;
  verifiedBot: boolean;
  tlsVersion: string;
  httpProtocol: string;
  attestedAt: number;
}
export interface CfEnvelope { data: CfFields; sig: string }
export interface CfChunk { schema: 1; data: CfFields; sig: string }

/** Fields compared for change-detection. Everything except
 *  `attestedAt` — a new chunk only gets written when something real
 *  about the user's edge context changes. */
const CHANGE_KEYS: Array<keyof CfFields> = [
  'country', 'asn', 'threatScore', 'ipHash', 'colo',
  'verifiedBot', 'tlsVersion', 'httpProtocol',
];

function fingerprintsMatch(a: CfFields, b: CfFields): boolean {
  return CHANGE_KEYS.every((k) => a[k] === b[k]);
}

export async function fetchCfContext(): Promise<CfEnvelope | null> {
  try {
    const res = await fetch('/api/cf-context');
    if (!res.ok) return null;
    return (await res.json()) as CfEnvelope;
  } catch {
    return null;
  }
}

/** Decide whether to write a new CF chunk. Returns the Walrus blob
 *  ID of the freshly-uploaded chunk, or null when the fingerprint is
 *  unchanged (no write needed). Caller then passes the blob ID into
 *  `append_cf_history` as part of the enclosing roster-write PTB.
 *
 *  When `tailBlobId` is provided, we decrypt the prior chunk and
 *  compare fingerprints before writing. On decrypt failure (network,
 *  expired session key) we fall back to writing — staleness is
 *  preferable to a silent history gap. */
export async function maybeBuildCfChunk(opts: {
  ownerAddress: string;
  tailBlobId: string;
  signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }>;
}): Promise<string | null> {
  const env = await fetchCfContext();
  if (!env) return null;
  if (opts.tailBlobId) {
    try {
      const prev = (await decryptCfChunkForAddress({
        blobId: opts.tailBlobId,
        address: opts.ownerAddress,
        signPersonalMessage: opts.signPersonalMessage,
      })) as CfChunk | null;
      if (prev?.data && fingerprintsMatch(prev.data, env.data)) {
        return null;
      }
    } catch {
      // Fall through to write.
    }
  }
  const chunk: CfChunk = { schema: 1, data: env.data, sig: env.sig };
  const { blobId } = await encryptCfChunkToWalrus(opts.ownerAddress, chunk);
  return blobId;
}

/** Decrypt and return the full CF history for the caller. Returns an
 *  empty array if the user has no cf_history or every decrypt fails. */
export async function readCfHistory(opts: {
  ownerAddress: string;
  blobIds: string[];
  signPersonalMessage: (msg: Uint8Array) => Promise<{ signature: string }>;
}): Promise<CfChunk[]> {
  const out: CfChunk[] = [];
  for (const id of opts.blobIds) {
    const chunk = (await decryptCfChunkForAddress({
      blobId: id,
      address: opts.ownerAddress,
      signPersonalMessage: opts.signPersonalMessage,
    })) as CfChunk | null;
    if (chunk) out.push(chunk);
  }
  return out;
}
