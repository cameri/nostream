exports.up = async function (knex) {
  await knex.schema.alterTable('peering_invoices', (table) => {
    table.timestamp('payment_activity_at', { useTz: true }).nullable()
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('peering_invoices', (table) => {
    table.dropColumn('payment_activity_at')
  })
}
