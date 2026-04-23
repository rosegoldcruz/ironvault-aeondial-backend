import "dotenv/config";
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { authRoutes } from './routes/auth.js';
import { sessionRoutes } from './routes/session.js';
import { callRoutes } from './routes/calls.js';
import { campaignRoutes } from './routes/campaigns.js';
import { telnyxWebhookRoutes } from './routes/webhooks.js';

const app = Fastify({ logger: true, bodyLimit: 52428800 });

// ── Plugins ──────────────────────────────────────────────
await app.register(cors, {
  origin: [
    process.env.FRONTEND_URL ?? 'https://crm.aeondial.com',
    'http://localhost:3000',
  ],
  credentials: true,
});

await app.register(jwt, {
  secret: process.env.JWT_SECRET ?? 'changeme',
});

// ── Auth decorator ────────────────────────────────────────
app.decorate('authenticate', async (req: any, reply: any) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.status(401).send({ error: 'Unauthorized' });
  }
});

// ── Routes ────────────────────────────────────────────────
await app.register(authRoutes, { prefix: '/auth' });
await app.register(sessionRoutes, { prefix: '/session' });
await app.register(callRoutes, { prefix: '/calls' });
await app.register(campaignRoutes, { prefix: '/campaigns' });
await app.register(telnyxWebhookRoutes, { prefix: '/webhooks' });

// ── Health ────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001);

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[AEON DIAL] API running on port ${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
