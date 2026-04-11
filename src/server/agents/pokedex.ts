/**
 * Pokedex — Pokemon Swarm coordinator DO.
 *
 * Phase 2 of the Pokemon Swarm spec
 * (docs/superpowers/specs/2026-04-11-pokemon-swarm-agents.md).
 *
 * Owns the spawn loop: every 15 minutes, picks the oldest un-actioned
 * observation (TODO or error shape), derives a Pokemon name + level
 * deterministically from its hash, and proposes a "wild" spawn. Phase 2
 * STUBS out the actual GitHub issue creation — it logs what it would do
 * and stores the proposal with a negative `issueNumber` sentinel so
 * Phase 3 can plug in the live `gh` / REST path later.
 *
 * Observations are pushed in by external agents:
 *   POST /observe-todos   — { todos:  [{ file, line, text }] }
 *   POST /observe-errors  — { errors: [{ shape, count }] }
 *   POST /observe-issues  — { issues: [{ number, title }] }
 *
 * Singleton DO: always accessed via idFromName('singleton').
 */

import { Agent } from 'agents';

// ── Tunables ─────────────────────────────────────────────────────────────
const TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const SPAWN_RATE_LIMIT_MS = 6 * 60 * 60 * 1000; // 6 hours between spawns
const WILD_BUDGET_CAP = 20; // max concurrent wild proposals

// Gen-1 Pokemon pool for deterministic spawn naming.
// Kept small + curated; Phase 4 widens this when legendary evolutions land.
const POKEMON_POOL: readonly string[] = [
  'Bulbasaur', 'Charmander', 'Squirtle', 'Pikachu', 'Jigglypuff',
  'Meowth', 'Psyduck', 'Machop', 'Geodude', 'Gastly',
  'Onix', 'Cubone', 'Eevee', 'Dratini', 'Abra',
  'Magnemite', 'Ditto', 'Porygon', 'Chansey', 'Snorlax',
] as const;

// ── Types ────────────────────────────────────────────────────────────────
export interface PokedexTodoObservation {
  file: string;
  line: number;
  text: string;
  seenMs: number;
  actioned: boolean;
}

export interface PokedexErrorObservation {
  shape: string;
  count: number;
  seenMs: number;
  actioned: boolean;
}

export interface PokedexIssueObservation {
  number: number;
  title: string;
  seenMs: number;
}

export interface PokedexSpawn {
  pokemon: string;         // e.g. "Chansey Lv.20"
  issueNumber: number;     // stub negative int; Phase 3 will store real gh numbers
  spawnReason: string;     // human-readable explanation
  sourceFile?: string;     // path that triggered the spawn, if any
  createdMs: number;
  status: 'wild' | 'captured' | 'merged' | 'evolved';
  mergedSha?: string;
  levelUps: number;        // bumped each post-merge commit touching the feature
}

export interface PokedexState {
  last_spawn_ms: number;
  last_tick_ms: number;
  spawned: PokedexSpawn[];
  todos: PokedexTodoObservation[];
  errors: PokedexErrorObservation[];
  openIssues: PokedexIssueObservation[];
  totalSpawnsProposed: number;
  totalSpawnsActioned: number;
}

interface Env {
  GITHUB_TOKEN?: string;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Stable 32-bit hash of a string (FNV-1a). Deterministic across runs. */
function _hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** XOR-shuffle: permutes an index using the hash so picks look varied. */
function _pickPokemon(seed: number): string {
  const i = ((seed ^ (seed >>> 7) ^ (seed >>> 13)) >>> 0) % POKEMON_POOL.length;
  return POKEMON_POOL[i];
}

/** Derives a level 10–69 deterministically from a numeric signal. */
function _deriveLevel(seed: number): number {
  return (seed % 60) + 10;
}

function _normStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function _normInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

// ── DO class ─────────────────────────────────────────────────────────────
export class Pokedex extends Agent<Env, PokedexState> {
  initialState: PokedexState = {
    last_spawn_ms: 0,
    last_tick_ms: 0,
    spawned: [],
    todos: [],
    errors: [],
    openIssues: [],
    totalSpawnsProposed: 0,
    totalSpawnsActioned: 0,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Wrap the Agent framework's alarm so our tick always runs.
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._tick();
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // On first touch, ensure an alarm is scheduled.
    if (this.state.last_tick_ms === 0) {
      try { await this.ctx.storage.setAlarm(Date.now() + 1_000); } catch { /* ignore */ }
    }

    try {
      if (request.method === 'POST' && path.endsWith('/observe-todos')) {
        return await this._handleObserveTodos(request);
      }
      if (request.method === 'POST' && path.endsWith('/observe-errors')) {
        return await this._handleObserveErrors(request);
      }
      if (request.method === 'POST' && path.endsWith('/observe-issues')) {
        return await this._handleObserveIssues(request);
      }
      if (request.method === 'POST' && path.endsWith('/tick')) {
        await this._tick();
        return Response.json({ ok: true, state: this._publicState() });
      }
      if (request.method === 'GET' && path.endsWith('/state')) {
        return Response.json(this._publicState());
      }
      if (request.method === 'GET' && path.endsWith('/spawned')) {
        return Response.json({ spawned: this.state.spawned });
      }
      if (request.method === 'POST' && path.endsWith('/mark-captured')) {
        return await this._handleMarkStatus(request, 'captured');
      }
      if (request.method === 'POST' && path.endsWith('/mark-merged')) {
        return await this._handleMarkStatus(request, 'merged');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: msg }, { status: 500 });
    }

