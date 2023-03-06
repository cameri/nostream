exports.up = function (knex) {
  return knex.raw('ALTER TABLE invoices ADD verify_url TEXT;')
}

exports.down = function (knex) {
  return knex.schema.alterTable('invoices', function (table) {
    table.dropColumn('verify_url')
  })
}
