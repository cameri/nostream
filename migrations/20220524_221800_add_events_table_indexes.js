exports.up = function (knex) {
  return knex.raw(
    'CREATE INDEX event_tags_idx ON events USING GIN ( event_tags );',
  )
}

exports.down = function (knex) {
  return knex.raw('DROP INDEX IF EXISTS event_tags_idx')
}
