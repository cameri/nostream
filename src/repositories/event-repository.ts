import { Knex } from 'knex'
import { applySpec, pipe, prop } from 'ramda'

import { DBEvent, Event } from '../types/event'
import { IEventRepository } from '../types/repositories'
import { SubscriptionFilter } from '../types/subscription'

const toBuffer = (input: any) => Buffer.from(input, 'hex')

const fromBuffer = (input: Buffer) => input.toString('hex')

export class EventRepository implements IEventRepository {
  public constructor(private readonly dbClient: Knex) {}

  public async findByfilters(filters: SubscriptionFilter[]): Promise<Event[]> {
    const queries = filters.map((filter) => {
      const builder = this.dbClient<DBEvent>('events')

      if (Array.isArray(filter.authors)) {
        builder.whereIn('event_pubkey', filter.authors.map(toBuffer))
      }

      if (Array.isArray(filter.ids)) {
        builder.whereIn('event_id', filter.ids.map(toBuffer))
      }

      if (Array.isArray(filter.kinds)) {
        builder.whereIn('event_kind', filter.kinds)
      }

      if (typeof filter.since === 'number') {
        builder.where('event_created_at', '>=', filter.since)
      }

      if (typeof filter.until === 'number') {
        builder.where('event_created_at', '<=', filter.until)
      }

      if (typeof filter.limit === 'number') {
        builder.limit(filter.limit).orderBy('event_created_at', 'DESC')
      } else {
        builder.orderBy('event_created_at', 'asc')
      }

      return builder
    })

    const [query, ...subqueries] = queries
    if (subqueries.length) {
      query.union(subqueries)
    }

    console.log('Query', query.toString())

    return query.then((rows) =>
      rows.map(
        (row) =>
          applySpec({
            id: pipe(prop('event_id'), fromBuffer),
            kind: prop('event_kind'),
            pubkey: pipe(prop('event_pubkey'), fromBuffer),
            created_at: prop('event_created_at'),
            content: prop('event_content'),
            tags: prop('event_tags'),
            sig: pipe(prop('event_signature'), fromBuffer),
          })(row) as Event,
      ),
    )
  }

  public async create(event: Event): Promise<void> {
    console.log('Creating event', event)

    const toJSON = (input: any) => JSON.stringify(input)

    const row = applySpec({
      event_id: pipe(prop('id'), toBuffer),
      event_pubkey: pipe(prop('pubkey'), toBuffer),
      event_created_at: prop('created_at'),
      event_kind: prop('kind'),
      event_tags: pipe(prop('tags'), toJSON),
      event_content: prop('content'),
      event_signature: pipe(prop('sig'), toBuffer),
    })(event)

    return void this.dbClient('events')
      .insert(row)
      .onConflict('event_id')
      .ignore()
      .then((number) => {
        console.log(`Rows added`, (number as any).rowCount)
      })
  }
}
