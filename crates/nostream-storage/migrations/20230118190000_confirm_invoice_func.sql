create function now_utc() returns timestamp as $$
  select now() at time zone 'utc';
$$ language sql;

create function ASSERT_SERIALIZED() returns void as $$
BEGIN
    IF (select current_setting('transaction_isolation') <> 'serializable') THEN
        RAISE EXCEPTION 'SN_NOT_SERIALIZABLE';
    END IF;
END;
$$ language plpgsql;

CREATE OR REPLACE FUNCTION confirm_invoice(invoice_id UUID, amount_received BIGINT, confirmation_date TIMESTAMP WITHOUT TIME ZONE)
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
$$;
