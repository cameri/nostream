exports.up = function (knex) {
  return knex.schema.createTable('notification_delivery_log', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'))
    table.uuid('outbox_id').nullable()
    table.text('event_type').notNullable()
    table.text('target_id').notNullable()
    table.enum('target_type', ['http', 'discord', 'slack', 'telegram']).notNullable()
    table.enum('status', ['success', 'failed']).notNullable()
    table.integer('attempt_number').unsigned().notNullable()
    table.text('error_snippet').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['created_at'], 'idx_notification_delivery_log_created_at')
    table.index(['event_type', 'created_at'], 'idx_notification_delivery_log_event_created_at')
    table.foreign('outbox_id').references('id').inTable('notification_outbox').onDelete('SET NULL')
  })
}

exports.down = function (knex) {
  return knex.schema.dropTable('notification_delivery_log')
}
