exports.up = function (knex) {
  return knex.raw('ALTER TABLE events ADD remote_address inet NULL;')
}

exports.down = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.dropColumn('remote_address')
  })
}
