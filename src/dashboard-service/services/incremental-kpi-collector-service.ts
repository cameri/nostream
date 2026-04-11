import { DashboardMetrics, EventsByKindCount, TopTalker } from '../types'
import { createLogger } from '../../factories/logger-factory'
import { DatabaseClient } from '../../@types/base'

const debug = createLogger('dashboard-service:incremental-kpi-collector')

const DEFAULT_TRACKED_KINDS = [7, 1, 6, 1984, 4, 3, 9735]
const MINUTES_PER_DAY = 24 * 60
const SATS_SCALE_FACTOR = 1000


class MinHeap {
  private readonly data: TopTalker[] = []

  public constructor(private readonly maxSize: number) {}

  public push(item: TopTalker): void {
    if (this.data.length < this.maxSize) {
      this.data.push(item)
      this.bubbleUp(this.data.length - 1)
    } else if (this.data.length > 0 && item.count > this.data[0].count) {
      this.data[0] = item
      this.sinkDown(0)
    }
  }

  /** Returns the heap contents sorted descending by count. */
  public toSortedDescArray(): TopTalker[] {
    return [...this.data].sort((a, b) => b.count - a.count)
  }

  public get size(): number {
    return this.data.length
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parent = (idx - 1) >> 1
      if (this.data[parent].count <= this.data[idx].count) {
        break
      }
      [this.data[parent], this.data[idx]] = [this.data[idx], this.data[parent]]
      idx = parent
    }
  }

  private sinkDown(idx: number): void {
    const n = this.data.length
    // eslint-disable-next-line no-constant-condition
    while(true) {
      let smallest = idx
      const left = 2 * idx + 1
      const right = 2 * idx + 2

      if (left < n && this.data[left].count < this.data[smallest].count) {
        smallest = left
      }
      if (right < n && this.data[right].count < this.data[smallest].count) {
        smallest = right
      }
      if (smallest === idx) {
        break
      }
      [this.data[smallest], this.data[idx]] = [this.data[idx], this.data[smallest]]
      idx = smallest
    }
  }
}


interface ICombinedEventRow {
  agg_type: 'kind' | 'talker' | 'bucket'
  event_kind: number | null
  pubkey: string | null
  bucket_epoch: string | number | null
  count: string | number
}

interface IEventCursorRow {
  first_seen: string
  id: string
}

interface IUserSnapshotRow {
  pubkey: string | Buffer
  is_admitted: boolean | number | string
  balance: string | number | null
  updated_at_epoch: string | number
}

interface IUserCursorRow {
  updated_at_epoch: string | number
  pubkey: string | Buffer
}


const toNumber = (value: unknown): number => {
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'string' && value !== '') {
    return Number(value)
  }
  return 0
}

const toBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value === 1
  }
  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 't'
  }
  return false
}

const normalizeText = (value: unknown): string => {
  if (Buffer.isBuffer(value)) {
    return value.toString('hex')
  }
  return String(value)
}


interface IEventCursor {
  firstSeen: string
  id: string
}

interface IUserCursor {
  updatedAtEpoch: number
  pubkey: string
}

interface IUserState {
  isAdmitted: boolean
  balanceMillisats: number
}

export class IncrementalKPICollectorService {
  private readonly trackedKindsSet: Set<number>

  // All-time talker counts stored in a Map; the MinHeap is rebuilt on each
  // collectMetrics() call from this map — keeping O(N) space in the map while
  // heap work is O(N log K) per cycle instead of O(N log N).
  private readonly allTimeTalkerCounts = new Map<string, number>()

  private readonly eventsByKindCounts = new Map<string, number>()

  // Recent bucket data: minuteEpoch → pubkey → count (pruned each cycle)
  private readonly recentBucketTalkerCounts = new Map<number, Map<string, number>>()

  private readonly userStates = new Map<string, IUserState>()

  private admittedUsers = 0

  private eventCursor: IEventCursor = {
    firstSeen: '1970-01-01 00:00:00.000000',
    id: '00000000-0000-0000-0000-000000000000',
  }

  private initialized = false

  private satsPaidMillisats = 0

  private userCursor: IUserCursor = {
    updatedAtEpoch: 0,
    pubkey: '',
  }

  public constructor(
    private readonly dbClient: DatabaseClient,
    private readonly trackedKinds: number[] = DEFAULT_TRACKED_KINDS,
    private readonly topTalkersLimit = 10,
    private readonly recentDays = 3,
  ) {
    this.trackedKindsSet = new Set(trackedKinds)
  }

