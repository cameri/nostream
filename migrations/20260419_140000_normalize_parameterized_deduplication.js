exports.up = async function (knex) {
  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        row_number() OVER (
          PARTITION BY event_pubkey, event_kind, jsonb_build_array(COALESCE(event_deduplication->>0, ''))
          ORDER BY event_created_at DESC, event_id ASC
        ) AS row_rank
      FROM events
      WHERE event_kind >= 30000
        AND event_kind < 40000
    )
    DELETE FROM events AS e
    USING ranked AS r
    WHERE e.id = r.id
      AND r.row_rank > 1;
  `)

  await knex.raw(`
    UPDATE events
    SET event_deduplication = jsonb_build_array(COALESCE(event_deduplication->>0, ''))
    WHERE event_kind >= 30000
      AND event_kind < 40000
      AND event_deduplication IS DISTINCT FROM jsonb_build_array(COALESCE(event_deduplication->>0, ''));
  `)
}

exports.down = async function () {
  // Irreversible data migration.
}
