/**
 * Migration: add dashboard KPI query indexes
 *
 * Without these the incremental collector degrades to sequential scans:
 *   - idx_events_cursor     → covers the (first_seen, id) cursor predicate used in every
 *                             incremental delta query and the bootstrap cursor select.
 *   - idx_events_pubkey     → covers the GROUP BY event_pubkey in the all-time talker query.
 *   - idx_users_cursor      → covers the (updated_at, pubkey) cursor predicate used in the
 *                             user delta / cursor-select queries.
 *
 * All three are created CONCURRENTLY so they don't lock the table on a live relay.
 * knex does not support CREATE INDEX CONCURRENTLY natively, so we use raw SQL and
 * set `disableTransactions` to true (DDL inside a transaction would negate CONCURRENTLY).
 */

exports.up = async (knex) => {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_cursor
      ON events (first_seen, id);
  `)

  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_pubkey
      ON events (event_pubkey);
  `)

  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_cursor
      ON users (updated_at, pubkey);
  `)
}

exports.down = async (knex) => {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_events_cursor;')
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_events_pubkey;')
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_users_cursor;')
}

// Required so knex doesn't wrap the CONCURRENTLY statements in a transaction.
exports.config = { transaction: false }
