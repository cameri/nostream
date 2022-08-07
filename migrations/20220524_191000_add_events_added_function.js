exports.up = function (knex) {
  return knex.raw(
    `CREATE OR REPLACE FUNCTION event_added()
    RETURNS trigger
    LANGUAGE plpgsql
   AS $function$
     BEGIN
       perform pg_notify('event_added', row_to_json(NEW)::text);
       return new;
     END;
   $function$
   ;`,
  )
}

exports.down = function (knex) {
  return knex.raw('DROP FUNCTION IF EXISTS event_added();')
}
