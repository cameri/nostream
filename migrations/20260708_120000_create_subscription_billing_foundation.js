exports.up = async function (knex) {
  await knex.schema.createTable('user_subscriptions', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('uuid_generate_v4()'))
    table.binary('pubkey').primary()
    table.text('plan_id').notNullable()
    table
      .enum('status', ['active', 'renewal_pending', 'past_due', 'expired', 'canceled'], {
        useNative: true,
        enumName: 'subscription_status',
      })
      .notNullable()
    table.timestamp('current_period_start', { useTz: true }).notNullable()
    table.timestamp('current_period_end', { useTz: true }).notNullable()
    table.timestamp('grace_until', { useTz: true }).nullable()
    table.boolean('cancel_at_period_end').notNullable().defaultTo(false)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.raw('CREATE UNIQUE INDEX user_subscriptions_id_idx ON user_subscriptions(id)')

  await knex.raw(
    'ALTER TABLE user_subscriptions ADD CONSTRAINT user_subscriptions_pubkey_fkey FOREIGN KEY (pubkey) REFERENCES users(pubkey) ON DELETE CASCADE',
  )

  await knex.raw(
    'CREATE INDEX user_subscriptions_status_period_end_idx ON user_subscriptions(status, current_period_end)',
  )

  await knex.schema.alterTable('invoices', (table) => {
    table
      .enum('fee_schedule', ['admission', 'subscription', 'publication'], {
        useNative: true,
        enumName: 'invoice_fee_schedule',
      })
      .notNullable()
      .defaultTo('admission')
    table.text('plan_id').nullable()
    table.uuid('subscription_id').nullable()
    table.timestamp('period_start', { useTz: true }).nullable()
    table.timestamp('period_end', { useTz: true }).nullable()
  })

  await knex.raw(
    'ALTER TABLE invoices ADD CONSTRAINT invoices_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id) ON DELETE SET NULL',
  )
}

exports.down = async function (knex) {
  await knex.schema.alterTable('invoices', (table) => {
    table.dropForeign('subscription_id')
    table.dropColumn('period_end')
    table.dropColumn('period_start')
    table.dropColumn('subscription_id')
    table.dropColumn('plan_id')
    table.dropColumn('fee_schedule')
  })

  await knex.schema.dropTableIfExists('user_subscriptions')

  await knex.raw('DROP TYPE IF EXISTS invoice_fee_schedule')
  await knex.raw('DROP TYPE IF EXISTS subscription_status')
}
