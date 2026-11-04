import http from 'node:http'
import { AddressInfo } from 'node:net'

import chai from 'chai'
import Sinon from 'sinon'
import WebSocket, { WebSocketServer } from 'ws'

import { WebSocketServerAdapter } from '../../../src/adapters/web-socket-server-adapter'
import * as rateLimiterMiddleware from '../../../src/handlers/request-handlers/rate-limiter-middleware'

const { expect } = chai

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('WebSocketServerAdapter real socket admission', () => {
  let sandbox: Sinon.SinonSandbox
  let server: http.Server
  let webSocketServer: WebSocketServer
  let adapter: WebSocketServerAdapter
  let isRateLimitedStub: Sinon.SinonStub
  let receivedFrames: Buffer[] | undefined
  const clients: WebSocket[] = []

  const settings = () =>
    ({
      network: { remoteIpHeader: '' },
      limits: { connection: { rateLimits: [] } },
    }) as any

  beforeEach(async () => {
    sandbox = Sinon.createSandbox()
    receivedFrames = undefined
    isRateLimitedStub = sandbox.stub(rateLimiterMiddleware, 'isRateLimited').resolves(false)

    server = http.createServer()
    webSocketServer = new WebSocketServer({ server })

    adapter = new WebSocketServerAdapter(
      server,
      webSocketServer,
      ([client]: [WebSocket, unknown, unknown]) => {
        const received: Buffer[] = []
        receivedFrames = received
        client.on('message', (data: Buffer) => received.push(data))

        return {
          emit: () => undefined,
          drainAndClose: () => client.close(),
          getClientId: () => 'real-client',
          getClientAddress: () => '127.0.0.1',
        } as any
      },
      settings,
    )

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      if (client.readyState === WebSocket.OPEN) {
        client.terminate()
      }
    }

    await new Promise<void>((resolve) => adapter.close(() => resolve()))
    sandbox.restore()
  })

  it('delivers frames sent immediately on open across a delayed admission check', async () => {
    let releaseAdmission: ((limited: boolean) => void) | undefined
    isRateLimitedStub.returns(
      new Promise<boolean>((resolve) => {
        releaseAdmission = resolve
      }),
    )

    const address = server.address() as AddressInfo
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    clients.push(client)

    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve())
      client.once('error', reject)
    })

    const frames = [
      Buffer.from('["REQ","immediate-one",{"kinds":[1]}]'),
      Buffer.from('["REQ","immediate-two",{"kinds":[1]}]'),
    ]

    for (const frame of frames) {
      client.send(frame)
    }

    // Give the frames time to reach the relay while admission is still pending.
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseAdmission?.(false)

    await waitFor(() => (receivedFrames?.length ?? 0) >= frames.length)

    expect((receivedFrames ?? []).map((frame) => frame.toString())).to.deep.equal(
      frames.map((frame) => frame.toString()),
    )
  })
})
