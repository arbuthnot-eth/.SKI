# Walrus Quilts, Seal Mainnet, and Storm Architecture Research

**Date:** 2026-03-28
**Status:** Research / reference document
**Related:** [Storm Concept](./2026-03-28-storm-concept.md), [Thunder Design](./2026-03-28-thunder-design.md)

---

## 1. Walrus Quilts

### What Are Quilts?

Quilts are Walrus's native batch storage solution, introduced to solve the economic inefficiency of storing many small files individually. In standard Walrus, every blob (regardless of size) incurs a minimum encoding overhead because the Red Stuff erasure coding distributes data across all storage nodes. For a 10KB file, the per-blob metadata and encoding overhead can dwarf the actual data cost.

Quilts solve this by packing up to **660 small files ("patches")** into a single Walrus blob. The encoding overhead is paid once for the entire quilt, then amortized across all patches inside it. Cost savings are dramatic:

- **~106x cheaper** for batches of 100KB blobs
- **~420x cheaper** for batches of 10KB blobs

Despite being bundled into a single encoded blob, each patch inside a quilt can be **accessed individually** without downloading or decoding the entire quilt. Retrieval latency for a single patch is comparable to (or lower than) that of a standalone blob.

### How Quilts Work Internally

Walrus's Red Stuff encoding organizes data into a 2D matrix of **rows x columns** (also called primary symbols x secondary symbols / slivers). The number of rows and columns is determined by `numShards` and the encoding type.

In a quilt, the matrix columns are partitioned among the patches:

1. The **first few columns** (up to 10) store the **quilt index** -- a BCS-serialized directory listing every patch's identifier, tags, and start/end column indices.
2. Each subsequent patch occupies a contiguous range of columns. A patch consists of:
   - A **6-byte header** (`QuiltPatchBlobHeader`): version (1 byte), length (4 bytes), mask flags (1 byte)
   - An **identifier** (variable-length BCS string, up to 65535 bytes)
   - Optional **tags** (BCS-serialized `Record<string, string>`)
   - The raw **content bytes**
3. Data is written column-by-column within each patch's assigned range. The `writeBlobToQuilt` function fills symbols row-by-row within each column, advancing to the next column when a column is full.

The `encodeQuilt` function:
1. Sorts blobs by identifier (lexicographic)
2. Computes the index size and per-patch metadata sizes
3. Uses binary search (`computeSymbolSize`) to find the minimum symbol size that fits all patches plus the index into the available columns
4. Writes the index into columns 0..N, then each patch sequentially
5. Returns the flat `Uint8Array` quilt buffer plus the index

**Key constraint:** The maximum number of patches is bounded by the number of secondary symbols (columns), which depends on `numShards`. With mainnet's shard count, this yields ~660 patches per quilt.

### Quilt IDs and Patch IDs

- A **quilt** is identified by its regular Walrus blob ID (32 bytes, URL-safe base64)
- A **patch** within a quilt is identified by a **QuiltPatchId**, which is a BCS-serialized struct containing:
  - `quiltId`: the parent blob ID
  - `patchId`: `{ version: 1, startIndex: number, endIndex: number }`
- The `parseWalrusId` function distinguishes them by length: 32 bytes = blob ID, longer = quilt patch ID

### SDK API (`@mysten/walrus` v1.1.0)

**Writing quilts:**
```ts
// High-level: writeFiles bundles everything into a quilt automatically
const results = await client.walrus.writeFiles({
  files: [
    WalrusFile.from({ contents: data1, identifier: 'msg-001.enc', tags: { type: 'storm' } }),
    WalrusFile.from({ contents: data2, identifier: 'msg-002.enc', tags: { type: 'storm' } }),
  ],
  epochs: 3,
  deletable: true,
  signer: keypair,
});
// results[i].id is the QuiltPatchId (URL-safe base64)
// results[i].blobId is the parent quilt blob ID

// Low-level: encodeQuilt directly
const { quilt, index } = await client.walrus.encodeQuilt({
  blobs: [
    { contents: new Uint8Array(...), identifier: 'file1', tags: { 'content-type': 'text/plain' } },
    { contents: new Uint8Array(...), identifier: 'file2' },
  ],
});
// quilt is a Uint8Array ready to be written as a single blob
// index.patches[i] has { identifier, startIndex, endIndex, tags }
```

