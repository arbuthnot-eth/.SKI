/**
 * Prism — rich cross-chain tx vehicle layered on Thunder attachments.
 *
 * A Prism is a Thunder message carrying two SDK-native attachments:
 *   1. `prism.manifest.json` — JSON describing the cross-chain payload
 *      (target chain, recipient, amount, mint, optional IKA dWallet cap
 *      reference, optional human note, sender signature).
 *   2. `prism.payload.bin` — (optional) raw bytes the recipient needs to
 *      consume on the target chain (e.g. pre-signed Solana tx, ERC-20
 *      calldata, Bitcoin PSBT). Absent when the recipient rebuilds the
 *      tx from the manifest alone.
 *
 * Both are encrypted + Walrus-uploaded by the Thunder SDK's
 * AttachmentsManager — no parallel crypto, no parallel storage.
 *
 * There is no on-chain Prism object. A Prism is just a Thunder with a
 * manifest attachment. The `prism.manifest` extras.kind tag is the
 * only discriminator — anything else is a regular Thunder.
 *
 * === Sender authenticity ===
 * SDK attachment encryption binds to Storm (group) membership, not
 * sender identity — any storm member could forge a Prism claiming to
 * be from anyone. We close that gap with a Sui personal-message
 * signature over `{ prismId, stormId, thunderId, targetChain,
 * recipient, amount, mint, createdAt }` sorted canonically. Receiver
 * verifies against `senderAddress`; unsigned or mis-signed manifests
 * surface as `{ verified: false }` and higher-trust handlers ignore
 * them. Manifests bound to a specific `thunderId` also prevent
 * replay across threads.
 */

import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type {
  AttachmentFile,
  AttachmentHandle,
  DecryptedMessage,
} from './thunder-stack.js';

// ─── Types ──────────────────────────────────────────────────────────

export type PrismChain = 'solana' | 'ethereum' | 'bitcoin' | 'sui';

export interface PrismManifest {
  /** Schema version. Bump on breaking changes to this interface. */
  schema: 1;
  /** Per-prism identifier — crypto.randomUUID at build time. */
  prismId: string;
  /** Storm this Prism was sent into (group UUID in SDK terms). */
  stormId?: string;
  /** Parent Thunder's messageId — binds the manifest to one delivery
   *  and defeats cross-thread replay. Optional because the sender
   *  doesn't always know its own messageId pre-send (set by server).
   *  When absent, receivers should treat the Prism as lower-trust. */
  thunderId?: string;
  /** Target chain where the payload resolves. */
  targetChain: PrismChain;
  /** Chain-native recipient address (base58 for Solana, 0x for EVM, bech32 for BTC, 0x for Sui). */
  recipient: string;
  /** Amount in smallest chain-native units, encoded as a decimal string
   *  (bigint-safe across the JSON boundary). */
  amount: string;
  /** Token identifier on the target chain — SPL mint, ERC-20 address, BTC asset id, Sui coin type. */
  mint?: string;
  /** IKA dWallet cap object ID the recipient should invoke to finalize
   *  the transfer. When absent the recipient is expected to resolve it
   *  themselves via their SUIAMI roster entry. */
  dwalletCapRef?: string;
  /** Human-readable note — displayed alongside the transfer confirm UI. */
  note?: string;
  /** ms epoch of manifest construction (sender-side clock). */
  createdAt: number;
  /** Sender's Sui address (bech32-normalized). Optional for
   *  back-compat with unsigned Prisms from older clients. */
  senderAddress?: string;
  /** Sui personal-message signature over canonicalManifestBytes
   *  (the manifest minus this field). Optional; receivers should
   *  mark unsigned manifests as `verified: false`. */
  senderSignature?: string;
}

/** Extras tags used by the SDK's AttachmentsManager to discriminate
 *  Prism attachments from regular files. */
const KIND_MANIFEST = 'prism.manifest';
const KIND_PAYLOAD = 'prism.payload';

// ─── Canonicalization ───────────────────────────────────────────────

/** The fields a sender signs. Ordered explicitly so canonical bytes
 *  are stable across client versions. `senderAddress` is included so
 *  a signature can't be lifted onto a different sender identity;
 *  `senderSignature` is excluded (obviously). */
const SIGNED_FIELDS = [
  'schema', 'prismId', 'stormId', 'thunderId', 'targetChain',
  'recipient', 'amount', 'mint', 'dwalletCapRef', 'note',
  'createdAt', 'senderAddress',
] as const;

function canonicalManifestBytes(m: PrismManifest): Uint8Array {
  const ordered: Record<string, unknown> = {};
  for (const k of SIGNED_FIELDS) {
    const v = (m as unknown as Record<string, unknown>)[k];
    if (v !== undefined) ordered[k] = v;
  }
  return new TextEncoder().encode(JSON.stringify(ordered));
}

// ─── Build ──────────────────────────────────────────────────────────

/** Build the AttachmentFile[] that encode a Prism. Signs the manifest
 *  with the sender's Sui key via `signPersonalMessage` when provided;
 *  omits the signature otherwise (receivers treat unsigned as
 *  lower-trust). `thunderId` may be passed if the sender has pre-
 *  allocated one, or left undefined for back-compat. */
