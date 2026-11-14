exports.up = async function (knex) {
  await knex.schema.alterTable('invoices', (table) => {
    table.enum('purpose', ['admission', 'subscription', 'peering']).nullable()
    table.bigint('term_amount_msats').unsigned().nullable()
    table.integer('term_period_seconds').nullable()
    table.index(['purpose', 'status'], 'idx_invoices_purpose_status')
  })

  // Existing rows predate the purpose column. A plan means a subscription; no plan means the
  // admission-fee flow. Peering invoices always set purpose explicitly.
  await knex.raw(`
    UPDATE invoices
    SET purpose = CASE WHEN plan_id IS NULL THEN 'admission' ELSE 'subscription' END
    WHERE purpose IS NULL
  `)

  await knex.raw('ALTER TABLE invoices ALTER COLUMN purpose SET DEFAULT \'admission\'')
  await knex.raw('ALTER TABLE invoices ALTER COLUMN purpose SET NOT NULL')

  // confirm_invoice() credits the payer's user balance. A peering invoice is paid
  // by another relay, not by a user, so skip the balance credit for that purpose.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION confirm_invoice(invoice_id TEXT, amount_received BIGINT, confirmation_date TIMESTAMP WITHOUT TIME ZONE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  payee BYTEA;
  confirmed_date TIMESTAMP WITHOUT TIME ZONE;
  invoice_unit TEXT;
  invoice_purpose TEXT;
BEGIN
  PERFORM ASSERT_SERIALIZED();

  SELECT "pubkey", "confirmed_at", "unit", "purpose"
    INTO payee, confirmed_date, invoice_unit, invoice_purpose
    FROM "invoices"
    WHERE id = invoice_id;

  IF confirmed_date IS NULL THEN
      UPDATE invoices
      SET
        "confirmed_at" = confirmation_date,
        "amount_paid" = amount_received,
        "updated_at" = now_utc()
      WHERE id = invoice_id;

      IF invoice_purpose <> 'peering' THEN
        IF invoice_unit = 'sats' THEN
          UPDATE users SET balance = balance + amount_received * 1000 WHERE "pubkey" = payee;
        ELSIF invoice_unit = 'msats' THEN
          UPDATE users SET balance = balance + amount_received WHERE "pubkey" = payee;
        ELSIF invoice_unit = 'btc' THEN
          UPDATE users SET balance = balance + amount_received * 100000000 * 1000 WHERE "pubkey" = payee;
        END IF;
      END IF;
  END IF;
  RETURN 0;
END;
$$;`)

  await knex.schema.createTable('peering_payments', (table) => {
    // A peer can both buy from and sell to this relay, so direction is part of the key.
    table.binary('peer_pubkey').notNullable()
    table.enum('direction', ['sell', 'buy']).notNullable().defaultTo('sell')
    table
      .enum('status', ['unpaid', 'invoiced', 'active', 'renewal_pending', 'lapsed'])
      .notNullable()
      .defaultTo('unpaid')
    table.text('current_invoice_id').nullable()
    table.text('renewal_invoice_id').nullable()
    table.timestamp('period_start', { useTz: true }).nullable()
    table.timestamp('period_end', { useTz: true }).nullable()
    table.bigint('term_amount_msats').unsigned().nullable()
    table.integer('term_period_seconds').nullable()
    table.text('last_settled_invoice_id').nullable()
    table.timestamp('last_settled_at', { useTz: true }).nullable()
    table.timestamp('last_checked_at', { useTz: true }).nullable()
    table.text('last_error').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.primary(['peer_pubkey', 'direction'])
    table.index(['status', 'period_end'], 'idx_peering_payments_status_period_end')
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('peering_payments')

  // Restore the previous confirm_invoice() before the purpose column disappears.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION confirm_invoice(invoice_id TEXT, amount_received BIGINT, confirmation_date TIMESTAMP WITHOUT TIME ZONE)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  payee BYTEA;
  confirmed_date TIMESTAMP WITHOUT TIME ZONE;
  invoice_unit TEXT;
BEGIN
  PERFORM ASSERT_SERIALIZED();

  SELECT "pubkey", "confirmed_at", "unit" INTO payee, confirmed_date, invoice_unit FROM "invoices" WHERE id = invoice_id;
  IF confirmed_date IS NULL THEN
      UPDATE invoices
      SET
        "confirmed_at" = confirmation_date,
        "amount_paid" = amount_received,
        "updated_at" = now_utc()
      WHERE id = invoice_id;
      IF invoice_unit = 'sats' THEN
        UPDATE users SET balance = balance + amount_received * 1000 WHERE "pubkey" = payee;
      ELSIF invoice_unit = 'msats' THEN
        UPDATE users SET balance = balance + amount_received WHERE "pubkey" = payee;
      ELSIF invoice_unit = 'btc' THEN
        UPDATE users SET balance = balance + amount_received * 100000000 * 1000 WHERE "pubkey" = payee;
      END IF;
  END IF;
  RETURN 0;
END;
$$;`)

  await knex.schema.alterTable('invoices', (table) => {
    table.dropIndex(['purpose', 'status'], 'idx_invoices_purpose_status')
    table.dropColumn('term_amount_msats')
    table.dropColumn('term_period_seconds')
    table.dropColumn('purpose')
  })
}
