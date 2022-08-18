exports.up = function (knex) {
  // NIP-16: Replaceable Events
  return knex.raw(
    'CREATE UNIQUE INDEX replaceable_events_idx ON events ( event_pubkey, event_kind ) WHERE event_kind = 0 OR event_kind = 3 OR event_kind >= 10000 AND event_kind < 20000;',
  )
}

exports.down = function (knex) {
  return knex.raw('DROP INDEX IF EXISTS replaceable_events_idx')
}
