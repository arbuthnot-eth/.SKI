# IKA DKG Blocker: SDK Fetches Hundreds of Objects Sequentially

## Problem

The IKA SDK's `getLatestNetworkEncryptionKey()` / `prepareDKGAsync()` fetches **250+ encryption key objects one at a time** via individual `getObject` calls, each going through our `/api/rpc` proxy. All calls succeed but the total time exceeds the SDK's internal timeout, resulting in "Network error: Failed to fetch encryption keys".

## Evidence

Console logs show:
- `sui_multiGetObjects` → ok (coordinator + system)
- `suix_getDynamicFields` → ok (5+ pages of validator encryption keys)
- `sui_getObject` × 250+ → all ok (individual key objects)
- `sui_multiGetObjects` → ok (batch of 46)
- `suix_getDynamicFields` → ok (more pages)
- Eventually: SDK timeout → "Failed to fetch encryption keys"

## Root Cause

The SDK's `fetchEncryptionKeysFromNetwork` iterates `fetchAllDynamicFields` which returns object IDs, then fetches each encryption key object individually instead of batching via `multiGetObjects`. With 250+ validators on IKA mainnet, this creates 250+ sequential HTTP requests through our proxy.

## Possible Solutions

1. **Batch the proxy**: Buffer `getObject` calls and auto-batch them into `multiGetObjects` after a short debounce window (e.g., 50ms). This would turn 250 sequential calls into ~5 batched calls of 50 each.

2. **Pre-cache encryption keys**: On the server side, periodically fetch and cache all encryption keys. Serve them from the Worker's cache on `/api/ika/encryption-keys` so the client doesn't need to fetch them individually.

3. **Patch the SDK**: Fork `@ika.xyz/sdk` and fix `fetchEncryptionKeysFromNetwork` to use `multiGetObjects` instead of individual fetches.

4. **Use the SDK's initialize()**: Call `client.initialize()` first which may pre-fetch and cache the coordinator data.

5. **Contact IKA team**: Report the performance issue — this is a SDK bug that affects all browser-based DKG consumers.

## Recommended: Option 1 (Auto-batching proxy)

Wrap the Proxy shim's `getObject` handler with a microtask debounce:
```ts
let pendingGets: Map<string, { resolve, reject }> = new Map();
let batchTimer: number | null = null;

// When getObject is called, queue it
// After 50ms of no new calls, batch-fetch all queued IDs via multiGetObjects
```

This is transparent to the SDK and doesn't require forking.
