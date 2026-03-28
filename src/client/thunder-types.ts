/** Thunder — Seal-encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/** Thunder package ID (mainnet). */
export const THUNDER_PACKAGE_ID = '0xb5fea008e11375aa8903597817b87c0879e0e9548630c3d10823efe19ed02203';

/** Thunder.in shared object ID (mainnet). */
export const THUNDER_IN_ID = '0x2e77433393ea8487035ebcce7788c1516b1926ca3e11740b98b29f4f8e8d9132';

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
