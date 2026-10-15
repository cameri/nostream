/**
 * Supports EventRepository.applyActionableReportExclusion's NOT EXISTS
 * subquery (used by findByFilters/countByFilters when
 * nip56.hideActionableReports is enabled):
 *
 *   WHERE NOT EXISTS (
 *     SELECT 1 FROM reports
 *     WHERE actionable = true
 *       AND (reported_event_id = events.event_id OR reported_pubkey = events.event_pubkey)
 *   )
 *
 * Partial on actionable = true since non-actionable reports (the vast
 * majority -- most reporters are not trusted moderators) never participate
 * in this check, matching the existing events_deleted_at_partial_idx
 * precedent for keeping partial indexes small.
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction.
 */

exports.config = { transaction: false }

exports.up = async function (knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS reports_actionable_reported_event_id_idx
    ON reports (reported_event_id)
    WHERE actionable = true AND reported_event_id IS NOT NULL
  `)

  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS reports_actionable_reported_pubkey_idx
    ON reports (reported_pubkey)
    WHERE actionable = true AND reported_pubkey IS NOT NULL
  `)
}

exports.down = async function (knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS reports_actionable_reported_event_id_idx')
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS reports_actionable_reported_pubkey_idx')
}
