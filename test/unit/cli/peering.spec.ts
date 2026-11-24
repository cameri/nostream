import chai from 'chai'
import EventEmitter from 'events'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import type { Event } from '../../../src/@types/event'
import { runPeeringRequest, sendPeeringRequest } from '../../../src/cli/commands/peering'
import { getPublicKey, identifyEvent, signEvent } from '../../../src/utils/event'
import { buildPeeringAcceptanceEvent } from '../../../src/utils/peering-attestation'

chai.use(sinonChai)
const { expect } = chai

const ownerKey = '1'.repeat(64)
const relayKey = '2'.repeat(64)
const receiverKey = '3'.repeat(64)
const ownerPubkey = getPublicKey(ownerKey)
const relayPubkey = getPublicKey(relayKey)
const receiverPubkey = getPublicKey(receiverKey)
const scopes = [{ kinds: [1] }]
const terms = [{ amount: 21000, unit: 'msats', period: 2592000 }]

const requestEvent = async (): Promise<Event> =>
  signEvent(ownerKey)(
    await identifyEvent({
      pubkey: ownerPubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 28937,
      tags: [],
      content: '{}',
    }),
  )

const acceptanceEvent = async (request: Event): Promise<Event> =>
  signEvent(receiverKey)(
    await identifyEvent({
      pubkey: receiverPubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 28938,
      tags: [['e', request.id]],
      content: JSON.stringify({
        request_id: request.id,
        relay_pubkey: receiverPubkey,
        relay_url: 'wss://receiver.example.com',
        terms_hash: 'f'.repeat(64),
        accepted_at: Math.floor(Date.now() / 1000),
      }),
    }),
  )

class FakeSocket extends EventEmitter {
  public readonly sent: string[] = []
  public close = Sinon.stub()

  public send(message: string): void {
    this.sent.push(message)
  }
}

