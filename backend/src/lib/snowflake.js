// =============================================================================
// Snowflake ID generator (Twitter-style, as used by Discord).
// Layout: 42-bit timestamp (ms since custom epoch) | 5-bit worker | 5-bit process | 12-bit seq
// IDs are time-sortable and safe to generate across many nodes.
// Stored in PostgreSQL as BIGINT.
// =============================================================================

const EPOCH = 1400000000000; // custom epoch (2014-05-13), same spirit as Discord's

const WORKER_ID = Number(process.env.SNOWFLAKE_WORKER_ID ?? 1) & 0x1f;
const PROCESS_ID = Number(process.env.SNOWFLAKE_PROCESS_ID ?? 1) & 0x1f;

let lastTs = -1;
let seq = 0;

/** Returns the next unique snowflake id as a JS BigInt-safe string. */
export function snowflake() {
  let ts = Date.now() - EPOCH;
  if (ts === lastTs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) {
      // sequence exhausted within this ms — wait for the next clock tick
      while (ts <= lastTs) ts = Date.now() - EPOCH;
    }
  } else {
    seq = 0;
  }
  lastTs = ts;
  const id =
    (BigInt(ts) << 22n) |
    (BigInt(WORKER_ID) << 17n) |
    (BigInt(PROCESS_ID) << 12n) |
    BigInt(seq);
  return id.toString();
}

/** Extract creation timestamp (ms since unix epoch) from a snowflake id. */
export function snowflakeTime(id) {
  return Number((BigInt(id) >> 22n) + BigInt(EPOCH));
}
