exports.up = function (knex) {
  return knex.schema.createTable('reports', (table) => {
    // Auto-increment, not the report event's own id: a single kind-1984 event
    // can carry a p tag and an e tag with different report types (two
    // distinct claims), which needs two rows -- see event_id below for the
    // link back to the source event.
    table.increments('id').primary()
    table.binary('event_id').notNullable()
    table.binary('reporter_pubkey').notNullable()
    table.binary('reported_pubkey').nullable()
    table.binary('reported_event_id').nullable()
    table
      .enum('report_type', ['nudity', 'malware', 'profanity', 'illegal', 'spam', 'impersonation', 'other'])
      .notNullable()
    table.float('weight').notNullable()
    table.boolean('actionable').notNullable().defaultTo(false)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.index(['event_id'], 'idx_reports_event_id')
    table.index(['reported_pubkey'], 'idx_reports_reported_pubkey')
    table.index(['reported_event_id'], 'idx_reports_reported_event_id')
    table.index(['reporter_pubkey'], 'idx_reports_reporter_pubkey')
    // Serves the future Month-5 management API's "actionable reports needing
    // review" query -- filter by actionable, ordered newest-first.
    table.index(['actionable', 'created_at'], 'idx_reports_actionable_created_at')
  })
}

exports.down = function (knex) {
  return knex.schema.dropTable('reports')
}
