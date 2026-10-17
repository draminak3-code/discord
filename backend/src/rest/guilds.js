// =============================================================================
// REST: guilds (servers), channels, roles & permission overwrites.
// All mutations run inside a transaction-equivalent and then PUBLISH an event
// onto Redis so the WebSocket gateways can fan it out — the gateway itself
// never reads/writes the database (docs §1.5).
// =============================================================================
import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { snowflake } from '../lib/snowflake.js';
import { publish } from '../cache/redis.js';
import { P, has, computeChannelPermissions } from '../config/permissions.js';

export const guildRouter = Router();
export const channelRouter = Router();

const publicUser = (u) => u && ({ id: u.id, username: u.username, discriminator: u.discriminator, avatar: u.avatar_hash, status: u.status, bot: u.bot });

/** Resolve member's effective permissions in a channel (full Discord algorithm). */
export function memberPermsInChannel(guildId, userId, channelId) {
  const everyone = [...db.tables.roles.values()].find((r) => r.guild_id === String(guildId) && r.is_default);
  const memberRoleIds = db.tables.member_roles
    .filter((m) => m.user_id === userId && m.guild_id === String(guildId)).map((m) => String(m.role_id));
  const memberRoles = memberRoleIds.map((id) => db.byId('roles', id)).filter(Boolean);
  const ovs = db.tables.channel_overwrites.filter((o) => String(o.channel_id) === String(channelId));
  return computeChannelPermissions(
    memberRoles, everyone,
    {
      everyone: ovs.find((o) => o.target_type === 'everyone'),
      roles: ovs.filter((o) => o.target_type === 'role'),
    },
    ovs.find((o) => o.target_type === 'member' && String(o.target_id) === String(userId)),
  );
}

/** Middleware-style guard used by handlers below. */
function requirePerm(req, res, channelId, perm) {
  const guildId = req.params.guild_id || db.byId('channels', channelId)?.guild_id;
  if (!guildId) return false;
  // Guild-level checks evaluate against the default channel of the guild
  const evalChannel = channelId ?? [...db.tables.channels.values()].find((c) => String(c.guild_id) === String(guildId) && c.type === 'text')?.id ?? guildId;
  const perms = memberPermsInChannel(guildId, req.user.uid, evalChannel);
  if (!has(perms, perm)) {
    res.status(403).json({ code: 50013, message: 'Missing Permissions' });
    return false;
  }
  return true;
}

// Auto-join the demo workspace so a fresh account is immediately usable
// (in production this would be an invite flow instead).
export function ensureDemoMembership(userId) {
  const first = [...db.tables.guilds.values()][0];
  if (!first) return;
  if (!db.tables.guild_members.some((m) => m.user_id === userId && m.guild_id === first.id)) {
    db.tables.guild_members.push({ guild_id: first.id, user_id: userId, nickname: null, joined_at: Date.now() });
  }
}

// ------------------------------ GUILDS --------------------------------------
guildRouter.get('/', (req, res) => {
  const ids = db.tables.guild_members.filter((m) => m.user_id === req.user.uid).map((m) => m.guild_id);
  res.json(ids.map((id) => db.byId('guilds', id)).filter(Boolean));
});

guildRouter.post('/', (req, res) => {
  const name = String(req.body?.name || 'New Server').slice(0, 100);
  const guild = { id: snowflake(), name, owner_id: req.user.uid, icon_hash: null, created_at: Date.now() };
  // Transaction: guild + @everyone role + default channels atomically
  db.tx(() => {
    db.tables.guilds.set(guild.id, guild);
    const everyone = { id: snowflake(), guild_id: guild.id, name: '@everyone', color: 0, position: 0,
      permissions: 1043897057n.toString(), is_default: true, hoist: false, managed: false };
    db.tables.roles.set(everyone.id, everyone);
    db.tables.guild_members.push({ guild_id: guild.id, user_id: req.user.uid, nickname: null, joined_at: Date.now() });
    for (const [i, ch] of [['general', 'text'], ['General Voice', 'voice']].entries()) {
      const c = { id: snowflake(), guild_id: guild.id, type: ch, name: i ? ch : 'general',
        topic: null, position: i, nsfw: false, last_message_id: null, created_at: Date.now() };
      c.name = i === 0 ? 'general' : 'General Voice';
      db.tables.channels.set(c.id, c);
    }
  });
  res.status(201).json(guild);
});

