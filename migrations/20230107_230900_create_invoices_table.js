exports.up = function (knex) {
  return knex.schema.createTable('invoices', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    table.binary('pubkey').notNullable().index()
    table.text('bolt11').notNullable()
    table.bigint('amount_requested').unsigned().notNullable()
    table.bigint('amount_paid').unsigned()
    table.enum('unit', ['msats', 'sats', 'btc'])
    table.enum('status', ['pending', 'completed', 'expired'])
    table.text('description')
    table.datetime('confirmed_at', { useTz: false, precision: 3 })
    table.datetime('expires_at', { useTz: false, precision: 3 })
    table.timestamps(true, true, false)
  })
}

exports.down = function (knex) {
  return knex.schema.dropTable('invoices')
}
