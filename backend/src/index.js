// =============================================================================
// Discord Clone backend entrypoint — hybrid server:
//   • Express REST API  (only component that touches the database)
//   • ws WebSocket Gateway at /ws?token=<jwt> (relay-only, scales horizontally
//     via Redis pub/sub fan-out)
//   • healthcheck endpoint for Docker HEALTHCHECK / nginx upstream probes
// =============================================================================
import http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { db, seed } from './db/index.js';
import { snowflake } from './lib/snowflake.js';
import { connectRedis, redisMode } from './cache/redis.js';
import { authRouter, usersRouter } from './rest/auth.js';
import { guildRouter, channelRouter } from './rest/guilds.js';
import { messageRouter, miscRouter } from './rest/messages.js';
import { auth, rateLimitGlobal } from './rest/middleware.js';
import { createGateway } from './gateway/server.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ---- health -----------------------------------------------------------------
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, service: 'discord-clone-backend', bus: redisMode(), time: Date.now() }));

// ---- public REST --------------------------------------------------------------
app.use('/api/auth', authRouter);

// ---- authenticated REST (JWT bearer + global 50rps rate limit w/ X-RateLimit-* headers)
app.use('/api', auth, rateLimitGlobal);
app.use('/api/users', usersRouter);
app.use('/api/guilds', guildRouter);
app.use('/api/channels/:channel_id/messages', messageRouter);
app.use('/api/channels', channelRouter);
app.use('/api', miscRouter); // /webhooks, /uploads

// ---- 404 shaped like Discord's API errors -------------------------------------
app.use((_req, res) => res.status(404).json({ code: 0, message: '404: Not Found' }));

const server = http.createServer(app);

// ---- WebSocket gateway on the SAME port under /ws (nginx proxies it) -----------
createGateway(server);

const PORT = Number(process.env.PORT || 3000);

async function main() {
  const busInfo = await connectRedis();          // real Redis in Docker, memory fallback in dev
  seed(snowflake, await bcrypt.hash('password123', 10)); // demo workspace, alice/bob pass: password123
  server.listen(PORT, () => {
    console.log(`[backend] REST + WS gateway listening on :${PORT} | bus=${busInfo.mode ?? redisMode()}`);
    console.log(`[backend] REST base: /api  |  WS: ws://localhost:${PORT}/ws?token=<jwt>`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
