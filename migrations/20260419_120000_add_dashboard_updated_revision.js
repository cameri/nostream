exports.up = async function (knex) {
  await knex.schema.createTable('dashboard_state', (table) => {
    table.integer('id').primary()
    table.bigInteger('revision').notNullable().defaultTo(0)
    table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(knex.fn.now())
  })

  await knex('dashboard_state')
    .insert({
      id: 1,
      revision: 0,
      updated_at: knex.fn.now(),
    })
    .onConflict('id')
    .ignore()

  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION dashboard_updated() RETURNS TRIGGER AS $$
    BEGIN
      UPDATE dashboard_state
      SET
        revision = revision + 1,
        updated_at = NOW()
      WHERE id = 1;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `)

  await knex.schema.raw(`
    DROP TRIGGER IF EXISTS dashboard_revision_events_trigger ON events;

    CREATE TRIGGER dashboard_revision_events_trigger
    AFTER INSERT OR UPDATE OR DELETE ON events
    FOR EACH STATEMENT
    EXECUTE FUNCTION dashboard_updated();
  `)

  await knex.schema.raw(`
    DROP TRIGGER IF EXISTS dashboard_revision_users_trigger ON users;

    CREATE TRIGGER dashboard_revision_users_trigger
    AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH STATEMENT
    EXECUTE FUNCTION dashboard_updated();
  `)
}

exports.down = async function (knex) {
  await knex.schema.raw('DROP TRIGGER IF EXISTS dashboard_revision_events_trigger ON events;')
  await knex.schema.raw('DROP TRIGGER IF EXISTS dashboard_revision_users_trigger ON users;')
  await knex.schema.raw('DROP FUNCTION IF EXISTS dashboard_updated();')
  await knex.schema.dropTableIfExists('dashboard_state')
}