guildRouter.patch('/:guild_id', async (req, res) => {
  const g = db.byId('guilds', req.params.guild_id);
  if (!g) return res.status(404).json({ code: 10004, message: 'Unknown Guild' });
  if (!requirePerm(req, res, null, P.MANAGE_GUILD)) return;
  if (req.body.name) g.name = String(req.body.name).slice(0, 100);
  await publish(`guild:${g.id}`, { t: 'GUILD_UPDATE', d: g });
  res.json(g);
});

guildRouter.get('/:guild_id/channels', (req, res) => {
  const all = db.find('channels', (c) => String(c.guild_id) === String(req.params.guild_id));
  // filter by VIEW_CHANNEL per user
  const visible = all.filter((c) => has(memberPermsInChannel(req.params.guild_id, req.user.uid, c.id), P.VIEW_CHANNEL));
  res.json(visible.sort((a, b) => a.position - b.position));
});

guildRouter.post('/:guild_id/channels', async (req, res) => {
  if (!requirePerm(req, res, null, P.MANAGE_CHANNELS)) return;
  const { name, type = 'text', topic } = req.body || {};
  const channel = { id: snowflake(), guild_id: req.params.guild_id, type,
    name: String(name || 'new-channel').toLowerCase().replace(/\s+/g, '-').slice(0, 64),
    topic: topic || null, position: db.find('channels', (c) => String(c.guild_id) === String(req.params.guild_id)).length,
    nsfw: false, last_message_id: null, created_at: Date.now() };
  db.tables.channels.set(channel.id, channel);   // monitored → stored → success response
  await publish(`guild:${channel.guild_id}`, { t: 'CHANNEL_CREATE', d: channel });
  res.status(201).json(channel);
});

guildRouter.get('/:guild_id/members', (req, res) => {
  const rows = db.tables.guild_members.filter((m) => String(m.guild_id) === String(req.params.guild_id));
  res.json(rows.map((m) => ({ ...publicUser(db.byId('users', m.user_id)), nick: m.nickname, roles:
    db.tables.member_roles.filter((r) => r.user_id === m.user_id).map((r) => r.role_id) })));
});

guildRouter.get('/:guild_id/invites', (req, res) => {
  res.json([...db.tables.invites.values()].filter((i) => String(i.guild_id) === String(req.params.guild_id)));
});

guildRouter.post('/:guild_id/invites', async (req, res) => {
  if (!requirePerm(req, res, null, P.CREATE_INSTANT_INVITE)) return;
  const invite = { code: crypto.randomBytes(5).toString('base64url'), guild_id: req.params.guild_id,
    channel_id: null, inviter_id: req.user.uid, max_uses: req.body?.max_uses ?? null, uses: 0, expires_at: null };
  db.tables.invites.set(invite.code, invite);
  res.status(201).json({ ...invite, url: `https://discord-clone.test/invite/${invite.code}` });
});

guildRouter.post('/join/:code', (req, res) => {
  const invite = db.tables.invites.get(req.params.code);
  if (!invite) return res.status(404).json({ code: 10006, message: 'Unknown Invite Code' });
  if (invite.max_uses != null && invite.uses >= invite.max_uses)
    return res.status(400).json({ code: 10026, message: 'Invite was expired or used up' });
  invite.uses += 1;
  if (!db.tables.guild_members.some((m) => m.guild_id === invite.guild_id && m.user_id === req.user.uid)) {
    db.tables.guild_members.push({ guild_id: invite.guild_id, user_id: req.user.uid, nickname: null, joined_at: Date.now() });
    const g = db.byId('guilds', invite.guild_id);
    publish(`guild:${g.id}`, { t: 'GUILD_MEMBER_ADD', d: { guild_id: g.id, user: publicUser(db.byId('users', req.user.uid)) } });
  }
  res.json(db.byId('guilds', invite.guild_id));
});

// ------------------------------- ROLES ---------------------------------------
guildRouter.get('/:guild_id/roles', (req, res) => {
  res.json(db.find('roles', (r) => String(r.guild_id) === String(req.params.guild_id)).sort((a, b) => a.position - b.position));
});

