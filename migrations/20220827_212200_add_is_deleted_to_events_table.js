exports.up = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.timestamp('deleted_at', { useTz: false }).nullable()
  })
}

exports.down = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.dropColumn('deleted_at')
  })
}
