exports.up = function (knex) {
  return knex.raw(
    `CREATE CONSTRAINT TRIGGER events_after_insert
    AFTER INSERT
    ON events
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION event_added();`,
  )
}

exports.down = function (knex) {
  return knex.raw('DROP TRIGGER IF EXISTS events_after_insert ON events')
}
