exports.up = async function (knex) {
  await knex.schema
    .raw('DROP INDEX IF EXISTS pubkey_delegator_kind_idx;')
  await knex.schema.alterTable('events', function (table) {
    table.dropColumn('event_delegator')
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('events', function (table) {
    table.binary('event_delegator').nullable().index()
  })
  await knex.schema
    .raw(
      `CREATE UNIQUE INDEX pubkey_delegator_kind_idx
      ON events ( event_pubkey, event_delegator, event_kind );`,
    )
}
