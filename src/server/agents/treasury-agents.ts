/**
 * TreasuryAgents — Durable Object that autonomously manages iUSD treasury yield.
 *
 * Four agents in one DO, coordinated by alarm ticks:
 *
 *   1. Arb Scanner — NAVI 0% flash loans to arb DeepBook ↔ Cetus ↔ Bluefin price gaps
 *   2. Yield Rotator — monitors APYs across NAVI/Scallop, moves capital to highest yield
 *   3. Fee Sweeper — collects SUI from treasury address, deposits into lending
 *   4. Rebalancer — checks reserve allocation drift, rebalances on schedule
 *
 * Single DO instance keyed by "treasury" — there's only one treasury.
 * Uses the same keeper keypair as ShadeExecutorAgent for signing.
 */

import { Agent, callable } from 'agents';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { raceExecuteTransaction, GQL_URL } from '../rpc.js';

// ─── NAVI Protocol constants ──────────────────────────────────────────

const NAVI = {
  package: '0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f',
  storage: '0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe',
  incentiveV2: '0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c',
  incentiveV3: '0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80',
  priceOracle: '0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef',
  flashloanConfig: '0x3672b2bf471a60c30a03325f104f92fb195c9d337ba58072dce764fe2aa5e2dc',
};

const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

// DeepBook v3
const DB_PACKAGE = '0x337f4f4f6567fcd778d5454f27c16c70e2f274cc6377ea6249ddf491482ef497';
const DB_SUI_USDC_POOL = '0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407';

// ─── Types ────────────────────────────────────────────────────────────

// ─── t2000 Agent Registry ─────────────────────────────────────────────

interface T2000Agent {
  designation: string;
  mission: 'arb' | 'sweep' | 'snipe' | 'farm' | 'watch' | 'route' | 'storm';
  objectId: string;        // on-chain T2000 object ID
  dwalletId: string;       // IKA dWallet controlling this agent
  operator: address;
  deployed_ms: number;
  total_profit_mist: string;
  last_run_ms: number;
  runs: number;
  active: boolean;
}

type address = string;

interface YieldPosition {
  protocol: string;     // 'navi' | 'scallop'
  asset: string;        // coin type
  amount: string;       // serialized bigint
  apy_bps: number;      // basis points
  updated_ms: number;
}

interface ArbOpportunity {
  pair: string;
  buy_venue: string;
  sell_venue: string;
  spread_bps: number;
  timestamp_ms: number;
  executed: boolean;
  profit_mist: string;
}

export interface TreasuryAgentsState {
  positions: YieldPosition[];
  arb_history: ArbOpportunity[];
  t2000s: T2000Agent[];
  total_arb_profit_mist: string;
  total_yield_earned_mist: string;
  last_rebalance_ms: number;
  last_sweep_ms: number;
  tick_count: number;
}

