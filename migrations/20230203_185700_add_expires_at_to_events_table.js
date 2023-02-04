exports.up = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.integer('expires_at').unsigned().nullable().index()
  })
}

exports.down = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.dropColumn('expires_at')
  })
}
