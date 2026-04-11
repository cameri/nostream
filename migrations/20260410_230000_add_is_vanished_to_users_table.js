exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.boolean('is_vanished').notNullable().defaultTo(false)
  })

  await knex.raw(`
    UPDATE users u
    SET is_vanished = true
    WHERE EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_pubkey = u.pubkey
        AND e.event_kind = 62
        AND e.deleted_at IS NULL
    )
  `)
}

exports.down = function (knex) {
  return knex.schema.alterTable('users', (table) => {
    table.dropColumn('is_vanished')
  })
}
