# Thunder Privacy — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four cheap metadata-leak holes identified in the 2026-04-10 Thunder privacy audit — message size padding, timestamp jitter, sender address → sender index on the wire, and an attachments-metadata guard.

**Architecture:** All four fixes are scoped to `src/client/thunder-stack.ts` (client: pad/unpad + sender index mapping) and `src/server/agents/timestream.ts` (server: jitter timestamps on ingest, store sender by index, reject attachments). No new files. No SDK version bump. Backward-compatible with existing DOs (empty participants list ⇒ legacy behavior; messages without index fields fall back to address).

**Tech Stack:** `@mysten/sui-stack-messaging@0.0.2`, `@mysten/seal@1.1.1`, Cloudflare Durable Objects, TypeScript, existing `encryptWithRetry` / `TimestreamRelayer` / `TimestreamAgent` code paths.

**Spec:** `docs/superpowers/specs/2026-04-10-thunder-privacy-audit-and-roadmap.md` §4 Phase 1.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/client/thunder-stack.ts` | Modify | Pad plaintext before encrypt; unpad after decrypt; send sender index instead of address; stop reading `createdAt` with ms precision |
| `src/server/agents/timestream.ts` | Modify | Jitter timestamps to 10s buckets + ±5s noise on ingest; store messages with `senderIndex` (position in participants) instead of raw address; reject non-empty `attachments` in `_handleSend`; expose participant list length in `_handleFetch` response so client can map index → address for own messages |

---

## Task 1: P1.2 — Pad plaintext to fixed size buckets

**Files:**
- Modify: `src/client/thunder-stack.ts` (add `padPlaintext` / `unpadPlaintext` helpers; call them in `encryptWithRetry` and in the `getThunders` decrypt loop)

Pad every plaintext to the smallest bucket in `[256, 1024, 4096, 16384]` bytes. Wire format: `[4-byte little-endian u32 length][plaintext bytes][zero padding]`. On decrypt, read the length prefix and slice back to the original plaintext. AES-GCM ciphertext then has a fixed size corresponding to the bucket, killing the plaintext-length side channel.

- [ ] **Step 1: Add `padPlaintext` / `unpadPlaintext` helpers near the existing `toB64`/`fromB64` helpers (around line 118)**

```typescript
// ─── Message padding (P1.2) ────────────────────────────────────────
// Pad to fixed buckets so ciphertext size does not leak plaintext length.
// Wire format: [u32 LE length][plaintext][zero padding up to bucket].
const PAD_BUCKETS = [256, 1024, 4096, 16384] as const;
const PAD_MAX = PAD_BUCKETS[PAD_BUCKETS.length - 1];

function padPlaintext(data: Uint8Array): Uint8Array {
  const len = data.length;
  // Minimum size of a padded message: 4-byte length prefix + payload.
  const needed = 4 + len;
  if (needed > PAD_MAX) {
    // Oversize messages are sent at their natural size + length prefix;
    // this is still a fixed-format message, just not bucketed.
    const out = new Uint8Array(needed);
    new DataView(out.buffer).setUint32(0, len, true);
    out.set(data, 4);
    return out;
  }
  const bucket = PAD_BUCKETS.find(b => b >= needed) ?? PAD_MAX;
  const out = new Uint8Array(bucket);
  new DataView(out.buffer).setUint32(0, len, true);
  out.set(data, 4);
  // Remaining bytes are already zero from Uint8Array init.
  return out;
}

function unpadPlaintext(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) return padded; // legacy (unpadded) message
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, true);
  // Sanity check: if len is obviously wrong, assume legacy unpadded plaintext.
  if (len > padded.length - 4 || len > PAD_MAX) return padded;
  return padded.slice(4, 4 + len);
}
```

- [ ] **Step 2: Wrap the `encryptWithRetry` call in `sendThunder` so the transfer-note encrypt path pads (around line 345)**

Change:
```typescript
      const noteBytes = new TextEncoder().encode(transferNote);
      const noteEnv = await encryptWithRetry(groupId, noteBytes);
```
to:
```typescript
      const noteBytes = padPlaintext(new TextEncoder().encode(transferNote));
      const noteEnv = await encryptWithRetry(groupId, noteBytes);
