exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.boolean('is_vanished').notNullable().defaultTo(false)
  })

  await knex.raw(`
    UPDATE users u
    SET is_vanished = true
    FROM events e
    WHERE u.pubkey = e.event_pubkey
      AND e.event_kind = 62
      AND e.deleted_at IS NULL
  `)

  await knex.raw(`
    INSERT INTO users (pubkey, is_admitted, balance, is_vanished, created_at, updated_at)
    SELECT DISTINCT e.event_pubkey, false, 0, true, NOW(), NOW()
    FROM events e
    LEFT JOIN users u ON u.pubkey = e.event_pubkey
    WHERE e.event_kind = 62
      AND e.deleted_at IS NULL
      AND u.pubkey IS NULL
  `)
}

exports.down = function (knex) {
  return knex.schema.alterTable('users', (table) => {
    table.dropColumn('is_vanished')
  })
}
