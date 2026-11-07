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

// Every case below sends at the open tick, but an immediately resolved
// admission check answers before the client's frames can reach the server, so
// the adapter installs its normal listener first and the buffering path never
// runs. Hold admission open until the frames are known to be in the server's
// queue, then admit every client at once.
const holdAdmission = (stub: Sinon.SinonStub) => {
  let release: (() => void) | undefined
  stub.returns(
    new Promise<boolean>((resolve) => {
      release = () => resolve(false)
    }),
  )

  return async (settleMs = 50) => {
    await new Promise((resolve) => setTimeout(resolve, settleMs))
    release?.()
  }
}

describe('WebSocketServerAdapter real socket non-sequential & race cases (#1052)', function () {
  this.timeout(10_000)

  let sandbox: Sinon.SinonSandbox
  let server: http.Server
  let webSocketServer: WebSocketServer
  let adapter: WebSocketServerAdapter
  let isRateLimitedStub: Sinon.SinonStub
  let receivedFrames: Buffer[]
  let receivedFramesByClient: Map<WebSocket, Buffer[]>
  let allReceivedFrames: { client: WebSocket; data: Buffer }[]
  const clients: WebSocket[] = []

  const settings = () =>
    ({
      network: { remoteIpHeader: '' },
      limits: { connection: { rateLimits: [] } },
    }) as any

  beforeEach(async () => {
    sandbox = Sinon.createSandbox()
    receivedFrames = []
    receivedFramesByClient = new Map()
    allReceivedFrames = []
    isRateLimitedStub = sandbox.stub(rateLimiterMiddleware, 'isRateLimited').resolves(false)

    server = http.createServer()
    webSocketServer = new WebSocketServer({ server })

    adapter = new WebSocketServerAdapter(
      server,
      webSocketServer,
      ([client]: [WebSocket, unknown, unknown]) => {
        const received: Buffer[] = []
        receivedFrames = received
        receivedFramesByClient.set(client, received)
        client.on('message', (data: Buffer) => {
          const buf = Buffer.from(data)
          received.push(buf)
          allReceivedFrames.push({ client, data: buf })
        })

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

  // --------------------------------------------------------------------------
  // Baseline check: delayed admission buffering (from #1045)
  // --------------------------------------------------------------------------
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
      client.once('open', resolve)
      client.once('error', reject)
    })

    const frames = [
      Buffer.from('["REQ","immediate-one",{"kinds":[1]}]'),
      Buffer.from('["REQ","immediate-two",{"kinds":[1]}]'),
    ]

    for (const frame of frames) {
      client.send(frame)
    }

    // Allow frames to hit the server socket while admission is still pending
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseAdmission?.(false)

    await waitFor(() => (receivedFrames?.length ?? 0) >= frames.length)

    expect((receivedFrames ?? []).map((f) => f.toString())).to.deep.equal(
      frames.map((f) => f.toString()),
    )
  })

  // --------------------------------------------------------------------------
  // Shape 1: Subscribe at open tick / reconnect storm across N concurrent sockets
  // --------------------------------------------------------------------------
  it('Shape 1: handles concurrent reconnect storm with REQs sent at open tick across N sockets', async () => {
    const address = server.address() as AddressInfo
    const N = 10
    const admit = holdAdmission(isRateLimitedStub)
    const sentIds = new Set<string>()

    const connectPromises = Array.from({ length: N }).map((_, i) => {
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${address.port}`)
        clients.push(ws)

        const id = `sub-storm-${i}`
        sentIds.add(id)

        ws.on('open', () => {
          ws.send(Buffer.from(JSON.stringify(['REQ', id, { kinds: [1] }])))
          resolve()
        })
        ws.on('error', reject)
      })
    })

    await Promise.all(connectPromises)
    await admit()

    await waitFor(() => {
      let total = 0
      for (const frames of receivedFramesByClient.values()) {
        total += frames.length
      }
      return total >= N
    })

    expect(receivedFramesByClient.size).to.equal(N)

    const receivedIds: string[] = []
    for (const frames of receivedFramesByClient.values()) {
      expect(frames).to.have.length(1)
      const parsed = JSON.parse(frames[0].toString())
      expect(parsed).to.have.length(3)
      expect(parsed[0]).to.equal('REQ')
      expect(parsed[1]).to.match(/^sub-storm-\d+$/)
      expect(parsed[2]).to.deep.equal({ kinds: [1] })
      receivedIds.push(parsed[1])
    }

    // One complete command per socket, and the N ids received are exactly the
    // N ids sent — a duplicated or cross-wired command would break the set.
    expect(receivedIds.sort()).to.deep.equal([...sentIds].sort())
  })

  // --------------------------------------------------------------------------
  // Shape 2: Pipelined commands in one write
  // --------------------------------------------------------------------------
  it('Shape 2: delivers pipelined commands in the exact order sent', async () => {
    const address = server.address() as AddressInfo
    const admit = holdAdmission(isRateLimitedStub)
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    clients.push(client)

    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })

    const cmd1 = Buffer.from('["REQ","pipelined-1",{"kinds":[1]}]')
    const cmd2 = Buffer.from('["REQ","pipelined-2",{"kinds":[0]}]')

    // Pipelined writes into the socket stream back-to-back
    client.send(cmd1)
    client.send(cmd2)

    await admit()
    await waitFor(() => (receivedFrames?.length ?? 0) >= 2)

    expect(receivedFrames.map((f) => f.toString())).to.deep.equal([cmd1.toString(), cmd2.toString()])
  })

  // --------------------------------------------------------------------------
  // Shape 3: REQ followed immediately by CLOSE of the same subscription id
  // --------------------------------------------------------------------------
  it('Shape 3: processes REQ followed immediately by CLOSE without error or socket termination', async () => {
    const address = server.address() as AddressInfo
    const admit = holdAdmission(isRateLimitedStub)
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    clients.push(client)

    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })

    client.send(Buffer.from('["REQ","race-cancel",{"kinds":[1]}]'))
    client.send(Buffer.from('["CLOSE","race-cancel"]'))

    await admit()
    await waitFor(() => (receivedFrames?.length ?? 0) >= 2)

    const parsed = receivedFrames.map((f) => JSON.parse(f.toString()))
    expect(parsed[0]).to.deep.equal(['REQ', 'race-cancel', { kinds: [1] }])
    expect(parsed[1]).to.deep.equal(['CLOSE', 'race-cancel'])
    expect(client.readyState).to.equal(WebSocket.OPEN)
  })

  // --------------------------------------------------------------------------
  // Shape 4: EVENT sent in the same turn as open
  // --------------------------------------------------------------------------
  it('Shape 4: delivers EVENT sent in the same turn as open', async () => {
    const address = server.address() as AddressInfo
    const admit = holdAdmission(isRateLimitedStub)
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    clients.push(client)

    const testEvent = ['EVENT', { id: 'evt-race-1', kind: 1, content: 'race event' }]

    await new Promise<void>((resolve, reject) => {
      client.on('open', () => {
        client.send(Buffer.from(JSON.stringify(testEvent)))
        resolve()
      })
      client.on('error', reject)
    })

    await admit()
    await waitFor(() => (receivedFrames?.length ?? 0) >= 1)

    expect(JSON.parse(receivedFrames[0].toString())).to.deep.equal(testEvent)
  })

  // --------------------------------------------------------------------------
  // Shape 5: Binary and fragmented frames
  // --------------------------------------------------------------------------
  it('Shape 5: correctly receives fragmented frames and binary frames and keeps socket usable', async () => {
    const address = server.address() as AddressInfo
    const admit = holdAdmission(isRateLimitedStub)
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    clients.push(client)

    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })

    // Fragmented frame: split command across two frames
    client.send('["REQ","frag', { fin: false })
    client.send('-sub",{"kinds":[1]}]', { fin: true })

    // Binary frame carrying JSON command
    const binaryCommand = Buffer.from('["REQ","binary-frame",{"kinds":[1]}]')
    client.send(binaryCommand, { binary: true })

    // Next command on the same socket
    const nextCommand = Buffer.from('["REQ","next-cmd",{"kinds":[1]}]')
    client.send(nextCommand)

    await admit()
    await waitFor(() => (receivedFrames?.length ?? 0) >= 3)

    expect(receivedFrames[0].toString()).to.equal('["REQ","frag-sub",{"kinds":[1]}]')
    expect(receivedFrames[1].toString()).to.equal(binaryCommand.toString())
    expect(receivedFrames[2].toString()).to.equal(nextCommand.toString())
  })

  // --------------------------------------------------------------------------
  // Shape 6: Invalid JSON mid-stream maintains socket health for next valid command
  // --------------------------------------------------------------------------
  it('Shape 6: maintains socket usability for next valid command after invalid JSON', async () => {
    const address = server.address() as AddressInfo
    const admit = holdAdmission(isRateLimitedStub)
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    clients.push(client)

    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })

    const badPayload = Buffer.from('{"broken_json_without_closing_bracket')
    const nextValidCommand = Buffer.from('["REQ","valid-after-bad",{"kinds":[1]}]')

    client.send(badPayload)
    client.send(nextValidCommand)

    await admit()
    await waitFor(() => (receivedFrames?.length ?? 0) >= 2)

    expect(receivedFrames[0].toString()).to.equal(badPayload.toString())
    expect(receivedFrames[1].toString()).to.equal(nextValidCommand.toString())
    expect(client.readyState).to.equal(WebSocket.OPEN)
  })
})