    return new Response('not found', { status: 404 });
  }

  // ── observation ingestion ──────────────────────────────────────────────
  private async _handleObserveTodos(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { todos?: Array<{ file?: unknown; line?: unknown; text?: unknown }> };
    if (!body || !Array.isArray(body.todos)) {
      return Response.json({ ok: false, error: 'bad input: todos must be array' }, { status: 400 });
    }
    const now = Date.now();
    const existing = new Set(this.state.todos.map(t => `${t.file}:${t.line}`));
    const merged = [...this.state.todos];
    let added = 0;
    for (const row of body.todos.slice(0, 500)) {
      const file = _normStr(row.file);
      const line = _normInt(row.line);
      const text = _normStr(row.text);
      if (!file || line === null || !text) continue;
      const key = `${file}:${line}`;
      if (existing.has(key)) continue;
      existing.add(key);
      merged.push({ file, line, text, seenMs: now, actioned: false });
      added++;
    }
    this.setState({ ...this.state, todos: merged });
    return Response.json({ ok: true, added, total: merged.length });
  }

  private async _handleObserveErrors(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { errors?: Array<{ shape?: unknown; count?: unknown }> };
    if (!body || !Array.isArray(body.errors)) {
      return Response.json({ ok: false, error: 'bad input: errors must be array' }, { status: 400 });
    }
    const now = Date.now();
    const map = new Map<string, PokedexErrorObservation>();
    for (const e of this.state.errors) map.set(e.shape, e);
    let added = 0;
    for (const row of body.errors.slice(0, 500)) {
      const shape = _normStr(row.shape);
      const count = _normInt(row.count);
      if (!shape || count === null || count < 0) continue;
      const prev = map.get(shape);
      if (prev) {
        map.set(shape, { ...prev, count: prev.count + count });
      } else {
        map.set(shape, { shape, count, seenMs: now, actioned: false });
        added++;
      }
    }
    this.setState({ ...this.state, errors: Array.from(map.values()) });
    return Response.json({ ok: true, added, total: map.size });
  }

  private async _handleObserveIssues(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { issues?: Array<{ number?: unknown; title?: unknown }> };
    if (!body || !Array.isArray(body.issues)) {
      return Response.json({ ok: false, error: 'bad input: issues must be array' }, { status: 400 });
    }
    const now = Date.now();
    const normalized: PokedexIssueObservation[] = [];
    for (const row of body.issues.slice(0, 500)) {
      const number = _normInt(row.number);
      const title = _normStr(row.title);
      if (number === null || !title) continue;
      normalized.push({ number, title, seenMs: now });
    }
    // Replace wholesale — caller sends the current open-issue snapshot.
    this.setState({ ...this.state, openIssues: normalized });
    return Response.json({ ok: true, total: normalized.length });
  }