describe('peering CLI', () => {
  afterEach(() => Sinon.restore())

  it('sends the request and resolves with the acceptance', async () => {
    const request = await requestEvent()
    const acceptance = await acceptanceEvent(request)
    const socket = new FakeSocket()
    socket.send = (message: string) => {
      socket.sent.push(message)
      setImmediate(() => {
        socket.emit('message', Buffer.from(JSON.stringify(['EVENT', 'peering-acceptance', acceptance])))
        socket.emit('message', Buffer.from(JSON.stringify(['OK', request.id, true, ''])))
      })
    }

    const reply = await sendPeeringRequest(socket as any, request, 1_000)

    expect(reply.ok).to.equal(true)
    expect(reply.acceptance?.event.id).to.equal(acceptance.id)
  })

  it('keeps success when the acceptance and OK arrive before a short timeout', async () => {
    const request = await requestEvent()
    const acceptance = await acceptanceEvent(request)
    const socket = new FakeSocket()
    socket.send = (message: string) => {
      socket.sent.push(message)
      socket.emit('message', Buffer.from(JSON.stringify(['EVENT', 'peering-acceptance', acceptance])))
      socket.emit('message', Buffer.from(JSON.stringify(['OK', request.id, true, ''])))
    }

    const reply = await sendPeeringRequest(socket as any, request, 100)

    expect(reply.ok).to.equal(true)
    expect(reply.acceptance?.event.id).to.equal(acceptance.id)
  })

  it('keeps a positive acknowledgement when the socket closes', async () => {
    const request = await requestEvent()
    const socket = new FakeSocket()
    socket.send = (message: string) => {
      socket.sent.push(message)
      socket.emit('message', Buffer.from(JSON.stringify(['OK', request.id, true, ''])))
      socket.emit('close')
    }

    const reply = await sendPeeringRequest(socket as any, request, 1_000)

    expect(reply.ok).to.equal(true)
    expect(reply.acceptance).to.equal(undefined)
  })

  it('settles a positive acknowledgement on a socket error', async () => {
    const request = await requestEvent()
    const socket = new FakeSocket()
    socket.send = (message: string) => {
      socket.sent.push(message)
      socket.emit('message', Buffer.from(JSON.stringify(['OK', request.id, true, ''])))
      socket.emit('error', new Error('broken pipe'))
    }

    const reply = await sendPeeringRequest(socket as any, request, 1_000)

    expect(reply.ok).to.equal(true)
  })

  it('returns the peer rejection reason', async () => {
    const request = await requestEvent()
    const socket = new FakeSocket()
    socket.send = (message: string) => {
      socket.sent.push(message)
      setImmediate(() => {
        socket.emit('message', Buffer.from(JSON.stringify(['OK', request.id, false, 'restricted: not configured'])))
      })
    }

    const reply = await sendPeeringRequest(socket as any, request, 1_000)

    expect(reply).to.include({ ok: false, message: 'restricted: not configured' })
  })

  it('builds a request for the advertised terms and sends it', async () => {
    const socket = new FakeSocket()
    let sent: Event | undefined
    const log = Sinon.stub(process.stdout, 'write')

    const code = await runPeeringRequest(
      { relayUrl: 'wss://peer.example.com', ownerKey, json: true },
      {
        loadSettings: () => ({ info: { relay_url: 'wss://me.example.com' } }) as any,
        fetchAdvertisement: async () => ({
          enabled: true,
          self: receiverPubkey,
          scopes,
          terms,
          supportedNips: [77],
        }),
        authenticate: async () => ({ socket: socket as any, challenge: 'c', authEvent: {} as any }),
        relayPrivateKey: () => relayKey,
        send: async (_socket, request) => {
          sent = request
          return { ok: true, message: 'accepted' }
        },
      },
    )

    expect(code).to.equal(0)
    expect(sent?.pubkey).to.equal(ownerPubkey)
    expect(JSON.parse(sent!.content)).to.include({
      relay_pubkey: relayPubkey,
      relay_url: 'wss://me.example.com',
    })
    expect(socket.close).to.have.been.calledOnce
    expect(log).to.have.been.called
  })

  it('fails when the peer does not advertise peering', async () => {
    let error: unknown
    try {
      await runPeeringRequest(
        { relayUrl: 'wss://peer.example.com', ownerKey },
        {
          loadSettings: () => ({ info: { relay_url: 'wss://me.example.com' } }) as any,
          fetchAdvertisement: async () => ({
            enabled: false,
            self: receiverPubkey,
            scopes: [],
            terms: [],
            supportedNips: [],
          }),
          relayPrivateKey: () => relayKey,
        },
      )
    } catch (caught) {
      error = caught
    }

    expect((error as Error).message).to.include('does not advertise peering')
  })

  it('fails when the peer does not advertise its relay key', async () => {
    let error: unknown
    try {
      await runPeeringRequest(
        { relayUrl: 'wss://peer.example.com', ownerKey },
        {
          loadSettings: () => ({ info: { relay_url: 'wss://me.example.com' } }) as any,
          fetchAdvertisement: async () => ({ enabled: true, scopes, terms, supportedNips: [] }),
          relayPrivateKey: () => relayKey,
        },
      )
    } catch (caught) {
      error = caught
    }

    expect((error as Error).message).to.include('relay pubkey')
  })

  it('rejects an invalid acceptance with --json', async () => {
    const socket = new FakeSocket()
    const stderr = Sinon.stub(process.stderr, 'write')

    const code = await runPeeringRequest(
      { relayUrl: 'wss://peer.example.com', ownerKey, json: true },
      {
        loadSettings: () => ({ info: { relay_url: 'wss://me.example.com' } }) as any,
        fetchAdvertisement: async () => ({
          enabled: true,
          self: receiverPubkey,
          scopes,
          terms,
          supportedNips: [77],
        }),
        authenticate: async () => ({ socket: socket as any, challenge: 'c', authEvent: {} as any }),
        relayPrivateKey: () => relayKey,
        send: async () => ({
          ok: true,
          message: 'accepted',
          acceptance: { event: await requestEvent(), acceptance: {} as any },
        }),
      },
    )

    expect(code).to.equal(1)
    expect(JSON.parse(String(stderr.firstCall.args[0])).error.message).to.include('invalid acceptance')
  })

  it('rejects an acceptance signed by a different relay key', async () => {
    const socket = new FakeSocket()
    const stderr = Sinon.stub(process.stderr, 'write')

    const code = await runPeeringRequest(
      { relayUrl: 'wss://peer.example.com', ownerKey, json: true },
      {
        loadSettings: () => ({ info: { relay_url: 'wss://me.example.com' } }) as any,
        fetchAdvertisement: async () => ({
          enabled: true,
          self: receiverPubkey,
          scopes,
          terms,
          supportedNips: [77],
        }),
        authenticate: async () => ({ socket: socket as any, challenge: 'c', authEvent: {} as any }),
        relayPrivateKey: () => relayKey,
        send: async (_socket, request) => ({
          ok: true,
          message: 'accepted',
          acceptance: {
            event: await buildPeeringAcceptanceEvent({
              request,
              acceptance: JSON.parse(request.content),
              relayPrivateKey: relayKey,
              relayUrl: 'wss://receiver.example.com',
            }),
            acceptance: JSON.parse(request.content),
          },
        }),
      },
    )

    expect(code).to.equal(1)
    expect(JSON.parse(String(stderr.firstCall.args[0])).error.message).to.include('different relay key')
  })

  it('times out when the peer never answers', async () => {
    const request = await requestEvent()
    const socket = new FakeSocket()
    socket.send = (message: string) => socket.sent.push(message)

    const reply = await sendPeeringRequest(socket as any, request, 20)

    expect(reply).to.include({ ok: false })
  })

  it('prints a machine-readable rejection with --json', async () => {
    const socket = new FakeSocket()
    const stderr = Sinon.stub(process.stderr, 'write')

    const code = await runPeeringRequest(
      { relayUrl: 'wss://peer.example.com', ownerKey, json: true },
      {
        loadSettings: () => ({ info: { relay_url: 'wss://me.example.com' } }) as any,
        fetchAdvertisement: async () => ({
          enabled: true,
          self: receiverPubkey,
          scopes,
          terms,
          supportedNips: [77],
        }),
        authenticate: async () => ({ socket: socket as any, challenge: 'c', authEvent: {} as any }),
        relayPrivateKey: () => relayKey,
        send: async () => ({ ok: false, message: 'restricted: not configured' }),
      },
    )

    expect(code).to.equal(1)
    expect(JSON.parse(String(stderr.firstCall.args[0]))).to.deep.equal({
      error: { message: 'peer rejected the peering request: restricted: not configured', code: 1 },
    })
  })

  it('requires an owner key', async () => {
    const previous = process.env.PEERING_OWNER_PRIVATE_KEY
    delete process.env.PEERING_OWNER_PRIVATE_KEY

    try {
      let error: unknown
      try {
        await runPeeringRequest({ relayUrl: 'wss://peer.example.com' })
      } catch (caught) {
        error = caught
      }
      expect(error).to.be.instanceOf(Error)
      expect((error as Error).message).to.include('PEERING_OWNER_PRIVATE_KEY')
    } finally {
      if (previous !== undefined) {
        process.env.PEERING_OWNER_PRIVATE_KEY = previous
      }
    }
  })
})
