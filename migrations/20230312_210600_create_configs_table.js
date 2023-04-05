exports.up = function (knex) {
  return knex.schema.createTable('configs', (config) => {
    config.unique(['key', 'category'])
    config.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    config.text('key').notNullable().index()
    config.jsonb('value').notNullable().index()
    config.text('category').notNullable().index()
  })
}

exports.down = function (knex) {
  return knex.schema.dropTable('configs')
}
