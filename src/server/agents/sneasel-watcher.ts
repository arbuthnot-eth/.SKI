/**
 * SneaselWatcher — Durable Object that watches stealth-guest hot addresses
 * and sweeps incoming funds to cold squids.
 *
 * One DO instance per parent whelm-eth name (keyed by parentHash hex or the
 * parent ENS name, e.g. "brando.whelm.eth"). It tracks fresh per-counterparty
 * hot addresses (`*.brando.whelm.eth` → hotAddr), listens for inbound funds
 * via webhook (Alchemy for EVM, Helius for SOL, Mempool.space/BTC bridge, …),
 * and after a short debounce fires an ultron-signed sweep hot → cold.
 *
 * The cold destination is never plaintext on-chain. Ultron decrypts it
 * just-in-time via Seal (`seal_approve_guest_stealth`) using its own address
 * as sender proof, then signs the sweep through IKA.
 *
 * Pipeline: watch() → webhook enqueueSweep() → alarm tick() → Seal decrypt
 * (Blizzard) → IKA sign ceremony (Icy Wind) → batched submit (Beat Up).
 *
 * This scaffold establishes state shape + callable surface only. Live Seal
 * decrypt and live IKA signing are landed in follow-up moves.
 *
 * Related files:
 *   - contracts/suiami/sources/roster.move       — Move-side guest_stealth (Ice Shard)
 *   - src/client/sneasel-guest.ts                — browser PTB builder (Feint Attack)
 *   - src/server/agents/shade-executor.ts        — reference alarm-driven sweep DO
 *   - src/server/agents/chronicom.ts             — reference webhook-driven DO
 *   - src/server/ultron-policy.ts                — requireUltronAdmin gate
 */

import { Agent, callable } from 'agents';

// ─── Constants ──────────────────────────────────────────────────────────

/** Default alarm cadence — tick every 5 minutes to batch pending sweeps. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** How many completed sweeps to retain in rolling history. */
const COMPLETED_HISTORY_MAX = 100;

/** Short debounce after detection before we sweep — gives late-arriving
 *  top-ups a chance to coalesce into one batch. */
const SWEEP_DEBOUNCE_MS = 30 * 1000;

/** Ultron's canonical EVM address — the sole authorized sweep delegate
 *  on the ETH side today. Cross-referenced by guard checks; the Seal
 *  policy enforces the on-chain version. */
export const ULTRON_ETH_ADDR = '0xcaA8d6F00f465129eF0B7D7ABBeA9f2C8a90882d';

// ─── Types ──────────────────────────────────────────────────────────────

export interface WatchedHotAddr {
  /** keccak256(parent ENS name) as 0x-prefixed hex — matches Move roster. */
  parentHash: string;
  /** Guest label (e.g. "amazon" in amazon.brando.whelm.eth). */
  label: string;
  /** Freshly-provisioned hot receive address (chain-native format). */
  hotAddr: string;
  /** "eth" | "sol" | "btc" | "tron" | "sui". */
  chain: string;
  /** Address whose on-chain sender proof unlocks Seal decrypt of coldAddr.
   *  Today always eth@ultron. */
  sweepDelegate: string;
  /** When this binding expires (ms epoch). 0 = never. */
  expiresMs: number;
  /** When we started watching (ms epoch). */
  registeredAtMs: number;
}

export interface PendingSweep {
  /** Hot address where funds landed. */
  hotAddr: string;
  /** Amount detected, as base-unit string (wei for ETH, lamports for SOL, …). */
  amountWei: string;
  /** When webhook reported the inbound transfer. */
  detectedAtMs: number;
  /** Earliest time we're allowed to fire the sweep (debounce window). */
  scheduledMs: number;
  /** Assigned once a batch groups this sweep with peers. */
  batchId?: string;
}

export interface CompletedSweep {
  hotAddr: string;
  /** Short-form cold destination (first 6 + last 4) — never full plaintext. */
  coldAddrShort: string;
  /** Tx digest / hash returned by the signing ceremony. */
  digest: string;
  executedAtMs: number;
}

export interface SneaselWatcherState {
  watchedHotAddrs: WatchedHotAddr[];
  pendingSweeps: PendingSweep[];
  completedSweeps: CompletedSweep[];
}

interface Env {
  /** Set by wrangler; gates state-changing paths when non-mainnet. */
  SUI_NETWORK?: string;
  /** Ultron signing key (bech32) — used by Icy Wind move, not this scaffold. */
  SHADE_KEEPER_PRIVATE_KEY?: string;
}

// Admin-gated callable request shape. Callers sign a
// `sneasel-watcher:<op>:<parentHash>:<today>` personal message with an
// allowlisted ultron admin key. Verification happens in `_requireAdmin`.
interface AdminAuth {
  adminAddress: string;
  signature: string;
  message: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function isMainnetEnv(env: Env): boolean {
  const network = (env.SUI_NETWORK || 'mainnet').toLowerCase();
  return network === 'mainnet';
}

function shortenAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr ?? '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─── Agent ──────────────────────────────────────────────────────────────

export class SneaselWatcherAgent extends Agent<Env, SneaselWatcherState> {
  initialState: SneaselWatcherState = {
    watchedHotAddrs: [],
    pendingSweeps: [],
    completedSweeps: [],
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Chain our alarm after the agents-base alarm (same pattern as
    // ShadeExecutorAgent — the base class uses `this.alarm` for its
    // cf_agents_schedules system).
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._runSneaselAlarm();
    };
  }

