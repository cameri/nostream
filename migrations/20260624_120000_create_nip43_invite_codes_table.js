exports.up = async function (knex) {
  await knex.schema.createTable('invite_codes', (table) => {
    table.string('code', 64).primary()
    table.binary('created_by').nullable()
    table.binary('claimed_by').nullable()
    table.timestamp('expires_at', { useTz: true }).nullable()
    table.integer('max_uses').notNullable().defaultTo(1)
    table.integer('use_count').notNullable().defaultTo(0)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.raw(
    'ALTER TABLE invite_codes ADD CONSTRAINT chk_use_count_non_negative CHECK (use_count >= 0)'
  )
  await knex.raw(
    'ALTER TABLE invite_codes ADD CONSTRAINT chk_max_uses_non_negative CHECK (max_uses >= 0)'
  )

  // partial index: only rows with an expiry set
  await knex.raw(
    'CREATE INDEX idx_invite_codes_expires_at ON invite_codes(expires_at) WHERE expires_at IS NOT NULL'
  )
}

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('invite_codes')
}
