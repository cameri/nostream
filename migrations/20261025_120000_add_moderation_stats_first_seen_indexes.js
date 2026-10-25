/**
 * Supports admin moderation activity stats (queryTopPublishingPubkeys /
 * queryTopClientIps), which filter live events by relay receipt time:
 *
 *   WHERE deleted_at IS NULL AND first_seen >= ?
 *
 * Partial indexes keep the working set small on relays where most rows are
 * soft-deleted history. CREATE INDEX CONCURRENTLY cannot run inside a
 * transaction.
 */

exports.config = { transaction: false }

exports.up = async function (knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS events_live_first_seen_pubkey_idx
    ON events (first_seen, event_pubkey)
    WHERE deleted_at IS NULL
  `)

  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS events_live_first_seen_remote_address_idx
    ON events (first_seen, remote_address)
    WHERE deleted_at IS NULL AND remote_address IS NOT NULL
  `)
}

exports.down = async function (knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS events_live_first_seen_remote_address_idx')
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS events_live_first_seen_pubkey_idx')
}
