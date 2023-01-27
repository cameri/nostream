exports.up = function (knex) {
  return knex.schema.createTable('users', (table) => {
    table.binary('pubkey').primary()
    table.boolean('is_admitted').default(0)
    table.bigint('balance').default(0)
    table.datetime('tos_accepted_at', { useTz: false, precision: 3 })
    table.timestamps(true, true, false)
  })
}

exports.down = function (knex) {
  return knex.schema.dropTable('users')
}
