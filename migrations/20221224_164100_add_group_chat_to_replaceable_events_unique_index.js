exports.up = async function (knex) {
  return knex.schema
    .raw('DROP INDEX IF EXISTS replaceable_events_idx')
    .raw(`DELETE FROM events a
      WHERE a.event_kind = 41
      AND a.event_created_at < (
	      SELECT max(event_created_at)
	      FROM events b
	      WHERE a.event_pubkey = b.event_pubkey
	      AND b.event_kind = 41
	      AND a.event_tags = b.event_tags
      );`)
    .raw(`UPDATE events a
      SET	event_deduplication = ('["' || encode(a.event_pubkey, 'hex') || '",' || a.event_kind || ']')::jsonb
      WHERE a.event_kind = 41
      AND a.event_created_at = (
	      SELECT max(event_created_at)
	      FROM events b
	      WHERE a.event_pubkey = b.event_pubkey
	      AND b.event_kind = 41
	      AND a.event_tags = b.event_tags
      );`)
    .raw(
      `CREATE UNIQUE INDEX replaceable_events_idx
      ON events ( event_pubkey, event_kind, event_deduplication )
      WHERE
        (
          event_kind = 0
          OR event_kind = 3
          OR event_kind = 41
          OR (event_kind >= 10000 AND event_kind < 20000)
        )
        OR (event_kind >= 30000 AND event_kind < 40000);`,
    )
}

exports.down = function (knex) {
  return knex.schema
    .raw('DROP INDEX IF EXISTS replaceable_events_idx')
    .raw(
      `CREATE UNIQUE INDEX replaceable_events_idx
      ON events ( event_pubkey, event_kind, event_deduplication )
      WHERE
        (
          event_kind = 0
          OR event_kind = 3
          OR (event_kind >= 10000 AND event_kind < 20000)
        )
        OR (event_kind >= 30000 AND event_kind < 40000);`,
    )
}
