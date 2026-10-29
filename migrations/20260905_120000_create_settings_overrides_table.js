exports.up = async function (knex) {
  await knex.schema.createTable('settings_overrides', (table) => {
    table.text('path').primary()
    table.jsonb('value').notNullable()
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('settings_overrides')
}
