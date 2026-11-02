import chai from 'chai'
import { createHash } from 'crypto'
import EventEmitter from 'events'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { MessageType } from '../../../src/@types/messages'
import { IEventRepository } from '../../../src/@types/repositories'
import { Settings } from '../../../src/@types/settings'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'
import { NegMsgMessageHandler } from '../../../src/handlers/neg-msg-message-handler'
import { NegOpenMessageHandler } from '../../../src/handlers/neg-open-message-handler'
import { Negentropy, NegentropyStorageVector } from '../../../src/utils/negentropy'
import { NegentropySessions } from '../../../src/utils/negentropy-sessions'

chai.use(sinonChai)
const { expect } = chai

const BASE_TIMESTAMP = 1700000000

const idFor = (n: number): Buffer => createHash('sha256').update(`neg-open-${n}`).digest()

const rowsFor = (from: number, to: number) => {
  const rows: { event_created_at: number; event_id: Buffer }[] = []
  for (let i = from; i < to; i++) {
    rows.push({ event_created_at: BASE_TIMESTAMP + i, event_id: idFor(i) })
  }

  return rows
}

const clientFor = (from: number, to: number): Negentropy => {
  const storage = new NegentropyStorageVector()
  for (const row of rowsFor(from, to)) {
    storage.insert(row.event_created_at, row.event_id)
  }
  storage.seal()

  return new Negentropy(storage)
}

const emptyClientMessageHex = Buffer.from(clientFor(0, 0).initiate()).toString('hex')

