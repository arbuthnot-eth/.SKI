/**
 * Sneasel Ice Fang — watcher DO unit tests.
 *
 * Covers plan §5.3 seed items:
 *   - tick() with two distinct-guest pending sweeps produces two batches
 *   - tick() rejects v1 sealed payload with clear "ice-fang-requires-v2"
 *
 * We don't spin a real Durable Object — we mock the `agents` module to
 * expose a trivial Agent base with `state` / `setState` / `ctx.storage`.
 * That lets the grouping + jitter logic in tick() run under bun:test
 * without Cloudflare infra.
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test';

beforeAll(() => {
  mock.module('agents', () => ({
    // Minimal Agent stub — initialState seeds state, setState mutates
    // in place, ctx.storage.setAlarm is a no-op. Good enough for the
    // grouping + jitter assertions.
    Agent: class AgentStub<_E, S> {
      state: S;
      name = 'test';
      ctx: { storage: { setAlarm: (ms: number) => void } };
      env: unknown;
      initialState!: S;
      constructor(_ctx: unknown, env: unknown) {
        this.env = env;
        this.ctx = { storage: { setAlarm: () => {} } };
        // Subclass sets initialState as a field; pull it after super().
        setTimeout(() => { this.state = this.initialState; }, 0);
      }
      setState(s: S) { this.state = s; }
      alarm = async () => {};
    },
    callable: () => (_target: unknown, _prop: unknown, desc: PropertyDescriptor) => desc,
  }));
});

// ─── tick() grouping ──────────────────────────────────────────────────

describe('SneaselWatcherAgent.tick() — Ice Fang grouping', () => {
  test('two distinct-guest pending sweeps produce two batches, not one', async () => {
    const { SneaselWatcherAgent } = await import('../sneasel-watcher.js');
    // Construct with a dummy ctx + env. Agent stub defers state init
    // via setTimeout; just set it synchronously here for the test.
    const agent = new SneaselWatcherAgent(
      {} as unknown as DurableObjectState,
      { SUI_NETWORK: 'mainnet' },
    );
    agent.state = {
      watchedHotAddrs: [
        {
          parentHash: '0xparent',
          label: 'hermes',
          hotAddr: '0xHOT_AMAZON',
          chain: 'eth',
          sweepDelegate: '0xULTRON',
          expiresMs: 0,
          registeredAtMs: 0,
        },
        {
          parentHash: '0xparent',
          label: 'athena',
          hotAddr: '0xHOT_VENMO',
          chain: 'eth',
          sweepDelegate: '0xULTRON',
          expiresMs: 0,
          registeredAtMs: 0,
        },
      ],
      pendingSweeps: [
        {
          hotAddr: '0xHOT_AMAZON',
          amountWei: '1000',
          detectedAtMs: 0,
          scheduledMs: 0, // already ready
        },
        {
          hotAddr: '0xHOT_VENMO',
          amountWei: '2000',
          detectedAtMs: 0,
          scheduledMs: 0,
        },
      ],
      completedSweeps: [],
    };

    const result = await agent.tick();
    // Two distinct guests → TWO batches. This is the headline Ice
    // Fang regression: the v1 grouping would have collapsed both
    // into one (chain, sweepDelegate) bucket.
    expect(result.batches).toBe(2);
    expect(result.processed).toBe(2);
  });

  test('two sweeps for the SAME guest stay in one batch (intra-guest OK)', async () => {
    const { SneaselWatcherAgent } = await import('../sneasel-watcher.js');
    const agent = new SneaselWatcherAgent(
      {} as unknown as DurableObjectState,
      { SUI_NETWORK: 'mainnet' },
    );
    agent.state = {
      watchedHotAddrs: [
        {
          parentHash: '0xparent',
          label: 'hermes',
          hotAddr: '0xHOT_AMAZON',
          chain: 'eth',
          sweepDelegate: '0xULTRON',
          expiresMs: 0,
          registeredAtMs: 0,
        },
      ],
      pendingSweeps: [
        { hotAddr: '0xHOT_AMAZON', amountWei: '1000', detectedAtMs: 0, scheduledMs: 0 },
        { hotAddr: '0xHOT_AMAZON', amountWei: '500', detectedAtMs: 0, scheduledMs: 0 },
      ],
      completedSweeps: [],
    };
    const result = await agent.tick();
    expect(result.batches).toBe(1);
    expect(result.processed).toBe(2);
  });
});

// ─── v1-reject gate ───────────────────────────────────────────────────

describe('SneaselWatcherAgent.rejectV1SealedPayload', () => {
  test('rejects v1 sealed payload with ice-fang-requires-v2', async () => {
    const { SneaselWatcherAgent } = await import('../sneasel-watcher.js');
    expect(() => SneaselWatcherAgent.rejectV1SealedPayload({ version: 1 })).toThrow(
      /ice-fang-requires-v2/,
    );
  });

  test('rejects missing version field', async () => {
    const { SneaselWatcherAgent } = await import('../sneasel-watcher.js');
    expect(() => SneaselWatcherAgent.rejectV1SealedPayload({})).toThrow(/ice-fang-requires-v2/);
  });

  test('accepts v2 payload silently', async () => {
    const { SneaselWatcherAgent } = await import('../sneasel-watcher.js');
    expect(() => SneaselWatcherAgent.rejectV1SealedPayload({ version: 2 })).not.toThrow();
  });
});

// ─── Shadow Ball pt1 — Sui sweep branch ──────────────────────────────

describe('SneaselWatcherAgent — Sui sweep branch', () => {
  test('tick() with two ready Sui sweeps for distinct guests produces two batches', async () => {
    const { SneaselWatcherAgent } = await import('../sneasel-watcher.js');
    const agent = new SneaselWatcherAgent(
      {} as unknown as DurableObjectState,
      { SUI_NETWORK: 'mainnet' },
    );
    const SUI_ULTRON = '0x' + 'cc'.repeat(32);
    agent.state = {
      watchedHotAddrs: [
        {
          parentHash: '0xparent',
          label: 'hermes',
          hotAddr: '0x' + 'aa'.repeat(32),
          chain: 'sui',
          sweepDelegate: SUI_ULTRON,
          expiresMs: 0,
          registeredAtMs: 0,
        },
        {
          parentHash: '0xparent',
          label: 'athena',
          hotAddr: '0x' + 'bb'.repeat(32),
          chain: 'sui',
          sweepDelegate: SUI_ULTRON,
          expiresMs: 0,
          registeredAtMs: 0,
        },
      ],
      pendingSweeps: [
        { hotAddr: '0x' + 'aa'.repeat(32), amountWei: '100000', detectedAtMs: 0, scheduledMs: 0 },
        { hotAddr: '0x' + 'bb'.repeat(32), amountWei: '200000', detectedAtMs: 0, scheduledMs: 0 },
      ],
      completedSweeps: [],
    };
    const result = await agent.tick();
    // Ice Fang invariant holds on Sui — two distinct guests → two batches,
    // even sharing the same sweep delegate on Sui side.
    expect(result.batches).toBe(2);
    expect(result.processed).toBe(2);
  });

  test('_sweepSui no-ops on zero balance (dust gate)', async () => {
    const { SneaselWatcherAgent } = await import('../sneasel-watcher.js');
    const agent = new SneaselWatcherAgent(
      {} as unknown as DurableObjectState,
      { SUI_NETWORK: 'mainnet' },
    );
    const hot = '0x' + 'aa'.repeat(32);
    agent.state = {
      watchedHotAddrs: [
        {
          parentHash: '0xparent',
          label: 'hermes',
          hotAddr: hot,
          chain: 'sui',
          sweepDelegate: '0x' + 'cc'.repeat(32),
          expiresMs: 0,
          registeredAtMs: 0,
        },
      ],
      pendingSweeps: [],
      completedSweeps: [],
    };
    // amountWei=0 → webhook reported nothing. _sweepSui should short-circuit
    // on the dust gate without attempting decrypt/sign.
    const res = await agent._sweepSui([
      { hotAddr: hot, amountWei: '0', detectedAtMs: 0, scheduledMs: 0 },
    ]);
    expect(res.count).toBe(0);
    expect(res.reason).toBe('below-dust');
    expect(res.digest).toBe('');
  });

  test('_sweepSui rejects v1 sealed payload with clear error', async () => {
    const { SneaselWatcherAgent } = await import('../sneasel-watcher.js');
    const agent = new SneaselWatcherAgent(
      {} as unknown as DurableObjectState,
      { SUI_NETWORK: 'mainnet' },
    );
    // The v1-reject gate is the contract pt2 will call once Seal decrypt
    // lands. Pt1 exposes it directly so the error surface is pinned now.
    expect(() => agent._sweepSuiRejectV1({ version: 1 })).toThrow(/ice-fang-requires-v2/);
    expect(() => agent._sweepSuiRejectV1({})).toThrow(/ice-fang-requires-v2/);
    expect(() => agent._sweepSuiRejectV1({ version: 2 })).not.toThrow();
  });
});

// ─── jitter window ────────────────────────────────────────────────────

describe('pickSweepJitterMs', () => {
  test('returns values in [30s, 30min]', async () => {
    const { pickSweepJitterMs } = await import('../sneasel-watcher.js');
    for (let i = 0; i < 50; i += 1) {
      const j = pickSweepJitterMs();
      expect(j).toBeGreaterThanOrEqual(30_000);
      expect(j).toBeLessThanOrEqual(30 * 60 * 1000);
    }
  });
});
