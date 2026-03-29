/** Thunder — encrypt signals between SuiNS identities. Types and constants. */

export const THUNDER_VERSION = 1;

/**
 * Thunder mainnet deployment (v3 — signal/quest/cloud).
 * Package: 0x5a60...::thunder (module)
 * Storm:   0xfaf8...::thunder::Storm (shared object — NOT the UpgradeCap)
 *
 * To verify: sui client object <STORM_ID> → type should be ...::thunder::Storm
 */
export const THUNDER_PACKAGE_ID = '0x7d2a68288a8687c54901d3e47511dc65c5a41c50d09378305c556a65cbe2f782';
export const STORM_ID = '0x04928995bbb8e1ab9beff0ccb2747ea1ce404140be8dcc8929827c3985d836e6';

/** Thunder signal — the cleartext content. */
export interface ThunderPayload {
  v: typeof THUNDER_VERSION;
  sender: string;
  senderAddress: string;
  message: string;
  timestamp: string;
  suiami?: string;
}
