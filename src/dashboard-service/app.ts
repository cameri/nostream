import { createDashboardRouter } from './api/dashboard-router'
import { createLogger } from '../factories/logger-factory'
import { DashboardServiceConfig } from './config'
import { DashboardWebSocketHub } from './ws/dashboard-ws-hub'
import express from 'express'
import { getHealthRequestHandler } from './handlers/request-handlers/get-health-request-handler'
import http from 'http'
import { PollingScheduler } from './polling/polling-scheduler'
import { SnapshotService } from './services/snapshot-service'
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
    'dashboard-service: creating service (host=%s, port=%d, wsPath=%s, pollIntervalMs=%d)',
    config.host,
    config.port,
    config.wsPath,
    config.pollIntervalMs,
  )

  const snapshotService = new SnapshotService()

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

  const pollingScheduler = new PollingScheduler(config.pollIntervalMs, () => {
    const nextSnapshot = snapshotService.refreshPlaceholder()
    debug('poll tick produced snapshot sequence=%d', nextSnapshot.sequence)
    webSocketHub.broadcastTick(nextSnapshot.sequence)
    webSocketHub.broadcastSnapshot(nextSnapshot)
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

    pollingScheduler.start()
    console.info('dashboard-service: polling scheduler started')
  }

  const stop = async () => {
    console.info('dashboard-service: stopping service')
    pollingScheduler.stop()
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
