import chai from 'chai'
import { createHash } from 'crypto'
import EventEmitter from 'events'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { MessageType } from '../../../src/@types/messages'
import { Settings } from '../../../src/@types/settings'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'
import { NegMsgMessageHandler } from '../../../src/handlers/neg-msg-message-handler'
import { Negentropy, NegentropyStorageVector } from '../../../src/utils/negentropy'
import { NegentropySessions } from '../../../src/utils/negentropy-sessions'

chai.use(sinonChai)
const { expect } = chai

const storageOf = (count: number): NegentropyStorageVector => {
  const storage = new NegentropyStorageVector()
  for (let i = 0; i < count; i++) {
    storage.insert(1700000000 + i, createHash('sha256').update(`neg-msg-${i}`).digest())
  }
  storage.seal()

  return storage
}

describe('NegMsgMessageHandler', () => {
  let sandbox: Sinon.SinonSandbox
  let webSocket: IWebSocketAdapter
  let sessions: NegentropySessions
  let settings: Settings
  let emitted: Sinon.SinonStub
  let handler: NegMsgMessageHandler

  const send = (id: string, hex: string) => handler.handleMessage([MessageType.NEG_MSG, id, hex] as any)

  const openSession = (id: string, itemCount = 5, filter: any = { kinds: [1] }) => {
    const token = sessions.reserve(id, 3) as symbol
    sessions.activate(id, token, { negentropy: new Negentropy(storageOf(itemCount)), filter }, 60000)
  }

  const validMessageHex = Buffer.from(new Negentropy(storageOf(0)).initiate()).toString('hex')

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sessions = new NegentropySessions(() => undefined)
    settings = { nip77: { enabled: true } } as Settings

    webSocket = new EventEmitter() as any
    webSocket.getNegentropySessions = () => sessions

    emitted = sandbox.stub()
    webSocket.on(WebSocketAdapterEvent.Message, emitted)

    handler = new NegMsgMessageHandler(webSocket, () => settings)
  })

  afterEach(() => {
    sessions.closeAll()
    webSocket.removeAllListeners()
    sandbox.restore()
  })

  it('answers a message on an open session with a NEG-MSG', async () => {
    openSession('sync1')

    await send('sync1', validMessageHex)

    expect(emitted).to.have.been.calledOnce
    const [type, id, payload] = emitted.firstCall.args[0]
    expect(type).to.equal(MessageType.NEG_MSG)
    expect(id).to.equal('sync1')
    expect(payload).to.match(/^61(?:[0-9a-f]{2})+$/)
    expect(sessions.getSessionIds()).to.deep.equal(['sync1'])
  })

  it('replies NEG-ERR closed for an unknown subscription id', async () => {
    await send('nope', validMessageHex)

    expect(emitted).to.have.been.calledOnceWithExactly([
      MessageType.NEG_ERR,
      'nope',
      'closed: unknown negentropy subscription',
    ])
  })

  it('does not answer for a REQ subscription id: the namespaces are separate', async () => {
    // A REQ subscription named "sync1" lives in the adapter's subscriptions, not in the negentropy sessions.
    await send('sync1', validMessageHex)

    expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_ERR)
  })

  it('closes the session and replies NEG-ERR when the message is malformed', async () => {
    openSession('sync1')

    await send('sync1', '6100')

    expect(emitted).to.have.been.calledOnceWithExactly([
      MessageType.NEG_ERR,
      'sync1',
      'invalid: malformed negentropy message',
    ])
    expect(sessions.getSessionIds()).to.deep.equal([])
  })

  it('keeps other sessions when one is closed by an error', async () => {
    openSession('a')
    openSession('b')

    await send('a', '6100')

    expect(sessions.getSessionIds()).to.deep.equal(['b'])
  })

  it('ends the session with NEG-ERR blocked when NIP-77 is turned off while it is open', async () => {
    openSession('sync1')
    settings = { nip77: { enabled: false } } as Settings

    await send('sync1', validMessageHex)

    expect(emitted).to.have.been.calledOnceWithExactly([
      MessageType.NEG_ERR,
      'sync1',
      'blocked: NIP-77 is disabled by relay configuration',
    ])
    expect(sessions.getSessionIds()).to.deep.equal([])
  })

  describe('authorization is checked on every message', () => {
    const pubkey = 'f'.repeat(64)
    let authenticated: Set<string>

    beforeEach(() => {
      authenticated = new Set([pubkey])
      webSocket.getAuthenticatedPubkeys = () => authenticated
      settings = { nip77: { enabled: true }, nip42: { restrictedReads: { enabled: true } } } as Settings
    })

    it('keeps answering while the client is still authorized', async () => {
      openSession('sync1', 5, { authors: [pubkey] })

      await send('sync1', validMessageHex)

      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
    })

    it('closes the session with auth-required once authentication lapses', async () => {
      openSession('sync1', 5, { authors: [pubkey] })
      authenticated.clear() // e.g. nip42.sessionExpirySeconds elapsed

      await send('sync1', validMessageHex)

      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'sync1',
        'auth-required: authentication is required to sync these event kinds',
      ])
      expect(sessions.getSessionIds()).to.deep.equal([])
    })

    it('closes the session when restricted reads were switched on after it opened', async () => {
      settings = { nip77: { enabled: true } } as Settings
      openSession('sync1', 5, {})
      settings = { nip77: { enabled: true }, nip42: { restrictedReads: { enabled: true } } } as Settings
      authenticated.clear()

      await send('sync1', validMessageHex)

      expect(emitted.firstCall.args[0][2]).to.match(/^auth-required:/)
      expect(sessions.getSessionIds()).to.deep.equal([])
    })

    it('does not ask for auth when the session only covers ordinary kinds', async () => {
      openSession('sync1', 5, { kinds: [1] })
      authenticated.clear()

      await send('sync1', validMessageHex)

      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
    })
  })

  it('answers an unsupported protocol version with just the supported version', async () => {
    openSession('sync1')

    await send('sync1', '62')

    expect(emitted).to.have.been.calledOnceWithExactly([MessageType.NEG_MSG, 'sync1', '61'])
  })

  describe('paid access is checked on every message', () => {
    const peer = 'a'.repeat(64)
    let billing: { getAccess: Sinon.SinonStub }

    beforeEach(() => {
      billing = { getAccess: sandbox.stub().resolves({ allowed: true }) }
      ;(webSocket as any).getPeerPubkey = () => peer
      handler = new NegMsgMessageHandler(webSocket, () => settings, billing as any)
    })

    it('keeps answering while the peer still has an active period', async () => {
      openSession('sync1')

      await send('sync1', validMessageHex)

      expect(billing.getAccess).to.have.been.calledWith(peer)
      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
    })

    it('closes the session when the paid period lapses mid-sync', async () => {
      openSession('sync1')
      billing.getAccess.resolves({ allowed: false, reason: 'peering access lapsed; request a new invoice' })

      await send('sync1', validMessageHex)

      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'sync1',
        'payment-required: peering access lapsed; request a new invoice',
      ])
      expect(sessions.getSessionIds()).to.deep.equal([])
    })

    it('does not double-prefix a payment-required reason', async () => {
      openSession('sync1')
      billing.getAccess.resolves({ allowed: false, reason: 'payment-required: settle the invoice' })

      await send('sync1', validMessageHex)

      expect(emitted.firstCall.args[0][2]).to.equal('payment-required: settle the invoice')
    })

    it('fails closed when the billing check errors', async () => {
      openSession('sync1')
      billing.getAccess.rejects(new Error('database down'))

      await send('sync1', validMessageHex)

      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'sync1',
        'error: unable to check peering access',
      ])
      expect(sessions.getSessionIds()).to.deep.equal([])
    })

    it('does not consult billing for a connection without a peer identity', async () => {
      ;(webSocket as any).getPeerPubkey = () => undefined
      openSession('sync1')

      await send('sync1', validMessageHex)

      expect(billing.getAccess).not.to.have.been.called
      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
    })

    it('does not answer or close a replacement session after the billing wait', async () => {
      openSession('sync1')
      let settle!: (access: unknown) => void
      billing.getAccess.returns(
        new Promise((resolve) => {
          settle = resolve
        }),
      )

      const pending = send('sync1', validMessageHex)
      // The peer replaces sync1 while the billing check is still running.
      openSession('sync1')
      settle({ allowed: false, reason: 'peering access lapsed' })

      await pending

      expect(emitted).not.to.have.been.called
      expect(sessions.getSessionIds()).to.deep.equal(['sync1'])
    })

    it('does not close a replacement session when the billing check fails', async () => {
      openSession('sync1')
      let fail!: (error: unknown) => void
      billing.getAccess.returns(
        new Promise((_resolve, reject) => {
          fail = reject
        }),
      )

      const pending = send('sync1', validMessageHex)
      openSession('sync1')
      fail(new Error('database down'))

      await pending

      expect(emitted).not.to.have.been.called
      expect(sessions.getSessionIds()).to.deep.equal(['sync1'])
    })

    it('does not answer a session that was closed during the billing wait', async () => {
      openSession('sync1')
      let settle!: (access: unknown) => void
      billing.getAccess.returns(
        new Promise((resolve) => {
          settle = resolve
        }),
      )

      const pending = send('sync1', validMessageHex)
      sessions.close('sync1')
      settle({ allowed: false, reason: 'peering access lapsed' })

      await pending

      expect(emitted).not.to.have.been.called
      expect(sessions.getSessionIds()).to.deep.equal([])
    })
  })
})
