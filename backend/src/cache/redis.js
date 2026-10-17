// =============================================================================
// Redis layer: ephemeral state + Pub/Sub message bus between gateway nodes.
//   • presence  : HASH presence:user:<uid> {status, game} + SET presence:online
//   • typing    : ZSET typing:<channel_id> (score = expiry ms, ~10s TTL)
//   • receipts  : HASH reads:<user_id> field channel_id -> last_read_msg_id
//   • pub/sub   : PUBLISH channel:<id> | guild:<id> | user:<id>
// If REDIS_URL is unreachable (dev mode), a same-process in-memory bus keeps
// the architecture semantics identical so the app still runs end-to-end.
// =============================================================================
import { EventEmitter } from 'node:events';

const localBus = new EventEmitter();
localBus.setMaxListeners(0);

let redis = null;           // real client when available
let subRedis = null;        // dedicated subscriber connection

/** Connect using node-redis if installed & REDIS_URL set; else memory fallback. */
export async function connectRedis(url = process.env.REDIS_URL) {
  if (!url) return fallbackInfo('REDIS_URL not set — using in-memory bus');
  try {
    const mod = await import('redis').catch(() => null);
    if (!mod) return fallbackInfo('node-redis not installed — using in-memory bus');
    redis = mod.createClient({ url });
    subRedis = redis.duplicate();
    await Promise.all([redis.connect(), subRedis.connect()]);
    return { mode: 'redis' };
  } catch (e) {
    return fallbackInfo(`redis unavailable (${e.message}) — using in-memory bus`);
  }
}

let fallbackNote = null;
function fallbackInfo(note) { fallbackNote = note; return { mode: 'memory', note }; }
export function redisMode() { return redis ? 'redis' : `memory${fallbackNote ? ` (${fallbackNote})` : ''}`; }

// ---------------------------------------------------------------------------
// Pub/Sub fan-out — every gateway instance subscribes; REST publishes AFTER
// persisting to the DB. Gateway servers never write to the database directly.
// ---------------------------------------------------------------------------
export async function publish(channelKey, eventObj) {
  const payload = JSON.stringify(eventObj);
  if (redis) await redis.publish(channelKey, payload);
  else localBus.emit(channelKey, payload);
}

export async function subscribe(channelKey, handler) {
  if (subRedis) {
    await subRedis.subscribe(channelKey, (msg) => handler(JSON.parse(msg)));
  } else {
    localBus.on(channelKey, (raw) => handler(JSON.parse(raw)));
  }
}

// ---------------------------------------------------------------------------
// Ephemeral state helpers (rebuilt naturally from live WS connections on restart)
// ---------------------------------------------------------------------------
export async function setPresence(userId, status, game = null) {
  const key = `presence:user:${userId}`;
  if (redis) {
    await redis.hSet(key, { status, game: game ? JSON.stringify(game) : '' });
    if (status === 'offline') await redis.sRem('presence:online', userId);
    else await redis.sAdd('presence:online', userId);
  } else {
    memPresence.set(String(userId), { status, game });
  }
}

const memPresence = new Map();
export async function getPresence(userId) {
  if (redis) {
    const h = await redis.hGetAll(`presence:user:${userId}`);
    return Object.keys(h).length ? { status: h.status, game: h.game ? JSON.parse(h.game) : null } : null;
  }
  return memPresence.get(String(userId)) ?? null;
}

/** Typing indicator: mark user typing in channel for ~10 seconds. */
export async function markTyping(channelId, userId) {
  const key = `typing:${channelId}`;
  const expiry = Date.now() + 10_000;
  if (redis) await redis.zAdd(key, { score: expiry, value: String(userId) }, { GT: true });
  else (memTyping.get(String(channelId)) ?? memTyping.set(String(channelId), new Map()).get(String(channelId))).set(String(userId), expiry);
}
const memTyping = new Map();
export async function activeTypers(channelId) {
  const key = `typing:${channelId}`;
  const now = Date.now();
  if (redis) {
    await redis.zRemRangeByScore(key, 0, now);
    return redis.zRange(key, 0, -1);
  }
  const m = memTyping.get(String(channelId));
  if (!m) return [];
  for (const [u, exp] of m) if (exp < now) m.delete(u);
  return [...m.keys()];
}

/** Read receipt (last read message id per channel) + unread badge count mirror. */
export async function setReadReceipt(userId, channelId, lastMessageId) {
  if (redis) await redis.hSet(`reads:${userId}`, String(channelId), String(lastMessageId));
  else (memReads.get(String(userId)) ?? memReads.set(String(userId), new Map()).get(String(userId))).set(String(channelId), String(lastMessageId));
}
const memReads = new Map();
export async function getReadReceipt(userId, channelId) {
  if (redis) return redis.hGet(`reads:${userId}`, String(channelId));
  return memReads.get(String(userId))?.get(String(channelId)) ?? null;
}
