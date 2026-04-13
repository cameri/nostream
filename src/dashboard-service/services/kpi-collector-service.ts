import { DashboardMetrics, EventsByKindCount, TopTalker } from '../types'
import { createLogger } from '../../factories/logger-factory'
import { DatabaseClient } from '../../@types/base'

const debug = createLogger('dashboard-service:kpi-collector')

const DEFAULT_TRACKED_KINDS = [7, 1, 6, 1984, 4, 3, 9735]

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') {
    return value
  }

  if (typeof value === 'string' && value !== '') {
    return Number(value)
  }

  return 0
}

export class KPICollectorService {
  public constructor(
    private readonly dbClient: DatabaseClient,
    private readonly trackedKinds: number[] = DEFAULT_TRACKED_KINDS,
    private readonly topTalkersLimit = 10,
    private readonly recentDays = 3,
  ) { }

  public async collectMetrics(): Promise<DashboardMetrics> {
    debug('collecting dashboard metrics')

    const [
      eventsByKind,
      admittedUsers,
      satsPaid,
      allTimeTopTalkers,
      recentTopTalkers,
    ] = await Promise.all([
      this.getEventsByKind(),
      this.getAdmittedUsersCount(),
      this.getSatsPaidCount(),
      this.getTopTalkersAllTime(),
      this.getTopTalkersRecent(),
    ])

    return {
      eventsByKind,
      admittedUsers,
      satsPaid,
      topTalkers: {
        allTime: allTimeTopTalkers,
        recent: recentTopTalkers,
      },
    }
  }

  private async getEventsByKind(): Promise<EventsByKindCount[]> {
    const rows = await this.dbClient('events')
      .select('event_kind')
      .count('id as count')
      .whereIn('event_kind', this.trackedKinds)
      .groupBy('event_kind')
      .orderBy('count', 'desc') as Array<{ event_kind: number, count: string }>

    const other = await this.dbClient('events')
      .whereNotIn('event_kind', this.trackedKinds)
      .count<{ count: string }>('id as count')
      .first()

    const eventsByKind = rows.map((row) => {
      return {
        kind: String(row.event_kind),
        count: toNumber(row.count),
      }
    })

    eventsByKind.push({
      kind: 'other',
      count: toNumber(other?.count),
    })

    return eventsByKind
  }

  private async getAdmittedUsersCount(): Promise<number> {
    const result = await this.dbClient('users')
      .where('is_admitted', true)
      .count<{ count: string }>('pubkey as count')
      .first()

    return toNumber(result?.count)
  }

  private async getSatsPaidCount(): Promise<number> {
    const result = await this.dbClient('users')
      .where('is_admitted', true)
      .sum<{ total: string | null }>('balance as total')
      .first()

    const millisats = toNumber(result?.total)
    return millisats / 1000
  }

  private async getTopTalkersAllTime(): Promise<TopTalker[]> {
    const rows = await this.dbClient('events')
      .select(this.dbClient.raw("encode(event_pubkey, 'hex') as pubkey"))
      .count('id as count')
      .groupBy('event_pubkey')
      .orderBy('count', 'desc')
      .limit(this.topTalkersLimit) as unknown as Array<{ pubkey: string | Buffer, count: string | number }>

    return rows.map((row) => ({
      pubkey: String(row.pubkey),
      count: toNumber(row.count),
    }))
  }

  private async getTopTalkersRecent(): Promise<TopTalker[]> {
    const since = new Date(Date.now() - this.recentDays * 24 * 60 * 60 * 1000)

    const rows = await this.dbClient('events')
      .select(this.dbClient.raw("encode(event_pubkey, 'hex') as pubkey"))
      .count('id as count')
      .where('first_seen', '>=', since)
      .groupBy('event_pubkey')
      .orderBy('count', 'desc')
      .limit(this.topTalkersLimit) as unknown as Array<{ pubkey: string | Buffer, count: string | number }>

    return rows.map((row) => ({
      pubkey: String(row.pubkey),
      count: toNumber(row.count),
    }))
  }
}
