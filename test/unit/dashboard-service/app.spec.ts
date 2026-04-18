import axios from 'axios'
import { createDashboardService } from '../../../src/dashboard-service/app'
import { expect } from 'chai'
import WebSocket from 'ws'

describe('dashboard-service app', () => {
  it('serves health, snapshot, and websocket endpoints', async () => {
    const service = createDashboardService({
      host: '127.0.0.1',
      port: 0,
      wsPath: '/api/v1/kpis/stream',
      pollIntervalMs: 1000,
    })

    await service.start()

    const port = service.getHttpPort()

    const healthResponse = await axios.get(`http://127.0.0.1:${port}/healthz`)
    expect(healthResponse.status).to.equal(200)

    const snapshotResponse = await axios.get(`http://127.0.0.1:${port}/api/v1/kpis/snapshot`)
    expect(snapshotResponse.status).to.equal(200)

    const snapshotJson = snapshotResponse.data as any
    expect(snapshotJson.data).to.have.property('sequence')

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/kpis/stream`)

    const connectedEvent = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout waiting for ws message')), 2000)
      ws.once('message', (raw) => {
        clearTimeout(timeout)
        resolve(JSON.parse(raw.toString()))
      })
    })

    expect(connectedEvent).to.have.property('type', 'dashboard.connected')

    ws.close()
    await service.stop()
  })
})
