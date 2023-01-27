exports.up = async function (knex) {
  return knex.schema
    .raw('CREATE EXTENSION btree_gin;')
    .raw(
      `CREATE INDEX kind_tags_created_at_idx
      ON events USING GIN ( event_kind, event_tags, event_created_at );`,
    )
}

exports.down = function (knex) {
  return knex.schema
    .raw('DROP INDEX IF EXISTS kind_tags_created_at_idx;')
    .raw('DROP EXTENSION btree_gin;')
}
