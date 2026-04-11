exports.up = function (knex) {
  return knex.schema.createTable('nip05_verifications', function (table) {
    table.binary('pubkey').notNullable().primary()
    table.text('nip05').notNullable()
    table.text('domain').notNullable()
    table.boolean('is_verified').notNullable().defaultTo(false)
    table.timestamp('last_verified_at', { useTz: true }).nullable()
    table.timestamp('last_checked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.integer('failure_count').notNullable().defaultTo(0)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['domain'], 'idx_nip05_verifications_domain')
    table.index(['is_verified'], 'idx_nip05_verifications_is_verified')
    table.index(['last_checked_at'], 'idx_nip05_verifications_last_checked_at')
  })
}

exports.down = function (knex) {
  return knex.schema.dropTable('nip05_verifications')
}