```

- [ ] **Step 3: Pad the main message encrypt path (around line 372)**

Change:
```typescript
  const msgBytes = new TextEncoder().encode(opts.text);
  const envelope = await encryptWithRetry(groupId, msgBytes);
```
to:
```typescript
  const msgBytes = padPlaintext(new TextEncoder().encode(opts.text));
  const envelope = await encryptWithRetry(groupId, msgBytes);
```

- [ ] **Step 4: Unpad in the decrypt loop inside `getThunders` (around line 448)**

Change:
```typescript
          const plaintext = await client.messaging.encryption.decrypt({
            uuid: groupId,
            envelope: { ciphertext, nonce, keyVersion: kv },
          });
          text = new TextDecoder().decode(plaintext);
```
to:
```typescript
          const plaintext = await client.messaging.encryption.decrypt({
            uuid: groupId,
            envelope: { ciphertext, nonce, keyVersion: kv },
          });
          text = new TextDecoder().decode(unpadPlaintext(plaintext));
```

- [ ] **Step 5: Build**

```bash
bun run build
```

Expected: `Bundled ... modules in ...` with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/client/thunder-stack.ts
git commit -m "$(cat <<'EOF'
feat(thunder): P1.2 — pad plaintext to fixed size buckets

Altaria Lv.56 — Thunder plaintext is now padded to the smallest bucket
in [256, 1024, 4096, 16384] bytes before Seal encryption. Wire format:
[u32 LE length][plaintext][zero padding]. On decrypt, the length prefix
is read and the padding stripped. AES-GCM ciphertext is now a fixed
size per bucket, killing the plaintext-length side channel that would
otherwise distinguish "hey" from "\$7M transfer notice".

Legacy (unpadded) messages decrypt unchanged — the length-prefix check
falls back gracefully if the first 4 bytes decode to a nonsense length.

Part of the Thunder privacy Phase 1 roadmap (spec 2026-04-10).
EOF
)"
```

---

## Task 2: P1.3 — Jitter timestamps on ingest

**Files:**
- Modify: `src/server/agents/timestream.ts` (round `createdAt`/`updatedAt` in `_handleSend` and `_handleUpdate`)

Round the ingest timestamp down to the nearest 10-second boundary, then add a uniform random offset in `[-5000, 5000]` ms. Message ordering is preserved via the monotonic `order` field; absolute timing becomes fuzzy by ±5s plus the 10s bucket. Cheap, no protocol change, and defeats traffic analysis by second-level timing.

- [ ] **Step 1: Add a `jitterTs` helper near `normAddr` (around line 44)**

```typescript
/** Round timestamp to 10s bucket + add ±5s uniform noise. Preserves order via the monotonic `order` field. */
function jitterTs(ms: number): number {
  const bucket = Math.floor(ms / 10_000) * 10_000;
  const noise = Math.floor((Math.random() - 0.5) * 10_000);
  return bucket + noise;
}
```

- [ ] **Step 2: Use it in `_handleSend` (around line 125)**

Change:
```typescript
    const messageId = crypto.randomUUID();
    const order = this.state.nextOrder;
    const now = Date.now();
```
to:
```typescript
    const messageId = crypto.randomUUID();
    const order = this.state.nextOrder;
    const now = jitterTs(Date.now());
```

- [ ] **Step 3: Use it in `_handleUpdate` (around line 208)**

Change:
```typescript
    updated.updatedAt = Date.now();
```
to:
```typescript
    updated.updatedAt = jitterTs(Date.now());
```

- [ ] **Step 4: Use it in `_handleDelete` (around line 229)**

Change:
```typescript
    messages[idx] = { ...messages[idx], isDeleted: true, updatedAt: Date.now() };
```
to:
```typescript
    messages[idx] = { ...messages[idx], isDeleted: true, updatedAt: jitterTs(Date.now()) };
```

- [ ] **Step 5: Build**

```bash
bun run build
```

- [ ] **Step 6: Commit**

