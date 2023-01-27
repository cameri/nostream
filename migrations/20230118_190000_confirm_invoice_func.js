// Adapted from: https://github.com/stackernews/stacker.news
// Original Author: Keyan Kousha https://github.com/huumn
/**
MIT License

Copyright (c) 2023 Keyan Kousha / Stacker News

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
 */
exports.up = async function (knex) {
  return knex.schema
    .raw(`create function now_utc() returns timestamp as $$
  select now() at time zone 'utc';
$$ language sql;`)
    .raw(`create function ASSERT_SERIALIZED() returns void as $$
BEGIN
    IF (select current_setting('transaction_isolation') <> 'serializable') THEN
        RAISE EXCEPTION 'SN_NOT_SERIALIZABLE';
    END IF;
END;
$$ language plpgsql;
    `)
    .raw(
      `CREATE OR REPLACE FUNCTION confirm_invoice(invoice_id UUID, amount_received BIGINT, confirmation_date TIMESTAMP WITHOUT TIME ZONE)
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
    .raw('DROP FUNCTION IF EXISTS confirm_invoice(UUID, BYTEA, TIMESTAMP);')
    .raw('DROP FUNCTION IF EXISTS ASSERT_SERIALIZED();')
    .raw('DROP FUNCTION IF EXISTS now_utc();')
}