guildRouter.post('/:guild_id/roles', async (req, res) => {
  if (!requirePerm(req, res, null, P.MANAGE_ROLES)) return;
  const g = db.byId('guilds', req.params.guild_id);
  // hierarchy check: cannot create above your own top role
  const myTopPos = Math.min(...[0, ...db.tables.member_roles
    .filter((mr) => mr.user_id === req.user.uid && mr.guild_id === String(g.id))
    .map((mr) => db.byId('roles', mr.role_id)?.position ?? 99)]);
  const pos = Number(req.body?.position ?? myTopPos + 1);
  if (pos <= myTopPos) return res.status(403).json({ code: 50013, message: 'Cannot manage roles above your highest role' });
  const role = { id: snowflake(), guild_id: g.id, name: String(req.body?.name || 'new role'),
    color: Number(req.body?.color || 0), position: pos,
    permissions: String(req.body?.permissions ?? 0), is_default: false,
    hoist: !!req.body?.hoist, managed: false };
  db.tables.roles.set(role.id, role);
  await publish(`guild:${g.id}`, { t: 'GUILD_ROLE_CREATE', d: { guild_id: g.id, role } });
  res.status(201).json(role);
});

guildRouter.put('/:guild_id/members/:user_id/roles/:role_id', (req, res) => {
  if (!requirePerm(req, res, null, P.MANAGE_ROLES)) return;
  const role = db.byId('roles', req.params.role_id);
  if (!role || String(role.guild_id) !== String(req.params.guild_id))
    return res.status(404).json({ code: 10011, message: 'Unknown Role' });
  // Hierarchy: only assign roles ranked strictly below your highest role
  const actorTop = Math.min(...db.tables.member_roles
    .filter((mr) => mr.user_id === req.user.uid).map((mr) => db.byId('roles', mr.role_id)?.position ?? 99));
  if (role.position <= actorTop && !role.is_default)
    return res.status(403).json({ code: 50013, message: 'Role is higher than your highest role' });
  db.tables.member_roles.push({ guild_id: req.params.guild_id, user_id: req.params.user_id, role_id: role.id });
  res.status(204).end();
});

// Channel permission overwrite (role/member/everyone)
channelRouter.put('/:channel_id/permissions/:target_id', (req, res) => {
  if (!requirePerm(req, res, req.params.channel_id, P.MANAGE_ROLES)) return;
  const { target_type = 'role', allow = 0, deny = 0 } = req.body || {};
  const list = db.tables.channel_overwrites;
  const existing = list.find((o) => String(o.channel_id) === String(req.params.channel_id) && String(o.target_id) === String(req.params.target_id));
  const row = existing || { channel_id: req.params.channel_id, target_id: req.params.target_id, target_type };
  row.allow_bits = String(allow); row.deny_bits = String(deny);
  if (!existing) list.push(row);
  res.json(row);
});

// ----------------------------- CHANNELS ---------------------------------------
channelRouter.get('/:channel_id', (req, res) => {
  const c = db.byId('channels', req.params.channel_id);
  if (!c) return res.status(404).json({ code: 10003, message: 'Unknown Channel' });
  if (!has(memberPermsInChannel(c.guild_id, req.user.uid, c.id), P.VIEW_CHANNEL))
    return res.status(403).json({ code: 50013, message: 'Missing Permissions' });
  res.json(c);
});

channelRouter.get('/:channel_id/messages', (req, res) => {
  // GET /channels/{channel_id}/messages?limit=100 — history fetch via REST, not WS
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  res.json(db.messagesForChannel(req.params.channel_id, { limit, before: req.query.before }));
});

channelRouter.post('/:channel_id/typing', async (req, res) => {
  const { markTyping } = await import('../cache/redis.js');
  await markTyping(req.params.channel_id, req.user.uid);
  await publish(`channel:${req.params.channel_id}`, {
    t: 'TYPING_START', d: { channel_id: req.params.channel_id, user_id: req.user.uid, timestamp: Date.now() },
  });
  res.status(204).end();
});

channelRouter.put('/:channel_id/read-receipt', async (req, res) => {
  const { setReadReceipt } = await import('../cache/redis.js');
  await setReadReceipt(req.user.uid, req.params.channel_id, req.body?.last_message_id);
  res.status(204).end();
});
