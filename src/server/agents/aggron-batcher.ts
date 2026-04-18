/**
 * Aggron Iron Defense — Quilt-batcher DO scaffold (Move 1 of the Aggron arc).
 *
 * AggronBatcher accepts ciphertext blobs from any producer (SUIAMI upgrade,
 * thunder attachments, storm archives, CF-edge timeline, stealth cold dests…),
 * buffers them in SQLite-backed state, and on an alarm cadence flushes the
 * batch to Walrus as a single Quilt. Users pay $0: ultron signs the Quilt
 * publish PTB with its own SUI / WAL, amortizing the fee across the cohort.
 *
 * This is Move 1 — the SCAFFOLD.
 *   - state shape: pendingBlobs, completedFlushes
 *   - callables:   enqueue, status, poke, purgeByKind
 *   - alarm stub:  counts by kind, logs, and (Move 2) hands off to a Quilt
 *                  PTB publisher. Until Move 2 lands, the stub marks entries
 *                  as `flushed: true` in state so the queue clears but no
 *                  real Walrus write happens — safe to deploy, observable.
 *
 * One singleton DO instance (name: `aggron`). We don't shard by user because
 * amortization is the whole point — the bigger the Quilt, the cheaper each
 * entry. If throughput ever outgrows one DO we shard by `kind` later.
 *
 * Privacy: Aggron sees only ciphertext. Seal-encryption happens upstream in
 * the producing path (encryptSquidsToWalrus, thunder sealed body, etc.).
 * Ultron's WAL payment is the only cost we bear.
 *
 * Related:
 *   - memory/project_aggron_batcher.md       — architectural direction
 *   - docs/superpowers/plans/2026-04-18-aggron-design.md — parked design
 *   - src/server/agents/weavile-assurance.ts — DO scaffold pattern reference
 *   - src/client/walrus.ts                   — putWalrusBlob (legacy direct path)
 */

import { Agent, callable } from 'agents';

// ─── Constants ──────────────────────────────────────────────────────

/** Flush cadence. 10 minutes matches the "quiet enough to amortize,
 *  fast enough to feel live" band. Tunable per deploy. */
export const AGGRON_ALARM_MS = 10 * 60 * 1000;

/** Force an early flush when total buffered bytes exceed this. Protects
 *  against one huge attachment starving smaller entries behind it. */
export const AGGRON_FLUSH_BYTES_MAX = 4 * 1024 * 1024; // 4 MiB

/** Force an early flush when entry count exceeds this. */
export const AGGRON_FLUSH_COUNT_MAX = 256;

/** Rolling cap on completedFlushes history (most-recent kept). */
export const AGGRON_HISTORY_MAX = 50;

// ─── Types ──────────────────────────────────────────────────────────

/** Known blob classes. Add new ones by extending this and updating the
 *  Seal-policy / Move-pointer wiring in the respective producer. */
export type AggronKind =
  | 'suiami-chains'
  | 'thunder-attach'
  | 'storm-history'
  | 'cf-edge'
  | 'stealth-cold-dest'
  | 'misc';

export interface AggronPendingBlob {
  /** 32-byte random hex, 0x-prefixed. Unique per entry. */
  blobId: string;
  kind: AggronKind;
  /** Opaque identifier the producer uses to reconcile this entry with
   *  its destination record (roster name-hash, thunder id, …). */
  targetKey: string;
  /** Ciphertext bytes, base64-encoded. Seal-encrypted upstream. */
  ciphertextB64: string;
  /** Size in bytes (decoded). Tracked for flush thresholds + history. */
  sizeBytes: number;
  /** Optional producer-scoped metadata pass-through. Not inspected here. */
  metadata?: Record<string, string>;
  submittedAtMs: number;
  /** Flipped to true by the alarm stub when the entry is "accepted for
   *  flush". Move 2 replaces this with a real Walrus quilt pointer. */
  flushed?: boolean;
}

