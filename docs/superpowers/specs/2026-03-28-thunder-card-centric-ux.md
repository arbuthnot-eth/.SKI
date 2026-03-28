# Thunder Card-Centric UX Redesign

## Problem

The current Thunder UX overloads the input box (minting, sending coins, filtering roster, addressing thunder) with implicit mode switching. The conversation view, send controls, and receive flow are tangled. Users lose track of signaling state.

## Mental Model

**Each SuiNS name is a mailbox.** Your NFT is the key. Anyone can drop a signal in (permissionless). Only you can open it (NFT-gated quest). The roster is your contact list. The NFT card is the selected mailbox.

## Lexicon

The Thunder system uses a consistent vocabulary derived from the Move contract:

| Term | Meaning |
|------|---------|
| **Signal** | An encrypted message (payload deposited on-chain) |
| **Storm** | The shared object that holds all ragtags |
| **Ragtag** | Per-name collection of signals (dynamic field on Storm) |
| **Quest** | Claiming/decrypting signals (removes from ragtag, returns storage rebate) |
| **Signaled** | Event emitted when a signal is sent |
| **Questfi** | Event emitted when a signal is claimed |
| **Thunder** | The overall messaging system between SuiNS identities |

All UI copy, code comments, and variable names should use these terms consistently. "Message" → "signal". "Send" → "signal" (verb). "Receive/decrypt" → "quest".

## Layout

```
┌─────────────────────────────────────────┐
│  [■] [input box............] [.sui] [⚡] │  main input: mint/send/new signal
├─────────────────────────────────────────┤
│  ┌─────────┐                            │
│  │  QR     │  stables.sui  ⚡12         │  NFT card (always visible)
│  │         │  stables.sui.ski ↗         │
│  │         │  Apr 30, 2026 · 34d        │
│  └─────────┘                            │
├─────────────────────────────────────────┤  conversation (toggled by card click)
│  [alice] hey what's up                  │
│                        yo what's good ↗ │
│  [alice] check this out                 │
│                                         │
│  ⚡3 new — [Quest]                      │  unread indicator + quest button
│                                         │
│           [private thunder...      ] [⚡]│  reply input (right-justified text)
├─────────────────────────────────────────┤
│  ⌘SKI ROSTER              $69/mo    65 │
│  stables 34d  │  genie● 139d  │  ...   │  ● = has new unquested signals
│  version 42d  │  brando◆ 0    │  ...   │  ◆ = wishlist/contact
└─────────────────────────────────────────┘
```

## NFT Card

- Always visible above roster, positioned between the input row and the roster.
- Synced to input value (if it matches an owned name) or falls back to most-thundered name.
- Badge shows **total signal count** (sent + received): `⚡12`.
- New unquested on-chain signals get a distinct visual indicator (pulse/color on badge).
- Click card → toggles conversation open/closed below the card, pushing roster down.

### Hard Refresh Behavior

- **Unqueued signals exist on any owned name:** Card shows the name with the most unquested signals. Conversation auto-opens.
- **No unquested signals:** Card recalls its last open/closed state from `localStorage`. Shows last-viewed name or first owned name.
- The input box is always empty on hard refresh. Card selection is independent of input.

## Conversation View

- Renders below the card, above the roster. Pushes roster down when open.
- Bubbles: outgoing right-aligned, incoming left-aligned with sender name label.
- If unquested on-chain signals exist: shows `⚡N new` with a **Quest** button (questing costs gas, returns storage rebate).
- After quest: new signals appear in conversation, badge count updates.
- Reply input at bottom of conversation: text right-justified against the ⚡ send button.
- Click card again or click outside → collapses conversation.

## Main Input Box

Restored to its core purposes — no longer the thunder conversation controller:

- **Available name** → Mint button appears.
- **Owned name** → Shows NFT card for that name, can send coins.
- **Taken name (not owned)** → ⚡ Thunder button appears. Type signal, send.
- **Sending a signal auto-adds recipient as a wishlist chip** (black diamond ◆) in the roster. This makes the roster double as a contact list.

## Roster Chips