  public async collectMetrics(): Promise<DashboardMetrics> {
    if (!this.initialized) {
      await this.bootstrapState()
      this.initialized = true
    } else {
      await Promise.all([
        this.applyEventDeltas(),
        this.applyUserDeltas(),
      ])
    }

    this.pruneRecentBuckets()

    return {
      eventsByKind: this.buildEventsByKindMetrics(),
      admittedUsers: this.admittedUsers,
      satsPaid: this.satsPaidMillisats / SATS_SCALE_FACTOR,
      topTalkers: {
        allTime: this.getTopKFromMap(this.allTimeTalkerCounts),
        recent: this.getRecentTopTalkers(),
      },
    }
  }

  /**
   * Fetches all new events since the last cursor in a single MATERIALIZED CTE
   * query, then fans the rows out into three accumulators:
   *   • kind counts
   *   • all-time talker counts
   *   • per-minute bucket talker counts (for the recent window)
   *
   * Using MATERIALIZED forces a single table scan; without it PG 15 may inline
   * the CTE and re-scan for each UNION ALL branch.
   */

  private async applyEventDeltas(): Promise<void> {
    const sinceMinuteEpoch = this.getWindowStartMinute()

    // Combined query: one MATERIALIZED CTE, three aggregation branches.
    const combinedSql = `
      WITH new_events AS MATERIALIZED (
        SELECT event_kind, event_pubkey, first_seen
        FROM events
        WHERE (first_seen, id) > (?, ?)
      )
      SELECT 'kind'   AS agg_type,
             event_kind,
             NULL::text                                                         AS pubkey,
             NULL::bigint                                                        AS bucket_epoch,
             COUNT(*)::bigint                                                    AS count
      FROM new_events
      GROUP BY event_kind

      UNION ALL

      SELECT 'talker',
             NULL,
             encode(event_pubkey, 'hex'),
             NULL,
             COUNT(*)::bigint
      FROM new_events
      GROUP BY event_pubkey

      UNION ALL

      SELECT 'bucket',
             NULL,
             encode(event_pubkey, 'hex'),
             extract(epoch FROM date_trunc('minute', first_seen))::bigint,
             COUNT(*)::bigint
      FROM new_events
      WHERE first_seen >= to_timestamp(?)
      GROUP BY event_pubkey, date_trunc('minute', first_seen);
    `

    // Cursor update: a separate lightweight query on the indexed (first_seen, id) pair.
    const cursorSql = `
      SELECT to_char(first_seen, 'YYYY-MM-DD HH24:MI:SS.US') AS first_seen, id
      FROM events
      WHERE (first_seen, id) > (?, ?)
      ORDER BY first_seen DESC, id DESC
      LIMIT 1;
    `

    const [combinedRows, cursorRows] = await Promise.all([
      this.queryRows<ICombinedEventRow>(combinedSql, [
        this.eventCursor.firstSeen,
        this.eventCursor.id,
        sinceMinuteEpoch * 60,
      ]),
      this.queryRows<IEventCursorRow>(cursorSql, [
        this.eventCursor.firstSeen,
        this.eventCursor.id,
      ]),
    ])

    for (const row of combinedRows) {
      const count = toNumber(row.count)

      if (row.agg_type === 'kind') {
        const kind = this.trackedKindsSet.has(toNumber(row.event_kind))
          ? String(row.event_kind)
          : 'other'
        this.eventsByKindCounts.set(kind, (this.eventsByKindCounts.get(kind) ?? 0) + count)
      } else if (row.agg_type === 'talker') {
        const pubkey = row.pubkey ?? ''
        this.allTimeTalkerCounts.set(pubkey, (this.allTimeTalkerCounts.get(pubkey) ?? 0) + count)
      } else if (row.agg_type === 'bucket') {
        const minuteEpoch = toNumber(row.bucket_epoch)
        const pubkey = row.pubkey ?? ''
        const bucket = this.recentBucketTalkerCounts.get(minuteEpoch) ?? new Map<string, number>()
        bucket.set(pubkey, (bucket.get(pubkey) ?? 0) + count)
        this.recentBucketTalkerCounts.set(minuteEpoch, bucket)
      }
    }

    if (cursorRows.length > 0) {
      this.eventCursor = {
        firstSeen: cursorRows[0].first_seen,
        id: cursorRows[0].id,
      }
    }
  }

