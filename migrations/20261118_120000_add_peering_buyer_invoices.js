exports.up = async function (knex) {
  await knex.schema.createTable('peering_invoices', (table) => {
    // The BOLT11 payment hash is the idempotency key: a redelivered kind 402
    // event must not create a second payment, and it must survive restarts.
    table.text('payment_hash').primary()
    table.text('event_id').notNullable().unique()
    table.binary('peer_pubkey').notNullable()
    table.text('bolt11').notNullable()
    table.bigint('amount_msats').unsigned().notNullable()
    table
      .enum('status', ['received', 'paying', 'paid', 'held', 'rejected', 'failed'])
      .notNullable()
      .defaultTo('received')
    table.text('reason').nullable()
    table.boolean('auto_paid').notNullable().defaultTo(false)
    table.timestamp('budget_period_start', { useTz: true }).nullable()
    table.timestamp('budget_period_end', { useTz: true }).nullable()
    table.integer('term_period_seconds').nullable()
    table.timestamp('expires_at', { useTz: true }).nullable()
    table.integer('seen_count').notNullable().defaultTo(1)
    table.timestamp('paid_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['status', 'created_at'], 'idx_peering_invoices_status_created_at')
    table.index(['peer_pubkey', 'status'], 'idx_peering_invoices_peer_status')
  })

  await knex.schema.createTable('peering_budgets', (table) => {
    // scope is `global` or `peer:<hex>`. The period is a fixed, epoch-aligned
    // window so a renewal inside one period cannot borrow from the next.
    table.text('scope').notNullable()
    table.timestamp('period_start', { useTz: true }).notNullable()
    table.timestamp('period_end', { useTz: true }).notNullable()
    table.bigint('spent_msats').unsigned().notNullable().defaultTo(0)

    table.primary(['scope', 'period_start'])
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('peering_budgets')
  await knex.schema.dropTable('peering_invoices')
}