- **Owned names** (blue square ■): Click → shows NFT card + can open conversation.
- **Wishlist/contact names** (black diamond ◆): Click → populates input box with that name for sending a new signal. Does NOT open a conversation (you don't own the NFT).
- **Thunder badge on chip**: Shows total signal count. Dot/color indicator for unquested.
- **Sort order**: Unqueued first → most signals → earliest expiry.

## Thunder Count Badge

- Count = **total signals** in the conversation (sent + received). Goes up over time.
- **Unqueued indicator**: Distinct visual treatment (color change, dot, or pulse) when new on-chain signals exist that haven't been quested yet.
- After questing, the unquested indicator clears but the total count remains (and increases by the number of newly quested signals).

## Sending Identity

- Always `app.suinsName` (your primary SuiNS name). No ambiguity about "who am I signaling as."
- Displayed in outgoing bubbles implicitly (right-aligned = you).

## Receiving Flow

1. See `⚡3` badge (unquested) on card or chip.
2. Click card → conversation opens.
3. See `⚡3 new — [Quest]` at bottom of existing signals.
4. Click Quest → quest PTB executes on-chain (gas cost, storage rebate returned), signals decrypted.
5. New signals appear in conversation. Badge updates. Unqueued indicator clears.

## Signaling Flow (Reply)

1. Conversation is open for a name you own.
2. Type in the reply input at bottom of conversation.
3. Click ⚡ or press Enter → builds thunder signal PTB, signs, executes.
4. Signal appears as outgoing bubble. Badge count increments.

## Signaling Flow (New Conversation)

1. Type a taken name in the main input box.
2. ⚡ button appears.
3. Type signal in the thunder input that appears.
4. Send → recipient name auto-added as wishlist chip (◆) in roster.
5. Signal stored in local encrypted log.

## Data Model Changes

### Local Storage Keys

- `ski:thunder-card-open` — `'1'` or `'0'`, persists card conversation open/closed state.
- `ski:thunder-card-domain` — last-viewed domain on the card (for no-unquested restore).
- Existing `ski:thunder-counts` — on-chain unquested signal counts (from poll).
- Existing `ski:thunder-log:{address}` — encrypted conversation log.

### Thunder Log Entries

No structural changes needed. Existing `ThunderLogEntry` already tracks `to`, `from`, `msg`, `ts`, `dir`.

### Conversation Threading (Client-Side)

No Move contract changes required. Threading is implemented inside the encrypted `ThunderPayload` JSON:

```typescript
interface ThunderPayload {
  v: number;
  sender: string;
  senderAddress: string;
  message: string;
  timestamp: string;
  threadId?: string;   // keccak256(sorted(sender_name_hash, recipient_name_hash))
  replyTo?: number;    // timestamp of the signal being replied to
  suiami?: string;
}
```

- **`threadId`**: Deterministic conversation identifier. `keccak256(sorted(sender_name_hash, recipient_name_hash))` so both parties produce the same ID. Enables multiple simultaneous conversations between the same two names.
- **`replyTo`**: Optional timestamp reference to a specific signal for quote-reply UI.
- Both fields live inside the AES-encrypted payload — invisible on-chain. Third parties cannot correlate signals into conversations.
- On-chain model stays flat (signals are independent blobs in a ragtag). Threading is purely client-side after quest/decryption.
- Older clients without `threadId` still work — signals missing it are grouped by counterparty name (current behavior).

### Walrus Quilts (Batch Signal Storage)

For high-volume signaling or large payloads, signals can be stored on Walrus instead of inline on-chain. Quilts batch up to 660 small encrypted signals into a single Walrus blob (~100x cheaper than individual blobs).

**When to use quilts:**
- Batching many small signals (e.g., notification services, DAOs)
- Encrypted image/audio/video attachments too large for on-chain storage (>2KB)

**How it works:**
1. Accumulate N encrypted signals
2. Pack into a quilt via `encodeQuilt` (each signal is a "patch" with its own identifier + tags)
3. Write quilt to Walrus once (single blob registration)
4. Store a `QuiltPatchId` on-chain (in the Signal struct or a future StormPointer) pointing to the specific patch
5. Recipients read their individual patch without downloading the full quilt

**SDK pattern (`@mysten/walrus` v1.1.0):**
```typescript
const results = await client.walrus.writeFiles({
  files: signals.map((s, i) => WalrusFile.from({
    contents: s.ciphertext,
    identifier: `signal-${i}.enc`,
    tags: { type: 'thunder', nameHash: s.nameHash },
  })),
  epochs: 3,
  deletable: true,
  signer: keypair,
});
// results[i].id = QuiltPatchId (individual signal address)
```

**Not needed for current implementation** — current Thunder signals are small text (<2KB, stored inline on-chain). Quilts are the upgrade path for rich media and high-volume scenarios. No Move contract changes required for the client-side threading; quilts would require a `PayloadLocation` enum in a future contract revision.

### Wishlist Chips

Wishlist names are already supported in the roster (`data-wish="1"`). Sending a signal to a new name should persist it to the wishlist in localStorage.

## Out of Scope

- Multi-name sending identity (always primary name).
- Group signaling.
- Signal delivery receipts.
- Walrus quilt integration (documented above as upgrade path, not in this release).
- Move contract changes for PayloadLocation enum (future work for rich media).
