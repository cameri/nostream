import { Knex } from 'knex'
import { __, applySpec, equals, modulo, omit, pipe, prop, cond, always, groupBy, T, evolve, forEach, isEmpty, forEachObjIndexed, isNil, complement, toPairs, filter, nth, ifElse, invoker, identity } from 'ramda'
import { EventId } from '../@types/base'

import { DBEvent, Event } from '../@types/event'
import { IEventRepository, IQueryResult } from '../@types/repositories'
import { SubscriptionFilter } from '../@types/subscription'
import { isGenericTagQuery } from '../utils/filter'
import { toBuffer, toJSON } from '../utils/transform'

const even = pipe(modulo(__, 2), equals(0))

const groupByLengthSpec = groupBy(
  pipe(
    prop('length'),
    cond([
      [equals(64), always('exact')],
      [even, always('even')],
      [T, always('odd')],
    ])
  )
)

export class EventRepository implements IEventRepository {
  public constructor(private readonly dbClient: Knex) {}

  public findByFilters(filters: SubscriptionFilter[]): IQueryResult<DBEvent[]> {
    if (!Array.isArray(filters) || !filters.length) {
      throw new Error('Filters cannot be empty')
    }
    const queries = filters.map((currentFilter) => {
      const builder = this.dbClient<DBEvent>('events')

      forEachObjIndexed((tableField: string, filterName: string) => {
        builder.andWhere((bd) => {
          cond([
            [isEmpty, () => void bd.whereRaw('1 = 0')],
            [
              complement(isNil),
              pipe(
                groupByLengthSpec,
                evolve({
                  exact: (pubkeys: string[]) => void bd.whereIn(tableField, pubkeys.map(toBuffer)),
                  even: forEach((prefix: string) => void bd.orWhereRaw(
                    `substring("${tableField}" from 1 for ?) = ?`,
                    [prefix.length >> 1, toBuffer(prefix)]
                  )),
                  odd: forEach((prefix: string) => void bd.orWhereRaw(
                    `substring("${tableField}" from 1 for ?) BETWEEN ? AND ?`,
                    [
                      (prefix.length >> 1) + 1,
                      `\\x${prefix}0`,
                      `\\x${prefix}f`
                    ],
                  )),
                }),
              ),
            ],
          ])(currentFilter[filterName] as string[])
        })
      })({
        authors: 'event_pubkey',
        ids: 'event_id',
      })

      if (Array.isArray(currentFilter.kinds)) {
        builder.whereIn('event_kind', currentFilter.kinds)
      }

      if (typeof currentFilter.since === 'number') {
        builder.where('event_created_at', '>=', currentFilter.since)
      }

      if (typeof currentFilter.until === 'number') {
        builder.where('event_created_at', '<=', currentFilter.until)
      }

      if (typeof currentFilter.limit === 'number') {
        builder.limit(currentFilter.limit).orderBy('event_created_at', 'DESC')
      } else {
        builder.orderBy('event_created_at', 'asc')
      }

      const andWhereRaw = invoker(1, 'andWhereRaw')
      const orWhereRaw = invoker(2, 'orWhereRaw')

      pipe(
        toPairs,
        filter(pipe(nth(0), isGenericTagQuery)) as any,
        forEach(([filterName, criteria]: [string, string[]]) => {
          builder.andWhere((bd) => {
            ifElse(
              isEmpty,
              () => andWhereRaw('1 = 0', bd),
              forEach((criterion: string[]) => void orWhereRaw(
                '"event_tags" @> ?',
                [
                  JSON.stringify([[filterName[1], criterion]]) as any
                ],
                bd,
              )),
            )(criteria)
          })
        }),
      )(currentFilter as any)

      return builder
    })

    const [query, ...subqueries] = queries
    if (subqueries.length) {
      query.union(subqueries, true)
    }

    return query
  }

  public async create(event: Event): Promise<number> {
    return this.insert(event).then(prop('rowCount') as () => number)
  }

  private insert(event: Event): Knex.QueryBuilder {
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
      .onConflict(this.dbClient.raw('(event_pubkey, event_kind) WHERE event_kind = 0 OR event_kind = 3 OR event_kind >= 10000 AND event_kind < 2000'))
      .merge(omit(['event_pubkey', 'event_kind'])(row))
      .where('events.event_created_at', '<', row.event_created_at)
      .then(prop('rowCount') as () => number)
  }

  public async deleteByPubkeyAndIds(pubkey: string, ids: EventId[]): Promise<number> {
    const query = this.dbClient('events')
      .where({
        event_pubkey: pubkey,
      })
      .whereIn('event_id', ids)
      .delete()

    return query.then(identity)
  }
}