  // ─── Callables ────────────────────────────────────────────────────

  /** Register a hot address to watch.
   *  Guard: requires ultron admin signature; mainnet-only. */
  @callable()
  async watch(params: {
    parentHash: string;
    label: string;
    hotAddr: string;
    chain: string;
    sweepDelegate: string;
    expiresMs: number;
    auth: AdminAuth;
  }): Promise<{ success: boolean; error?: string }> {
    if (!isMainnetEnv(this.env)) {
      return { success: false, error: 'SneaselWatcher is mainnet-only — this worker is on a non-mainnet network' };
    }
    const denial = await this._requireAdmin(params.auth, `watch:${params.parentHash}:${params.label}`);
    if (denial) return { success: false, error: denial };

    // Dedupe on (parentHash, label) — a re-watch replaces the old entry.
    const pruned = this.state.watchedHotAddrs.filter(
      w => !(w.parentHash === params.parentHash && w.label === params.label),
    );
    const entry: WatchedHotAddr = {
      parentHash: params.parentHash,
      label: params.label,
      hotAddr: params.hotAddr,
      chain: params.chain,
      sweepDelegate: params.sweepDelegate,
      expiresMs: params.expiresMs,
      registeredAtMs: Date.now(),
    };
    this.setState({ ...this.state, watchedHotAddrs: [...pruned, entry] });
    this._scheduleSneaselAlarm();
    // TODO(Sneasel Metal Claw): register hotAddr with Alchemy/Helius webhooks
    // so inbound transfers land in enqueueSweep() automatically.
    return { success: true };
  }

  /** Stop watching a hot address. */
  @callable()
  async unwatch(params: {
    parentHash: string;
    label: string;
    auth: AdminAuth;
  }): Promise<{ success: boolean; error?: string }> {
    const denial = await this._requireAdmin(params.auth, `unwatch:${params.parentHash}:${params.label}`);
    if (denial) return { success: false, error: denial };

    this.setState({
      ...this.state,
      watchedHotAddrs: this.state.watchedHotAddrs.filter(
        w => !(w.parentHash === params.parentHash && w.label === params.label),
      ),
    });
    // TODO(Sneasel Metal Claw): deregister from webhook provider.
    return { success: true };
  }

  /** Debug dump — full state. Admin-gated because addresses are sensitive. */
  @callable()
  async poke(params: { auth: AdminAuth }): Promise<{
    watched: number;
    pending: number;
    completed: number;
    state: SneaselWatcherState;
  } | { error: string }> {
    const denial = await this._requireAdmin(params.auth, 'poke');
    if (denial) return { error: denial };
    return {
      watched: this.state.watchedHotAddrs.length,
      pending: this.state.pendingSweeps.length,
      completed: this.state.completedSweeps.length,
      state: this.state,
    };
  }

  /** Public status — counts only, no addresses. Safe to expose unauthenticated. */
  @callable()
  async status(): Promise<{
    watched: number;
    pending: number;
    completed: number;
    lastSweepMs: number | null;
  }> {
    const lastSweepMs = this.state.completedSweeps.length > 0
      ? this.state.completedSweeps[this.state.completedSweeps.length - 1].executedAtMs
      : null;
    return {
      watched: this.state.watchedHotAddrs.length,
      pending: this.state.pendingSweeps.length,
      completed: this.state.completedSweeps.length,
      lastSweepMs,
    };
  }

  /** Webhook-called when inbound funds are detected at a watched hot address.
   *  Today requires admin auth — in live webhook wiring (Metal Claw) the
   *  HTTP router that receives the provider webhook will verify the
   *  provider HMAC and then forward to this method with an ultron-signed
   *  auth envelope, OR Metal Claw will introduce a provider-HMAC guard
   *  directly in this DO's onRequest. */
  @callable()
  async enqueueSweep(params: {
    hotAddr: string;
    amountWei: string;
    auth: AdminAuth;
  }): Promise<{ success: boolean; error?: string; scheduledMs?: number }> {
    const denial = await this._requireAdmin(params.auth, `enqueueSweep:${params.hotAddr}`);
    if (denial) return { success: false, error: denial };

    // Verify the hot address is actually being watched — we don't sweep
    // randoms, only registered stealth guests.
    const watched = this.state.watchedHotAddrs.find(w => w.hotAddr.toLowerCase() === params.hotAddr.toLowerCase());
    if (!watched) {
      return { success: false, error: `hotAddr ${shortenAddr(params.hotAddr)} is not watched by this DO` };
    }
    if (watched.expiresMs > 0 && watched.expiresMs < Date.now()) {
      return { success: false, error: `hotAddr ${shortenAddr(params.hotAddr)} binding expired` };
    }

    const now = Date.now();
    const entry: PendingSweep = {
      hotAddr: params.hotAddr,
      amountWei: params.amountWei,
      detectedAtMs: now,
      scheduledMs: now + SWEEP_DEBOUNCE_MS,
    };
    this.setState({
      ...this.state,
      pendingSweeps: [...this.state.pendingSweeps, entry],
    });
    this._scheduleSneaselAlarm();
    return { success: true, scheduledMs: entry.scheduledMs };
  }

