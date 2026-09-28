exports.up = function (knex) {
  return knex.schema.createTable('notification_outbox', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    table.text('event_type').notNullable()
    table.jsonb('payload').notNullable()
    table
      .enum('status', ['pending', 'processing', 'delivered', 'dead'])
      .notNullable()
      .defaultTo('pending')
    table.integer('attempt_count').unsigned().notNullable().defaultTo(0)
    table.timestamp('available_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.text('last_error').nullable()
    table.timestamp('delivered_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['status', 'available_at', 'created_at'], 'idx_notification_outbox_dispatch')
    table.index(['event_type', 'created_at'], 'idx_notification_outbox_event_type_created_at')
  })
}

exports.down = function (knex) {
  return knex.schema.dropTable('notification_outbox')
}
