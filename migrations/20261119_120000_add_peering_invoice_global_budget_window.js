exports.up = async function (knex) {
  await knex.schema.alterTable('peering_invoices', (table) => {
    table.timestamp('global_budget_period_start', { useTz: true }).nullable()
    table.timestamp('global_budget_period_end', { useTz: true }).nullable()
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('peering_invoices', (table) => {
    table.dropColumn('global_budget_period_start')
    table.dropColumn('global_budget_period_end')
  })
}
