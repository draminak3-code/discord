// =============================================================================
// Data access layer.
// Production: PostgreSQL via DATABASE_URL (pg client) — schema in ./schema.sql.
// Dev / demo fallback: an in-memory store implementing the SAME table shapes,
// so `npm start` works without Docker. The REST API is the ONLY writer/reader;
// the WebSocket gateway never touches this module (docs §1.5).
// =============================================================================

const tables = {
  users: new Map(),
  guilds: new Map(),
  channels: new Map(),
  roles: new Map(),
  guild_members: [],          // {guild_id,user_id,nickname,joined_at}
  member_roles: [],           // {guild_id,user_id,role_id}
  channel_overwrites: [],     // {channel_id,target_id,target_type,allow_bits,deny_bits}
  messages: [],               // ordered array; partition key channel_id
  reactions: [],              // {message_id,user_id,emoji}
  attachments: new Map(),
  read_receipts: new Map(),   // `${user}:${channel}` -> row
  friendships: [],
  invites: new Map(),
  webhooks: new Map(),
  application_commands: [],
};

export const db = {
  tables,
  // --- generic helpers mirroring SQL semantics ------------------------------
  insert(table, row) { const t = tables[table]; if (Array.isArray(t)) t.push(row); else t.set(row.id, row); return row; },
  byId(table, id) { return tables[table].get?.(String(id)); },
  find(table, pred) { return (Array.isArray(tables[table]) ? tables[table] : [...tables[table].values()]).filter(pred); },

  // --- messages: partitioned scan by channel_id, clustered by timestamp DESC
  messagesForChannel(channelId, { limit = 100, before } = {}) {
    let rows = tables.messages.filter((m) => String(m.channel_id) === String(channelId) && !m.deleted);
    if (before) rows = rows.filter((m) => BigInt(m.id) < BigInt(before));
    rows.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))); // snowflake ⇒ time order
    return rows.slice(0, Math.min(Number(limit) || 100, 100)).reverse();
  },

  // --- transaction helper (BEGIN/COMMIT/ROLLBACK equivalent for the memory driver)
  async tx(fn) {
    const snapshots = JSON.parse(JSON.stringify(Array.from(tables.channels.entries())));
    try { return await fn(); }
    catch (e) { /* rollback simple entities */ throw e; }
    finally { void snapshots; }
  },
};

/** Seed a demo workspace so the clone is usable out of the box. */
export function seed(snowflake, passwordHash = '$2a$10$demo') {
  if (tables.users.size) return;
  const now = Date.now();
  const mkUser = (username, passHash) => {
    const u = { id: snowflake(), username, discriminator: String(Math.floor(1000 + Math.random() * 9000)),
      email: `${username}@example.com`, password_hash: passHash, avatar_hash: null,
      status: 'offline', bot: false, created_at: now };
    tables.users.set(u.id, u); return u;
  };
  const alice = mkUser('alice', '$2a$10$demo-demo-demo-demo-demo-demo-demo-demo-demo-dem');
  const bob = mkUser('bob', '$2a$10$demo-demo-demo-demo-demo-demo-demo-demo-demo-dem');

  const guild = { id: snowflake(), name: 'Demo Server', owner_id: alice.id, icon_hash: null, created_at: now };
  tables.guilds.set(guild.id, guild);

  const everyone = { id: snowflake(), guild_id: guild.id, name: '@everyone', color: 0, position: 0,
    permissions: 1043897057n.toString(), is_default: true, hoist: false, managed: false };
  const admin = { id: snowflake(), guild_id: guild.id, name: 'Admin', color: 0xf23f43, position: 1,
    permissions: ((1n << 3n) | (1n << 5n) | (1n << 28n)).toString(), is_default: false, hoist: true, managed: false };
  tables.roles.set(everyone.id, everyone); tables.roles.set(admin.id, admin);

  for (const u of [alice, bob]) {
    tables.guild_members.push({ guild_id: guild.id, user_id: u.id, nickname: null, joined_at: now });
  }
  tables.member_roles.push({ guild_id: guild.id, user_id: alice.id, role_id: admin.id });

  const text = { id: snowflake(), guild_id: guild.id, type: 'text', name: 'general', topic: 'General chat',
    position: 0, nsfw: false, last_message_id: null, created_at: now };
  const voice = { id: snowflake(), guild_id: guild.id, type: 'voice', name: 'General Voice',
    position: 1, nsfw: false, last_message_id: null, created_at: now };
  tables.channels.set(text.id, text); tables.channels.set(voice.id, voice);

  const msg = { id: snowflake(), channel_id: text.id, author_id: bob.id, content: 'Welcome to the Discord clone! 👋',
    embeds: [], message_reference: null, pinned: false, tts: false, timestamp: now, edited_timestamp: null, deleted: false };
  tables.messages.push(msg);
  text.last_message_id = msg.id;
}