  private async applyUserDeltas(): Promise<void> {
    const [changedUsers, latestUserCursor] = await Promise.all([
      this.queryRows<IUserSnapshotRow>(
        `
        SELECT
          encode(pubkey, 'hex') AS pubkey,
          is_admitted,
          balance,
          extract(epoch FROM updated_at)::bigint AS updated_at_epoch
        FROM users
        WHERE (extract(epoch FROM updated_at)::bigint, encode(pubkey, 'hex')) > (?, ?)
        ORDER BY updated_at ASC, pubkey ASC;
        `,
        [this.userCursor.updatedAtEpoch, this.userCursor.pubkey],
      ),
      this.queryRows<IUserCursorRow>(
        `
        SELECT
          extract(epoch FROM updated_at)::bigint AS updated_at_epoch,
          encode(pubkey, 'hex') AS pubkey
        FROM users
        WHERE (extract(epoch FROM updated_at)::bigint, encode(pubkey, 'hex')) > (?, ?)
        ORDER BY updated_at DESC, pubkey DESC
        LIMIT 1;
        `,
        [this.userCursor.updatedAtEpoch, this.userCursor.pubkey],
      ),
    ])

    for (const row of changedUsers) {
      const pubkey = normalizeText(row.pubkey)
      const nextState: IUserState = {
        isAdmitted: toBoolean(row.is_admitted),
        balanceMillisats: toNumber(row.balance),
      }

      const previousState = this.userStates.get(pubkey)
      if (previousState?.isAdmitted) {
        this.admittedUsers -= 1
        this.satsPaidMillisats -= previousState.balanceMillisats
      }

      if (nextState.isAdmitted) {
        this.admittedUsers += 1
        this.satsPaidMillisats += nextState.balanceMillisats
      }

      this.userStates.set(pubkey, nextState)
    }

    if (latestUserCursor.length > 0) {
      this.userCursor = {
        updatedAtEpoch: toNumber(latestUserCursor[0].updated_at_epoch),
        pubkey: normalizeText(latestUserCursor[0].pubkey),
      }
    }
  }

  /**
   * The bootstrap runs only for the first time and 
   * Same MATERIALIZED CTE strategy as applyEventDeltas but without the cursor
   * predicate (reads entire table on first run).
   */
  private async bootstrapState(): Promise<void> {
    debug('bootstrapping incremental KPI collector state')

    this.resetState()

    const sinceMinuteEpoch = this.getWindowStartMinute()

    const bootstrapEventsSql = `
      WITH all_events AS MATERIALIZED (
        SELECT event_kind, event_pubkey, first_seen
        FROM events
      )
      SELECT 'kind'   AS agg_type,
             event_kind,
             NULL::text        AS pubkey,
             NULL::bigint      AS bucket_epoch,
             COUNT(*)::bigint  AS count
      FROM all_events
      GROUP BY event_kind

      UNION ALL

      SELECT 'talker',
             NULL,
             encode(event_pubkey, 'hex'),
             NULL,
             COUNT(*)::bigint
      FROM all_events
      GROUP BY event_pubkey

      UNION ALL

      SELECT 'bucket',
             NULL,
             encode(event_pubkey, 'hex'),
             extract(epoch FROM date_trunc('minute', first_seen))::bigint,
             COUNT(*)::bigint
      FROM all_events
      WHERE first_seen >= to_timestamp(?)
      GROUP BY event_pubkey, date_trunc('minute', first_seen);
    `

    const [combinedRows, eventCursorRows, userRows, userCursorRows] = await Promise.all([
      this.queryRows<ICombinedEventRow>(bootstrapEventsSql, [sinceMinuteEpoch * 60]),
      this.queryRows<IEventCursorRow>(
        `
        SELECT to_char(first_seen, 'YYYY-MM-DD HH24:MI:SS.US') AS first_seen, id
        FROM events
        ORDER BY first_seen DESC, id DESC
        LIMIT 1;
        `,
        [],
      ),
      // Only load admitted users at bootstrap — avoids unbounded memory growth
      // from loading every user row into the in-memory map.
      this.queryRows<IUserSnapshotRow>(
        `
        SELECT
          encode(pubkey, 'hex') AS pubkey,
          is_admitted,
          balance,
          extract(epoch FROM updated_at)::bigint AS updated_at_epoch
        FROM users
        WHERE is_admitted = true;
        `,
        [],
      ),
      this.queryRows<IUserCursorRow>(
        `
        SELECT
          extract(epoch FROM updated_at)::bigint AS updated_at_epoch,
          encode(pubkey, 'hex') AS pubkey
        FROM users
        ORDER BY updated_at DESC, pubkey DESC
        LIMIT 1;
        `,
        [],
      ),
    ])

    for (const row of combinedRows) {
      const count = toNumber(row.count)

      if (row.agg_type === 'kind') {
        const kind = this.trackedKindsSet.has(toNumber(row.event_kind))
          ? String(row.event_kind)
          : 'other'
        this.eventsByKindCounts.set(kind, (this.eventsByKindCounts.get(kind) ?? 0) + count)
      } else if (row.agg_type === 'talker') {
        const pubkey = row.pubkey ?? ''
        this.allTimeTalkerCounts.set(pubkey, (this.allTimeTalkerCounts.get(pubkey) ?? 0) + count)
      } else if (row.agg_type === 'bucket') {
        const minuteEpoch = toNumber(row.bucket_epoch)
        const pubkey = row.pubkey ?? ''
        const bucket = this.recentBucketTalkerCounts.get(minuteEpoch) ?? new Map<string, number>()
        bucket.set(pubkey, (bucket.get(pubkey) ?? 0) + count)
        this.recentBucketTalkerCounts.set(minuteEpoch, bucket)
      }
    }

    // Bootstrap only admitted users (memory-safe for large relays).
    for (const row of userRows) {
      const pubkey = normalizeText(row.pubkey)
      const userState: IUserState = {
        isAdmitted: true, // filtered in query
        balanceMillisats: toNumber(row.balance),
      }
      this.userStates.set(pubkey, userState)
      this.admittedUsers += 1
      this.satsPaidMillisats += userState.balanceMillisats
    }

    if (eventCursorRows.length > 0) {
      this.eventCursor = {
        firstSeen: eventCursorRows[0].first_seen,
        id: eventCursorRows[0].id,
      }
    }

    if (userCursorRows.length > 0) {
      this.userCursor = {
        updatedAtEpoch: toNumber(userCursorRows[0].updated_at_epoch),
        pubkey: normalizeText(userCursorRows[0].pubkey),
      }
    }
  }

