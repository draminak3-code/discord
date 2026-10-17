-- =============================================================================
-- Discord Clone — PostgreSQL schema (transactional / ACID store)
-- Primary keys are Twitter-style Snowflake IDs (BIGINT).
-- Indexes on every foreign key for high-throughput lookups.
-- NOTE: at massive scale, `messages` migrates to a wide-column store
-- (ScyllaDB/Cassandra) partitioned by channel_id — see docs/TECH_PROMPT.md §2.2.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT PRIMARY KEY,                 -- snowflake
  username      TEXT NOT NULL UNIQUE,
  discriminator TEXT NOT NULL DEFAULT '0',
  email         TEXT UNIQUE,
  password_hash TEXT NOT NULL,                      -- bcrypt
  avatar_hash   TEXT,
  status        TEXT NOT NULL DEFAULT 'offline'
                CHECK (status IN ('online','idle','dnd','invisible','offline')),
  bot           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guilds (
  id          BIGINT PRIMARY KEY,                   -- snowflake
  name        TEXT NOT NULL,
  owner_id    BIGINT NOT NULL REFERENCES users(id),
  icon_hash   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_guilds_owner ON guilds(owner_id);

CREATE TABLE IF NOT EXISTS channels (
  id          BIGINT PRIMARY KEY,                   -- snowflake
  guild_id    BIGINT REFERENCES guilds(id) ON DELETE CASCADE,  -- NULL = DM channel
  type        TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','voice','category','dm','group_dm')),
  name        TEXT NOT NULL,
  topic       TEXT,
  position    INT  NOT NULL DEFAULT 0,
  nsfw        BOOLEAN NOT NULL DEFAULT FALSE,
  last_message_id BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_channels_guild ON channels(guild_id);

-- Roles carry a 53-bit permission bitfield in `permissions`.
CREATE TABLE IF NOT EXISTS roles (
  id          BIGINT PRIMARY KEY,                   -- snowflake
  guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       INT NOT NULL DEFAULT 0,
  position    INT NOT NULL DEFAULT 1,               -- hierarchy: lower number ⇒ higher rank
  permissions BIGINT NOT NULL DEFAULT 1043897057,   -- @everyone default bitfield
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,       -- the @everyone role
  hoist       BOOLEAN NOT NULL DEFAULT FALSE,
  managed     BOOLEAN NOT NULL DEFAULT FALSE        -- bot/integration roles cannot be edited
);
CREATE INDEX IF NOT EXISTS idx_roles_guild ON roles(guild_id);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname    TEXT,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON guild_members(user_id);

CREATE TABLE IF NOT EXISTS member_roles (
  guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_member_roles_user ON member_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_member_roles_role ON member_roles(role_id);

-- Permission overwrites on channels (for @everyone, roles, or specific members).
CREATE TABLE IF NOT EXISTS channel_overwrites (
  channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id   BIGINT NOT NULL,                      -- role_id or user_id
  target_type TEXT NOT NULL CHECK (target_type IN ('role','member','everyone')),
  allow_bits  BIGINT NOT NULL DEFAULT 0,
  deny_bits   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_id)
);

-- Messages. Sharded/partitioned by channel_id to avoid hot partitions when
-- this table grows into billions of rows (or moved to ScyllaDB verbatim).
CREATE TABLE IF NOT EXISTS messages (
  id            BIGINT PRIMARY KEY,                 -- snowflake (time-sortable)
  channel_id    BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id     BIGINT NOT NULL REFERENCES users(id),
  content       TEXT NOT NULL DEFAULT '',
  embeds        JSONB NOT NULL DEFAULT '[]',
  message_reference JSONB,                          -- reply/thread linkage {message_id, channel_id}
  pinned        BOOLEAN NOT NULL DEFAULT FALSE,
  tts           BOOLEAN NOT NULL DEFAULT FALSE,
  timestamp     BIGINT NOT NULL,                    -- ms since epoch (clustering key in C*)
  edited_timestamp BIGINT,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

-- Attachment metadata only — bytes live in MinIO (S3-compatible object store).
CREATE TABLE IF NOT EXISTS attachments (
  id          BIGINT PRIMARY KEY,                   -- snowflake file id
  message_id  BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  uploader_id BIGINT NOT NULL REFERENCES users(id),
  filename    TEXT NOT NULL,
  size        BIGINT NOT NULL,
  content_type TEXT,
  s3_key      TEXT NOT NULL,                        -- path inside the MinIO bucket
  thumb_key   TEXT,                                 -- generated by the sharp worker service
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- Read receipts & unread counters (hot ephemeral mirror lives in Redis HASH).
CREATE TABLE IF NOT EXISTS read_receipts (
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id      BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_msg_id BIGINT NOT NULL,
  mention_count   INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS friendships (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','blocked')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);

CREATE TABLE IF NOT EXISTS invites (
  code        TEXT PRIMARY KEY,
  guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id  BIGINT REFERENCES channels(id) ON DELETE CASCADE,
  inviter_id  BIGINT REFERENCES users(id),
  max_uses    INT,
  uses        INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ
);

-- One-way HTTP webhooks (distinct from bots which hold a WS gateway session).
CREATE TABLE IF NOT EXISTS webhooks (
  id          BIGINT PRIMARY KEY,
  channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_by  BIGINT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL DEFAULT 'Webhook',
  token       TEXT NOT NULL,                        -- secret proving request authenticity
  signing_key TEXT,                                 -- Ed25519 verify of X-Signature-* headers
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Slash / User / Message command registrations for bots.
CREATE TABLE IF NOT EXISTS application_commands (
  id          BIGINT PRIMARY KEY,
  application_id BIGINT NOT NULL,                  -- bot user id
  guild_id    BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'chat_input' CHECK (type IN ('chat_input','user','message')),
  name        TEXT NOT NULL,
  description TEXT,
  options     JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (id)
);

COMMIT;
