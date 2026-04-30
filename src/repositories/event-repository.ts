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

import {
  ContextMetadataKey,
  DEFAULT_FILTER_LIMIT,
  EventDeduplicationMetadataKey,
  EventExpirationTimeMetadataKey,
  EventKinds,
} from '../constants/base'
import { DatabaseClient, EventId } from '../@types/base'
import { DBEvent, Event } from '../@types/event'
import { EventPurgeCounts, EventRetentionOptions, IEventRepository, IQueryResult } from '../@types/repositories'
import { toBuffer, toJSON } from '../utils/transform'
import { createLogger } from '../factories/logger-factory'
import { isGenericTagQuery, isGeohashPrefixCriterion, stripGeohashPrefixWildcard } from '../utils/filter'
import { SubscriptionFilter } from '../@types/subscription'

const even = pipe(modulo(__, 2), equals(0))

const groupByLengthSpec = groupBy<string, 'exact' | 'even' | 'odd'>(
  pipe(
    prop('length'),
    cond([
      [equals(64), always('exact')],
      [even, always('even')],
      [T, always('odd')],
    ]),
  ),
)

const logger = createLogger('event-repository')

export class EventRepository implements IEventRepository {
  public constructor(
    private readonly masterDbClient: DatabaseClient,
    private readonly readReplicaDbClient: DatabaseClient,
  ) {}

  public findByFilters(filters: SubscriptionFilter[]): IQueryResult<DBEvent[]> {
    logger('querying for %o', filters)
    if (!Array.isArray(filters) || !filters.length) {
      throw new Error('Filters cannot be empty')
    }
    const queries = filters.map((currentFilter) => {
      const builder = this.readReplicaDbClient<DBEvent>('events')

      const isTagQuery = this.applyFilterConditions(builder, currentFilter)

      if (typeof currentFilter.limit === 'number') {
        builder.limit(currentFilter.limit).orderBy('event_created_at', 'DESC').orderBy('event_id', 'asc')
      } else {
        builder.limit(DEFAULT_FILTER_LIMIT).orderBy('event_created_at', 'asc').orderBy('event_id', 'asc')
      }

      if (isTagQuery) {
        builder.select('events.*')
      }

      return builder
    })

    const [query, ...subqueries] = queries
    if (subqueries.length) {
      query.union(subqueries, true)
    }

    return query
  }

  public async countByFilters(filters: SubscriptionFilter[]): Promise<number> {
    logger('counting events for %o', filters)

    if (!Array.isArray(filters) || !filters.length) {
      throw new Error('Filters cannot be empty')
    }

    const now = Math.floor(Date.now() / 1000)

    const queries = filters.map((currentFilter) => {
      const builder = this.readReplicaDbClient<DBEvent>('events').select('events.event_id')

      const isTagQuery = this.applyFilterConditions(builder, currentFilter)

      if (typeof currentFilter.limit === 'number') {
        builder.limit(currentFilter.limit).orderBy('event_created_at', 'DESC').orderBy('event_id', 'asc')
      }

      if (isTagQuery) {
        builder.select('events.event_id')
      }

      builder.whereNull('events.deleted_at').andWhere((bd) => {
        bd.whereNull('events.expires_at').orWhere('events.expires_at', '>', now)
      })

      return builder
    })

    const [query, ...subqueries] = queries
    if (subqueries.length) {
      query.union(subqueries, true)
    }

    const result = await this.readReplicaDbClient.from(query.as('matching_events')).countDistinct({ count: 'event_id' }).first()

    return Number(result?.count ?? 0)
  }