  /** Alarm-driven batch processor. Scaffold: logs what it would sweep.
   *  Real signing lands in Sneasel Icy Wind; batching in Sneasel Beat Up. */
  @callable()
  async tick(): Promise<{ processed: number; batches: number }> {
    const now = Date.now();
    const ready = this.state.pendingSweeps.filter(p => p.scheduledMs <= now);
    if (ready.length === 0) {
      this._scheduleSneaselAlarm();
      return { processed: 0, batches: 0 };
    }

    // TODO(Sneasel Beat Up): group ready sweeps by (chain, sweepDelegate)
    // and build one multi-send tx per batch instead of one per sweep.
    const batchCount = new Set(
      ready.map(p => {
        const w = this.state.watchedHotAddrs.find(w => w.hotAddr.toLowerCase() === p.hotAddr.toLowerCase());
        return `${w?.chain ?? 'unknown'}|${w?.sweepDelegate ?? 'unknown'}`;
      }),
    ).size;

    // TODO(Sneasel Blizzard): for each ready sweep, fetch the sealed
    // cold destination from Move roster GuestStealth entry and call
    // Seal decrypt with ultron's sender proof (seal_approve_guest_stealth).
    //
    // TODO(Sneasel Icy Wind): take the decrypted cold destination and
    // run an IKA dWallet signing ceremony on the hot-address keyshares
    // to produce a hot→cold transfer tx, then submit to the chain.
    //
    // TODO(Sneasel Beat Up): issue a single batched tx per (chain,
    // delegate) group, record one digest per group, and attribute
    // individual sweeps to that digest.

    console.log(
      `[SneaselWatcher:${this.name}] tick() — would sweep ${ready.length} addresses in ${batchCount} batch(es); scaffold only, no signing yet`,
    );
    this._scheduleSneaselAlarm();
    return { processed: ready.length, batches: batchCount };
  }

  // ─── Private ──────────────────────────────────────────────────────

  /** Admin auth check — verifies personal-message signature against the
   *  ultron admin allowlist. Mirrors `requireUltronAdmin` from
   *  ultron-policy.ts, adapted to return an error string (or null) for
   *  use inside `@callable` methods where we don't have a Hono context. */
  private async _requireAdmin(auth: AdminAuth | undefined, op: string): Promise<string | null> {
    if (!auth?.adminAddress || !auth.signature || !auth.message) {
      return 'Missing adminAddress, signature, or message';
    }
    const { ADMIN_ADDRESSES, todayUtc } = await import('../ultron-policy.js');
    const normalized = auth.adminAddress.toLowerCase();
    if (!ADMIN_ADDRESSES.has(normalized)) {
      return `${auth.adminAddress} not in admin allowlist`;
    }
    const expected = `sneasel-watcher:${op}:${todayUtc()}`;
    if (auth.message !== expected) {
      return `message must be exactly "${expected}"`;
    }
    try {
      const { verifyPersonalMessageSignature } = await import('@mysten/sui/verify');
      const messageBytes = new TextEncoder().encode(auth.message);
      await verifyPersonalMessageSignature(messageBytes, auth.signature, { address: normalized });
    } catch (err) {
      return `Invalid signature: ${err instanceof Error ? err.message : String(err)}`;
    }
    return null;
  }

  private async _runSneaselAlarm(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      console.error(`[SneaselWatcher:${this.name}] alarm error:`, err);
    } finally {
      this._scheduleSneaselAlarm();
    }
  }

  /** Keep state bounded: evict completed sweeps past the rolling cap. */
  private _trimSneaselCompleted() {
    if (this.state.completedSweeps.length <= COMPLETED_HISTORY_MAX) return;
    const trimmed = this.state.completedSweeps.slice(-COMPLETED_HISTORY_MAX);
    this.setState({ ...this.state, completedSweeps: trimmed });
  }

  /** Schedule next alarm — earliest pending sweep, or SWEEP_INTERVAL_MS
   *  out if nothing pending (so the DO keeps itself warm enough to process
   *  webhook-enqueued sweeps promptly). */
  private _scheduleSneaselAlarm() {
    this._trimSneaselCompleted();
    const now = Date.now();
    const pending = this.state.pendingSweeps
      .map(p => p.scheduledMs)
      .sort((a, b) => a - b);
    const nextPending = pending[0] ?? Infinity;
    const nextIdle = now + SWEEP_INTERVAL_MS;
    const next = Math.min(nextPending, nextIdle);
    this.ctx.storage.setAlarm(Math.max(next, now + 1_000));
  }
}
