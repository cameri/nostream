exports.up = async function (knex) {
  return knex.schema
    .raw(
      `CREATE OR REPLACE FUNCTION admit_user(user_pubkey BYTEA, tos_accepted TIMESTAMP WITHOUT TIME ZONE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM ASSERT_SERIALIZED();

    INSERT INTO "users" ("pubkey", "is_admitted", "tos_accepted_at", "created_at", "updated_at")
    VALUES (user_pubkey, true, tos_accepted, now_utc(), now_utc())
    ON CONFLICT ("pubkey")
    DO UPDATE SET
      "is_admitted" = true,
      "tos_accepted_at" = tos_accepted,
      "updated_at" = now_utc();

    RETURN 0;
END;
$$;`)
}

exports.down = function (knex) {
  return knex.schema
    .raw('DROP FUNCTION IF EXISTS admit_user(BYTEA, TIMESTAMP WITHOUT TIME ZONE);')
}