  private async _handleMarkStatus(request: Request, target: 'captured' | 'merged'): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { issueNumber?: unknown; mergedSha?: unknown };
    const issueNumber = _normInt(body.issueNumber);
    if (issueNumber === null) {
      return Response.json({ ok: false, error: 'bad input: issueNumber required' }, { status: 400 });
    }
    const mergedSha = target === 'merged' ? _normStr(body.mergedSha) ?? undefined : undefined;
    const spawned = this.state.spawned.map((s) => {
      if (s.issueNumber !== issueNumber) return s;
      const next: PokedexSpawn = { ...s, status: target };
      if (target === 'merged') {
        next.mergedSha = mergedSha;
        next.levelUps = (s.levelUps ?? 0) + 1;
      }
      return next;
    });
    const found = spawned.some(s => s.issueNumber === issueNumber);
    if (!found) {
      return Response.json({ ok: false, error: `issueNumber ${issueNumber} not found` }, { status: 404 });
    }
    this.setState({ ...this.state, spawned });
    return Response.json({ ok: true });
  }

  // ── spawn loop ─────────────────────────────────────────────────────────
  private async _tick(): Promise<void> {
    const now = Date.now();
    this.setState({ ...this.state, last_tick_ms: now });

    try {
      await this._runSpawnLoop(now);
    } catch (err) {
      console.log('[pokedex/tick] spawn loop error:', err instanceof Error ? err.message : String(err));
    }

    // Reschedule next tick.
    try { await this.ctx.storage.setAlarm(Date.now() + TICK_INTERVAL_MS); } catch { /* ignore */ }
  }

  private async _runSpawnLoop(now: number): Promise<void> {
    const wildCount = this.state.spawned.filter(s => s.status === 'wild').length;
    if (wildCount >= WILD_BUDGET_CAP) {
      console.log(`[pokedex/spawn] budget cap reached (${wildCount}/${WILD_BUDGET_CAP} wild), skipping`);
      return;
    }
    if (now - this.state.last_spawn_ms < SPAWN_RATE_LIMIT_MS) {
      const waitMin = Math.ceil((SPAWN_RATE_LIMIT_MS - (now - this.state.last_spawn_ms)) / 60_000);
      console.log(`[pokedex/spawn] rate-limited, next spawn in ~${waitMin}m`);
      return;
    }

    // Pick oldest un-actioned observation (TODO preferred, fall back to error).
    const todo = this.state.todos
      .filter(t => !t.actioned)
      .sort((a, b) => a.seenMs - b.seenMs)[0];
    const err = this.state.errors
      .filter(e => !e.actioned)
      .sort((a, b) => a.seenMs - b.seenMs)[0];

    const pick: { kind: 'todo'; obs: PokedexTodoObservation } | { kind: 'error'; obs: PokedexErrorObservation } | null =
      todo ? { kind: 'todo', obs: todo }
      : err ? { kind: 'error', obs: err }
      : null;

    if (!pick) {
      console.log('[pokedex/spawn] no un-actioned observations');
      return;
    }

    // Derive Pokemon + level deterministically.
    const seed = pick.kind === 'todo'
      ? _hash32(`${pick.obs.file}:${pick.obs.line}:${pick.obs.text}`)
      : _hash32(`err:${pick.obs.shape}`);
    const pokemon = _pickPokemon(seed);
    const level = pick.kind === 'todo'
      ? ((pick.obs.line % 60) + 10)
      : _deriveLevel(seed);
    const pokemonLabel = `${pokemon} Lv.${level}`;

    // Dedupe against open issues by title substring.
    const dup = this.state.openIssues.some(i => i.title.includes(pokemonLabel));
    if (dup) {
      console.log(`[pokedex/spawn] ${pokemonLabel} already open, marking observation actioned`);
      this._markActioned(pick);
      return;
    }

    const spawnReason = pick.kind === 'todo'
      ? `TODO in ${pick.obs.file}:${pick.obs.line} — "${pick.obs.text.slice(0, 120)}"`
      : `error shape ${pick.obs.shape} (count ${pick.obs.count})`;
    const sourceFile = pick.kind === 'todo' ? pick.obs.file : undefined;

    console.log(`[pokedex/spawn] would spawn ${pokemonLabel} for ${spawnReason}`);

    // Phase 2: stub issue creation. If a GITHUB_TOKEN secret is present,
    // Phase 3 will POST to the GitHub REST API here and capture the real
    // issue number. For now we log the intent and record a negative stub.
    let issueNumber = -(this.state.spawned.length + 1);
    let actioned = 0;
    if (this.env.GITHUB_TOKEN) {
      console.log('[pokedex/spawn] GITHUB_TOKEN present — Phase 3 would POST to /repos/:owner/:repo/issues here');
      // Phase 3 will:
      //   1. POST https://api.github.com/repos/<owner>/<repo>/issues
      //      with Authorization: Bearer <token>
      //      body: { title, body, labels: ['wild', `type:${type}`] }
      //   2. Parse JSON, pull `.number` into issueNumber
      //   3. Increment totalSpawnsActioned
      actioned = 1;
    } else {
      console.log('[pokedex/spawn] no GITHUB_TOKEN — logging only, stub issueNumber');
    }

    const spawn: PokedexSpawn = {
      pokemon: pokemonLabel,
      issueNumber,
      spawnReason,
      sourceFile,
      createdMs: now,
      status: 'wild',
      levelUps: 0,
    };

    this._markActioned(pick);
    this.setState({
      ...this.state,
      spawned: [...this.state.spawned, spawn],
      last_spawn_ms: now,
      totalSpawnsProposed: this.state.totalSpawnsProposed + 1,
      totalSpawnsActioned: this.state.totalSpawnsActioned + actioned,
    });
  }

  private _markActioned(pick: { kind: 'todo'; obs: PokedexTodoObservation } | { kind: 'error'; obs: PokedexErrorObservation }): void {
    if (pick.kind === 'todo') {
      const todos = this.state.todos.map(t =>
        (t.file === pick.obs.file && t.line === pick.obs.line) ? { ...t, actioned: true } : t
      );
      this.setState({ ...this.state, todos });
    } else {
      const errors = this.state.errors.map(e =>
        e.shape === pick.obs.shape ? { ...e, actioned: true } : e
      );
      this.setState({ ...this.state, errors });
    }
  }

  private _publicState(): PokedexState & { wildCount: number } {
    return {
      ...this.state,
      wildCount: this.state.spawned.filter(s => s.status === 'wild').length,
    };
  }
}
