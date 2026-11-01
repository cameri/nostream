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

const INDEX_NAMES = [
  'events_live_first_seen_pubkey_idx',
  'events_live_first_seen_remote_address_idx',
]

// A failed concurrent build leaves the index behind as invalid. `IF NOT EXISTS`
// would then skip it on retry, leaving the migration successful but the index
// unusable. Drop any invalid leftover before recreating it.
const dropInvalidIndex = async (knex, indexName) => {
  const result = await knex.raw(
    `
      SELECT 1
      FROM pg_index
      WHERE indexrelid = to_regclass(?)
        AND NOT indisvalid
    `,
    [indexName],
  )

  if (result.rows.length > 0) {
    await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS ??', [indexName])
  }
}

exports.up = async function (knex) {
  for (const indexName of INDEX_NAMES) {
    await dropInvalidIndex(knex, indexName)
  }

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
