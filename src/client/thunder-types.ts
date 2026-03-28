/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0xbc403b6a1d567f70609a210e4d0909c4be96a19c548903716fc0b1795bb56ee4';

/** Thunder.in shared object ID (mainnet). */
export const THUNDER_IN_ID = '0x6ab0b4cdabc4bde32f8c03a907e940e4f348b752a9152ccd4f0b2adec1ea689d';

/** Thunder payload — the cleartext inside the encrypt blob. */
export interface ThunderPayload {
  v: typeof THUNDER_VERSION;
  sender: string;
  senderAddress: string;
  message: string;
  timestamp: string;
  suiami?: string;
}

/** On-chain ThunderPointer fields (mirrors Move struct). */
export interface ThunderPointerData {
  blobId: Uint8Array;
  sealedNamespace: Uint8Array;
  timestampMs: number;
}
