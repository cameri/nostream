import { IKPICollector, SnapshotService } from './services/snapshot-service'
import { createDashboardRouter } from './api/dashboard-router'
import { createLogger } from '../factories/logger-factory'
import { DashboardServiceConfig } from './config'
import { DashboardUpdateVersionService } from './services/dashboard-update-version-service'
import { DashboardWebSocketHub } from './ws/dashboard-ws-hub'
import express from 'express'
import { getHealthRequestHandler } from './handlers/request-handlers/get-health-request-handler'
import { getReadReplicaDbClient } from '../database/client'
import http from 'http'
import { KPICollectorService } from './services/kpi-collector-service'
import { PollingScheduler } from './polling/polling-scheduler'
import { WebSocketServer } from 'ws'
const debug = createLogger('dashboard-service:app')

export interface DashboardService {
  readonly config: DashboardServiceConfig
  readonly snapshotService: SnapshotService
  readonly pollingScheduler: PollingScheduler
  start(): Promise<void>
  stop(): Promise<void>
  getHttpPort(): number
}

export const createDashboardService = (config: DashboardServiceConfig): DashboardService => {
  console.info(
    'dashboard-service: creating service (host=%s, port=%d, wsPath=%s, pollIntervalMs=%d, useDummyData=%s)',
    config.host,
    config.port,
    config.wsPath,
    config.pollIntervalMs,
    config.useDummyData,
  )

  const dbClient = config.useDummyData ? undefined : getReadReplicaDbClient()
  const collector: IKPICollector = config.useDummyData
    ? {
      collectMetrics: async () => ({
        eventsByKind: [],
        admittedUsers: 0,
        satsPaid: 0,
        topTalkers: { allTime: [], recent: [] },
      }),
    }
    : new KPICollectorService(dbClient)

  const updateVersionProvider = typeof dbClient === 'undefined'
    ? undefined
    : new DashboardUpdateVersionService(dbClient)

  const snapshotService = new SnapshotService(collector, updateVersionProvider)

  const app = express()
    .disable('x-powered-by')
    .get('/healthz', getHealthRequestHandler)
    .use('/api/v1/kpis', createDashboardRouter(snapshotService))

  const webServer = http.createServer(app)
  const webSocketServer = new WebSocketServer({
    server: webServer,
    path: config.wsPath,
  })

  const webSocketHub = new DashboardWebSocketHub(webSocketServer, () => snapshotService.getSnapshot())

  const pollingScheduler = new PollingScheduler(config.pollIntervalMs, async () => {
    const { snapshot, changed } = await snapshotService.refresh()

    if (!changed) {
      debug('poll tick detected no KPI changes')
      return
    }

    debug('poll tick produced snapshot sequence=%d status=%s', snapshot.sequence, snapshot.status)
    webSocketHub.broadcastTick(snapshot.sequence)
    webSocketHub.broadcastSnapshot(snapshot)
  })

  const start = async () => {
    if (webServer.listening) {
      debug('start requested but service is already listening')
      return
    }

    console.info('dashboard-service: starting http and websocket servers')

    await new Promise<void>((resolve, reject) => {
      webServer.listen(config.port, config.host, () => {
        const address = webServer.address()
        debug('listening on %o', address)
        console.info('dashboard-service: listening on %o', address)
        resolve()
      })
      webServer.once('error', (error) => {
        console.error('dashboard-service: failed to start server', error)
        reject(error)
      })
    })

    try {
      const initialSnapshotRefresh = await snapshotService.refresh()
      if (initialSnapshotRefresh.changed) {
        debug('initial snapshot prepared with sequence=%d status=%s', initialSnapshotRefresh.snapshot.sequence, initialSnapshotRefresh.snapshot.status)
      }
    } catch (error) {
      console.error('dashboard-service: initial snapshot refresh failed (will retry on next poll)', error)
    }

    pollingScheduler.start()
    console.info('dashboard-service: polling scheduler started')
  }

  const stop = async () => {
    console.info('dashboard-service: stopping service')
    pollingScheduler.stop()

    if (collector?.close) {
      try {
        await collector.close()
      } catch (error) {
        console.error('dashboard-service: failed to close collector resources', error)
      }
    }

    webSocketHub.close()
    await new Promise<void>((resolve, reject) => {
      if (!webServer.listening) {
        debug('stop requested while server was already stopped')
        resolve()
        return
      }

      webServer.close((error) => {
        if (error) {
          console.error('dashboard-service: failed to stop cleanly', error)
          reject(error)
          return
        }

        console.info('dashboard-service: http server closed')
        resolve()
      })
    })
  }

  const getHttpPort = (): number => {
    const address = webServer.address()
    return typeof address === 'object' && address !== null ? address.port : config.port
  }

  return {
    config,
    snapshotService,
    pollingScheduler,
    start,
    stop,
    getHttpPort,
  }
}