  private applyFilterConditions(builder: any, currentFilter: SubscriptionFilter): boolean {
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
                  tableFields.forEach((tableField) => bd.orWhereIn(tableField, pubkeys.map(toBuffer))),
                even: forEach((prefix: string) =>
                  tableFields.forEach((tableField) =>
                    bd.orWhereRaw(`substring("${tableField}" from 1 for ?) = ?`, [prefix.length >> 1, toBuffer(prefix)]),
                  ),
                ),
                odd: forEach((prefix: string) =>
                  tableFields.forEach((tableField) =>
                    bd.orWhereRaw(`substring("${tableField}" from 1 for ?) BETWEEN ? AND ?`, [
                      (prefix.length >> 1) + 1,
                      `\\x${prefix}0`,
                      `\\x${prefix}f`,
                    ]),
                  ),
                ),
              } as any),
            ),
          ],
        ])(currentFilter[filterName] as string[])
      })
    })({ authors: ['event_pubkey'], ids: ['event_id'] })

    if (Array.isArray(currentFilter.kinds)) {
      builder.whereIn('event_kind', currentFilter.kinds)
    }

    if (typeof currentFilter.since === 'number') {
      builder.where('event_created_at', '>=', currentFilter.since)
    }

    if (typeof currentFilter.until === 'number') {
      builder.where('event_created_at', '<=', currentFilter.until)
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
            forEach(
              (criterion: string) => {
                if (isGeohashPrefixCriterion(filterName, criterion)) {
                  return void orWhereRaw(
                    'event_tags.tag_name = ? AND event_tags.tag_value LIKE ?',
                    [filterName[1], `${stripGeohashPrefixWildcard(criterion)}%`],
                    bd,
                  )
                }

                return void orWhereRaw(
                  'event_tags.tag_name = ? AND event_tags.tag_value = ?',
                  [filterName[1], criterion],
                  bd,
                )
              },
            ),
          )(criteria)
        })
      }),
    )(currentFilter as any)

    if (isTagQuery) {
      builder.leftJoin('event_tags', 'events.event_id', 'event_tags.event_id')
    }

    return isTagQuery
  }

  public async create(event: Event): Promise<number> {
    return this.insert(event).then(prop('rowCount') as () => number, () => 0)
  }

  public async createMany(events: Event[]): Promise<number> {
    if (!events.length) {
      return 0
    }

    const rows = events.map((event) => this.toInsertRow(event))

    return this.masterDbClient('events')
      .insert(rows)
      .onConflict()
      .ignore()
      .then(prop('rowCount') as () => number, () => 0)
  }

  private toInsertRow(event: Event) {
    return applySpec({
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
  }

  private insert(event: Event) {
    logger('inserting event: %o', event)
    const row = this.toInsertRow(event)

    return this.masterDbClient('events').insert(row).onConflict().ignore()
  }

  public upsert(event: Event): Promise<number> {
    logger('upserting event: %o', event)

    const row = this.toUpsertRow(event)

    const query = this.masterDbClient('events')
      .insert(row)
      // NIP-16: Replaceable Events
      // NIP-33: Parameterized Replaceable Events
      .onConflict(
        this.masterDbClient.raw(
          '(event_pubkey, event_kind, event_deduplication) WHERE (event_kind = 0 OR event_kind = 3 OR event_kind = 41 OR (event_kind >= 10000 AND event_kind < 20000)) OR (event_kind >= 30000 AND event_kind < 40000)',
        ),
      )
      .merge(omit(['event_pubkey', 'event_kind', 'event_deduplication'])(row))
      .where(function () {
        this.where('events.event_created_at', '<', row.event_created_at).orWhere(function () {
          this.where('events.event_created_at', '=', row.event_created_at).andWhere(
            'events.event_id',
            '>',
            row.event_id,
          )
        })
      })

    return {
      then: <T1, T2>(
        onfulfilled: (value: number) => T1 | PromiseLike<T1>,
        onrejected: (reason: any) => T2 | PromiseLike<T2>,
      ) => query.then(prop('rowCount') as () => number).then(onfulfilled, onrejected),
      catch: <T>(onrejected: (reason: any) => T | PromiseLike<T>) => query.catch(onrejected),
      toString: (): string => query.toString(),
    } as Promise<number>
  }

  public async upsertMany(events: Event[]): Promise<number> {
    if (!events.length) {
      return 0
    }

    const rows = events.map((event) => this.toUpsertRow(event))

    return this.masterDbClient('events')
      .insert(rows)
      .onConflict(
        this.masterDbClient.raw(
          '(event_pubkey, event_kind, event_deduplication) WHERE (event_kind = 0 OR event_kind = 3 OR event_kind = 41 OR (event_kind >= 10000 AND event_kind < 20000)) OR (event_kind >= 30000 AND event_kind < 40000)',
        ),
      )
      .merge([
        'deleted_at',
        'event_content',
        'event_created_at',
        'event_id',
        'event_signature',
        'event_tags',
        'expires_at',
      ])
      .whereRaw(
        '("events"."event_created_at" < "excluded"."event_created_at" or ("events"."event_created_at" = "excluded"."event_created_at" and "events"."event_id" > "excluded"."event_id"))',
      )
      .then(prop('rowCount') as () => number, () => 0)
  }

  private toUpsertRow(event: Event) {
    const toJSON = (input: any) => JSON.stringify(input)

    return applySpec<DBEvent>({
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
  }

  public deleteByPubkeyAndIds(pubkey: string, eventIdsToDelete: EventId[]): Promise<number> {
    logger('deleting events from %s: %o', pubkey, eventIdsToDelete)

    return this.masterDbClient('events')
      .where('event_pubkey', toBuffer(pubkey))
      .whereIn('event_id', map(toBuffer)(eventIdsToDelete))
      .whereNot('event_kind', EventKinds.REQUEST_TO_VANISH)
      .whereNull('deleted_at')
      .update({
        deleted_at: this.masterDbClient.raw('now()'),
      })
  }

  public deleteByPubkeyExceptKinds(pubkey: string, excludedKinds: number[]): Promise<number> {
    logger('deleting events from %s except kinds %o', pubkey, excludedKinds)

    return this.masterDbClient('events')
      .where('event_pubkey', toBuffer(pubkey))
      .whereNotIn('event_kind', excludedKinds)
      .whereNull('deleted_at')
      .update({
        deleted_at: this.masterDbClient.raw('now()'),
      })
  }

  public async hasActiveRequestToVanish(pubkey: string): Promise<boolean> {
    const result = await this.readReplicaDbClient('events')
      .select('event_id')
      .where('event_pubkey', toBuffer(pubkey))
      .where('event_kind', EventKinds.REQUEST_TO_VANISH)
      .whereNull('deleted_at')
      .first()

    return Boolean(result)
  }

  public deleteExpiredAndRetained(options?: EventRetentionOptions): Promise<EventPurgeCounts> {
    const now = Math.floor(Date.now() / 1000)
    const maxDays = options?.maxDays

    if (typeof maxDays !== 'number' || isNaN(maxDays) || maxDays <= 0) {
      logger('skipping purge: retention.maxDays is not a positive number')
      return Promise.resolve({
        deleted: 0,
        expired: 0,
        retained: 0,
      })
    }

    const retentionLimit = now - maxDays * 86400
    const batchSize = 1000

    logger(
      'deleting expired and retained events (retentionLimit: %d, now: %d, batchSize: %d)',
      retentionLimit,
      now,
      batchSize,
    )

    const kindWhitelist = [
      ...(Array.isArray(options?.kindWhitelist) ? options.kindWhitelist : []),
      EventKinds.REQUEST_TO_VANISH,
    ].reduce<(number | [number, number])[]>((result, item) => {
      const key = Array.isArray(item) ? `range:${item[0]}-${item[1]}` : `kind:${item}`

      if (
        !result.some((existing) => {
          const existingKey = Array.isArray(existing) ? `range:${existing[0]}-${existing[1]}` : `kind:${existing}`
          return existingKey === key
        })
      ) {
        result.push(item)
      }

      return result
    }, [])

    const candidates = this.masterDbClient('events')
      .select('event_id')
      .where(function () {
        this.where('expires_at', '<', now).orWhereNotNull('deleted_at').orWhere('event_created_at', '<', retentionLimit)
      })
      .modify((query) => {
        query.whereNot((builder) => {
          kindWhitelist.forEach((kindOrRange) => {
            if (Array.isArray(kindOrRange)) {
              builder.orWhereBetween('event_kind', kindOrRange)
            } else {
              builder.orWhere('event_kind', kindOrRange)
            }
          })
        })

        if (Array.isArray(options?.pubkeyWhitelist) && options.pubkeyWhitelist.length > 0) {
          query.whereNotIn('event_pubkey', map(toBuffer)(options.pubkeyWhitelist))
        }
      })
      .limit(batchSize)

    const query = this.masterDbClient('events')
      .whereIn('event_id', candidates)
      .del(['deleted_at', 'expires_at', 'event_created_at'])

    const mapToCounts = (
      deletedRows: Pick<DBEvent, 'deleted_at' | 'expires_at' | 'event_created_at'>[],
    ): EventPurgeCounts =>
      deletedRows.reduce(
        (counts, row) => {
          if (row.deleted_at) {
            counts.deleted += 1
          } else if (typeof row.expires_at === 'number' && row.expires_at < now) {
            counts.expired += 1
          } else if (row.event_created_at < retentionLimit) {
            counts.retained += 1
          }

          return counts
        },
        {
          deleted: 0,
          expired: 0,
          retained: 0,
        },
      )

    const getPromise = () => query.then((rows: any) => mapToCounts(rows))

    return {
      then: <T1, T2>(
        onfulfilled?: ((value: EventPurgeCounts) => T1 | PromiseLike<T1>) | null,
        onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null,
      ) => getPromise().then(onfulfilled as any, onrejected as any),
      catch: <T>(onrejected?: ((reason: any) => T | PromiseLike<T>) | null) => getPromise().catch(onrejected as any),
      finally: (onfinally?: (() => void) | null) => getPromise().finally(onfinally as any),
      toString: (): string => query.toString(),
    } as Promise<EventPurgeCounts> & { toString(): string }
  }
}
