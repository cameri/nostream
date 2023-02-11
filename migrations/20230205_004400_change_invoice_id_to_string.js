exports.up = function (knex) {
  return knex.schema
    .raw('ALTER TABLE invoices ALTER COLUMN id TYPE text USING id::text; ALTER TABLE invoices ALTER COLUMN id DROP DEFAULT;')
    .raw(`CREATE OR REPLACE FUNCTION confirm_invoice(invoice_id TEXT, amount_received BIGINT, confirmation_date TIMESTAMP WITHOUT TIME ZONE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  payee BYTEA;
  confirmed_date TIMESTAMP WITHOUT TIME ZONE;
BEGIN
  PERFORM ASSERT_SERIALIZED();

  SELECT "pubkey", "confirmed_at" INTO payee, confirmed_date FROM "invoices" WHERE id = invoice_id;
  IF confirmed_date IS NULL THEN
      UPDATE invoices
      SET
        "confirmed_at" = confirmation_date,
        "amount_paid" = amount_received,
        "updated_at" = now_utc()
      WHERE id = invoice_id;
      UPDATE users SET balance = balance + amount_received WHERE "pubkey" = payee;
  END IF;
  RETURN 0;
END;
$$;`)
}

exports.down = function (knex) {
  return knex.schema
    .raw('ALTER TABLE invoices ALTER COLUMN id TYPE uuid USING id::uuid; ALTER TABLE invoices ALTER COLUMN id SET DEFAULT uuid_generate_v4();')
    .raw(`CREATE OR REPLACE FUNCTION confirm_invoice(invoice_id UUID, amount_received BIGINT, confirmation_date TIMESTAMP WITHOUT TIME ZONE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    payee BYTEA;
    confirmed_date TIMESTAMP WITHOUT TIME ZONE;
BEGIN
    PERFORM ASSERT_SERIALIZED();

    SELECT "pubkey", "confirmed_at" INTO payee, confirmed_date FROM "invoices" WHERE id = invoice_id;
    IF confirmed_date IS NULL THEN
        UPDATE invoices
        SET
          "confirmed_at" = confirmation_date,
          "amount_paid" = amount_received,
          "updated_at" = now_utc()
        WHERE id = invoice_id;
        UPDATE users SET balance = balance + amount_received WHERE "pubkey" = payee;
    END IF;
    RETURN 0;
END;
$$;`)
}
