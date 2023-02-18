exports.up = function (knex) {
  return knex.schema
    .raw(`CREATE OR REPLACE FUNCTION confirm_invoice(invoice_id TEXT, amount_received BIGINT, confirmation_date TIMESTAMP WITHOUT TIME ZONE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  payee BYTEA;
  confirmed_date TIMESTAMP WITHOUT TIME ZONE;
  unit TEXT;
BEGIN
  PERFORM ASSERT_SERIALIZED();

  SELECT "pubkey", "confirmed_at", "unit" INTO payee, confirmed_date, unit FROM "invoices" WHERE id = invoice_id;
  IF confirmed_date IS NULL THEN
      UPDATE invoices
      SET
        "confirmed_at" = confirmation_date,
        "amount_paid" = amount_received,
        "updated_at" = now_utc()
      WHERE id = invoice_id;
      IF unit = 'sats' THEN
        UPDATE users SET balance = balance + amount_received * 1000 WHERE "pubkey" = payee;
      ELSIF unit = 'msats' THEN
        UPDATE users SET balance = balance + amount_received WHERE "pubkey" = payee;
      ELSIF unit = 'btc' THEN
        UPDATE users SET balance = balance + amount_received * 100000000 * 1000 WHERE "pubkey" = payee;
      END IF;
  END IF;
  RETURN 0;
END;
$$;`)
}

exports.down = function (knex) {
  return knex.schema
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
