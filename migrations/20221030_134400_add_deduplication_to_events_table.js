exports.up = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.jsonb('event_deduplication').nullable()
  })
}

exports.down = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.dropColumn('event_deduplication')
  })
}
