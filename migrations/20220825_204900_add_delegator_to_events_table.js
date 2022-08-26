exports.up = function (knex) {
  // NIP-26: Delegated Event Signing
  return knex.schema.alterTable('events', function (table) {
    table.binary('event_delegator').nullable().index()
  })
}

exports.down = function (knex) {
  return knex.schema.alterTable('events', function (table) {
    table.dropColumn('event_delegator')
  })
}
