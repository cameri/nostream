exports.up = function (knex) {
  return knex.schema.createTable('dvm_jobs', (table) => {
    table.binary('id').primary()
    table.binary('requester_pubkey').notNullable()
    table.integer('kind').unsigned().notNullable()
    table.integer('worker_index').nullable()
    table
      .enum('status', ['submitted', 'picked_up', 'completed', 'failed', 'timed_out'])
      .notNullable()
      .defaultTo('submitted')
    table.binary('result_event_id').nullable()
    table.text('error').nullable()
    table.timestamp('picked_up_at', { useTz: true }).nullable()
    table.timestamp('completed_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['requester_pubkey'], 'idx_dvm_jobs_requester_pubkey')
    // Composite (not status-only): findPendingJobs() filters by status AND
    // orders by created_at, so the index needs to satisfy both the filter
    // and the sort for FIFO polling, same as invoices_pending_created_at_idx.
    table.index(['status', 'created_at'], 'idx_dvm_jobs_status_created_at')
    table.index(['kind'], 'idx_dvm_jobs_kind')
  })
}

exports.down = function (knex) {
  return knex.schema.dropTable('dvm_jobs')
}
