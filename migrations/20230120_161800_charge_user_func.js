exports.up = async function (knex) {
  return knex.schema
    .raw(
      `CREATE OR REPLACE FUNCTION charge_user(charged_user BYTEA, amount BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    current_balance BIGINT;
BEGIN
    PERFORM ASSERT_SERIALIZED();

    SELECT "balance" INTO current_balance FROM "users" WHERE "pubkey" = charged_user;
    IF current_balance - amount >= 0 THEN
      UPDATE "users" SET balance = balance - amount WHERE "pubkey" = charged_user;
      RETURN 1;
    ELSE
      RETURN 0;
    END IF;
END;
$$;`)
}

exports.down = function (knex) {
  return knex.schema
    .raw('DROP FUNCTION IF EXISTS charge_user(BYTEA, BIGINT);')
}
