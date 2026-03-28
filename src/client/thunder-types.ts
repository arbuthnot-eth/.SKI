/** Thunder — encrypt SuiNS messaging types and constants. */

export const THUNDER_VERSION = 1;

/**
 * Thunder mainnet deployment.
 * Package: 0xc164...::thunder (module)
 * Storm:   0xe8e7...::thunder::Storm (shared object — NOT the UpgradeCap)
 *
 * To verify: sui client object <STORM_ID> → type should be ...::thunder::Storm
 */
export const THUNDER_PACKAGE_ID = '0xc164180c5aca24b42c5b865c6fcf9160deeed8eafee37635135ac54ab6632a1a';
export const STORM_ID = '0xe8e7d1a55a1cd4ea73be796bb73a2d2f3371c772de5fbdc4c084e939100b45a0';

/** Thunder payload — the cleartext inside the encrypt payload. */
export interface ThunderPayload {
  v: typeof THUNDER_VERSION;
  sender: string;
  senderAddress: string;
  message: string;
  timestamp: string;
  suiami?: string;
}