```bash
git add src/server/agents/timestream.ts
git commit -m "$(cat <<'EOF'
feat(timestream): P1.3 — jitter createdAt/updatedAt on ingest

Xatu Lv.54 — TimestreamAgent now rounds every stored timestamp to the
nearest 10-second boundary and adds ±5s uniform noise. Applied to send,
update, and delete paths. Message ordering is preserved via the
monotonic `order` field, so UI sort order does not regress. Absolute
wall-clock timing of individual messages is now fuzzy on the wire,
defeating second-level traffic analysis against DO storage dumps.

Part of the Thunder privacy Phase 1 roadmap (spec 2026-04-10).
EOF
)"
```

---

## Task 3: P1.1 — Strip sender address, store sender index

**Files:**
- Modify: `src/server/agents/timestream.ts` (store `senderIndex: number` on messages instead of the raw address; resolve index from `participants` on send; include `participants` in fetch response so clients can map back)
- Modify: `src/client/thunder-stack.ts` (map `m.senderIndex` to the corresponding address after fetch; fall back to `m.senderAddress` for legacy rows)

Today every stored message has a plaintext `senderAddress`. A passive reader of DO storage learns who authored every message in a group. Phase 1 lite replaces that field with `senderIndex` — a small integer that is only meaningful in the context of the DO's `participants` list. The raw address is still sent in the `send` POST body (required to auto-join first senders), but the DO resolves it to an index immediately and never stores the address alongside the message. A dump of just `messages` reveals "participant #0 sent N messages, participant #1 sent M" — but the mapping #0 → address is kept in `state.participants`, which is a separate, smaller surface to protect. On fetch, the DO returns the participants list alongside the messages so the client can resolve indices back to addresses for UI display.

**Backward compatibility:** legacy messages keep `senderAddress` populated. New messages set `senderAddress` to the empty string and populate `senderIndex`. The client's decrypt loop prefers `senderIndex` when present.

- [ ] **Step 1: Add optional `senderIndex` field to `StoredMessage` and mark `senderAddress` as legacy (around line 16)**

```typescript
interface StoredMessage {
  messageId: string;
  groupId: string;
  order: number;
  encryptedText: string;  // base64 (Seal-encrypted ciphertext)
  nonce: string;          // base64
  keyVersion: string;     // bigint as string
  /** @deprecated post-P1.1 — populated only for legacy rows. New rows use senderIndex. */
  senderAddress: string;
  /** Index into participants[] at write time. Stable for the life of the group. */
  senderIndex: number;
  createdAt: number;
  updatedAt: number;
  isEdited: boolean;
  isDeleted: boolean;
  signature: string;      // hex
  publicKey: string;      // hex
}
```

- [ ] **Step 2: Add a `_participantIndex` helper (after `_addParticipant`, around line 102)**

```typescript
/** Return the index of an address in participants, adding it if absent. Returns -1 for empty/invalid input. */
private _participantIndex(address: string): number {
  if (!address) return -1;
  const norm = normAddr(address);
  let idx = this.state.participants.findIndex(p => normAddr(p) === norm);
  if (idx >= 0) return idx;
  // Auto-add and return new index.
  const participants = [...this.state.participants, address];
  this.setState({ ...this.state, participants });
  return participants.length - 1;
}
```

- [ ] **Step 3: Update `_handleSend` to resolve the sender to an index and blank the stored address (around line 104)**

Replace the full body of `_handleSend` with:

```typescript
  private async _handleSend(request: Request): Promise<Response> {
    const body = await request.json() as {
      groupId: string;
      encryptedText: string;
      nonce: string;
      keyVersion: string;
      senderAddress: string;
      signature?: string;
      publicKey?: string;
      attachments?: unknown[];
    };

    // P1.4 — reject messages with attachments. Our transport does not
    // round-trip attachments; silently accepting them would risk leaking
    // attachment blob IDs outside the Seal envelope.
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      return Response.json({ error: 'Attachments not supported by this transport' }, { status: 400 });
    }

    // Auth: sender must be a participant (or first sender auto-joins).
    if (this.state.participants.length > 0 && !this._isParticipant(body.senderAddress)) {
      return Response.json({ error: 'Not a participant' }, { status: 403 });
    }

    // P1.1 — resolve the sender to a participant index; blank the stored address.
    const senderIndex = this._participantIndex(body.senderAddress);
    if (senderIndex < 0) return Response.json({ error: 'Invalid sender' }, { status: 400 });

    const messageId = crypto.randomUUID();
    const order = this.state.nextOrder;
    const now = jitterTs(Date.now());

    const msg: StoredMessage = {
      messageId,
      groupId: body.groupId,
      order,
      encryptedText: body.encryptedText,
      nonce: body.nonce,
      keyVersion: body.keyVersion,
      senderAddress: '', // P1.1 — no raw address on new rows.
      senderIndex,
      createdAt: now,
      updatedAt: now,
      isEdited: false,
      isDeleted: false,
      signature: body.signature || '',
      publicKey: body.publicKey || '',
    };

    const messages = [...this.state.messages, msg];
    this.setState({ ...this.state, messages, nextOrder: order + 1 });

    return Response.json({ messageId });
  }
```

