exports.up = async function (knex) {
  await knex.schema.createTable('peering_attestations', (table) => {
    table.binary('relay_pubkey').primary()
    table.binary('owner_pubkey').notNullable()
    table.text('relay_url').notNullable()
    table.text('request_event_id').notNullable()
    table.jsonb('scopes').notNullable()
    table.jsonb('terms').notNullable()
    table.text('terms_hash').notNullable()
    table.integer('pow_difficulty').notNullable()
    table.timestamp('accepted_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('peering_attestations')
}
