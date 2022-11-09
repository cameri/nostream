exports.up = function (knex) {
  return knex('events')
    .whereIn('event_kind',  [0, 3])
    .orWhereBetween('event_kind', [10000, 19999])
    .whereNull('event_deduplication')
    .update({
      event_deduplication: knex.raw('jsonb_build_array(right(event_pubkey::text, 64), event_kind)'),
    })
}

exports.down = function (knex) {
  return knex('events')
    .whereIn('event_kind',  [0, 3])
    .orWhereBetween('event_kind', [10000, 19999])
    .whereNotNull('event_deduplication')
    .update({
      event_deduplication: null,
    })
}