describe('NegOpenMessageHandler', () => {
  let sandbox: Sinon.SinonSandbox
  let webSocket: IWebSocketAdapter
  let sessions: NegentropySessions
  let eventRepository: IEventRepository
  let findReconciliationItems: Sinon.SinonStub
  let settings: Settings
  let emitted: Sinon.SinonStub
  let handler: NegOpenMessageHandler

  const open = (id = 'sync1', filter: any = { kinds: [1] }, hex = emptyClientMessageHex) =>
    handler.handleMessage([MessageType.NEG_OPEN, id, filter, hex] as any)

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sessions = new NegentropySessions(() => undefined)
    findReconciliationItems = sandbox.stub().resolves(rowsFor(0, 5))
    eventRepository = { findReconciliationItems } as any
    settings = { nip77: { enabled: true, maxEventsPerSession: 100, maxSessionsPerConnection: 2 } } as Settings

    webSocket = new EventEmitter() as any
    webSocket.getNegentropySessions = () => sessions
    webSocket.getAuthenticatedPubkeys = () => new Set<string>()
    webSocket.getPeerPubkey = () => undefined

    emitted = sandbox.stub()
    webSocket.on(WebSocketAdapterEvent.Message, emitted)

    handler = new NegOpenMessageHandler(webSocket, eventRepository, () => settings)
  })

  afterEach(() => {
    sessions.closeAll()
    webSocket.removeAllListeners()
    sandbox.restore()
  })

  it('answers the initial message with a NEG-MSG and keeps the session open', async () => {
    await open()

    expect(emitted).to.have.been.calledOnce
    const [type, id, payload] = emitted.firstCall.args[0]
    expect(type).to.equal(MessageType.NEG_MSG)
    expect(id).to.equal('sync1')
    expect(payload).to.match(/^61(?:[0-9a-f]{2})+$/)
    expect(sessions.getSessionIds()).to.deep.equal(['sync1'])
  })

  it('reads the matching events with one row of headroom over the limit', async () => {
    await open('sync1', { kinds: [1], limit: 3 })

    expect(findReconciliationItems).to.have.been.calledOnceWithExactly({ kinds: [1], limit: 3 }, 101)
  })

  describe('when disabled', () => {
    it('replies NEG-ERR blocked and does not read events', async () => {
      settings = { nip77: { enabled: false } } as Settings

      await open()

      expect(findReconciliationItems).to.not.have.been.called
      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'sync1',
        'blocked: NIP-77 is disabled by relay configuration',
      ])
      expect(sessions.getSessionIds()).to.deep.equal([])
    })

    it('is disabled when the nip77 section is missing', async () => {
      settings = {} as Settings

      await open()

      expect(emitted.firstCall.args[0][2]).to.match(/^blocked: NIP-77 is disabled/)
    })
  })

  describe('limits', () => {
    it('rejects a query that matches more events than allowed, with the limit as 4th element', async () => {
      findReconciliationItems.resolves(rowsFor(0, 101))

      await open()

      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'sync1',
        'blocked: this query is too big',
        100,
      ])
      expect(sessions.getSessionIds()).to.deep.equal([])
    })

    it('accepts a query that matches exactly the limit', async () => {
      findReconciliationItems.resolves(rowsFor(0, 100))

      await open()

      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
    })

    it('frees the slot of a rejected oversized query', async () => {
      findReconciliationItems.resolves(rowsFor(0, 101))
      await open('big')

      findReconciliationItems.resolves(rowsFor(0, 5))
      await open('a')
      await open('b')

      expect(sessions.getSessionIds()).to.have.members(['a', 'b'])
    })

    it('rejects a new session beyond the per-connection limit', async () => {
      await open('a')
      await open('b')
      emitted.resetHistory()

      await open('c')

      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'c',
        'blocked: too many negentropy sessions or reads in progress on this connection (max 2)',
      ])
      expect(sessions.getSessionIds()).to.have.members(['a', 'b'])
    })

    it('lets a client reopen an id it already has when at the limit, replacing the session', async () => {
      await open('a')
      await open('b')
      emitted.resetHistory()

      await open('a')

      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
      expect(sessions.getSessionIds()).to.have.members(['a', 'b'])
    })

    it('uses the defaults when no limits are configured', async () => {
      settings = { nip77: { enabled: true } } as Settings

      await open()

      expect(findReconciliationItems.firstCall.args[1]).to.equal(100001)
    })

    it('rejects subscription ids over the configured length', async () => {
      settings = {
        nip77: { enabled: true },
        limits: { client: { subscription: { maxSubscriptionIdLength: 4 } } },
      } as Settings

      await open('too-long')

      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'too-long',
        'invalid: subscription id too long (max 4)',
      ])
      expect(findReconciliationItems).to.not.have.been.called
    })

    it('rejects filters with too many values', async () => {
      settings = {
        nip77: { enabled: true },
        limits: { client: { subscription: { maxFilterValues: 2 } } },
      } as Settings

      await open('sync1', { authors: ['a', 'b', 'c'] })

      expect(emitted.firstCall.args[0][2]).to.equal('blocked: too many filter values (max 2)')
      expect(findReconciliationItems).to.not.have.been.called
    })

    it('uses peer limits instead of client limits for a recognized peer', async () => {
      settings = {
        nip77: { enabled: true },
        limits: {
          client: { subscription: { maxFilterValues: 1 } },
          peer: { subscription: { maxFilterValues: 10 } },
        },
      } as Settings
      webSocket.getPeerPubkey = () => 'a'.repeat(64)

      await open('sync1', { authors: ['a', 'b'] })

      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
      expect(findReconciliationItems).to.have.been.called
    })
  })

  describe('NIP-42', () => {
    const pubkey = 'f'.repeat(64)
    const otherPubkey = 'e'.repeat(64)

    beforeEach(() => {
      settings = { nip77: { enabled: true }, nip42: { restrictedReads: { enabled: true } } } as Settings
    })

    const expectAuthRequired = () => {
      expect(findReconciliationItems).to.not.have.been.called
      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'sync1',
        'auth-required: authentication is required to sync these event kinds',
      ])
    }

    it('requires auth to sync restricted kinds', async () => {
      await open('sync1', { kinds: [1059], '#p': [pubkey] })

      expectAuthRequired()
    })

    // REQ hides restricted events one by one; reconciliation would list their ids, so a filter that
    // could match one has to be scoped to the client.
    it('requires auth for a filter that names no kinds, which could match restricted events', async () => {
      await open('sync1', {})

      expectAuthRequired()
    })

    it('requires auth for an authors-only filter of someone else', async () => {
      webSocket.getAuthenticatedPubkeys = () => new Set([pubkey])

      await open('sync1', { authors: [otherPubkey] })

      expectAuthRequired()
    })

    it('requires auth for a filter mixing a restricted and an ordinary kind', async () => {
      await open('sync1', { kinds: [1, 1059] })

      expectAuthRequired()
    })

    it('requires every author to be authenticated', async () => {
      webSocket.getAuthenticatedPubkeys = () => new Set([pubkey])

      await open('sync1', { authors: [pubkey, otherPubkey] })

      expectAuthRequired()
    })

    it('allows restricted kinds scoped to the authenticated pubkey', async () => {
      webSocket.getAuthenticatedPubkeys = () => new Set([pubkey])

      await open('sync1', { kinds: [1059], '#p': [pubkey] })

      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
    })

    it('allows a filter without kinds when it is scoped to the authenticated pubkey', async () => {
      webSocket.getAuthenticatedPubkeys = () => new Set([pubkey])

      await open('sync1', { authors: [pubkey] })

      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
    })

    it('does not restrict filters whose kinds are all ordinary', async () => {
      await open('sync1', { kinds: [1, 7] })

      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
    })

    it('does not restrict anything when restricted reads are off', async () => {
      settings = { nip77: { enabled: true } } as Settings

      await open('sync1', {})

      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
    })
  })

  describe('malformed input', () => {
    it('rejects an initial message that is not a negentropy message, before reading events', async () => {
      await open('sync1', {}, 'ff00')

      expect(findReconciliationItems).to.not.have.been.called
      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'sync1',
        'invalid: malformed negentropy message',
      ])
    })

    it('rejects a truncated initial message and keeps no session', async () => {
      await open('sync1', {}, '6100')

      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'sync1',
        'invalid: malformed negentropy message',
      ])
      expect(sessions.getSessionIds()).to.deep.equal([])
    })

    it('answers an unsupported protocol version with just the supported version', async () => {
      await open('sync1', {}, '62')

      expect(emitted).to.have.been.calledOnceWithExactly([MessageType.NEG_MSG, 'sync1', '61'])
    })
  })

  describe('failures', () => {
    it('replies with a generic NEG-ERR when reading events fails, without leaking the cause', async () => {
      findReconciliationItems.rejects(new Error('connection to 10.0.0.5 refused'))

      await open()

      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'sync1',
        'error: unable to process negentropy request',
      ])
      expect(sessions.getSessionIds()).to.deep.equal([])
    })

    it('frees the slot after a failure', async () => {
      findReconciliationItems.rejects(new Error('boom'))
      await open('a')
      await open('b')
      findReconciliationItems.resolves(rowsFor(0, 5))

      await open('c')
      await open('d')

      expect(sessions.getSessionIds()).to.have.members(['c', 'd'])
    })

    it('stays silent when the client closed the session while events were being read', async () => {
      let finishRead: (rows: any[]) => void = () => undefined
      findReconciliationItems.returns(new Promise((resolve) => (finishRead = resolve)))

      const pending = open('sync1')
      sessions.close('sync1')
      finishRead(rowsFor(0, 5))
      await pending

      expect(emitted).to.not.have.been.called
      expect(sessions.getSessionIds()).to.deep.equal([])
    })

    it('lets a newer NEG-OPEN win when two race on the same id', async () => {
      const finishers: ((rows: any[]) => void)[] = []
      findReconciliationItems.callsFake(() => new Promise((resolve) => finishers.push(resolve)))

      const first = open('sync1', { kinds: [1] })
      const second = open('sync1', { kinds: [7] })
      finishers[1](rowsFor(0, 5))
      await second
      finishers[0](rowsFor(0, 5))
      await first

      expect(emitted).to.have.been.calledOnce
      expect(sessions.getSessionIds()).to.deep.equal(['sync1'])
    })
  })

  describe('replacing an open session', () => {
    const pendingReads = () => {
      const finishers: { resolve: (rows: any[]) => void; reject: (error: Error) => void }[] = []
      findReconciliationItems.callsFake(() => new Promise((resolve, reject) => finishers.push({ resolve, reject })))

      return finishers
    }

    // NIP-77: after a NEG-ERR the subscription is considered closed.
    for (const [name, arrange, hex, filter] of [
      ['a bad version byte', () => undefined, 'ff00', {}],
      [
        'too many filter values',
        () =>
          (settings = {
            nip77: { enabled: true },
            limits: { client: { subscription: { maxFilterValues: 1 } } },
          } as Settings),
        emptyClientMessageHex,
        { authors: ['a', 'b'] },
      ],
      [
        'NIP-77 being turned off',
        () => (settings = { nip77: { enabled: false } } as Settings),
        emptyClientMessageHex,
        {},
      ],
      [
        'an unauthorized filter',
        () => (settings = { nip77: { enabled: true }, nip42: { restrictedReads: { enabled: true } } } as Settings),
        emptyClientMessageHex,
        {},
      ],
    ] as [string, () => void, string, any][]) {
      it(`closes the session the client already had when the replacement is rejected for ${name}`, async () => {
        await open('sync1')
        expect(sessions.getSessionIds()).to.deep.equal(['sync1'])
        arrange()
        emitted.resetHistory()

        await open('sync1', filter, hex)

        expect(emitted).to.have.been.calledOnce
        expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_ERR)
        expect(sessions.getSessionIds()).to.deep.equal([])
      })
    }

    it('frees the slot of a session whose replacement was rejected', async () => {
      await open('a')
      await open('b')

      await open('a', {}, 'ff00')

      await open('c')
      expect(sessions.getSessionIds()).to.have.members(['b', 'c'])
    })

    it('stays silent when a replaced request turns out to be too big', async () => {
      const reads = pendingReads()
      const first = open('sync1', { kinds: [1] })
      const second = open('sync1', { kinds: [7] })
      reads[1].resolve(rowsFor(0, 5))
      await second
      emitted.resetHistory()

      reads[0].resolve(rowsFor(0, 101))
      await first

      expect(emitted).to.not.have.been.called
      expect(sessions.getSessionIds()).to.deep.equal(['sync1'])
    })

    it('stays silent when a replaced request fails to read', async () => {
      const reads = pendingReads()
      const first = open('sync1', { kinds: [1] })
      const second = open('sync1', { kinds: [7] })
      reads[1].resolve(rowsFor(0, 5))
      await second
      emitted.resetHistory()

      reads[0].reject(new Error('boom'))
      await first

      expect(emitted).to.not.have.been.called
      expect(sessions.getSessionIds()).to.deep.equal(['sync1'])
    })

    it('stays silent when a replaced request had a malformed message', async () => {
      const reads = pendingReads()
      const first = open('sync1', { kinds: [1] }, '6100')
      const second = open('sync1', { kinds: [7] })
      reads[1].resolve(rowsFor(0, 5))
      await second
      emitted.resetHistory()

      reads[0].resolve(rowsFor(0, 5))
      await first

      expect(emitted).to.not.have.been.called
      expect(sessions.getSessionIds()).to.deep.equal(['sync1'])
    })

    it('does no work for a replaced request once its read returns', async () => {
      const reads = pendingReads()
      const first = open('sync1', { kinds: [1] })
      const second = open('sync1', { kinds: [7] })
      reads[1].resolve(rowsFor(0, 5))
      await second
      emitted.resetHistory()
      const sealSpy = sandbox.spy(NegentropyStorageVector.prototype, 'seal')

      reads[0].resolve(rowsFor(0, 50))
      await first

      expect(sealSpy).to.not.have.been.called
    })

    it('does not let repeated NEG-OPENs on one id pile up event reads', async () => {
      const reads = pendingReads()

      const opens = [open('sync1'), open('sync1')]
      await open('sync1') // a third read while the first two have not returned

      expect(findReconciliationItems).to.have.been.calledTwice
      expect(emitted).to.have.been.calledOnceWithExactly([
        MessageType.NEG_ERR,
        'sync1',
        'blocked: too many negentropy sessions or reads in progress on this connection (max 2)',
      ])

      reads.forEach((read) => read.resolve(rowsFor(0, 5)))
      await Promise.all(opens)
    })

    it('accepts new reads again once the earlier ones have returned', async () => {
      const reads = pendingReads()
      const opens = [open('sync1'), open('sync1')]
      reads.forEach((read) => read.resolve(rowsFor(0, 5)))
      await Promise.all(opens)
      findReconciliationItems.resolves(rowsFor(0, 5))
      emitted.resetHistory()

      await open('sync1')

      expect(emitted.firstCall.args[0][0]).to.equal(MessageType.NEG_MSG)
    })
  })

  describe('a full reconciliation through the handlers', () => {
    const decode = (message: any[]) => new Uint8Array(Buffer.from(message[2], 'hex'))

    // The relay holds events 10-59; the client holds 0-39. The client must learn that it lacks 40-59
    // and that the relay lacks 0-9.
    it('lets a client learn exactly which events differ', async () => {
      findReconciliationItems.resolves(rowsFor(10, 60))
      const msgHandler = new NegMsgMessageHandler(webSocket, () => settings)
      const client = clientFor(0, 40)
      const haveIds = new Set<string>()
      const needIds = new Set<string>()

      let outgoing: Uint8Array | null = client.initiate()
      let rounds = 0
      while (outgoing !== null) {
        expect(++rounds).to.be.lessThan(20)
        emitted.resetHistory()
        const hex = Buffer.from(outgoing).toString('hex')
        if (rounds === 1) {
          await open('sync1', { kinds: [1] }, hex)
        } else {
          await msgHandler.handleMessage([MessageType.NEG_MSG, 'sync1', hex] as any)
        }

        expect(emitted).to.have.been.calledOnce
        const reply = emitted.firstCall.args[0]
        expect(reply[0]).to.equal(MessageType.NEG_MSG)

        const result = client.reconcile(decode(reply))
        result.haveIds.forEach((id) => haveIds.add(id))
        result.needIds.forEach((id) => needIds.add(id))
        outgoing = result.output
      }

      const hexOf = (from: number, to: number) => rowsFor(from, to).map((row) => row.event_id.toString('hex'))
      expect([...haveIds].sort()).to.deep.equal(hexOf(0, 10).sort())
      expect([...needIds].sort()).to.deep.equal(hexOf(40, 60).sort())
    })
  })
})
