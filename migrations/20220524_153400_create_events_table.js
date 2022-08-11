exports.up = function (knex) {
  return knex.schema.createTable('events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    table.binary('event_id').unique().notNullable().index()
    table.binary('event_pubkey').notNullable().index()
    table.integer('event_kind').unsigned().notNullable().index()
    table.integer('event_created_at').unsigned().notNullable().index()
    table.text('event_content').notNullable()
    table.jsonb('event_tags')
    table.binary('event_signature').notNullable()
    table.timestamp('first_seen', { useTz: false }).defaultTo(knex.fn.now())
  })
}

exports.down = function (knex) {
  return knex.schema.dropTable('events')
}
