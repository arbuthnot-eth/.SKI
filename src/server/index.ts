import { Hono } from 'hono';
import { agentsMiddleware } from 'hono-agents';

const app = new Hono();

// Agents middleware handles WebSocket upgrades and RPC to /agents/*
app.use('/agents/*', agentsMiddleware());

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', version: '2.0.0' }));

export default app;

// Export Durable Object classes for Wrangler binding
export { SessionAgent } from './agents/session.js';
export { SponsorAgent } from './agents/sponsor.js';
export { SplashDeviceAgent } from './agents/splash.js';
export { ShadeExecutorAgent } from './agents/shade-executor.js';
