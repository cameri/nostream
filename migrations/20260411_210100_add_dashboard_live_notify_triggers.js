exports.up = async function (knex) {
  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION notify_dashboard_events_changed() RETURNS TRIGGER AS $$
    BEGIN
      PERFORM pg_notify('dashboard_events_changed', TG_OP);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `)

  await knex.schema.raw(`
    DROP TRIGGER IF EXISTS dashboard_events_changed_trigger ON events;

    CREATE TRIGGER dashboard_events_changed_trigger
    AFTER INSERT OR UPDATE OR DELETE ON events
    FOR EACH STATEMENT
    EXECUTE FUNCTION notify_dashboard_events_changed();
  `)

  await knex.schema.raw(`
    CREATE OR REPLACE FUNCTION notify_dashboard_users_changed() RETURNS TRIGGER AS $$
    BEGIN
      PERFORM pg_notify('dashboard_users_changed', TG_OP);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `)

  await knex.schema.raw(`
    DROP TRIGGER IF EXISTS dashboard_users_changed_trigger ON users;

    CREATE TRIGGER dashboard_users_changed_trigger
    AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH STATEMENT
    EXECUTE FUNCTION notify_dashboard_users_changed();
  `)
}

exports.down = async function (knex) {
  await knex.schema.raw('DROP TRIGGER IF EXISTS dashboard_events_changed_trigger ON events;')
  await knex.schema.raw('DROP TRIGGER IF EXISTS dashboard_users_changed_trigger ON users;')
  await knex.schema.raw('DROP FUNCTION IF EXISTS notify_dashboard_events_changed();')
  await knex.schema.raw('DROP FUNCTION IF EXISTS notify_dashboard_users_changed();')
}
