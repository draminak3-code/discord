// =============================================================================
// Discord-style Permissions Bitfield (up to 53 bits, BigInt-backed).
// Each permission is a power of two; role permissions are combined with OR (|),
// checked with AND (&):  (perms & SEND_MESSAGES) === SEND_MESSAGES
// Stored in PostgreSQL column roles.permissions BIGINT.
// =============================================================================

export const P = Object.freeze({
  CREATE_INSTANT_INVITE: 1n << 0n,        // 0x00000001   value 1
  KICK_MEMBERS:          1n << 1n,        // 0x00000002   value 2
  BAN_MEMBERS:           1n << 2n,        // 0x00000004   value 4
  ADMINISTRATOR:         1n << 3n,        // 0x00000008   value 8 — overrides everything
  MANAGE_CHANNELS:       1n << 4n,        // 0x00000010
  MANAGE_GUILD:          1n << 5n,        // 0x00000020
  ADD_REACTIONS:         1n << 6n,        // 0x00000040
  VIEW_AUDIT_LOG:        1n << 7n,        // 0x00000080
  PRIORITY_SPEAKER:      1n << 8n,        // 0x00000100
  STREAM:                1n << 9n,        // 0x00000200 (screen share via WebRTC)
  VIEW_CHANNEL:          1n << 10n,       // 0x00000400 — gateway perm; denied ⇒ ALL channel perms denied
  SEND_MESSAGES:         1n << 11n,       // 0x00000800 (Discord modern layout)
  SEND_TTS_MESSAGES:     1n << 12n,
  MENTION_EVERYONE:      1n << 13n,
  USE_EXTERNAL_EMOJIS:   1n << 14n,
  READ_MESSAGE_HISTORY:  1n << 15n,
  CONNECT:               1n << 20n,       // voice connect (implies MANAGE_CHANNEL considerations)
  SPEAK:                 1n << 21n,
  MUTE_MEMBERS:          1n << 22n,
  DEAFEN_MEMBERS:        1n << 23n,
  MOVE_MEMBERS:          1n << 24n,
  USE_VAD:               1n << 25n,
  CHANGE_NICKNAME:       1n << 26n,
  MANAGE_ROLES:          1n << 28n,       // 0x10000000   value 268435456
});

// Implicit dependencies: denying the key also denies every listed dependent.
const IMPLICATIONS = {
  SEND_MESSAGES: ['MENTION_EVERYONE', 'SEND_TTS_MESSAGES', 'ATTACH_FILES', 'EMBED_LINKS'],
  VIEW_CHANNEL: ['*ALL_CHANNEL_PERMS*'], // VIEW_CHANNEL denial denies everything in that channel
};

/** Combine multiple permission values (OR). */
export function combine(...vals) {
  return vals.reduce((acc, v) => acc | BigInt(v), 0n);
}

/** Check whether `perms` contains ALL bits of `required`. */
export function has(perms, required) {
  perms = BigInt(perms); required = BigInt(required);
  return (perms & required) === required;
}

/**
 * Evaluate a member's effective permissions in a channel.
 * Strict Discord hierarchy — Deny beats Allow at each stage:
 *   1. @everyone role base permissions
 *   2. channel @everyone overwrite   (allowed |= oa ; denied |= od)
 *   3. OR-union of all member role permissions
 *   4. per-role channel overwrites    (deny first, then allow)
 *   5. member-specific overwrite      (final and most important)
 *   6. ADMINISTRATOR short-circuits everything
 *   7. VIEW_CHANNEL gate: if denied → zero permissions for this channel
 * @param {{base:number|string}} everyoneRole       - @everyone role {permissions}
 * @param {Array<{id:string,permissions:number|string}>} memberRoles - roles held by member
 * @param {{allow?:number,bits?:string}} [memberOverwrite]            - member overwrite {allow:'ALLOW/...'|bigint str, deny}
 * @param {{id:string,allow:string,deny:string}} [channelOverwrites]  - {everyone:{allow,deny}, roles:[{id,allow,deny}], member:{allow,deny}}
 */
export function computeChannelPermissions(memberRoles, everyoneRole, channelOverwrites = {}, memberOverwrite = null) {
  let allowed = BigInt(everyoneRole?.permissions ?? 0);
  let denied = 0n;

  // Step A — @everyone channel overwrite (highest-priority base adjustment)
  if (channelOverwrites.everyone) {
    denied  |= BigInt(channelOverwrites.everyone.deny || 0);
    allowed |= BigInt(channelOverwrites.everyone.allow || 0);
  }

  // Step B — union of all member role permissions
  for (const r of memberRoles) allowed |= BigInt(r.permissions ?? 0);

  // Step C — per-role channel overwrites (deny applied before allow within each overwrite)
  for (const ov of channelOverwrites.roles || []) {
    const role = memberRoles.find((r) => String(r.id) === String(ov.id));
    if (!role) continue;
    denied  |= BigInt(ov.deny || 0);
    allowed |= BigInt(ov.allow || 0);
  }

  // Step D — member-specific overwrite (always last, always wins)
  if (memberOverwrite) {
    denied  |= BigInt(memberOverwrite.deny || 0);
    allowed |= BigInt(memberOverwrite.allow || 0);
  }

  // Final: remove denied bits from allowed
  let perms = allowed & ~denied;

  // ADMINISTRATOR grants literally everything (checked before the VIEW_CHANNEL
  // gate, matching Discord's documented precedence: admin implies VIEW_CHANNEL)
  if (has(perms, P.ADMINISTRATOR)) return (1n << 53n) - 1n;

  // VIEW_CHANNEL gate — implicit denial cascade (§ docs 5.3 step 7)
  if (!has(perms, P.VIEW_CHANNEL)) return 0n;

  return perms;
}

/** Human-readable flag list for debugging / REST responses. */
export function describe(perms) {
  perms = BigInt(perms);
  return Object.entries(P).filter(([, bit]) => (perms & bit) === bit).map(([k]) => k);
}
