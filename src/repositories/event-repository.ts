import {
  always,
  applySpec,
  ifElse,
  is,
  isNil,
  map,
  omit,
  path,
  paths,
  pipe,
  prop,
  propSatisfies,
} from 'ramda'
import { Settings } from '../@types/settings'

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

const logger = createLogger('event-repository')
const RETENTION_BATCH_SIZE = 1000
const SECONDS_PER_DAY = 86400

type HexCriterionGroups = {
  exact: string[]
  even: string[]
  odd: string[]
}

/** Default text-search configuration when nip50.language is unset. */
const DEFAULT_TS_CONFIG = 'simple'
/** Maximum search query length when nip50.maxQueryLength is unset. */
const DEFAULT_MAX_SEARCH_QUERY_LENGTH = 256

interface FilterConditionFlags {
  isTagQuery: boolean
  isSearchQuery: boolean
}

export class EventRepository implements IEventRepository {
  public constructor(
    private readonly masterDbClient: DatabaseClient,
    private readonly readReplicaDbClient: DatabaseClient,
    private readonly settings?: () => Settings,
  ) {}

  public findByFilters(filters: SubscriptionFilter[]): IQueryResult<DBEvent[]> {
    logger('querying for %o', filters)
    if (!Array.isArray(filters) || !filters.length) {
      throw new Error('Filters cannot be empty')
    }
    const queries = filters.map((currentFilter) => {
      const builder = this.readReplicaDbClient<DBEvent>('events')

      const { isTagQuery, isSearchQuery } = this.applyFilterConditions(builder, currentFilter)

      if (isSearchQuery) {
        // NIP-50: sort by relevance (ts_rank) descending, then by event_id for stability
        const tsConfig = this.getNip50Language()
        const nip50Settings = this.settings?.()
        const maxLen = nip50Settings?.nip50?.maxQueryLength ?? DEFAULT_MAX_SEARCH_QUERY_LENGTH
        const searchQuery = currentFilter.search.trim().slice(0, maxLen)
        const limit = typeof currentFilter.limit === 'number' ? currentFilter.limit : DEFAULT_FILTER_LIMIT
        builder
          .select(
            this.readReplicaDbClient.raw(
              'events.*, ts_rank(to_tsvector(?::regconfig, event_content), plainto_tsquery(?::regconfig, ?)) AS search_rank',
              [tsConfig, tsConfig, searchQuery],
            ),
          )
          .limit(limit)
          .orderBy('search_rank', 'DESC')
          .orderBy('event_id', 'asc')
      } else if (typeof currentFilter.limit === 'number') {
        builder.limit(currentFilter.limit).orderBy('event_created_at', 'DESC').orderBy('event_id', 'asc')
      } else {
        builder.limit(DEFAULT_FILTER_LIMIT).orderBy('event_created_at', 'asc').orderBy('event_id', 'asc')
      }

      if (isTagQuery && !isSearchQuery) {
        builder.distinct('events.*')
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

      const { isTagQuery } = this.applyFilterConditions(builder, currentFilter)

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

  private applyFilterConditions(builder: any, currentFilter: SubscriptionFilter): FilterConditionFlags {
    this.applyHexFilterConditions(builder, currentFilter)

    if (Array.isArray(currentFilter.kinds)) {
      builder.whereIn('event_kind', currentFilter.kinds)
    }

    if (typeof currentFilter.since === 'number') {
      builder.where('event_created_at', '>=', currentFilter.since)
    }

    if (typeof currentFilter.until === 'number') {
      builder.where('event_created_at', '<=', currentFilter.until)
    }

    // NIP-50: full-text search condition
    let isSearchQuery = false
    if (typeof currentFilter.search === 'string' && currentFilter.search.trim().length > 0) {
      const nip50Settings = this.settings?.()
      if (nip50Settings?.nip50?.enabled) {
        const tsConfig = this.getNip50Language()
        const maxLen = nip50Settings.nip50.maxQueryLength ?? DEFAULT_MAX_SEARCH_QUERY_LENGTH
        const searchQuery = currentFilter.search.trim().slice(0, maxLen)
        builder.andWhereRaw(
          'to_tsvector(?::regconfig, event_content) @@ plainto_tsquery(?::regconfig, ?)',
          [tsConfig, tsConfig, searchQuery],
        )
        isSearchQuery = true
      }
    }

    const isTagQuery = this.applyGenericTagFilterConditions(builder, currentFilter)

    if (isTagQuery) {
      builder.leftJoin('event_tags', 'events.event_id', 'event_tags.event_id')
    }

    return { isTagQuery, isSearchQuery }
  }

  /** Resolve the PostgreSQL text-search configuration name from settings. */
  private getNip50Language(): string {
    return this.settings?.()?.nip50?.language ?? DEFAULT_TS_CONFIG
  }

  private applyHexFilterConditions(builder: any, currentFilter: SubscriptionFilter): void {
    builder.andWhere((bd) => {
      this.applyHexCriteria(bd, ['event_pubkey'], currentFilter.authors)
    })

    builder.andWhere((bd) => {
      this.applyHexCriteria(bd, ['event_id'], currentFilter.ids)
    })
  }

  private applyHexCriteria(builder: any, tableFields: string[], criteria?: string[]): void {
    if (typeof criteria === 'undefined') {
      return
    }

    if (!criteria.length) {
      builder.whereRaw('1 = 0')
      return
    }

    const groups = this.groupHexCriteria(criteria)

    tableFields.forEach((tableField) => {
      if (groups.exact.length) {
        builder.orWhereIn(tableField, groups.exact.map(toBuffer))
      }

      groups.even.forEach((prefix) => {
        builder.orWhereRaw(`substring("${tableField}" from 1 for ?) = ?`, [prefix.length >> 1, toBuffer(prefix)])
      })

      groups.odd.forEach((prefix) => {
        builder.orWhereRaw(`substring("${tableField}" from 1 for ?) BETWEEN ? AND ?`, [
          (prefix.length >> 1) + 1,
          `\\x${prefix}0`,
          `\\x${prefix}f`,
        ])
      })
    })
  }

  private groupHexCriteria(criteria: string[]): HexCriterionGroups {
    return criteria.reduce<HexCriterionGroups>(
      (groups, criterion) => {
        if (criterion.length === 64) {
          groups.exact.push(criterion)
        } else if (criterion.length % 2 === 0) {
          groups.even.push(criterion)
        } else {
          groups.odd.push(criterion)
        }

        return groups
      },
      {
        exact: [],
        even: [],
        odd: [],
      },
    )
  }

  private applyGenericTagFilterConditions(builder: any, currentFilter: SubscriptionFilter): boolean {
    const tagFilters = Object.entries(currentFilter).filter(([filterName]) => isGenericTagQuery(filterName))

    tagFilters.forEach(([filterName, criteria]) => {
      this.applyGenericTagCriteria(builder, filterName, criteria as string[])
    })

    return tagFilters.length > 0
  }

  private applyGenericTagCriteria(builder: any, filterName: string, criteria: string[]): void {
    builder.andWhere((bd) => {
      if (!criteria.length) {
        bd.andWhereRaw('1 = 0')
        return
      }

      criteria.forEach((criterion) => {
        if (isGeohashPrefixCriterion(filterName, criterion)) {
          bd.orWhereRaw('event_tags.tag_name = ? AND event_tags.tag_value LIKE ?', [
            filterName[1],
            `${stripGeohashPrefixWildcard(criterion)}%`,
          ])
          return
        }

        bd.orWhereRaw('event_tags.tag_name = ? AND event_tags.tag_value = ?', [filterName[1], criterion])
      })
    })
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

    const retentionLimit = now - maxDays * SECONDS_PER_DAY

    logger(
      'deleting expired and retained events (retentionLimit: %d, now: %d, batchSize: %d)',
      retentionLimit,
      now,
      RETENTION_BATCH_SIZE,
    )

    const candidates = this.buildRetentionCandidateQuery(now, retentionLimit, options)

    const query = this.masterDbClient('events')
      .whereIn('event_id', candidates)
      .del(['deleted_at', 'expires_at', 'event_created_at'])

    const getPromise = () => query.then((rows: any) => this.mapToPurgeCounts(rows, now, retentionLimit))

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

  private buildRetentionCandidateQuery(
    now: number,
    retentionLimit: number,
    options?: EventRetentionOptions,
  ): any {
    return this.masterDbClient('events')
      .select('event_id')
      .where(function () {
        this.where('expires_at', '<', now).orWhereNotNull('deleted_at').orWhere('event_created_at', '<', retentionLimit)
      })
      .modify((query) => {
        this.applyRetentionKindWhitelist(query, options?.kindWhitelist)

        if (Array.isArray(options?.pubkeyWhitelist) && options.pubkeyWhitelist.length > 0) {
          query.whereNotIn('event_pubkey', map(toBuffer)(options.pubkeyWhitelist))
        }
      })
      .limit(RETENTION_BATCH_SIZE)
  }

  private applyRetentionKindWhitelist(query: any, kindWhitelist?: EventRetentionOptions['kindWhitelist']): void {
    const seen = new Set<string>()
    const configuredWhitelist = Array.isArray(kindWhitelist) ? kindWhitelist : []
    const dedupedWhitelist = [...configuredWhitelist, EventKinds.REQUEST_TO_VANISH].filter((item) => {
      const key = Array.isArray(item) ? `range:${item[0]}-${item[1]}` : `kind:${item}`

      if (seen.has(key)) {
        return false
      }

      seen.add(key)
      return true
    })
    query.whereNot((builder) => {
      dedupedWhitelist.forEach((kindOrRange) => {
        if (Array.isArray(kindOrRange)) {
          builder.orWhereBetween('event_kind', kindOrRange)
        } else {
          builder.orWhere('event_kind', kindOrRange)
        }
      })
    })
  }

  private mapToPurgeCounts(
    deletedRows: Pick<DBEvent, 'deleted_at' | 'expires_at' | 'event_created_at'>[],
    now: number,
    retentionLimit: number,
  ): EventPurgeCounts {
    return deletedRows.reduce((counts, row) => {
      if (row.deleted_at) {
        counts.deleted += 1
      } else if (typeof row.expires_at === 'number' && row.expires_at < now) {
        counts.expired += 1
      } else if (row.event_created_at < retentionLimit) {
        counts.retained += 1
      }

      return counts
    }, {
      deleted: 0,
      expired: 0,
      retained: 0,
    })
  }
}
