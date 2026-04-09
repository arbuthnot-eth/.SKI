/**
 * Legacy Thunder helpers — preserved for Chronicom signal counting
 * and backward compat during migration. Do NOT add new code here.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { gqlClient } from '../rpc.js';
import { STORM_ID } from './thunder-types.js';

/** Hash the full domain with .sui — matches the Move contract's keccak256(nft.domain().to_string()). */
export function nameHash(name: string): Uint8Array {
  const full = name.toLowerCase().replace(/\.sui$/, '') + '.sui';
  return keccak_256(new TextEncoder().encode(full));
}

/**
 * Get thunder presence for ALL names in one gRPC call.
 * Lists dynamic fields on Storm — if a storm exists for a name hash, it has ≥1 signal.
 * Returns a map of bareName → 1 (has thunder) or 0 (no thunder).
 */
export async function getThunderCountsBatch(names: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  if (names.length === 0) return result;

  const hashToBare: Record<string, string> = {};
  for (const name of names) {
    const bare = name.replace(/\.sui$/i, '').toLowerCase();
    const ns = nameHash(bare);
    const hex = Array.from(ns).map(b => b.toString(16).padStart(2, '0')).join('');
    hashToBare[hex] = bare;
    result[bare] = 0;
  }

  try {
    const { grpcClient } = await import('../rpc.js');
    const stormIds = [STORM_ID];
    for (const sid of stormIds) {
      try {
        const dfResult = await grpcClient.listDynamicFields({ parentId: sid });
        const fields = dfResult.dynamicFields ?? [];
        for (const df of fields) {
          const bcsValues = Object.values(df.name.bcs as unknown as Record<string, number>);
          const nameBytes = bcsValues.slice(1);
          const hex = nameBytes.map((b: number) => b.toString(16).padStart(2, '0')).join('');
          if (hashToBare[hex]) {
            result[hashToBare[hex]] = (result[hashToBare[hex]] || 0) + 1;
          }
        }
      } catch { /* skip this storm */ }
    }
  } catch { /* return cached zeros */ }

  return result;
}

/** Look up the SuinsRegistration NFT object ID for a name. Legacy — used by strike relay. */
export async function lookupRecipientNftId(name: string): Promise<string | null> {
  const fullName = name.replace(/\.sui$/i, '').toLowerCase() + '.sui';
  try {
    const { SuinsClient } = await import('@mysten/suins');
    const suinsClient = new SuinsClient({ client: gqlClient as never, network: 'mainnet' });
    const record = await suinsClient.getNameRecord(fullName);
    return record?.nftId ?? null;
  } catch { return null; }
}
