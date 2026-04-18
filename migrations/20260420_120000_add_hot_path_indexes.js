/**
 * Add narrow, query-driven indexes to cover the hottest read paths.
 *
 * Each index is created with CREATE INDEX CONCURRENTLY so the migration can be
 * applied to a running relay without taking an ACCESS EXCLUSIVE lock on the
 * events table. CONCURRENTLY is not allowed inside a transaction, so this
 * migration opts out of Knex's default transactional wrapper via
 * `exports.config.transaction = false`.
 *
 * Rationale for each index is documented inline. See also:
 *   https://devcenter.heroku.com/articles/postgresql-indexes
 */

exports.config = { transaction: false }

exports.up = async function (knex) {
  // Covers the hottest write-adjacent reads:
  //
  //   1. `EventRepository.hasActiveRequestToVanish(pubkey)`
  //        WHERE event_pubkey = ? AND event_kind = 62 AND deleted_at IS NULL
  //        -- invoked on every inbound event via UserRepository.isVanished
  //
  //   2. `EventRepository.deleteByPubkeyExceptKinds(pubkey, kinds)`
  //        WHERE event_pubkey = ? AND event_kind NOT IN (...) AND deleted_at IS NULL
  //
  //   3. NIP-01 REQ with `authors` + `kinds` filters ordered by created_at:
  //        WHERE event_pubkey IN (...) AND event_kind IN (...)
  //        ORDER BY event_created_at DESC LIMIT N
  //
  // Partial on `deleted_at IS NULL` so soft-deleted rows never bloat the index.
  // DESC on event_created_at lets the planner satisfy LIMIT N without a sort.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS events_active_pubkey_kind_created_at_idx
    ON events (event_pubkey, event_kind, event_created_at DESC)
    WHERE deleted_at IS NULL
  `)

  // Supports the retention/purge scan in `deleteExpiredAndRetained`:
  //   WHERE deleted_at IS NOT NULL
  // Partial index is tiny because well-maintained relays hard-delete these rows
  // periodically and most events have deleted_at IS NULL.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS events_deleted_at_partial_idx
    ON events (deleted_at)
    WHERE deleted_at IS NOT NULL
  `)

  // Supports `InvoiceRepository.findPendingInvoices` which is polled by the
  // maintenance worker:
  //   WHERE status = 'pending' ORDER BY created_at
  // Partial on status='pending' so the index only contains the rows we scan.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS invoices_pending_created_at_idx
    ON invoices (created_at)
    WHERE status = 'pending'
  `)
}

exports.down = async function (knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS invoices_pending_created_at_idx')
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS events_deleted_at_partial_idx')
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS events_active_pubkey_kind_created_at_idx')
}
