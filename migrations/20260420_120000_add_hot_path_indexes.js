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
  // Covers the hottest subscription / per-message reads:
  //
  //   1. NIP-01 REQ with `authors` + `kinds` ordered by created_at DESC
  //      (see EventRepository.findByFilters):
  //        WHERE event_pubkey = ? AND event_kind IN (...)
  //        ORDER BY event_created_at DESC, event_id ASC LIMIT N
  //
  //   2. `EventRepository.hasActiveRequestToVanish(pubkey)` — invoked on every
  //      inbound event via UserRepository.isVanished:
  //        WHERE event_pubkey = ? AND event_kind = 62 AND deleted_at IS NULL
  //
  //   3. `EventRepository.deleteByPubkeyExceptKinds(pubkey, kinds)`:
  //        WHERE event_pubkey = ? AND event_kind NOT IN (...) AND deleted_at IS NULL
  //
  // The index is intentionally NOT partial on `deleted_at IS NULL`: the REQ
  // subscription path in findByFilters does not currently add that predicate,
  // so a partial index would be ineligible for the most important query shape.
  // Soft-deleted rows are a small fraction of total rows in practice (they get
  // hard-deleted by the retention sweep), so the bloat is negligible compared
  // to the benefit of the index being usable by the hot path.
  //
  // Including `event_id` as the final column makes the composite key match the
  // full ORDER BY (created_at DESC, event_id ASC) used by findByFilters, so the
  // planner can satisfy LIMIT N directly from the index without an extra sort
  // step for the tie-breaker.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS events_active_pubkey_kind_created_at_idx
    ON events (event_pubkey, event_kind, event_created_at DESC, event_id)
  `)

  // Supports the retention / purge scan in `deleteExpiredAndRetained` and the
  // vanish hard-delete follow-up:
  //   WHERE deleted_at IS NOT NULL
  // Partial index is tiny because well-maintained relays hard-delete these
  // rows periodically and the vast majority of events have deleted_at IS NULL.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS events_deleted_at_partial_idx
    ON events (deleted_at)
    WHERE deleted_at IS NOT NULL
  `)

  // Supports `InvoiceRepository.findPendingInvoices`, which is polled by the
  // maintenance worker to detect settled invoices:
  //   WHERE status = 'pending' ORDER BY created_at ASC OFFSET ? LIMIT ?
  // Partial on status = 'pending' so the index only contains the rows the
  // poller actually scans. Keyed on `created_at` so the planner can satisfy
  // the ORDER BY straight from the index (FIFO polling, bounded tail latency
  // even with large pending backlogs).
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