export async function buildPrismAttachments(
  spec: Omit<PrismManifest, 'schema' | 'prismId' | 'createdAt' | 'senderSignature' | 'senderAddress'> & {
    senderAddress?: string;
  },
  payload?: Uint8Array,
  signPersonalMessage?: (msg: Uint8Array) => Promise<{ signature: string }>,
): Promise<AttachmentFile[]> {
  const manifest: PrismManifest = {
    schema: 1,
    prismId: crypto.randomUUID(),
    createdAt: Date.now(),
    ...spec,
    ...(spec.senderAddress ? { senderAddress: normalizeSuiAddress(spec.senderAddress) } : {}),
  };
  if (signPersonalMessage && manifest.senderAddress) {
    try {
      const bytes = canonicalManifestBytes(manifest);
      const { signature } = await signPersonalMessage(bytes);
      manifest.senderSignature = signature;
    } catch (err) {
      console.warn('[prism] sender signature skipped:', err instanceof Error ? err.message : err);
    }
  }
  const manifestFile: AttachmentFile = {
    fileName: 'prism.manifest.json',
    mimeType: 'application/json',
    data: new TextEncoder().encode(JSON.stringify(manifest)),
    extras: { kind: KIND_MANIFEST, prismId: manifest.prismId, targetChain: manifest.targetChain },
  };
  if (!payload) return [manifestFile];
  const payloadFile: AttachmentFile = {
    fileName: 'prism.payload.bin',
    mimeType: 'application/octet-stream',
    data: payload,
    extras: { kind: KIND_PAYLOAD, prismId: manifest.prismId },
  };
  return [manifestFile, payloadFile];
}

// ─── Read ───────────────────────────────────────────────────────────

export interface ParsedPrism {
  manifest: PrismManifest;
  /** Resolver for the optional payload bytes — null when the Prism
   *  carries manifest only. Calling `.data()` triggers the SDK
   *  download+decrypt for the raw payload. */
  payloadHandle: AttachmentHandle | null;
  /** true when the sender signature verifies and binds to
   *  `manifest.senderAddress`. false for unsigned manifests or
   *  signature mismatches. Higher-trust handlers (auto-broadcast,
   *  agent action) gate on this. */
  verified: boolean;
  /** When `verified` is false, this explains why. Useful for
   *  surfacing a badge in the UI ("unsigned", "signature mismatch",
   *  "wrong thread"). */
  verifyReason?: 'unsigned' | 'bad-signature' | 'thread-mismatch' | 'ok';
}

/** Inspect a decrypted Thunder message for a Prism manifest. Returns
 *  the parsed manifest plus a handle to the optional payload and a
 *  signature-verification verdict, or null when the message is not a
 *  Prism. Pass the Thunder's `(stormId, thunderId, senderAddress)` so
 *  we can cross-check the manifest binding. */
export async function extractPrismFromMessage(
  msg: DecryptedMessage,
  context?: { stormId?: string; thunderId?: string; senderAddress?: string },
): Promise<ParsedPrism | null> {
  const handles = (msg as unknown as { attachments?: AttachmentHandle[] }).attachments ?? [];
  if (handles.length === 0) return null;
  const manifestHandle = handles.find(
    (h) => h.extras && (h.extras as { kind?: string }).kind === KIND_MANIFEST,
  );
  if (!manifestHandle) return null;
  const manifestBytes = await manifestHandle.data();
  const parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as PrismManifest;
  if (parsed.schema !== 1) return null;
  const payloadHandle = handles.find(
    (h) =>
      h.extras &&
      (h.extras as { kind?: string; prismId?: string }).kind === KIND_PAYLOAD &&
      (h.extras as { prismId?: string }).prismId === parsed.prismId,
  ) ?? null;

  // Signature verification
  let verified = false;
  let verifyReason: ParsedPrism['verifyReason'] = 'unsigned';
  if (parsed.senderSignature && parsed.senderAddress) {
    try {
      const copy: PrismManifest = { ...parsed };
      delete copy.senderSignature;
      const bytes = canonicalManifestBytes(copy);
      const pub = await verifyPersonalMessageSignature(bytes, parsed.senderSignature);
      const expected = normalizeSuiAddress(parsed.senderAddress);
      const actual = pub.toSuiAddress();
      if (actual === expected) {
        // Cross-check Thunder context when provided. Binds manifest to
        // the specific Thunder delivery + storm, blocking replay.
        const stormOk = !context?.stormId || !parsed.stormId || context.stormId === parsed.stormId;
        const thunderOk = !context?.thunderId || !parsed.thunderId || context.thunderId === parsed.thunderId;
        const senderOk = !context?.senderAddress ||
          normalizeSuiAddress(context.senderAddress) === expected;
        if (stormOk && thunderOk && senderOk) {
          verified = true;
          verifyReason = 'ok';
        } else {
          verifyReason = 'thread-mismatch';
        }
      } else {
        verifyReason = 'bad-signature';
      }
    } catch {
      verifyReason = 'bad-signature';
    }
  }

  return { manifest: parsed, payloadHandle, verified, verifyReason };
}

/** Convenience predicate — is this Thunder a Prism? */
export function isPrism(msg: DecryptedMessage): boolean {
  const handles = (msg as unknown as { attachments?: AttachmentHandle[] }).attachments ?? [];
  return handles.some(
    (h) => h.extras && (h.extras as { kind?: string }).kind === KIND_MANIFEST,
  );
}
