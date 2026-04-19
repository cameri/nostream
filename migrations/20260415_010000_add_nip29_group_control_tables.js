exports.up = async function (knex) {
  await knex.schema.createTable('groups', (table) => {
    table.string('group_id', 64).primary()
    table.binary('owner_pubkey').notNullable()
    table.string('leader_relay_url', 255).notNullable()
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('group_control_log', (table) => {
    table.bigIncrements('sequence_id').primary()
    table.string('group_id', 64).notNullable().references('group_id').inTable('groups')
    table.bigInteger('group_sequence').notNullable()
    table.binary('event_id').notNullable().unique()
    table.binary('pubkey').notNullable()
    table.integer('kind').notNullable()
    table.jsonb('raw_event').notNullable()
    table.string('state_root', 64).notNullable()
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())

    table.unique(['group_id', 'group_sequence'])
    table.index(['group_id', 'group_sequence'])
    table.index(['group_id', 'created_at'])
    table.index(['kind'])
  })

  await knex.raw(
    'ALTER TABLE group_control_log ADD CONSTRAINT group_control_log_kind_check CHECK (kind >= 9000 AND kind <= 9006);'
  )

  await knex.schema.createTable('group_memberships', (table) => {
    table.string('group_id', 64).notNullable().references('group_id').inTable('groups')
    table.binary('pubkey').notNullable()
    table.string('role', 20).notNullable()

    table.primary(['group_id', 'pubkey'])
    table.index(['group_id', 'role'])
    table.index(['pubkey'])
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('group_memberships')
  await knex.raw('ALTER TABLE IF EXISTS group_control_log DROP CONSTRAINT IF EXISTS group_control_log_kind_check;')
  await knex.schema.dropTableIfExists('group_control_log')
  await knex.schema.dropTableIfExists('groups')
}