exports.up = async function (knex) {
  await knex.schema.alterTable('invoices', (table) => {
    table.integer('settlement_attempts').notNullable().defaultTo(0)
    table.text('last_settlement_error').nullable()
    table.timestamp('last_settlement_attempt_at', { useTz: true }).nullable()
    table.timestamp('settlement_alerted_at', { useTz: true }).nullable()
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('invoices', (table) => {
    table.dropColumn('settlement_alerted_at')
    table.dropColumn('last_settlement_attempt_at')
    table.dropColumn('last_settlement_error')
    table.dropColumn('settlement_attempts')
  })
}
