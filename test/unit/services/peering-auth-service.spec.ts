import { AddressInfo } from 'node:net'

import { expect } from 'chai'
import Sinon from 'sinon'
import { WebSocket, WebSocketServer } from 'ws'
import { AuthMessage } from '../../../src/@types/messages'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'
import { EventKinds, EventTags } from '../../../src/constants/base'
import { AuthMessageHandler } from '../../../src/handlers/auth-message-handler'
import { authenticateToPeeringRelay } from '../../../src/services/peering-auth-service'
import { getPublicKey, isEventIdValid, isEventSignatureValid } from '../../../src/utils/event'

describe('peering-auth-service', () => {
  const privateKey = 'a'.repeat(64)
  const pubkey = getPublicKey(privateKey)

  let server: WebSocketServer | undefined
  let client: WebSocket | undefined

  const startServer = async (onConnection: (socket: WebSocket) => void): Promise<string> => {
    const created = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => created.once('listening', () => resolve()))
    created.on('connection', onConnection)
    server = created
    const address = created.address() as AddressInfo

    return `ws://127.0.0.1:${address.port}`
  }

  afterEach(async () => {
    client?.terminate()
    client = undefined

    const current = server
    server = undefined
    if (!current) {
      return
    }

    await new Promise<void>((resolve) => {
      for (const socket of current.clients) {
        socket.terminate()
      }
      current.close(() => resolve())
    })
  })

  it('authenticates to a relay as this relay keypair', async () => {
    const challenge = 'server-challenge'
    let received: unknown

    const relayUrl = await startServer((socket) => {
      socket.send(JSON.stringify(['AUTH', challenge]))
      socket.on('message', (raw) => {
        received = JSON.parse(raw.toString())
        const event = (received as [string, { id: string }])[1]
        socket.send(JSON.stringify(['OK', event.id, true, '']))
      })
    })

    const result = await authenticateToPeeringRelay({ relayUrl, privateKey, timeoutMs: 2_000 })
    client = result.socket

    expect(result.challenge).to.equal(challenge)
    expect(result.authEvent.pubkey).to.equal(pubkey)

    const message = received as [string, typeof result.authEvent]
    expect(message[0]).to.equal('AUTH')
    expect(message[1].kind).to.equal(EventKinds.AUTH)
    expect(message[1].tags).to.deep.equal([
      [EventTags.AuthRelay, relayUrl],
      [EventTags.Challenge, challenge],
    ])
    expect(await isEventIdValid(message[1])).to.equal(true)
    expect(await isEventSignatureValid(message[1])).to.equal(true)
  })

  it('is recognized as a peer by another nostream relay', async () => {
    const challenge = 'nostream-challenge'
    let recognized: string | undefined

    const created = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => created.once('listening', () => resolve()))
    server = created
    const relayUrl = `ws://127.0.0.1:${(created.address() as AddressInfo).port}`

    created.on('connection', (socket) => {
      const adapter = {
        getClientId: () => 'peer-test',
        getChallenge: () => challenge,
        addAuthenticatedPubkey: () => true,
        setPeerPubkey: (peer: string) => {
          recognized = peer
        },
        emit: (event: string, payload: unknown) => {
          if (event === WebSocketAdapterEvent.Message) {
            socket.send(JSON.stringify(payload))
          }
        },
      } as any

      const handler = new AuthMessageHandler(
        adapter,
        () =>
          ({
            info: { relay_url: relayUrl },
            peering: {
              enabled: true,
              peers: [{ pubkey, relayUrl: 'wss://peer.example.com', enabled: true }],
            },
          }) as any,
      )

      socket.send(JSON.stringify(['AUTH', challenge]))
      socket.on('message', (raw) => {
        void handler.handleMessage(JSON.parse(raw.toString()) as AuthMessage)
      })
    })

    const result = await authenticateToPeeringRelay({ relayUrl, privateKey, timeoutMs: 2_000 })
    client = result.socket

    expect(result.authEvent.pubkey).to.equal(pubkey)
    expect(recognized).to.equal(pubkey)
  })

  it('rejects when the relay refuses the AUTH event', async () => {
    const relayUrl = await startServer((socket) => {
      socket.send(JSON.stringify(['AUTH', 'server-challenge']))
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString())[1] as { id: string }
        socket.send(JSON.stringify(['OK', event.id, false, 'blocked: peer not allowed']))
      })
    })

    const error = await authenticateToPeeringRelay({ relayUrl, privateKey, timeoutMs: 2_000 }).then(
      () => undefined,
      (err: Error) => err,
    )

    expect(error).to.be.instanceOf(Error)
    expect(error?.message).to.include('peering AUTH rejected')
    expect(error?.message).to.include('blocked: peer not allowed')
  })

  it('times out when the relay never sends an AUTH challenge', async () => {
    const relayUrl = await startServer(() => {
      // Deliberately send nothing.
    })

    const error = await authenticateToPeeringRelay({ relayUrl, privateKey, timeoutMs: 50 }).then(
      () => undefined,
      (err: Error) => err,
    )

    expect(error).to.be.instanceOf(Error)
    expect(error?.message).to.include('timed out waiting for peering AUTH')
  })
})