**Reading quilts:**
```ts
// getFiles accepts both blob IDs and quilt patch IDs transparently
const [file1, file2] = await client.walrus.getFiles({ ids: [patchId1, patchId2] });
const bytes = await file1.bytes();
const text = await file1.text();
const id = await file1.getIdentifier();   // e.g. 'msg-001.enc'
const tags = await file1.getTags();        // e.g. { type: 'storm' }

// Or read entire quilt contents via WalrusBlob
const blob = await client.walrus.getBlob({ blobId: quiltBlobId });
const allFiles = await blob.files();
const filtered = await blob.files({ tags: [{ type: 'storm' }] });
```

**Resumable uploads (v1.1.0):**
```ts
const flow = client.walrus.writeFilesFlow({ files });
for await (const step of flow.run({ signer, epochs: 3, deletable: true })) {
  await db.save(fileId, step); // persist for crash recovery
}
const fileRefs = await flow.listFiles();
```

The `_walrusBlobType: "quilt"` attribute is automatically set on the blob object when using `writeFiles` or `writeFilesFlow`.

### Quilts for Batching Encrypted Messages (Storm Use Case)

**Yes, quilts are ideal for batching many small encrypted messages.** A typical Seal-encrypted message is 500 bytes to 5KB (ciphertext + Seal metadata). Without quilts, each message would be a separate Walrus blob with full encoding overhead. With quilts:

- A batch of 100 encrypted Storm messages (~200KB total) fits in a single quilt
- The quilt index provides O(1) lookup by identifier or tag
- Individual messages can be read without downloading the full quilt
- Tags can encode metadata (sender hash, timestamp, chain type) without decryption
- Cost savings: ~100x vs individual blobs for small messages

**Design consideration for Storm:** Messages in the same quilt share a single blob ID on-chain. The `ThunderPointer` would store the `QuiltPatchId` (not the blob ID) so each message can be individually addressed and decrypted.

---

## 2. Seal Latest Developments

### SDK Version: `@mysten/seal` v1.1.1

Key changelog milestones:
- **v0.5.0** (late 2025): Mainnet release cut
- **v0.8.0**: Fixed BLS scalar encoding (big-endian forced after noble/curves changed default to little-endian)
- **v0.10.0**: Added key server v2 support and aggregator for committee mode
- **v1.0.0**: Updated to `SuiJsonRpcClient` API (Sui SDK v2.x)
- **v1.1.0**: Changed partial key server storage from `VecMap` to `vector`
- **v1.1.1**: Added embedded LLM-friendly docs

### Committee Mode vs Independent Mode

**Independent mode (v1 key servers):**
- Single operator runs a standalone server holding the full master secret key
- Each independent server is a separate entity in Seal's t-of-n threshold
- SDK config: `{ objectId: '0x...', weight: 1 }`
- Simple, but each server is a single point of compromise for its share

**Committee mode (v2 key servers, "Decentralized Seal Key Server"):**
- The master secret is split across multiple geo-distributed MPC operators
- No single operator ever holds the complete key
- An **aggregator** service coordinates: collects encrypted partial responses from operators, combines them into a single encrypted output
- The aggregator cannot decrypt data -- it only handles encrypted shares
- SDK config: `{ objectId: '0x...', weight: 1, aggregatorUrl: 'https://...' }`
- A single committee server counts as **one server** in Seal's threshold (e.g., one committee + two independent = 3 servers, threshold 2-of-3)
- Membership can rotate over time without re-encrypting existing data
- Currently **live on testnet**; mainnet status TBD

**Hybrid models:** Developers can mix independent and committee servers in the same threshold configuration.

### Mainnet Key Server Operators

At mainnet launch, the following operators are available:
- **Overclock** (independent)
- **NodeInfra** (independent)
- **Studio Mirai** (independent)
- **Ruby Nodes** (independent)
- **H2O Nodes** (independent)
- **Triton One** (independent)
- **Enoki by Mysten Labs** (independent)

**Known testnet object IDs (for reference):**
- Overclock: `0x9c949e53c36ab7a9c484ed9e8b43267a77d4b8d70e79aa6b39042e3d4c434105`
- Studio Mirai: `0x164ac3d2b3b8694b8181c13f671950004765c23f270321a45fdd04d40cccf0f2`

