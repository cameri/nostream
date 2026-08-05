exports.config = { transaction: false }

exports.up = function (knex) {
  return knex.raw(
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS events_content_fts_idx ON events USING gin (to_tsvector('simple', event_content))",
  )
}

exports.down = function (knex) {
  return knex.raw('DROP INDEX CONCURRENTLY IF EXISTS events_content_fts_idx')
}