  private buildEventsByKindMetrics(): EventsByKindCount[] {
    const eventsByKind = Array
      .from(this.eventsByKindCounts.entries())
      .filter(([kind]) => kind !== 'other')
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count)

    eventsByKind.push({
      kind: 'other',
      count: this.eventsByKindCounts.get('other') ?? 0,
    })

    return eventsByKind
  }

  /**
   * Builds Top-K talkers using a MinHeap (O(N log K)) instead of a full sort
   * (O(N log N)). For large relays with millions of distinct pubkeys this is a
   * significant speedup and the heap is bounded to K entries.
   */
  private getTopKFromMap(counts: Map<string, number>): TopTalker[] {
    const heap = new MinHeap(this.topTalkersLimit)

    for (const [pubkey, count] of counts) {
      heap.push({ pubkey, count })
    }

    return heap.toSortedDescArray()
  }

  private getRecentTopTalkers(): TopTalker[] {
    // Merge all per-minute buckets into a single counts map, then run Top-K.
    const merged = new Map<string, number>()

    for (const bucketCounts of this.recentBucketTalkerCounts.values()) {
      for (const [pubkey, count] of bucketCounts) {
        merged.set(pubkey, (merged.get(pubkey) ?? 0) + count)
      }
    }

    return this.getTopKFromMap(merged)
  }

  private getWindowStartMinute(): number {
    const windowMinutes = this.recentDays * MINUTES_PER_DAY
    const nowMinute = Math.floor(Date.now() / 60000)
    return nowMinute - windowMinutes
  }

  private pruneRecentBuckets(): void {
    const thresholdMinute = this.getWindowStartMinute()

    for (const bucketMinute of this.recentBucketTalkerCounts.keys()) {
      if (bucketMinute < thresholdMinute) {
        this.recentBucketTalkerCounts.delete(bucketMinute)
      }
    }
  }

  private async queryRows<T>(sql: string, bindings: unknown[]): Promise<T[]> {
    const rawResult = await this.dbClient.raw(sql, bindings)

    if (Array.isArray((rawResult as any).rows)) {
      return (rawResult as any).rows as T[]
    }

    if (Array.isArray(rawResult)) {
      return rawResult as unknown as T[]
    }

    return []
  }

  private resetState(): void {
    this.allTimeTalkerCounts.clear()
    this.eventsByKindCounts.clear()
    this.recentBucketTalkerCounts.clear()
    this.userStates.clear()
    this.admittedUsers = 0
    this.satsPaidMillisats = 0
    this.eventCursor = {
      firstSeen: '1970-01-01 00:00:00.000000',
      id: '00000000-0000-0000-0000-000000000000',
    }
    this.userCursor = {
      updatedAtEpoch: 0,
      pubkey: '',
    }
  }
}
