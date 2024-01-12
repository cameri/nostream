import {
  __,
  always,
  applySpec,
  complement,
  cond,
  equals,
  evolve,
  filter,
  forEach,
  forEachObjIndexed,
  groupBy,
  ifElse,
  invoker,
  is,
  isEmpty,
  isNil,
  map,
  modulo,
  nth,
  omit,
  path,
  paths,
  pipe,
  prop,
  propSatisfies,
  T,
  toPairs,
} from 'ramda'

import { ContextMetadataKey, EventDeduplicationMetadataKey, EventExpirationTimeMetadataKey } from '../constants/base'
import { DatabaseClient, EventId } from '../@types/base'
import { DBEvent, Event } from '../@types/event'
import { IEventRepository, IQueryResult } from '../@types/repositories'
import { toBuffer, toJSON } from '../utils/transform'
import { createLogger } from '../factories/logger-factory'
import { isGenericTagQuery } from '../utils/filter'
import { SubscriptionFilter } from '../@types/subscription'

const even = pipe(modulo(__, 2), equals(0))

const groupByLengthSpec = groupBy<string, 'exact' | 'even' | 'odd'>(
  pipe(
    prop('length'),
    cond([
      [equals(64), always('exact')],
      [even, always('even')],
      [T, always('odd')],
    ])
  )
)

const debug = createLogger('event-repository')

export class EventRepository implements IEventRepository {
  public constructor(
    private readonly masterDbClient: DatabaseClient,
    private readonly readReplicaDbClient: DatabaseClient,
  ) { }