**Mainnet object IDs:** Not publicly enumerated in search results. The official source is [seal-docs.wal.app/UsingSeal](https://seal-docs.wal.app/UsingSeal) under "Verified Key Servers." The on-chain object always holds the latest URL as the source of truth. Previously in SKI's MEMORY.md, the known free/open mainnet servers were Overclock, NodeInfra, and Studio Mirai (2-of-3 threshold).

### SDK Configuration

```ts
const sealClient = new SealClient({
  suiClient: grpcClient,  // Must be ClientWithExtensions<{ core: CoreClient }>
  serverConfigs: [
    { objectId: '<overclock-mainnet-id>', weight: 1 },
    { objectId: '<nodeinfra-mainnet-id>', weight: 1 },
    { objectId: '<studiomirai-mainnet-id>', weight: 1 },
  ],
  verifyKeyServers: true,  // verify PoP from each server
  timeout: 10_000,
});
```

### Other Notable Changes

- **DEM types:** AesGcm256 (default) and Hmac256Ctr
- **KEM type:** BonehFranklinBLS12381DemCCA (only option)
- **Session keys:** exportable/importable for persistence (IndexedDB), max TTL 30 minutes, support for MVR names
- **API key support:** servers can require API keys via `apiKeyName` + `apiKey` in config

---

## 3. Storm Architecture: Walrus for Large Encrypted Payloads

### The Problem

Thunder v1 stores small text ciphertext inline on-chain (< 2KB after Seal encryption). This works for text messages but cannot support:
- Encrypted images (100KB - 10MB)
- Encrypted audio clips (500KB - 50MB)
- Encrypted video (10MB - 1GB+)
- Encrypted document attachments

### Proposed PayloadLocation Enum

The `Thunder.in` contract (or Storm equivalent) should distinguish between inline and Walrus-stored payloads:

```
// Move pseudocode
struct StormPointer has store {
    id: UID,
    sender_hash: vector<u8>,
    payload: PayloadLocation,
    seal_pkg: address,        // which seal_approve package was used for encryption
    timestamp_ms: u64,
}

enum PayloadLocation has store, copy, drop {
    Inline { ciphertext: vector<u8> },           // small messages, <= 2KB
    Walrus { blob_id: u256 },                     // single large blob on Walrus
    WalrusQuilt { patch_id: vector<u8> },         // patch within a quilt
}
```

### Quilt Batching for Storm Messages

**Scenario:** A high-volume sender (e.g., a notification service, a DAO) sends many small encrypted messages. Instead of one Walrus write per message, they can batch:

1. Accumulate N messages (e.g., 100 encrypted Storm payloads)
2. Call `encodeQuilt` to pack them into a single quilt
3. Write the quilt to Walrus once (1 blob registration, 1 certification)
4. For each message, store a `StormPointer` on-chain with `PayloadLocation::WalrusQuilt { patch_id }` pointing to its specific patch

**Benefits:**
- ~100x cost reduction for small messages
- Single on-chain blob object instead of 100
- Recipients still access their individual messages without downloading others
- Tags can store unencrypted routing metadata

**When NOT to use quilts:**
- Single large files (images, video) -- just use a regular blob
- Messages that must be independently deletable (quilts are all-or-nothing for deletion)
- Real-time individual messages where batching latency is unacceptable

### Large File Encryption via Walrus

For large payloads (images, audio, video):

1. Seal-encrypt the payload (produces ciphertext + Seal metadata)
2. Write the ciphertext to Walrus as a regular blob: `client.walrus.writeBlob({ blob: ciphertext, ... })`
3. Store `PayloadLocation::Walrus { blob_id }` in the `StormPointer` on-chain
4. Recipient reads the blob from Walrus, then Seal-decrypts

**Size considerations:**
- Seal encryption adds ~100-200 bytes overhead (BCS-encoded EncryptedObject header)
- Walrus minimum storage unit is 1MB (smaller files still cost 1 unit)
- Walrus pricing: storage cost + write cost per unit per epoch
- For very large files, use the upload relay to avoid browser resource exhaustion

---

## 4. Walrus Publisher and Upload Alternatives

### Upload Relay (Recommended for Browser)

The **Upload Relay** is a lightweight HTTP service that accepts blob data from clients and distributes it to storage nodes on their behalf. This solves the browser problem: writing a blob directly requires ~2,200 requests to storage nodes (impractical from a browser).

**Mysten-operated relays:**
- Testnet: `https://upload-relay.testnet.walrus.space`
- Mainnet: `https://upload-relay.mainnet.walrus.space`

**Tipping model:** Relays may require a SUI tip (paid in the registration transaction) to cover operational costs. The tip configuration is available at `/v1/tip-config`. Tips can be:
- `const`: fixed amount per blob
- `linear`: base + per-encoded-KiB multiplier

**SDK integration:**
```ts
const client = new SuiGrpcClient({
  network: 'mainnet',
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
}).$extend(walrus({
  uploadRelay: {
    host: 'https://upload-relay.mainnet.walrus.space',
    sendTip: { max: 1_000 },  // auto-detect tip, cap at 1000 MIST
  },
}));
```

**Key advantage:** The client only sends the blob data once (to the relay), instead of slicing it into slivers and distributing to ~500+ storage nodes. The relay handles fan-out.

### Known Mainnet Publisher/Aggregator Endpoints

| Operator | Type | Endpoint | Notes |
|----------|------|----------|-------|
| Mysten Labs | Upload Relay | `https://upload-relay.mainnet.walrus.space` | Official, supports tipping |
| Staketab | Publisher | `https://walrus-mainnet-publisher-1.staketab.org:443` | Free |
| Nami Cloud | Publisher/Aggregator | Via Nami Cloud API | Also offers Go SDK, S3-compatible API |
| Blockberry | API | Blockberry Walrus API | Analytics + blob data endpoints |

### CORS and Browser Access

- Storage nodes now support **publicly trusted TLS certificates** (Let's Encrypt etc.), enabling JavaScript clients to directly store and retrieve blobs
- The Upload Relay is specifically designed for browser environments -- it accepts a single HTTP POST with the blob data
- Running your own publisher/aggregator: self-hostable via the `walrus` binary, supports JWT auth, can be deployed behind nginx with CORS headers
- The `@mysten/walrus` SDK works in browsers but needs the WASM module loaded (via bundler import or CDN: `https://unpkg.com/@mysten/walrus-wasm@latest/web/walrus_wasm_bg.wasm`)

### Publisher vs Upload Relay vs Direct SDK

| Method | Requests | Browser-friendly | Cost control | Notes |
|--------|----------|------------------|-------------|-------|
| Direct SDK (no relay) | ~2,200 writes | Impractical | Full control | Best for server-side batch jobs |
| Upload Relay | 1 POST | Yes | Relay tip | Recommended for browser uploads |
| Publisher (HTTP API) | 1 PUT | Yes (if CORS) | Publisher fee | Legacy approach, being replaced by relay |
| Aggregator (read) | 1 GET | Yes | Free | Read-only, for serving blobs |

---

## 5. Walrus + Seal Integration Notes

### Walrus Package Config (Mainnet)

```ts
const MAINNET_WALRUS_PACKAGE_CONFIG = {
  systemObjectId: '0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2',
  stakingPoolId: '0x10b9d30c28448939ce6c4d6c6e0ffce4a7f8a4ada8248bdad09ef8b70e4a3904',
};
```

### Walrus SDK Version

`@mysten/walrus` v1.1.0 -- key new features:
- Resumable uploads (`writeBlobFlow`, `writeFilesFlow` with `resume` option)
- `onStep` callbacks for progress tracking
- `WalrusFile` abstraction transparently handles blobs and quilt patches
- `encodeQuilt` exported as a standalone utility
- RS2 encoding type (default, more efficient than RedStuff for most workloads)

### Seal + Walrus Pattern for Storm

```
Encrypt(data) --> ciphertext (Uint8Array)
    |
    v
IF ciphertext.length < 2048:
    Store inline in StormPointer on-chain
ELSE IF batching multiple messages:
    Accumulate, encodeQuilt, writeBlob, store QuiltPatchIds on-chain
ELSE:
    writeBlob to Walrus, store blob_id on-chain
```

---

## References

- [Introducing Quilt (Walrus Blog)](https://www.walrus.xyz/blog/introducing-quilt)
- [Walrus SDK Docs](https://sdk.mystenlabs.com/walrus)
- [Seal Documentation](https://seal-docs.wal.app/)
- [Seal Mainnet Launch Blog](https://www.mystenlabs.com/blog/seal-mainnet-launch-privacy-access-control)
- [Decentralized Seal Key Server (Testnet)](https://blog.sui.io/introducing-decentralized-seal-key-server-testnet/)
- [Walrus Upload Relay Docs](https://docs.wal.app/operator-guide/upload-relay.html)
- [awesome-walrus (GitHub)](https://github.com/MystenLabs/awesome-walrus)
- [Seal Pricing](https://seal-docs.wal.app/Pricing)
- [Walrus Red Stuff Encoding](https://www.walrus.xyz/blog/how-walrus-red-stuff-encoding-works)
- [@mysten/walrus npm](https://www.npmjs.com/package/@mysten/walrus)
- [@mysten/seal npm](https://www.npmjs.com/package/@mysten/seal)
