// =============================================================================
// Minimal JWT (HS256) sign/verify using only node:crypto — no external deps.
// Used for REST Authorization: Bearer <jwt> AND for WebSocket authentication
// passed as a query-string parameter on the upgrade request: /ws?token=<jwt>
// (standard approach because WS handshakes cannot reliably carry HTTP headers).
// =============================================================================
import crypto from 'node:crypto';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function signature(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

export function signJwt(payload, ttlSeconds = 60 * 60 * 24 * 7) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64u(JSON.stringify(body))}`;
  return `${data}.${signature(data)}`;
}

export function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = signature(data);
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