  public findByFilters(filters: SubscriptionFilter[]): IQueryResult<DBEvent[]> {
    debug('querying for %o', filters)
    if (!Array.isArray(filters) || !filters.length) {
      throw new Error('Filters cannot be empty')
    }
    const queries = filters.map((currentFilter) => {
      const builder = this.readReplicaDbClient<DBEvent>('events')

      forEachObjIndexed((tableFields: string[], filterName: string | number) => {
        builder.andWhere((bd) => {
          cond([
            [isEmpty, () => void bd.whereRaw('1 = 0')],
            [
              complement(isNil),
              pipe(
                groupByLengthSpec,
                evolve({
                  exact: (pubkeys: string[]) =>
                    tableFields.forEach((tableField) =>
                      bd.orWhereIn(tableField, pubkeys.map(toBuffer))
                    ),
                  even: forEach((prefix: string) =>
                    tableFields.forEach((tableField) =>
                      bd.orWhereRaw(
                        `substring("${tableField}" from 1 for ?) = ?`,
                        [prefix.length >> 1, toBuffer(prefix)]
                      )
                    )
                  ),
                  odd: forEach((prefix: string) =>
                    tableFields.forEach((tableField) =>
                      bd.orWhereRaw(
                        `substring("${tableField}" from 1 for ?) BETWEEN ? AND ?`,
                        [
                          (prefix.length >> 1) + 1,
                          `\\x${prefix}0`,
                          `\\x${prefix}f`,
                        ],
                      )
                    )
                  ),
                } as any),
              ),
            ],
          ])(currentFilter[filterName] as string[])
        })
      })({
        authors: ['event_pubkey'],
        ids: ['event_id'],
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
        builder.limit(500).orderBy('event_created_at', 'asc')
      }

      const andWhereRaw = invoker(1, 'andWhereRaw')
      const orWhereRaw = invoker(2, 'orWhereRaw')

      let isTagQuery = false
      pipe(
        toPairs,
        filter(pipe(nth(0) as () => string, isGenericTagQuery)) as any,
        forEach(([filterName, criteria]: [string, string[]]) => {
          isTagQuery = true
          builder.andWhere((bd) => {
            ifElse(
              isEmpty,
              () => andWhereRaw('1 = 0', bd),
              forEach((criterion: string) => void orWhereRaw(
                'event_tags.tag_name = ? AND event_tags.tag_value = ?',
                [filterName[1], criterion],
                bd,
              )),
            )(criteria)
          })
        }),
      )(currentFilter as any)

      if (isTagQuery) {
        builder.leftJoin('event_tags', 'events.event_id', 'event_tags.event_id')
          .select('events.*')
      }

      return builder
    })

    const [query, ...subqueries] = queries
    if (subqueries.length) {
      query.union(subqueries, true)
    }

    return query
  }

  public async create(event: Event): Promise<number> {
    return this.insert(event).then(prop('rowCount') as () => number, () => 0)
  }

  private insert(event: Event) {
    debug('inserting event: %o', event)
    const row = applySpec({
      event_id: pipe(prop('id'), toBuffer),
      event_pubkey: pipe(prop('pubkey'), toBuffer),
      event_created_at: prop('created_at'),
      event_kind: prop('kind'),
      event_tags: pipe(prop('tags'), toJSON),
      event_content: prop('content'),
      event_signature: pipe(prop('sig'), toBuffer),
      remote_address: path([ContextMetadataKey as any, 'remoteAddress', 'address']),
      expires_at: ifElse(
        propSatisfies(is(Number), EventExpirationTimeMetadataKey),
        prop(EventExpirationTimeMetadataKey as any),
        always(null),
      ),
    })(event)

    return this.masterDbClient('events')
      .insert(row)
      .onConflict()
      .ignore()
  }

  public upsert(event: Event): Promise<number> {
    debug('upserting event: %o', event)

    const toJSON = (input: any) => JSON.stringify(input)

    const row = applySpec<DBEvent>({
      event_id: pipe(prop('id'), toBuffer),
      event_pubkey: pipe(prop('pubkey'), toBuffer),
      event_created_at: prop('created_at'),
      event_kind: prop('kind'),
      event_tags: pipe(prop('tags'), toJSON),
      event_content: prop('content'),
      event_signature: pipe(prop('sig'), toBuffer),
      event_deduplication: ifElse(
        propSatisfies(isNil, EventDeduplicationMetadataKey),
        pipe(paths([['pubkey'], ['kind']]), toJSON),
        pipe(prop(EventDeduplicationMetadataKey as any), toJSON),
      ),
      remote_address: path([ContextMetadataKey as any, 'remoteAddress', 'address']),
      expires_at: ifElse(
        propSatisfies(is(Number), EventExpirationTimeMetadataKey),
        prop(EventExpirationTimeMetadataKey as any),
        always(null),
      ),
      deleted_at: always(null),
    })(event)

    const query = this.masterDbClient('events')
      .insert(row)
      // NIP-16: Replaceable Events
      // NIP-33: Parameterized Replaceable Events
      .onConflict(
        this.masterDbClient.raw(
          '(event_pubkey, event_kind, event_deduplication) WHERE (event_kind = 0 OR event_kind = 3 OR event_kind = 41 OR (event_kind >= 10000 AND event_kind < 20000)) OR (event_kind >= 30000 AND event_kind < 40000)'
        )
      )
      .merge(omit(['event_pubkey', 'event_kind', 'event_deduplication'])(row))
      .where('events.event_created_at', '<', row.event_created_at)

    return {
      then: <T1, T2>(onfulfilled: (value: number) => T1 | PromiseLike<T1>, onrejected: (reason: any) => T2 | PromiseLike<T2>) => query.then(prop('rowCount') as () => number).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<number>
  }

  public deleteByPubkeyAndIds(pubkey: string, eventIdsToDelete: EventId[]): Promise<number> {
    debug('deleting events from %s: %o', pubkey, eventIdsToDelete)

    return this.masterDbClient('events')
      .where('event_pubkey', toBuffer(pubkey))
      .whereIn('event_id', map(toBuffer)(eventIdsToDelete))
      .whereNull('deleted_at')
      .update({
        deleted_at: this.masterDbClient.raw('now()'),
      })
  }
}