- [ ] **Step 4: Update `_handleFetch` to return `participants` alongside messages (around line 149)**

Replace the return statement:

```typescript
    return Response.json({ messages: page, hasNext });
```

with:

```typescript
    return Response.json({ messages: page, hasNext, participants: this.state.participants });
```

- [ ] **Step 5: Update `_handleUpdate` sender-match check to compare via index (around line 202)**

Change:
```typescript
    // Only the original sender can edit
    if (normAddr(this.state.messages[idx].senderAddress) !== normAddr(body.senderAddress)) {
      return Response.json({ error: 'Not the sender' }, { status: 403 });
    }
```
to:
```typescript
    // Only the original sender can edit — compare by participant index so
    // the senderAddress field on new rows (which is blanked) is irrelevant.
    const callerIdx = this._participantIndex(body.senderAddress);
    const storedIdx = this.state.messages[idx].senderIndex;
    const storedAddr = this.state.messages[idx].senderAddress;
    const matchByIndex = storedIdx >= 0 && callerIdx === storedIdx;
    const matchByLegacyAddr = storedAddr && normAddr(storedAddr) === normAddr(body.senderAddress);
    if (!matchByIndex && !matchByLegacyAddr) {
      return Response.json({ error: 'Not the sender' }, { status: 403 });
    }
```

- [ ] **Step 6: Update `initialState` so existing DOs migrate gracefully**

No change to `initialState` — `senderIndex` is read as `undefined` on legacy rows, which the client treats as "fall back to `senderAddress`". Add a comment on the legacy field to make that explicit:

```typescript
  initialState: TimestreamState = {
    messages: [],
    nextOrder: 1,
    // Participants is also used as the senderIndex namespace for P1.1.
    participants: [],
  };
```

- [ ] **Step 7: In `thunder-stack.ts`, map `senderIndex` → address after fetch (around line 456 — inside the `for (const m of data.messages)` loop)**

First find the snippet:
```typescript
        messages.push({
          messageId: m.messageId,
          groupId,
          order: m.order,
          encryptedText: ciphertext,
          nonce,
          keyVersion: kv,
          senderAddress: m.senderAddress || '',
          createdAt: m.timestamp ?? m.createdAt ?? Date.now(),
          updatedAt: m.timestamp ?? m.updatedAt ?? Date.now(),
```

Change it to:
```typescript
        const participants: string[] = Array.isArray((data as any).participants) ? (data as any).participants : [];
        const resolvedSender = typeof m.senderIndex === 'number' && m.senderIndex >= 0 && m.senderIndex < participants.length
          ? participants[m.senderIndex]
          : (m.senderAddress || '');
        messages.push({
          messageId: m.messageId,
          groupId,
          order: m.order,
          encryptedText: ciphertext,
          nonce,
          keyVersion: kv,
          senderAddress: resolvedSender,
          createdAt: m.timestamp ?? m.createdAt ?? Date.now(),
          updatedAt: m.timestamp ?? m.updatedAt ?? Date.now(),
```

Move the `participants` lookup out of the loop if the current `for` body declares it inside — hoist it just above the `for (const m of data.messages)` so it is computed once.

- [ ] **Step 8: Update the direct-DO-fetch convo render path in `ui.ts` so it also resolves `senderIndex`**

