/**
 * Thunder Timestream — re-export barrel.
 *
 * New SDK: import from './thunder-stack.js'
 * Legacy compat: this file re-exports both for gradual migration.
 * All consumers import from this file — it routes to the right implementation.
 */

// ─── New SDK (primary) ──────────────────────────────────────────────
export {
  initThunderClient,
  getThunderClient,
  resetThunderClient,
  sendThunder,
  getThunders,
  subscribeThunders,
  createTimestream,
  lookupRecipientAddress,
  type DecryptedMessage,
  type GroupRef,
  type RelayerTransport,
  type ThunderClientOptions,
} from './thunder-stack.js';

