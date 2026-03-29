/** Thunder — encrypt signals between SuiNS identities. Types and constants. */

export const THUNDER_VERSION = 1;

/**
 * Thunder mainnet deployment (v3 — signal/quest/cloud).
 * Package: 0x5a60...::thunder (module)
 * Storm:   0xfaf8...::thunder::Storm (shared object — NOT the UpgradeCap)
 *
 * To verify: sui client object <STORM_ID> → type should be ...::thunder::Storm
 */
export const THUNDER_PACKAGE_ID = '0xab627152bfbafeb06f567c1932f4d2eba11799160042219d2edaa0706c306ee6';
export const STORM_ID = '0xebafb2bc3e63664cbf7d9521fca7a809c35d89403fbc3a6669042eacefc34dc1';

/** Thunder signal — the cleartext content. */
export interface ThunderPayload {
  v: typeof THUNDER_VERSION;
  sender: string;
  senderAddress: string;
  message: string;
  timestamp: string;
  suiami?: string;
}
