exports.up = async function (knex) {
  return knex.schema
    .raw(
      `CREATE UNIQUE INDEX pubkey_delegator_kind_idx
      ON events ( event_pubkey, event_delegator, event_kind );`,
    )
}

exports.down = function (knex) {
  return knex.schema
    .raw('DROP INDEX IF EXISTS pubkey_delegator_kind_idx;')
}
