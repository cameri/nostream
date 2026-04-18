exports.up = async function (knex) {
  // Create the event_tags table
  await knex.schema.createTable('event_tags', function (table) {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    table.binary('event_id').notNullable()
    table.text('tag_name').notNullable()
    table.text('tag_value').notNullable()
  })

  // Add indexes
  await knex.schema.table('event_tags', function (table) {
    table.index('event_id')
    table.index(['tag_name', 'tag_value'])
  })

  // Add triggers
  await knex.raw(
    `CREATE OR REPLACE FUNCTION process_event_tags() RETURNS TRIGGER AS $$
    DECLARE
      tag_element jsonb;
      tag_name text;
      tag_value text;
    BEGIN
      DELETE FROM event_tags WHERE event_id = OLD.event_id;

      IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        FOR tag_element IN SELECT jsonb_array_elements(NEW.event_tags)
        LOOP
          tag_name := trim((tag_element->0)::text, '"');
          tag_value := trim((tag_element->1)::text, '"');
          IF length(tag_name) = 1 AND tag_value IS NOT NULL AND tag_value <> '' THEN
            INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (NEW.event_id, tag_name, tag_value);
          END IF;
        END LOOP;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER insert_event_tags
    AFTER INSERT OR UPDATE OR DELETE ON events
    FOR EACH ROW
    EXECUTE FUNCTION process_event_tags();
  `)

  // Migrate jsonb event_tags to event_tags table
  const events = await knex.select('event_id', 'event_tags').from('events')
  const totalEvents = events.length
  let processedEvents = 0
  let lastPercentage = 0

  for (const event of events) {
    const exists = await knex('event_tags').where('event_id', event.event_id).first()
    if (exists) {
      continue
    }

    for (const tag of event.event_tags) {
      const [tag_name, tag_value] = tag
      if (tag_name.length === 1 && tag_value) {
        await knex('event_tags').insert({
          event_id: event.event_id,
          tag_name: tag_name,
          tag_value: tag_value,
        })
      }
    }

    processedEvents++
    const currentPercentage = Math.floor(processedEvents / totalEvents * 100)
    if (currentPercentage > lastPercentage) {
      console.log(`${new Date().toLocaleString()} Migration progress: ${currentPercentage}% (${processedEvents}/${totalEvents})`)
      lastPercentage = currentPercentage
    }
  }
}

exports.down = function (knex) {
  return knex.schema
    // Drop the trigger first
    .raw('DROP TRIGGER IF EXISTS insert_event_tags ON events')
    // Then drop the function
    .raw('DROP FUNCTION IF EXISTS process_event_tags')
    // Finally, drop the table
    .dropTable('event_tags')
}
