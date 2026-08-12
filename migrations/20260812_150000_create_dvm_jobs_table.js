exports.up = function (knex) {
  return knex.schema.createTable('dvm_jobs', (table) => {
    table.binary('id').primary()
    table.binary('requester_pubkey').notNullable()
    table.integer('kind').unsigned().notNullable()
    table.integer('worker_index').nullable()
    table.enum('status', ['submitted', 'picked_up', 'completed', 'failed', 'timed_out']).notNullable().defaultTo('submitted')
    table.binary('result_event_id').nullable()
    table.text('error').nullable()
    table.timestamp('picked_up_at', { useTz: true }).nullable()
    table.timestamp('completed_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['requester_pubkey'], 'idx_dvm_jobs_requester_pubkey')
    table.index(['status'], 'idx_dvm_jobs_status')
    table.index(['kind'], 'idx_dvm_jobs_kind')
  })
}

exports.down = function (knex) {
  return knex.schema.dropTable('dvm_jobs')
}
