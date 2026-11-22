exports.up = async function (knex) {
  await knex.schema.alterTable('peering_invoices', (table) => {
    table.text('payment_attempt_id').nullable()
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('peering_invoices', (table) => {
    table.dropColumn('payment_attempt_id')
  })
}
