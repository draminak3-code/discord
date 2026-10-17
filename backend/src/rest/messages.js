// =============================================================================
// REST: message send/edit/delete, reactions, replies/threads, webhooks & uploads.
// The REST API is the ONLY component that persists data; afterwards it publishes
// events to Redis (`channel:<id>`), and gateway WS nodes fan them out live.
// =============================================================================
import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { snowflake } from '../lib/snowflake.js';
import { publish } from '../cache/redis.js';
import { P, has } from '../config/permissions.js';
import { memberPermsInChannel } from './guilds.js';
import { rateLimitSend } from './middleware.js';

export const messageRouter = Router();   // mounted at /api/channels/:channel_id/messages
export const miscRouter = Router();      // webhooks + uploads

const serializeMsg = (m) => ({
  id: m.id, channel_id: m.channel_id, author_id: m.author_id, content: m.content,
  embeds: m.embeds, message_reference: m.message_reference, pinned: m.pinned,
  timestamp: m.timestamp, edited_timestamp: m.edited_timestamp,
  attachments: db.find('attachments', (a) => a.message_id === m.id),
  reactions: db.tables.reactions.filter((r) => r.message_id === m.id)
    .reduce((acc, r) => ((acc[r.emoji] = (acc[r.emoji] || 0) + 1), acc), {}),
});

// POST /api/channels/:channel_id/messages — send a message (rate-limited per route)
messageRouter.post('/', rateLimitSend, async (req, res) => {
  const channelId = req.params.channel_id;
  const channel = db.byId('channels', channelId);
  if (!channel) return res.status(404).json({ code: 10003, message: 'Unknown Channel' });

  const perms = memberPermsInChannel(channel.guild_id, req.user.uid, channelId);
  if (!has(perms, P.SEND_MESSAGES))
    return res.status(403).json({ code: 50013, message: 'Missing Permissions' });
  // implicit cascade check: ATTACH_FILES requires SEND_MESSAGES (docs §5.2)
  if ((req.body.attachments?.length) && !has(perms, P.ATTACH_FILES ?? 0n))
    return res.status(403).json({ code: 50013, message: 'Missing Attachments Permission' });

  const msg = {
    id: snowflake(), channel_id: channelId, author_id: req.user.uid,
    content: String(req.body?.content ?? '').slice(0, 2000),
    embeds: req.body?.embeds ?? [],
    message_reference: req.body?.message_reference ?? null, // reply/thread link
    pinned: false, tts: !!req.body?.tts, timestamp: Date.now(), edited_timestamp: null, deleted: false,
  };
  db.tables.messages.push(msg);
  channel.last_message_id = msg.id;
  for (const att of req.body?.attachments ?? []) {
    const a = db.byId('attachments', att.id);
    if (a) a.message_id = msg.id;
  }

  // Persisted → now publish for realtime distribution (gateway never writes DB)
  await publish(`channel:${channelId}`, { t: 'MESSAGE_CREATE', d: serializeMsg(msg) });
  if (channel.guild_id) await publish(`guild:${channel.guild_id}`, { t: 'MESSAGE_CREATE', d: serializeMsg(msg) });
  res.status(201).json(serializeMsg(msg));
});

// PATCH /api/channels/:channel_id/messages/:message_id
messageRouter.patch('/:message_id', async (req, res) => {
  const msg = db.tables.messages.find((m) => m.id === req.params.message_id && !m.deleted);
  if (!msg) return res.status(404).json({ code: 10008, message: 'Unknown Message' });
  if (msg.author_id !== req.user.uid) return res.status(403).json({ message: 'Cannot edit others messages' });
  msg.content = String(req.body?.content ?? msg.content).slice(0, 2000);
  msg.edited_timestamp = Date.now();
  await publish(`channel:${msg.channel_id}`, { t: 'MESSAGE_UPDATE', d: serializeMsg(msg) });
  res.json(serializeMsg(msg));
});

// DELETE /api/channels/:channel_id/messages/:message_id
messageRouter.delete('/:message_id', async (req, res) => {
  const msg = db.tables.messages.find((m) => m.id === req.params.message_id && !m.deleted);
  if (!msg) return res.status(404).json({ code: 10008, message: 'Unknown Message' });
  msg.deleted = true;
  await publish(`channel:${msg.channel_id}`, { t: 'MESSAGE_DELETE', d: { id: msg.id, channel_id: msg.channel_id } });
  res.status(204).end();
});