export interface AggronCompletedFlush {
  /** Flush cycle identifier — unique per alarm tick. */
  flushId: string;
  /** Number of entries included. */
  count: number;
  /** Total decoded bytes. */
  totalBytes: number;
  /** Kinds represented (sorted). */
  kinds: string[];
  /** Stub value today; Move 2 puts the Walrus quilt blob id here. */
  quiltBlobId: string | null;
  /** Stub value; Move 2 puts the Sui tx digest of the Quilt PTB here. */
  publishDigest: string | null;
  flushedAtMs: number;
}

export interface AggronBatcherState {
  pendingBlobs: AggronPendingBlob[];
  completedFlushes: AggronCompletedFlush[];
}

interface Env {
  SUI_NETWORK?: string;
}

// ─── Pure helpers (exported for tests) ──────────────────────────────

/** Crypto-random 32-byte hex id, 0x-prefixed. */
export function generateBlobId(random?: () => Uint8Array): string {
  const bytes = random ? random() : crypto.getRandomValues(new Uint8Array(32));
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Decoded byte length of a base64 string without materializing the bytes. */
export function approxB64DecodedLen(b64: string): number {
  if (!b64) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/** Decide whether the current buffer should flush early. */
export function shouldFlushNow(
  entries: AggronPendingBlob[],
  limits = {
    countMax: AGGRON_FLUSH_COUNT_MAX,
    bytesMax: AGGRON_FLUSH_BYTES_MAX,
  },
): boolean {
  if (entries.length >= limits.countMax) return true;
  let bytes = 0;
  for (const e of entries) bytes += e.sizeBytes;
  return bytes >= limits.bytesMax;
}

// ─── Agent ──────────────────────────────────────────────────────────

export class AggronBatcher extends Agent<Env, AggronBatcherState> {
  initialState: AggronBatcherState = {
    pendingBlobs: [],
    completedFlushes: [],
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._runFlushAlarm();
    };
  }

  // ─── Callables ─────────────────────────────────────────────────────

  /** Queue a ciphertext blob for inclusion in the next Quilt flush.
   *  Idempotent on (kind + targetKey): a repeated submit supersedes the
   *  prior unflushed entry for the same target. */
  @callable({
    description:
      'Queue a Seal-ciphertext for the next Quilt flush. Producer passes ' +
      'kind + targetKey + ciphertextB64; Ultron batches + publishes.',
  })
  async enqueue(params: {
    kind: AggronKind;
    targetKey: string;
    ciphertextB64: string;
    metadata?: Record<string, string>;
  }): Promise<{ blobId: string; queuedCount: number; willFlushSoon: boolean }> {
    const { kind, targetKey, ciphertextB64, metadata } = params;
    if (!kind || !targetKey || !ciphertextB64) {
      throw new Error('aggron.enqueue: kind, targetKey, ciphertextB64 required');
    }
    const blob: AggronPendingBlob = {
      blobId: generateBlobId(),
      kind,
      targetKey,
      ciphertextB64,
      sizeBytes: approxB64DecodedLen(ciphertextB64),
      ...(metadata ? { metadata } : {}),
      submittedAtMs: Date.now(),
    };
    // Supersede any prior unflushed entry for the same (kind, targetKey).
    const kept = this.state.pendingBlobs.filter(
      b => !(b.kind === kind && b.targetKey === targetKey && !b.flushed),
    );
    const next = [...kept, blob];
    this.setState({ ...this.state, pendingBlobs: next });
    const willFlushSoon = shouldFlushNow(next);
    await this._scheduleFlushAlarm(willFlushSoon ? 1_000 : undefined);
    return { blobId: blob.blobId, queuedCount: next.length, willFlushSoon };
  }

  /** DO state snapshot — queue depth by kind, recent flushes. */
  @callable({ description: 'AggronBatcher state snapshot.' })
  async status(): Promise<{
    pendingCount: number;
    pendingBytes: number;
    pendingByKind: Record<string, number>;
    recentFlushes: AggronCompletedFlush[];
    nextAlarmMs: number | null;
  }> {
    const pendingByKind: Record<string, number> = {};
    let pendingBytes = 0;
    for (const b of this.state.pendingBlobs) {
      if (b.flushed) continue;
      pendingByKind[b.kind] = (pendingByKind[b.kind] ?? 0) + 1;
      pendingBytes += b.sizeBytes;
    }
    const recent = this.state.completedFlushes.slice(-10);
    const nextAlarmMs = (await this.ctx.storage.getAlarm?.()) ?? null;
    return {
      pendingCount: this.state.pendingBlobs.filter(b => !b.flushed).length,
      pendingBytes,
      pendingByKind,
      recentFlushes: recent,
      nextAlarmMs: typeof nextAlarmMs === 'number' ? nextAlarmMs : null,
    };
  }

  /** Force a flush now — admin/debug. */
  @callable({ description: 'Force a flush immediately.' })
  async poke(): Promise<{ triggered: boolean }> {
    await this._runFlushAlarm();
    return { triggered: true };
  }

  /** Drop all unflushed entries for one kind. Recovery path if a producer
   *  schemaed wrong; doesn't affect already-flushed history. */
  @callable({ description: 'Drop all unflushed entries for a given kind.' })
  async purgeByKind(params: { kind: AggronKind }): Promise<{ dropped: number }> {
    const before = this.state.pendingBlobs.length;
    const kept = this.state.pendingBlobs.filter(
      b => !(b.kind === params.kind && !b.flushed),
    );
    this.setState({ ...this.state, pendingBlobs: kept });
    return { dropped: before - kept.length };
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /** Move 1 stub: marks unflushed entries as `flushed` with a null quilt
   *  pointer, records the cycle in completedFlushes, and reschedules.
   *  Move 2 (Aggron Stone Edge) replaces this with a real Walrus SDK
   *  Quilt publish PTB signed by ultron. */
  async _runFlushAlarm(): Promise<void> {
    const ready = this.state.pendingBlobs.filter(b => !b.flushed);
    if (ready.length === 0) {
      await this._scheduleFlushAlarm();
      return;
    }
    const kinds = Array.from(new Set(ready.map(b => b.kind))).sort();
    const totalBytes = ready.reduce((acc, b) => acc + b.sizeBytes, 0);
    const flushId = generateBlobId();
    const flush: AggronCompletedFlush = {
      flushId,
      count: ready.length,
      totalBytes,
      kinds,
      quiltBlobId: null, // TODO(Aggron Stone Edge): real Walrus quilt blob id
      publishDigest: null, // TODO(Aggron Stone Edge): Sui tx digest
      flushedAtMs: Date.now(),
    };
    const flushedSet = new Set(ready.map(b => b.blobId));
    const updatedPending = this.state.pendingBlobs.map(b =>
      flushedSet.has(b.blobId) ? { ...b, flushed: true } : b,
    );
    const history = [...this.state.completedFlushes, flush].slice(-AGGRON_HISTORY_MAX);
    this.setState({
      ...this.state,
      pendingBlobs: updatedPending,
      completedFlushes: history,
    });
    console.log(
      `[AggronBatcher] flush stub ${flushId.slice(0, 10)}… — ${ready.length} entries, ${totalBytes} B, kinds=${kinds.join(',')}`,
    );
    await this._scheduleFlushAlarm();
  }

  /** Schedule the next alarm — by default the standard cadence, or a
   *  caller-supplied override (e.g., 1s to force an early flush). */
  private async _scheduleFlushAlarm(overrideMs?: number): Promise<void> {
    const at = Date.now() + (overrideMs ?? AGGRON_ALARM_MS);
    await this.ctx.storage.setAlarm(at);
  }
}