Search for the `_expandIdleConvo` direct fetch block (it calls `/api/timestream/${groupId}/fetch` and maps `m.senderAddress` directly). Change the mapping so it prefers `senderIndex` when present:

```typescript
            const participants: string[] = Array.isArray(_doData.participants) ? (_doData.participants as string[]) : [];
            entries = (_doData.messages || []).map((m: any) => {
              let text = '';
              try {
                const raw = atob(m.encryptedText);
                try { text = decodeURIComponent(escape(raw)); } catch { text = raw; }
              } catch { text = m.encryptedText || ''; }
              const senderAddress = typeof m.senderIndex === 'number' && m.senderIndex >= 0 && m.senderIndex < participants.length
                ? participants[m.senderIndex]
                : (m.senderAddress || '');
              return {
                text,
                senderAddress,
                createdAt: m.timestamp ?? m.createdAt ?? Date.now(),
                messageId: m.messageId || m.id || `msg-${m.order}`,
              };
            });
```

Also update the `_doData` type annotation on the `.json()` call one line above to match: `as { messages: any[]; participants?: string[] }`. Apply the same change to the polling fetch later in the function (same file, same `/api/timestream/.../fetch` + map pattern — there are two copies, update both).

- [ ] **Step 9: Build**

```bash
bun run build
```

Expected: clean build.

- [ ] **Step 10: Commit**

```bash
git add src/server/agents/timestream.ts src/client/thunder-stack.ts src/ui.ts
git commit -m "$(cat <<'EOF'
feat(thunder): P1.1 — store senderIndex instead of raw address

Swellow Lv.50 — TimestreamAgent now stores a participant index on every
new message instead of the raw Sui address. A passive dump of the
`messages` array no longer reveals who authored what; the address
mapping lives only in `state.participants`, a separate surface. The
fetch response now includes `participants[]` so the client resolves
indices back to addresses for UI display.

Legacy rows with populated senderAddress keep working — the client
prefers senderIndex when present and falls back to the address field.
Update path compares via index with a legacy-address fallback.

Also rejects `attachments: [...]` at the send boundary (P1.4) — our
transport does not round-trip attachments and silently accepting them
would leak blob IDs outside the Seal envelope.

Part of the Thunder privacy Phase 1 roadmap (spec 2026-04-10).
EOF
)"
```

---

## Task 4: Build, deploy, push

- [ ] **Step 1: Full build**

```bash
bun run build
```

- [ ] **Step 2: Deploy**

```bash
npx wrangler deploy
```

Expected: `Deployed dotski ...` with the new version ID. Record it.

- [ ] **Step 3: Push to origin**

```bash
git push origin feat/thunder-messaging-stack
```

---

## Execution Notes

- Tasks 1, 2, and 3 are independent on the client side but Task 3 touches both client and server; land them in order to keep each commit builds-and-deploys-cleanly.
- Existing deployed TimestreamAgent DOs will keep serving legacy rows correctly because `senderIndex` is optional and the client falls back to `senderAddress` when missing.
- The 10-second timestamp bucket is a cheap parameter to tune later — values up to 60 seconds are defensible before UX regressions in "message was sent just now" toast sorting become visible.
- Padding buckets are also a tuning parameter. The 16384-byte top bucket is intentional: Thunder messages that are longer than that (e.g. pasted contracts or long Storm welcome blurbs) should be rare enough that the bucket ceiling does not become a performance problem.
- P1.1 is the "lite" version of sealed sender. The full Signal-style construction lives in Phase 2 §P2.1 and requires its own design doc. Do not conflate the two in the commit history.

---

## Deferred (not in this plan)

- **P2.1 Sealed sender.** Needs a dedicated design doc before implementation.
- **P2.2 Non-derivable group IDs.** Requires a client-side encrypted counterparty → groupId index.
- **P2.3 Encrypted membership list.** Requires a Move module or zk-proof path for "prove you are a group member without revealing which".
- **Authenticated connection for real P1.1.** The full version of P1.1 derives sender from a signed challenge on the WebSocket handshake, not from a client-declared `senderAddress`. That depends on upgrading the DO transport from HTTP to WebSocket (spec §8.3 "real-time subscribe") and is out of scope here.
