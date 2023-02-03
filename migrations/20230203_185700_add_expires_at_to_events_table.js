exports.up = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.timestamp('expires_at', { useTz: false }).index().nullable()
  })
}

exports.down = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.dropColumn('expires_at')
  })
}
