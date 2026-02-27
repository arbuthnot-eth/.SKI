import { AgentClient } from 'agents/client';
import type { SplashDeviceState } from '../server/agents/splash.js';

let client: AgentClient<SplashDeviceState> | null = null;
let currentVisitorId: string | null = null;

function getClient(visitorId: string): AgentClient<SplashDeviceState> {
  if (client && currentVisitorId === visitorId) return client;
  if (client) { try { client.close(); } catch { /* ignore */ } }
  currentVisitorId = visitorId;
  client = new AgentClient<SplashDeviceState>({
    host: window.location.host,
    agent: 'splash-device-agent',
    name: visitorId,
  });
  return client;
}

export async function checkDeviceSplash(visitorId: string): Promise<boolean> {
  try {
    const c = getClient(visitorId);
    const result = await c.call<{ isSplashSponsor: boolean }>('check', []);
    return result.isSplashSponsor;
  } catch {
    return false;
  }
}

export async function activateDeviceSplash(visitorId: string, address: string): Promise<boolean> {
  try {
    const c = getClient(visitorId);
    const result = await c.call<{ success: boolean }>('activate', [{ address }]);
    return result.success;
  } catch {
    return false;
  }
}
