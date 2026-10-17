// =============================================================================
// REST middleware: JWT auth + Discord-style rate limiting.
// Rate limiter emits X-RateLimit-Limit / X-RateLimit-Remaining / Retry-After
// so clients can self-throttle and avoid 429 (docs §1.6).
// Global bucket: 50 req/s (same figure Discord enforces for bots) plus a
// stricter per-route bucket on message sends.
// =============================================================================
import { verifyJwt } from '../lib/jwt.js';

/** Bearer-token authentication for REST endpoints. */
export function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ code: 40001, message: 'Invalid token' });
  req.user = payload; // { uid, username, bot? }
  next();
}

class SlidingWindow {
  constructor() { this.buckets = new Map(); }
  /** returns {allowed, limit, remaining, retryAfterMs} */
  take(key, limit, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; this.buckets.set(key, b); }
    b.count += 1;
    const allowed = b.count <= limit;
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - b.count),
      retryAfterMs: allowed ? 0 : b.reset - now,
    };
  }
}

const globalBucket = new SlidingWindow();   // 50 rps per user/IP
const sendBucket = new SlidingWindow();     // 5 msg/5s per user+channel

export function rateLimitGlobal(req, res, next) {
  const key = req.user?.uid || req.ip;
  const r = globalBucket.take(key, 50, 1000);
  setHeaders(res, r);
  if (!r.allowed) return tooMany(res, r);
  next();
}

export function rateLimitSend(req, res, next) {
  const key = `${req.user?.uid}:${req.params.channel_id}`;
  const r = sendBucket.take(key, 5, 5000);
  setHeaders(res, r);
  if (!r.allowed) return tooMany(res, r);
  next();
}

function setHeaders(res, r) {
  res.set('X-RateLimit-Limit', String(r.limit));
  res.set('X-RateLimit-Remaining', String(r.remaining));
  res.set('X-RateLimit-Bucket', 'default');
}

function tooMany(res, r) {
  const secs = Math.ceil(r.retryAfterMs / 1000);
  res.set('Retry-After', String(secs));
  // 429 with Discord-shaped body incl. per-message cooldown hint
  return res.status(429).json({
    code: 429,
    message: 'You are being rate limited.',
    retry_after: secs,
    global: false,
  });
}
