/**
 * Chronicom — per-wallet Thunder Timestream signal watcher.
 *
 * Caches unread message counts per SuiNS name.
 * Counts are updated by the Timestream transport (push model)
 * instead of polling on-chain Storm dynamic fields.
 *
 * Auto-sleeps after 2 minutes of inactivity.
 */

import { Agent } from 'agents';

const ALARM_INTERVAL_MS = 5_000;
const INACTIVITY_TIMEOUT_MS = 120_000;

interface ChronicomState {
  counts: Record<string, number>;
  names: string[];
  lastPollMs: number;
  alarmActive: boolean;
}

interface Env {
  [key: string]: unknown;
}

export class Chronicom extends Agent<Env, ChronicomState> {
  initialState: ChronicomState = {
    counts: {},
    names: [],
    lastPollMs: 0,
    alarmActive: false,
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

    // POST /increment — Timestream transport pushes new message notifications
    if (request.method === 'POST' && (url.pathname.endsWith('/increment') || url.searchParams.has('increment'))) {
      const body = await request.json() as { name?: string; count?: number };
      if (body.name) {
        const bare = body.name.toLowerCase().replace(/\.sui$/, '');
        const counts = { ...this.state.counts };
        counts[bare] = (counts[bare] ?? 0) + (body.count ?? 1);
        this.setState({ ...this.state, counts });
      }
      return Response.json({ ok: true });
    }

    // POST /clear — mark messages as read for a name
    if (request.method === 'POST' && (url.pathname.endsWith('/clear') || url.searchParams.has('clear'))) {
      const body = await request.json() as { name?: string };
      if (body.name) {
        const bare = body.name.toLowerCase().replace(/\.sui$/, '');
        const counts = { ...this.state.counts };
        counts[bare] = 0;
        this.setState({ ...this.state, counts });
      }
      return Response.json({ ok: true });
    }

    // GET /poll — register watched names, return current counts
    if (url.pathname.endsWith('/poll') || url.searchParams.has('poll')) {
      const namesParam = url.searchParams.get('names') || '';
      const names = namesParam.split(',').map(n => n.toLowerCase().replace(/\.sui$/, '').trim()).filter(Boolean);

      if (names.length > 0) {
        this.setState({ ...this.state, names, lastPollMs: Date.now() });
      } else {
        this.setState({ ...this.state, lastPollMs: Date.now() });
      }

      if (!this.state.alarmActive && this.state.names.length > 0) {
        this.setState({ ...this.state, alarmActive: true });
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }

      return Response.json(this.state.counts);
    }

    return Response.json(this.state.counts);
  }

  private async _tick(): Promise<void> {
    const { lastPollMs, names } = this.state;

    if (Date.now() - lastPollMs > INACTIVITY_TIMEOUT_MS || names.length === 0) {
      this.setState({ ...this.state, alarmActive: false });
      return;
    }

    // Keep alarm alive for clients polling
    this.setState({ ...this.state, alarmActive: true });
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }
}
