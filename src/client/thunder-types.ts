/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0xda24db9d7ac4bd18c57641c01dc6312bb4bf04db25baf19e3b6273310b72d254';

/** Storm shared object ID (mainnet). */
export const STORM_ID = '0x7e8472ebcb4c8aecbd772899bd6a38d846891ff9de3bf34509e3bf9a7e1b4814';

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