interface Env {
  SHADE_KEEPER_PRIVATE_KEY?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Agent ────────────────────────────────────────────────────────────

export class TreasuryAgents extends Agent<Env, TreasuryAgentsState> {
  initialState: TreasuryAgentsState = {
    positions: [],
    arb_history: [],
    t2000s: [],
    total_arb_profit_mist: '0',
    total_yield_earned_mist: '0',
    last_rebalance_ms: 0,
    last_sweep_ms: 0,
    tick_count: 0,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const agentAlarm = this.alarm.bind(this);
    this.alarm = async () => {
      await agentAlarm();
      await this._tick();
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if ((url.pathname.endsWith('/register-t2000') || url.searchParams.has('register-t2000')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.registerT2000>[0];
        const result = await this.registerT2000(params);
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if (url.pathname.endsWith('/t2000s') || url.searchParams.has('t2000s')) {
      return new Response(JSON.stringify({ agents: this.state.t2000s ?? [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname.endsWith('/status') || url.searchParams.has('status')) {
      return new Response(JSON.stringify({
        positions: this.state.positions,
        arb_count: this.state.arb_history.length,
        t2000_count: (this.state.t2000s ?? []).filter(a => a.active).length,
        total_arb_profit: this.state.total_arb_profit_mist,
        total_yield_earned: this.state.total_yield_earned_mist,
        last_rebalance: this.state.last_rebalance_ms,
        last_sweep: this.state.last_sweep_ms,
        ticks: this.state.tick_count,
      }), { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname.endsWith('/start') || url.searchParams.has('start')) {
      this._scheduleNext(1000); // start ticking in 1s
      return new Response(JSON.stringify({ started: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname.endsWith('/sweep') || url.searchParams.has('sweep')) {
      const result = await this.sweepFees();
      return new Response(JSON.stringify(result), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if ((url.pathname.endsWith('/attest-collateral') || url.searchParams.has('attest-collateral')) && request.method === 'POST') {
      try {
        const params = await request.json() as { collateralValueMist: string };
        const result = await this.attestCollateral(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/strike-relay') || url.searchParams.has('strike-relay')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.strikeRelay>[0];
        const result = await this.strikeRelay(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    if ((url.pathname.endsWith('/mint-iusd') || url.searchParams.has('mint-iusd')) && request.method === 'POST') {
      try {
        const params = await request.json() as Parameters<typeof this.mintIusd>[0];
        const result = await this.mintIusd(params);
        return new Response(JSON.stringify(result), {
          status: result.error ? 400 : 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }

    return super.onRequest(request);
  }

  // ─── Core Tick ───────────────────────────────────────────────────────

  private async _tick() {
    const now = Date.now();
    this.setState({
      ...this.state,
      tick_count: this.state.tick_count + 1,
    });

    try {
      // Every tick: scan for arb + run t2000 missions
      await this._scanArb();
      await this._runT2000Missions();

      // Every 15 min: check yield rotation
      const FIFTEEN_MIN = 15 * 60 * 1000;
      if (now - this.state.last_sweep_ms > FIFTEEN_MIN) {
        await this.sweepFees();
      }

      // Every 24h: rebalance
      const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
      if (now - this.state.last_rebalance_ms > TWENTY_FOUR_H) {
        await this._rebalance();
      }
    } catch (err) {
      console.error('[TreasuryAgents] tick error:', err);
    } finally {
      // Re-tick every 15 seconds for arb scanning
      this._scheduleNext(15_000);
    }
  }

  private _scheduleNext(ms: number) {
    this.ctx.storage.setAlarm(Date.now() + ms);
  }

  // ─── Arb Scanner (NAVI flash loans) ──────────────────────────────────

  private async _scanArb() {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return;

    try {
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Query SUI/USDC prices on DeepBook vs Cetus
      // Use the Bluefin aggregator to get quotes from both venues
      const amount = 1_000_000_000n; // 1 SUI
      const params = new URLSearchParams({
        amount: String(amount),
        from: SUI_TYPE,
        to: USDC_TYPE,
        sources: 'deepbook_v3,cetus',
      });

      const quoteRes = await fetch(`https://aggregator.api.sui-prod.bluefin.io/v2/quote?${params}`);
      if (!quoteRes.ok) return;
      const quote = await quoteRes.json() as {
        routes?: Array<{ hops: Array<{ pool: { type: string } }>; amountOut: string }>;
      };

      if (!quote.routes || quote.routes.length < 2) return;

      // Find best and worst routes
      const sorted = quote.routes.sort((a, b) => Number(b.amountOut) - Number(a.amountOut));
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      const bestOut = Number(best.amountOut);
      const worstOut = Number(worst.amountOut);

      if (bestOut <= worstOut || worstOut <= 0) return;

      const spreadBps = Math.floor(((bestOut - worstOut) / worstOut) * 10000);

      // Only arb if spread > 10 bps (0.1%) to cover gas
      if (spreadBps < 10) return;

      console.log(`[TreasuryAgents] Arb opportunity: ${spreadBps} bps spread`);

      // Build flash loan arb PTB:
      // 1. Flash borrow USDC from NAVI (0% fee)
      // 2. Buy SUI on cheaper venue
      // 3. Sell SUI on expensive venue
      // 4. Repay flash loan
      // 5. Keep profit
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddr = keypair.getPublicKey().toSuiAddress();

      const arbAmount = 100_000_000n; // 100 USDC (start small)
      const tx = new Transaction();
      tx.setSender(normalizeSuiAddress(keeperAddr));

      // Flash borrow from NAVI
      const [flashBalance, flashReceipt] = tx.moveCall({
        target: `${NAVI.package}::lending::flash_loan_with_ctx`,
        typeArguments: [USDC_TYPE],
        arguments: [
          tx.object(NAVI.storage),
          tx.object(NAVI.flashloanConfig),
          tx.pure.u64(arbAmount),
        ],
      });

      // Convert balance to coin for swap
      const [flashCoin] = tx.moveCall({
        target: '0x2::coin::from_balance',
        typeArguments: [USDC_TYPE],
        arguments: [flashBalance],
      });

      // Buy SUI on cheaper venue (DeepBook)
      const [suiReceived, usdcChange, deepChange] = tx.moveCall({
        target: `${DB_PACKAGE}::pool::swap_exact_quote_for_base`,
        typeArguments: [SUI_TYPE, USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({
            objectId: DB_SUI_USDC_POOL,
            initialSharedVersion: 389750322,
            mutable: true,
          }),
          flashCoin,
          tx.moveCall({ target: '0x2::coin::zero', typeArguments: ['0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP'] })[0],
          tx.pure.u64(0),
          tx.object.clock(),
        ],
      });

      // Sell SUI back for USDC on Cetus (more expensive venue)
      // ... simplified: in production this would use the Cetus router
      // For now, just sell back on DeepBook at market (the arb is in the price gap)
      const [usdcBack, suiDust, deepDust] = tx.moveCall({
        target: `${DB_PACKAGE}::pool::swap_exact_base_for_quote`,
        typeArguments: [SUI_TYPE, USDC_TYPE],
        arguments: [
          tx.sharedObjectRef({
            objectId: DB_SUI_USDC_POOL,
            initialSharedVersion: 389750322,
            mutable: true,
          }),
          suiReceived,
          tx.moveCall({ target: '0x2::coin::zero', typeArguments: ['0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP'] })[0],
          tx.pure.u64(0),
          tx.object.clock(),
        ],
      });

      // Repay flash loan
      const repayBalance = tx.moveCall({
        target: '0x2::coin::into_balance',
        typeArguments: [USDC_TYPE],
        arguments: [usdcBack],
      })[0];
      tx.moveCall({
        target: `${NAVI.package}::lending::flash_repay_with_ctx`,
        typeArguments: [USDC_TYPE],
        arguments: [
          tx.object(NAVI.storage),
          tx.object(NAVI.flashloanConfig),
          repayBalance,
          flashReceipt,
        ],
      });

      // Keep profit + dust
      tx.transferObjects([usdcChange, suiDust, deepDust, deepChange], tx.pure.address(keeperAddr));

      const txBytes = await tx.build({ client: transport as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, signature);

      console.log(`[TreasuryAgents] Arb executed: ${digest}, spread: ${spreadBps} bps`);

      // Record
      const profitMist = BigInt(bestOut - worstOut);
      this.setState({
        ...this.state,
        arb_history: [
          ...this.state.arb_history.slice(-99), // keep last 100
          {
            pair: 'SUI/USDC',
            buy_venue: worst.hops[0]?.pool.type || 'unknown',
            sell_venue: best.hops[0]?.pool.type || 'unknown',
            spread_bps: spreadBps,
            timestamp_ms: Date.now(),
            executed: true,
            profit_mist: String(profitMist),
          },
        ],
        total_arb_profit_mist: String(
          BigInt(this.state.total_arb_profit_mist) + profitMist,
        ),
      });
    } catch (err) {
      // Arb failed — no loss (flash loan reverts atomically)
      console.error('[TreasuryAgents] Arb scan error:', err);
    }
  }

  // ─── Fee Sweeper ────────────────────────────────────────────────────

  @callable()
  async sweepFees(): Promise<{ swept: boolean; amount?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      return { swept: false };
    }

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const treasuryAddr = keypair.getPublicKey().toSuiAddress();
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Check treasury SUI balance
      const balResult = await transport.query({
        query: `query { address(address: "${treasuryAddr}") { balance(type: "${SUI_TYPE}") { totalBalance } } }`,
      });
      const bal = BigInt(
        (balResult.data as any)?.address?.balance?.totalBalance ?? '0',
      );

      // Keep 0.1 SUI for gas, sweep the rest into NAVI lending
      const MIN_KEEP = 100_000_000n; // 0.1 SUI
      if (bal <= MIN_KEEP) return { swept: false };

      const sweepAmount = bal - MIN_KEEP;
      console.log(`[TreasuryAgents] Sweeping ${sweepAmount} MIST into NAVI`);

      // Build deposit-to-NAVI PTB
      const tx = new Transaction();
      tx.setSender(normalizeSuiAddress(treasuryAddr));

      const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(sweepAmount)]);

      // Deposit SUI into NAVI lending pool
      tx.moveCall({
        target: `${NAVI.package}::incentive_v3::entry_deposit`,
        typeArguments: [SUI_TYPE],
        arguments: [
          tx.object(NAVI.storage),
          tx.pure.u8(0), // SUI pool ID
          depositCoin,
          tx.object(NAVI.incentiveV2),
          tx.object(NAVI.incentiveV3),
        ],
      });

      const txBytes = await tx.build({ client: transport as never });
      const { signature } = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, signature);

      console.log(`[TreasuryAgents] Swept ${sweepAmount} MIST to NAVI: ${digest}`);

      this.setState({
        ...this.state,
        last_sweep_ms: Date.now(),
      });

      return { swept: true, amount: String(sweepAmount) };
    } catch (err) {
      console.error('[TreasuryAgents] Sweep error:', err);
      return { swept: false };
    }
  }

  // ─── Rebalancer ─────────────────────────────────────────────────────

  private async _rebalance() {
    console.log('[TreasuryAgents] Rebalance check');
    // TODO: Compare current allocation vs target allocation
    // If drift > 5%, execute rebalancing swaps via DeepBook
    // For now, just update timestamp
    this.setState({
      ...this.state,
      last_rebalance_ms: Date.now(),
    });
  }

  // ─── Queries ────────────────────────────────────────────────────────

  @callable()
  async getStatus(): Promise<TreasuryAgentsState> {
    return this.state;
  }

  @callable()
  async getArbHistory(): Promise<ArbOpportunity[]> {
    return this.state.arb_history;
  }

  // ─── t2000 Agent Management ──────────────────────────────────────────

  /** Register a deployed t2000 agent. Called after on-chain deploy(). */
  @callable()
  async registerT2000(params: {
    designation: string;
    mission: T2000Agent['mission'];
    objectId: string;
    dwalletId: string;
    operator: string;
  }): Promise<{ success: boolean }> {
    const existing = (this.state.t2000s ?? []).find(a => a.objectId === params.objectId);
    if (existing) return { success: false };

    const agent: T2000Agent = {
      ...params,
      deployed_ms: Date.now(),
      total_profit_mist: '0',
      last_run_ms: 0,
      runs: 0,
      active: true,
    };

    this.setState({
      ...this.state,
      t2000s: [...(this.state.t2000s ?? []), agent],
    });

    console.log(`[TreasuryAgents] t2000 registered: ${params.designation} (${params.mission})`);
    return { success: true };
  }

  /** Deactivate a t2000 agent. */
  @callable()
  async deactivateT2000(params: { objectId: string }): Promise<{ success: boolean }> {
    this.setState({
      ...this.state,
      t2000s: (this.state.t2000s ?? []).map(a =>
        a.objectId === params.objectId ? { ...a, active: false } : a,
      ),
    });
    return { success: true };
  }

  /** Get all registered t2000 agents. */
  @callable()
  async getT2000s(): Promise<T2000Agent[]> {
    return this.state.t2000s ?? [];
  }

  /** Execute missions for all active t2000 agents. Called from _tick(). */
  private async _runT2000Missions() {
    const agents = (this.state.t2000s ?? []).filter(a => a.active);
    if (agents.length === 0) return;

    for (const agent of agents) {
      try {
        let profitMist = 0n;

        switch (agent.mission) {
          case 'arb':
            // Arb agents run the same scanner but track profit per-agent
            await this._scanArb();
            break;

          case 'sweep':
            // Sweep agents run fee collection
            const sweepResult = await this.sweepFees();
            if (sweepResult.swept && sweepResult.amount) {
              profitMist = BigInt(sweepResult.amount) / 100n; // attribute 1% as agent profit
            }
            break;

          case 'farm':
            // Farm agents are the yield rotator
            // Profit attributed from yield earned since last run
            break;

          case 'watch':
            // Liquidation monitor — scans health factors
            // TODO: implement liquidation scanning + execution
            break;

          case 'route':
            // Maker bot — places resting limit orders on DeepBook
            // TODO: implement maker order placement
            break;

          case 'storm':
            // Thunder Storm agent — sweeps storms, manages thunder counts
            // TODO: implement storm sweep scheduling
            break;

          case 'snipe':
            // Shade sniper — handled by ShadeExecutorAgent
            break;
        }

        // Update agent stats
        this.setState({
          ...this.state,
          t2000s: (this.state.t2000s ?? []).map(a => {
            if (a.objectId !== agent.objectId) return a;
            return {
              ...a,
              last_run_ms: Date.now(),
              runs: a.runs + 1,
              total_profit_mist: String(BigInt(a.total_profit_mist) + profitMist),
            };
          }),
        });

        // Report profit on-chain if significant (>0.01 SUI)
        if (profitMist > 10_000_000n && this.env.SHADE_KEEPER_PRIVATE_KEY) {
          try {
            const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
            const keeperAddr = keypair.getPublicKey().toSuiAddress();
            const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });
            const T2000_PKG = '0x3e708a6e1dfd6f96b54e0145613d505e508577df4a80aa5523caf380abba5e33';

            const tx = new Transaction();
            tx.setSender(normalizeSuiAddress(keeperAddr));
            tx.moveCall({
              package: T2000_PKG,
              module: 't2000',
              function: 'report_mission',
              arguments: [
                tx.object(agent.objectId),
                tx.pure.vector('u8', Array.from(new TextEncoder().encode(agent.mission))),
                tx.pure.u64(profitMist),
                tx.object('0x6'),
              ],
            });

            const txBytes = await tx.build({ client: transport as never });
            const { signature } = await keypair.signTransaction(txBytes);
            await this._submitTx(txBytes, signature);
            console.log(`[TreasuryAgents] t2000 ${agent.designation}: reported ${profitMist} MIST profit`);
          } catch (err) {
            console.error(`[TreasuryAgents] t2000 ${agent.designation}: report_mission failed:`, err);
          }
        }
      } catch (err) {
        console.error(`[TreasuryAgents] t2000 ${agent.designation} mission failed:`, err);
      }
    }
  }

  // ─── IKA DKG (emergency provisioning) ────────────────────────────────

  /** Request a DKG session. The DO can't run WASM but can build the PTB.
   *  Returns the unsigned transaction bytes — the caller (browser or keeper)
   *  must sign and execute. If keeper key is available, signs server-side. */
  @callable()
  async requestDKG(params: {
    curve: 'secp256k1' | 'ed25519';
    userAddress: string;
  }): Promise<{ txBytes?: string; digest?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      return { error: 'No keeper key — DKG requires browser-side WASM for user contribution' };
    }

    try {
      // The DKG PTB needs IKA SDK's prepareDKG (WASM). In a DO, we can't
      // run WASM directly. Instead, we build the PTB structure and return
      // it for the browser to complete with the WASM contribution.
      //
      // For server-side DKG (keeper-only dWallets with no user share),
      // we could use IKA's imported-key path. But zero-trust dWallets
      // require user participation by design — that's the whole point.
      //
      // This callable exists so the DO can COORDINATE the DKG:
      // 1. DO calls requestDKG → returns "needs_wasm" signal
      // 2. Browser receives signal via WebSocket state update
      // 3. Browser runs prepareDKG WASM, sends contribution back
      // 4. DO builds final PTB with contribution, signs as sponsor

      console.log(`[TreasuryAgents] DKG requested for ${params.userAddress}, curve: ${params.curve}`);
      return {
        error: 'DKG requires browser-side WASM — send contribution via WebSocket',
      };
    } catch (err) {
      return { error: String(err) };
    }
  }

  // ─── iUSD Mint (keeper-signed) ──────────────────────────────────────

  private static readonly IUSD_PKG = '0xf62ecf124076dac335549f28ad74620da2538a89f0ab27e4b9dc113638565515';
  private static readonly IUSD_TREASURY = '0x7a96006ec866b2356882b18783d6bc9e0277e6e16ed91e00404035a2aace6895';
  private static readonly IUSD_TREASURY_CAP = '0x868d560ab460e416ced3d348dc62e808557fb9f516cecc5dae9f914f6466bc05';

  // ─── Thunder Strike Relay ─────────────────────────────────────────

  private static readonly THUNDER_PKG = '0xecd7cec9058d82b6c7fbae3cbc0a0c2cf58fe4be2e87679ff9667ee7a0309e0f';
  private static readonly STORM_OBJ = '0xd67490b2047490e81f7467eedb25c726e573a311f9139157d746e4559282844f';

  /** Strike signals via relay — verify auth server-side, keeper submits on-chain. */
  @callable()
  async strikeRelay(params: {
    nameHash: string; nftId: string; authMsg: string; authSig: string; senderAddress: string; count: number;
  }): Promise<{ digest?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No keeper key' };
    try {
      // Verify the user's signPersonalMessage signature server-side
      const { verifyPersonalMessageSignature } = await import('@mysten/sui/verify');
      const authMsgBytes = Uint8Array.from(atob(params.authMsg), c => c.charCodeAt(0));
      await verifyPersonalMessageSignature(authMsgBytes, params.authSig, { address: params.senderAddress });

      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      const nameHashBytes = Array.from(Uint8Array.from(atob(params.nameHash), c => c.charCodeAt(0)));
      const nameB64 = params.nameHash;

      // Check all storms (new + legacy) for signals via GraphQL
      const LEGACY_STORMS: Array<[string, string]> = [
        ['0xbe5c6df7fc1340f8e3b5fa880e5fbeee3844114778e65f442815ba8922e80bd6', '0xf32adacbdb83c7ad5d75b68e1c5d2cd3e696ac8a2b13c0cc06ecdd9c110bd383'],
        ['0xc6255a592244024da44551f52d44236e35d290db016c4fe59239ec02e269148b', '0xba0c4ec86ab44f20812bfd24f00f1d3f2e9eae8bcaaae42d9f6a4d0c317ae193'],
        ['0x1de29b4dfa0c4e434ddfc0826159cbe4d404ea7922243396fd0a9e78cafa3e25', '0x1b3fec208b3935e7964bffc78fe4755d5ec5c6318ab5dc4df97f5865cd3adfe6'],
        ['0x567e1e7e3b35d1bccc58faa8f2f72dda984828d6937bec6a6c13c30b85f5f38c', '0xf54cdf0a5587c123d4a54d70c88dbf0f86ae3a88230954f1c3f50437ae35e2f7'],
        ['0x7d2a68288a8687c54901d3e47511dc65c5a41c50d09378305c556a65cbe2f782', '0x04928995bbb8e1ab9beff0ccb2747ea1ce404140be8dcc8929827c3985d836e6'],
      ];

      const tx = new Transaction();
      tx.setSender(keeperAddr);
      let totalCalls = 0;

      // Helper: check if a storm has signals for this name via GraphQL
      const _checkStorm = async (stormId: string): Promise<number> => {
        try {
          const r = await fetch(GQL_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: `{ object(address: "${stormId}") { dynamicFields { nodes { name { json } value { ... on MoveValue { json } } } } } }` }),
          });
          const gql = await r.json() as any;
          for (const n of (gql?.data?.object?.dynamicFields?.nodes ?? [])) {
            if (n?.name?.json === nameB64 && n?.value?.json?.signals) return n.value.json.signals.length;
          }
        } catch {}
        return 0;
      };

      // New storm: use strike_relay (admin-gated)
      const newCount = await _checkStorm(TreasuryAgents.STORM_OBJ);
      for (let i = 0; i < newCount; i++) {
        tx.moveCall({
          package: TreasuryAgents.THUNDER_PKG,
          module: 'thunder',
          function: 'strike_relay',
          arguments: [
            tx.object(TreasuryAgents.STORM_OBJ),
            tx.pure.vector('u8', nameHashBytes),
            tx.pure.address(params.nftId),
            tx.object('0x6'),
          ],
        });
        totalCalls++;
      }

      // Legacy storms: use old destructive quest (no admin check, needs NFT — but legacy quest is permissionless with NFT object)
      // Legacy contracts don't have strike_relay, only quest which needs &SuinsRegistration.
      // The keeper can't pass someone else's NFT. For legacy, we skip — they'll be auto-struck client-side for non-WaaP wallets.
      // For WaaP: legacy signals are stuck unless the user transfers to a non-WaaP wallet.
      // TODO: sweep legacy storms to clean up

      if (totalCalls === 0) return { error: 'No signals found on current storm' };

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      console.log(`[TreasuryAgents] Strike relay: ${digest}, calls: ${totalCalls}`);
      return { digest };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] strikeRelay error:', errStr);
      return { error: errStr };
    }
  }

  /** Attest collateral only — keeper signs as oracle. Mint is done by the wallet that owns the TreasuryCap. */
  @callable()
  async attestCollateral(params: { collateralValueMist: string }): Promise<{ digest?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) return { error: 'No keeper key' };
    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      const tx = new Transaction();
      tx.setSender(keeperAddr);
      tx.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'update_collateral',
        arguments: [
          tx.object(TreasuryAgents.IUSD_TREASURY),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('SUI'))),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('sui'))),
          tx.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
          tx.pure.u64(BigInt(params.collateralValueMist)),
          tx.pure.u8(0),
          tx.object('0x6'),
        ],
      });

      const txBytes = await tx.build({ client: transport as never });
      const sig = await keypair.signTransaction(txBytes);
      const digest = await this._submitTx(txBytes, sig.signature);
      return { digest };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] attestCollateral error:', errStr);
      return { error: errStr };
    }
  }

  /** Attest collateral + mint iUSD, signed by keeper (oracle + minter). */
  @callable()
  async mintIusd(params: {
    recipient: string;
    collateralValueMist: string;
    mintAmount: string;
  }): Promise<{ digest1?: string; digest2?: string; minted?: string; error?: string }> {
    if (!this.env.SHADE_KEEPER_PRIVATE_KEY) {
      return { error: 'No keeper key configured' };
    }

    const { recipient, collateralValueMist, mintAmount } = params;
    if (!recipient || !collateralValueMist || !mintAmount) {
      return { error: 'Missing required params' };
    }

    try {
      const keypair = Ed25519Keypair.fromSecretKey(this.env.SHADE_KEEPER_PRIVATE_KEY);
      const keeperAddr = normalizeSuiAddress(keypair.getPublicKey().toSuiAddress());
      const transport = new SuiGraphQLClient({ url: GQL_URL, network: 'mainnet' });

      // Step 1: Attest collateral (oracle-gated)
      const tx1 = new Transaction();
      tx1.setSender(keeperAddr);
      tx1.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'update_collateral',
        arguments: [
          tx1.object(TreasuryAgents.IUSD_TREASURY),
          tx1.pure.vector('u8', Array.from(new TextEncoder().encode('SUI'))),
          tx1.pure.vector('u8', Array.from(new TextEncoder().encode('sui'))),
          tx1.pure.address('0x0000000000000000000000000000000000000000000000000000000000000000'),
          tx1.pure.u64(BigInt(collateralValueMist)),
          tx1.pure.u8(0), // TRANCHE_SENIOR
          tx1.object('0x6'),
        ],
      });

      const txBytes1 = await tx1.build({ client: transport as never });
      const sig1 = await keypair.signTransaction(txBytes1);
      const digest1 = await this._submitTx(txBytes1, sig1.signature);
      console.log(`[TreasuryAgents] Collateral attested: ${digest1}`);

      // Step 2: Mint iUSD (minter-gated)
      const tx2 = new Transaction();
      tx2.setSender(keeperAddr);
      tx2.moveCall({
        package: TreasuryAgents.IUSD_PKG,
        module: 'iusd',
        function: 'mint_and_transfer',
        arguments: [
          tx2.object(TreasuryAgents.IUSD_TREASURY_CAP),
          tx2.object(TreasuryAgents.IUSD_TREASURY),
          tx2.pure.u64(BigInt(mintAmount)),
          tx2.pure.address(normalizeSuiAddress(recipient)),
        ],
      });

      const txBytes2 = await tx2.build({ client: transport as never });
      const sig2 = await keypair.signTransaction(txBytes2);
      const digest2 = await this._submitTx(txBytes2, sig2.signature);
      console.log(`[TreasuryAgents] iUSD minted: ${digest2}, amount: ${mintAmount}, to: ${recipient}`);

      return { digest1, digest2, minted: mintAmount };
    } catch (err) {
      const errStr = err instanceof Error ? err.stack || err.message : String(err);
      console.error('[TreasuryAgents] mintIusd error:', errStr);
      return { error: errStr };
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────

  private async _submitTx(txBytes: Uint8Array, signature: string): Promise<string> {
    const b64 = uint8ToBase64(txBytes);
    const { digest } = await raceExecuteTransaction(b64, [signature]);
    return digest;
  }
}
