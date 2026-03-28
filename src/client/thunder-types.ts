/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0x6e38812f93d06b6933ba72101357e2905566cd55681469e10b13c7e7507c77b1';

/** Thunder.in shared object ID (mainnet). */
export const THUNDER_IN_ID = '0x5b68533d5d29b5557efab30e959976e4a4fb6a162a138f8d48d1ee9eba5e3a93';

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
