/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0xcbb8832434de41704e176015493d05e0242ff8a994cf5c8e0b3e138e73ae6cec';

/** Thunder.in shared object ID (mainnet). */
export const THUNDER_IN_ID = '0x2c65298395a6c890ddb59ad327af0c0cb43f203572d25fe062605399b9929157';

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