// PUT /api/channels/:channel_id/messages/:message_id/reactions/:emoji/@me
messageRouter.put('/:message_id/reactions/:emoji/@me', async (req, res) => {
  const { message_id, emoji } = req.params;
  const exists = db.tables.reactions.find(
    (r) => r.message_id === message_id && r.user_id === req.user.uid && r.emoji === emoji);
  if (exists) db.tables.reactions.splice(db.tables.reactions.indexOf(exists), 1);
  else db.tables.reactions.push({ message_id, user_id: req.user.uid, emoji, created_at: Date.now() });
  await publish(`channel:${req.params.channel_id}`, {
    t: exists ? 'MESSAGE_REACTION_REMOVE' : 'MESSAGE_REACTION_ADD',
    d: { message_id, user_id: req.user.uid, emoji },
  });
  res.status(204).end();
});

// GET history (also available here; canonical path is /api/channels/:id/messages?limit=100)
messageRouter.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  res.json(db.messagesForChannel(req.params.channel_id, { limit, before: req.query.before }).map(serializeMsg));
});

// ---------------------------------------------------------------------------
// Webhooks: one-way HTTP endpoints (POST only). Bots instead keep a WS session.
// Signature verification mirrors Discord's X-Signature-Ed25519 scheme (here
// implemented as HMAC-SHA256 over timestamp+body using the webhook signing key).
// ---------------------------------------------------------------------------
miscRouter.post('/webhooks/:id/:token', async (req, res) => {
  const hook = db.byId('webhooks', req.params.id);
  if (!hook || hook.token !== req.params.token)
    return res.status(404).json({ code: 10015, message: 'Unknown Webhook' });

  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];
  if (hook.signing_key && sig && ts) {
    const expected = crypto.createHmac('sha256', hook.signing_key).update(`${ts}.${JSON.stringify(req.body)}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig))))
      return res.status(401).json({ message: 'Invalid signature' });
  }

  const msg = { id: snowflake(), channel_id: hook.channel_id, author_id: hook.created_by,
    content: String(req.body?.content ?? '').slice(0, 2000), embeds: req.body?.embeds ?? [],
    message_reference: null, pinned: false, tts: false, timestamp: Date.now(),
    edited_timestamp: null, deleted: false, webhook: { id: hook.id, name: hook.name } };
  db.tables.messages.push(msg);
  await publish(`channel:${hook.channel_id}`, { t: 'MESSAGE_CREATE', d: serializeMsg(msg) });
  res.status(204).end();
});

miscRouter.post('/channels/:channel_id/webhooks', async (req, res) => {
  const perms = memberPermsInChannel(db.byId('channels', req.params.channel_id)?.guild_id, req.user.uid, req.params.channel_id);
  if (!has(perms, P.MANAGE_WEBHOOKS ?? P.MANAGE_CHANNELS))
    return res.status(403).json({ code: 50013, message: 'Missing Permissions' });
  const hook = { id: snowflake(), channel_id: req.params.channel_id, created_by: req.user.uid,
    name: String(req.body?.name || 'Webhook'), token: crypto.randomBytes(24).toString('base64url'),
    signing_key: crypto.randomBytes(32).toString('hex'), created_at: Date.now() };
  db.tables.webhooks.set(hook.id, hook);
  res.status(201).json({ ...hook, url: `/api/webhooks/${hook.id}/${hook.token}` });
});

// ---------------------------------------------------------------------------
// Uploads: media NEVER flows through the message servers. This endpoint hands
// back an object-storage id (+ direct URL). The client then sends a normal text
// message referencing attachment ids. In production the URL is a MinIO
// presigned PUT; here we accept a small base64 body into the memory store.
// ---------------------------------------------------------------------------
miscRouter.post('/uploads', (req, res) => {
  const { filename = 'file.bin', content_type = 'application/octet-stream', data_base64 } = req.body || {};
  const buf = data_base64 ? Buffer.from(data_base64, 'base64') : Buffer.alloc(0);
  if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ message: 'File too large (dev limit 8MB)' });
  const att = { id: snowflake(), message_id: null, uploader_id: req.user.uid,
    filename, size: buf.length, content_type,
    s3_key: `files/${req.user.uid}/${Date.now()}-${filename}`, thumb_key: null, created_at: Date.now() };
  db.tables.attachments.set(att.id, att);
  // In Docker mode this becomes: MinIO presigned PUT → client uploads directly.
  res.status(201).json({ ...att, url: `/media/${att.s3_key}`, presigned_put: process.env.MINIO_ENDPOINT ? `${process.env.MINIO_ENDPOINT}/...` : undefined });
});
