import { Knex } from 'knex'
import { applySpec, omit, pipe, prop } from 'ramda'
import { PassThrough } from 'stream'

import { DBEvent, Event } from '../@types/event'
import { IEventRepository, IQueryResult } from '../@types/repositories'
import { SubscriptionFilter } from '../@types/subscription'
import { isGenericTagQuery } from '../utils/filter'
import { toBuffer, toJSON } from '../utils/transform'


const evenLengthTruncate = (input: string) => input.substring(0, input.length >> 1 << 1)

export class EventRepository implements IEventRepository {
  public constructor(private readonly dbClient: Knex) {}

  public findByFilters(filters: SubscriptionFilter[]): IQueryResult<DBEvent[]> {
    if (!Array.isArray(filters) || !filters.length) {
      throw new Error('Filters cannot be empty')
    }
    const queries = filters.map((filter) => {
      const builder = this.dbClient<DBEvent>('events')

      if (Array.isArray(filter.authors)) {
        builder.andWhere(function (bd) {
          bd.whereIn(
            'event_pubkey',
            filter.authors.filter((author) => author.length === 64).map(toBuffer)
          )

          for (const author of filter.authors.filter((author) => author.length < 64)) {
            const prefix = evenLengthTruncate(author)
            if (prefix.length) {
              bd.orWhereRaw('substring("event_pubkey" from 1 for ?) = ?', [prefix.length >> 1, toBuffer(prefix)])
            }

          }
        })
      }

      if (Array.isArray(filter.ids)) {
        builder.andWhere(function (bd) {
          bd.whereIn(
            'event_id',
            filter.ids.filter((id) => id.length === 64).map(toBuffer)
          )

          for (const id of filter.ids.filter((id) => id.length < 64)) {
            const prefix = evenLengthTruncate(id)
            if (prefix.length) {
              bd.orWhereRaw('substring("event_id" from 1 for ?) = ?', [prefix.length >> 1, toBuffer(prefix)])
            }
          }
        })
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

      Object.entries(filter)
        .filter(([key, criteria]) => isGenericTagQuery(key) && Array.isArray(criteria))
        .forEach(([key, criteria]) => {
          builder.andWhere(function (bd) {
            criteria.forEach((criterion) => {
              bd.orWhereRaw('"event_tags" @> ?', [JSON.stringify([[key[1], criterion]])])
            })
          })
        })

      return builder
    })

    const [query, ...subqueries] = queries
    if (subqueries.length) {
      query.union(subqueries, true)
    }

    console.log('query', query.toString())

    return query
  }

  public async create(event: Event): Promise<number> {

    const row = applySpec({
      event_id: pipe(prop('id'), toBuffer),
      event_pubkey: pipe(prop('pubkey'), toBuffer),
      event_created_at: prop('created_at'),
      event_kind: prop('kind'),
      event_tags: pipe(prop('tags'), toJSON),
      event_content: prop('content'),
      event_signature: pipe(prop('sig'), toBuffer),
    })(event)

    return this.dbClient('events')
      .insert(row)
      .onConflict()
      .ignore()
      .then(prop('rowCount') as () => number)
  }


  public async upsert(event: Event): Promise<number> {
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

    return this.dbClient('events')
      .insert(row)
      // NIP-16: Replaceable Events
      .onConflict(this.dbClient.raw('(event_pubkey, event_kind) WHERE event_kind = 0 OR event_kind >= 10000 AND event_kind < 2000'))
      .merge(omit(['event_pubkey', 'event_kind'])(row))
      .where('events.event_created_at', '<', row.event_created_at)
      .then(prop('rowCount') as () => number)
  }
}
