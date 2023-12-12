exports.up = async function (knex) {
  await knex.schema.createTable('event_tags', function (table) {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.binary('event_id').notNullable();
    table.text('tag_name').notNullable();
    table.text('tag_value').notNullable();
  });

  await knex.schema.table('event_tags', function (table) {
    table.index(['tag_name', 'tag_value']);
  });

  const events = await knex.select('event_id', 'event_tags').from('events');
  const totalEvents = events.length;
  let processedEvents = 0;
  let lastPercentage = 0;

  for (const event of events) {
    for (const tag of event.event_tags) {
      const [tag_name, tag_value] = tag;
      if (tag_name.length === 1 && tag_value) {
        await knex('event_tags').insert({
          events_event_id: event.event_id,
          tag_name: tag_name,
          tag_value: tag_value
        });
      }
    }
    processedEvents++;
    const currentPercentage = Math.floor(processedEvents / totalEvents * 100);
    if (currentPercentage > lastPercentage) {
      console.log(`${new Date().toLocaleString()} Migration progress: ${currentPercentage}%`);
      lastPercentage = currentPercentage;
    }
  }
};

exports.down = function (knex) {
  return knex.schema.dropTable('event_tags');
};