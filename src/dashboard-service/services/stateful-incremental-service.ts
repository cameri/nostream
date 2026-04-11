import { Client, ClientConfig } from 'pg'
import { createLogger } from '../../factories/logger-factory'
import { DashboardMetrics } from '../types'
import { DatabaseClient } from '../../@types/base'
import { IncrementalKPICollectorService } from './incremental-kpi-collector-service'

const debug = createLogger('dashboard-service:stateful-incremental-kpi-collector')

const DEFAULT_EVENTS_CHANNEL = 'dashboard_events_changed'
const DEFAULT_USERS_CHANNEL = 'dashboard_users_changed'

const isValidChannelName = (channel: string): boolean => {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(channel)
}

const getListenerConnectionConfig = (): ClientConfig => {
  if (process.env.DB_URI) {
    return {
      connectionString: process.env.DB_URI,
    }
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  }
}

const defaultMetrics = (): DashboardMetrics => {
  return {
    eventsByKind: [],
    admittedUsers: 0,
    satsPaid: 0,
    topTalkers: {
      allTime: [],
      recent: [],
    },
  }
}

export class StatefulIncrementalKPICollectorService {
  private cachedMetrics: DashboardMetrics = defaultMetrics()

  private hasCache = false

  private isDirty = true

  private isListenerReady = false

  /** Set to true permanently once close() is called — prevents reconnect loops after shutdown. */
  private isClosed = false

  private listenerClient: Client | undefined

  private reconnectTimer: ReturnType<typeof setTimeout> | undefined

  private readonly incrementalCollector: IncrementalKPICollectorService

  private readonly channels: string[]

  private static readonly BASE_DELAY_MS = 500
  private static readonly MAX_DELAY_MS = 30_000

  /** Backoff state — reset to BASE_DELAY_MS on every successful connect. */
  private reconnectDelayMs = StatefulIncrementalKPICollectorService.BASE_DELAY_MS

  public constructor(
    dbClient: DatabaseClient,
    trackedKinds?: number[],
    topTalkersLimit?: number,
    recentDays?: number,
  ) {
    this.incrementalCollector = new IncrementalKPICollectorService(
      dbClient,
      trackedKinds,
      topTalkersLimit,
      recentDays,
    )

    this.channels = [
      process.env.DASHBOARD_EVENTS_NOTIFY_CHANNEL ?? DEFAULT_EVENTS_CHANNEL,
      process.env.DASHBOARD_USERS_NOTIFY_CHANNEL ?? DEFAULT_USERS_CHANNEL,
    ]
  }

  public async collectMetrics(): Promise<DashboardMetrics> {
    // Kick off a connect attempt if the listener isn't alive yet.
    // We don't await here — the listener is best-effort; data comes from the
    // incremental collector regardless.
    if (!this.isListenerReady && !this.listenerClient) {
      this.scheduleReconnect(0)
    }

    if (!this.hasCache || this.isDirty) {
      this.cachedMetrics = await this.incrementalCollector.collectMetrics()
      this.hasCache = true
      this.isDirty = false
    }

    return this.cachedMetrics
  }

  public async close(): Promise<void> {
    this.isClosed = true

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    const client = this.listenerClient
    this.listenerClient = undefined
    this.isListenerReady = false

    if (!client) {
      return
    }

    for (const channel of this.channels) {
      if (!isValidChannelName(channel)) {
        continue
      }

      try {
        await client.query(`UNLISTEN ${channel}`)
      } catch (error) {
        console.error('dashboard-service: failed to unlisten channel', {
          channel,
          error,
        })
      }
    }

    client.removeAllListeners('notification')
    client.removeAllListeners('error')
    client.removeAllListeners('end')

    try {
      await client.end()
    } catch (error) {
      console.error('dashboard-service: failed to close stateful incremental collector listener', error)
    }
  }

 
  /**
   * Schedule a reconnect attempt after `delayMs` milliseconds.
   * Passing 0 connects immediately (used on first call and after close via `close()`).
   */
  private scheduleReconnect(delayMs: number): void {
    if (this.isClosed || this.reconnectTimer || this.isListenerReady) {
      return
    }

    debug('scheduling listener reconnect in %d ms', delayMs)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connectListener().catch((err) => {
        // connectListener already logs; just ensure the loop continues.
        debug('connectListener threw unexpectedly: %o', err)
      })
    }, delayMs)
  }

  private async connectListener(): Promise<void> {
    if (this.isClosed || this.isListenerReady) {
      return
    }

    const client = new Client(getListenerConnectionConfig())

    client.on('notification', (notification) => {
      if (!notification.channel || !this.channels.includes(notification.channel)) {
        return
      }

      this.isDirty = true
      debug('received postgres notification on channel=%s', notification.channel)
    })

    client.on('error', (error) => {
      this.isDirty = true
      this.isListenerReady = false
      console.error('dashboard-service: stateful incremental collector listener error', error)
      // Don't call scheduleReconnect here — 'end' will always fire after 'error'
      // on a pg.Client, so we reconnect from the 'end' handler to avoid double-scheduling.
    })

    client.on('end', () => {
      this.isDirty = true
      this.isListenerReady = false
      this.listenerClient = undefined
      debug('postgres stateful incremental collector listener ended — will reconnect in %d ms', this.reconnectDelayMs)

      if (!this.isClosed) {
        this.scheduleReconnect(this.reconnectDelayMs)
        // Exponential backoff, capped at MAX_DELAY_MS.
        this.reconnectDelayMs = Math.min(
          this.reconnectDelayMs * 2,
          StatefulIncrementalKPICollectorService.MAX_DELAY_MS,
        )
      }
    })

    try {
      await client.connect()

      for (const channel of this.channels) {
        if (!isValidChannelName(channel)) {
          console.error('dashboard-service: skipping invalid notify channel name', channel)
          continue
        }

        await client.query(`LISTEN ${channel}`)
      }

      this.listenerClient = client
      this.isListenerReady = true
      // Reset backoff on successful connect.
      this.reconnectDelayMs = StatefulIncrementalKPICollectorService.BASE_DELAY_MS
      debug('postgres stateful incremental collector listener initialized for channels=%o', this.channels)
    } catch (error) {
      this.isDirty = true
      this.listenerClient = undefined
      this.isListenerReady = false
      console.error('dashboard-service: unable to initialize stateful incremental collector listener', error)

      try {
        await client.end()
      } catch (_closeError) {
        // best effort — 'end' handler above will fire and schedule the next reconnect
      }
    }
  }
}
