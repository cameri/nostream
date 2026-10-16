exports.up = async function (knex) {
  await knex.schema.createTable('user_subscriptions', (table) => {
    // One subscription per pubkey, so the pubkey is the key.
    table.binary('pubkey').primary().references('pubkey').inTable('users').onDelete('CASCADE')
    table.text('plan_id').notNullable()
    table.enum('status', ['active', 'renewal_pending', 'past_due', 'expired']).notNullable().defaultTo('active')
    table.timestamp('current_period_start', { useTz: true }).notNullable()
    // NULL means the subscription never ends (the grandfathered plan).
    table.timestamp('current_period_end', { useTz: true }).nullable()
    table.timestamp('grace_ends_at', { useTz: true }).nullable()
    table.boolean('cancel_at_period_end').notNullable().defaultTo(false)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    // The renewal and expiry sweeps filter by status and order by the period end.
    table.index(['status', 'current_period_end'], 'idx_user_subscriptions_status_period_end')
  })

  await knex.schema.alterTable('invoices', (table) => {
    table.text('plan_id').nullable()
    table.timestamp('period_start', { useTz: true }).nullable()
    table.timestamp('period_end', { useTz: true }).nullable()
  })

  // Everyone admitted so far keeps access without a paid period: they move onto a plan that never
  // expires, so turning subscription plans on later cannot lock anyone out.
  await knex.raw(`
    INSERT INTO user_subscriptions (pubkey, plan_id, status, current_period_start, current_period_end)
    SELECT pubkey, 'grandfathered', 'active', COALESCE(tos_accepted_at AT TIME ZONE 'UTC', created_at), NULL
    FROM users
    WHERE is_admitted = true
    ON CONFLICT (pubkey) DO NOTHING
  `)
}

exports.down = async function (knex) {
  await knex.schema.alterTable('invoices', (table) => {
    table.dropColumn('plan_id')
    table.dropColumn('period_start')
    table.dropColumn('period_end')
  })

  await knex.schema.dropTable('user_subscriptions')
}
