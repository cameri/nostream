import { always } from 'ramda'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import EventEmitter from 'events'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { IAbortable, IMessageHandler } from '../../../src/@types/message-handlers'
import { MessageType, SubscribeMessage } from '../../../src/@types/messages'
import { SubscriptionFilter, SubscriptionId } from '../../../src/@types/subscription'
import * as eventUtils from '../../../src/utils/event'
import { Event } from '../../../src/@types/event'
import { EventTags } from '../../../src/constants/base'
import { IEventRepository, IInviteCodeRepository } from '../../../src/@types/repositories'
import { IRateLimiter } from '../../../src/@types/utils'
import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { PassThrough } from 'stream'
import { SubscribeMessageHandler } from '../../../src/handlers/subscribe-message-handler'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

const toDbEvent = (event: Event, metadata: { expires_at?: number; deleted_at?: Date | null } = {}) => ({
  event_id: Buffer.from(event.id, 'hex'),
  event_kind: event.kind,
  event_pubkey: Buffer.from(event.pubkey, 'hex'),
  event_created_at: event.created_at,
  event_content: event.content,
  event_tags: event.tags,
  event_signature: Buffer.from(event.sig, 'hex'),
  ...metadata,
})

describe('SubscribeMessageHandler', () => {
  const subscriptionId: SubscriptionId = 'subscriptionId'
  let filters: SubscriptionFilter[]
  let subscriptions: Map<SubscriptionId, SubscriptionFilter[]>
  let handler: IMessageHandler & IAbortable
  let webSocket: IWebSocketAdapter
  let eventRepository: IEventRepository
  let message: SubscribeMessage
  let stream: PassThrough
  let settingsFactory: Sinon.SinonStub
  let webSocketGetSubscriptionsStub: Sinon.SinonStub
  let eventRepositoryFindByFiltersStub: Sinon.SinonSpy
  let inviteCodeRepository: IInviteCodeRepository
  let inviteCodeRepositoryCreateStub: Sinon.SinonStub
  let rateLimiter: IRateLimiter
  let rateLimiterHitStub: Sinon.SinonStub
  let rateLimiterFactory: Sinon.SinonStub

  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    filters = [{}]
    subscriptions = new Map()
    webSocket = new EventEmitter() as any
    webSocketGetSubscriptionsStub = sandbox.stub().returns(subscriptions)
    webSocket.getSubscriptions = webSocketGetSubscriptionsStub
    settingsFactory = sandbox.stub()
    stream = new PassThrough({
      objectMode: true,
    })
    eventRepositoryFindByFiltersStub = sandbox.fake.returns({
      stream: () => stream,
    })
    eventRepository = {
      findByFilters: eventRepositoryFindByFiltersStub,
      create: sandbox.stub(),
    } as any
    inviteCodeRepositoryCreateStub = sandbox.stub().callsFake(async (code: string, options: any) => ({
      code,
      createdBy: options?.createdBy ?? null,
      claimedBy: null,
      expiresAt: options?.expiresAt ?? null,
      remainingUses: options?.remainingUses ?? 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
    inviteCodeRepository = { create: inviteCodeRepositoryCreateStub } as any
    rateLimiterHitStub = sandbox.stub().resolves(false)
    rateLimiter = { hit: rateLimiterHitStub } as any
    rateLimiterFactory = sandbox.stub().returns(rateLimiter)
    handler = new SubscribeMessageHandler(
      webSocket,
      eventRepository,
      settingsFactory,
      inviteCodeRepository,
      rateLimiterFactory,
    )
  })

  afterEach(() => {
    sandbox.restore()
    webSocket.removeAllListeners()
  })

  describe('#handleMessage', () => {
    let webSocketOnMessageStub: Sinon.SinonStub
    let webSocketOnSubscribeStub: Sinon.SinonStub
    let canSubscribeStub: Sinon.SinonStub
    let fetchAndSendStub: Sinon.SinonStub

    beforeEach(() => {
      webSocketOnMessageStub = sandbox.stub()
      webSocketOnSubscribeStub = sandbox.stub()
      webSocket.on(WebSocketAdapterEvent.Message, webSocketOnMessageStub)
      webSocket.on(WebSocketAdapterEvent.Subscribe, webSocketOnSubscribeStub)

      fetchAndSendStub = sandbox.stub(SubscribeMessageHandler.prototype, 'fetchAndSend' as any)
      canSubscribeStub = sandbox.stub(SubscribeMessageHandler.prototype, 'canSubscribe' as any)
    })

    it('emits notice message if subscription is rejected', async () => {
      canSubscribeStub.returns('reason')
      message = [MessageType.REQ, subscriptionId, ...filters] as any

      await handler.handleMessage(message)

      expect(webSocketOnMessageStub).to.have.been.calledOnceWithExactly(['NOTICE', 'Subscription rejected: reason'])
    })

    it('emits subscribe event if subscription is accepted', async () => {
      canSubscribeStub.returns(undefined)
      message = [MessageType.REQ, subscriptionId, ...filters] as any

      await handler.handleMessage(message)

      expect(webSocketOnSubscribeStub).to.have.been.calledOnceWith(subscriptionId)
      expect(fetchAndSendStub).to.have.been.calledOnceWithExactly(subscriptionId, filters)
    })

    it('closes subscription with auth-required if unauthenticated client requests only restricted kinds', async () => {
      canSubscribeStub.returns(undefined)
      settingsFactory.returns({ nip42: { restrictedReads: { enabled: true } } })
      webSocket.getAuthenticatedPubkeys = sandbox.stub().returns(new Set())
      message = [MessageType.REQ, subscriptionId, { kinds: [4, 1059] }] as any

      await handler.handleMessage(message)

      expect(webSocketOnMessageStub).to.have.been.calledOnceWithExactly([
        'CLOSED',
        subscriptionId,
        'auth-required: authentication is required to request these event kinds',
      ])
      expect(webSocketOnSubscribeStub).not.to.have.been.called
      expect(fetchAndSendStub).not.to.have.been.called
    })

    it('accepts restricted-kind subscription if client is authenticated', async () => {
      canSubscribeStub.returns(undefined)
      settingsFactory.returns({ nip42: { restrictedReads: { enabled: true } } })
      webSocket.getAuthenticatedPubkeys = sandbox.stub().returns(new Set(['a'.repeat(64)]))
      message = [MessageType.REQ, subscriptionId, { kinds: [1059] }] as any

      await handler.handleMessage(message)

      expect(webSocketOnSubscribeStub).to.have.been.calledOnceWith(subscriptionId)
      expect(fetchAndSendStub).to.have.been.calledOnce
    })

    it('accepts mixed-kind subscription from unauthenticated client', async () => {
      canSubscribeStub.returns(undefined)
      settingsFactory.returns({ nip42: { restrictedReads: { enabled: true } } })
      webSocket.getAuthenticatedPubkeys = sandbox.stub().returns(new Set())
      message = [MessageType.REQ, subscriptionId, { kinds: [1, 1059] }] as any

      await handler.handleMessage(message)

      expect(webSocketOnSubscribeStub).to.have.been.calledOnceWith(subscriptionId)
      expect(fetchAndSendStub).to.have.been.calledOnce
    })
  })

  // NIP-43: kind 28935 is answered by minting a code and returning a relay-signed
  // ephemeral event on the requesting socket. These tests exercise handleMessage
  // end to end (fetchAndSend is NOT stubbed) so the EOSE assertions are real.
  describe('#handleMessage NIP-43 invite requests', () => {
    const relayPrivkey = '5c0c523f52a5b6fad39ed2403092df8cebc36318b39383bca6c00808626fab3a'
    const requester = 'a'.repeat(64)
    const stranger = 'b'.repeat(64)

    let relayPubkey: string
    let webSocketOnMessageStub: Sinon.SinonStub
    let webSocketOnBroadcastStub: Sinon.SinonStub
    let getRelayPrivateKeyStub: Sinon.SinonStub

    const nip43Settings = (overrides: Record<string, unknown> = {}) => ({
      enabled: true,
      allowInviteRequests: true,
      inviteCodeExpirySeconds: 600,
      defaultMaxUses: 1,
      ...overrides,
    })

    const settingsWith = (overrides: Record<string, unknown> = {}) => ({
      info: { relay_url: 'wss://relay.example.com' },
      limits: { client: { subscription: {} } },
      nip43: nip43Settings(),
      ...overrides,
    })

    // Drives a full REQ and lets fetchAndSend stream to completion so a genuine
    // EOSE is emitted.
    const request = async (filters: SubscriptionFilter[], dbEvents: any[] = []) => {
      const promise = handler.handleMessage([MessageType.REQ, subscriptionId, ...filters] as any)
      for (const dbEvent of dbEvents) {
        stream.write(dbEvent)
      }
      stream.end()
      await promise
    }

    const emittedMessages = () => webSocketOnMessageStub.getCalls().map((call) => call.args[0])
    const emittedEvents = (): Event[] =>
      emittedMessages()
        .filter((message) => message[0] === 'EVENT')
        .map((message) => message[2])
    const claimEvents = () => emittedEvents().filter((event) => event.kind === 28935)
    const sentEOSE = () => emittedMessages().some((message) => message[0] === 'EOSE')

    beforeEach(() => {
      // Stub only the derivation: real signing still runs, so the emitted event's
      // signature is genuinely verifiable against the derived pubkey.
      getRelayPrivateKeyStub = sandbox.stub(eventUtils, 'getRelayPrivateKey').returns(relayPrivkey)
      relayPubkey = eventUtils.getPublicKey(relayPrivkey)

      settingsFactory.returns(settingsWith())
      webSocket.getAuthenticatedPubkeys = sandbox.stub().returns(new Set([requester]))

      webSocketOnMessageStub = sandbox.stub()
      webSocketOnBroadcastStub = sandbox.stub()
      webSocket.on(WebSocketAdapterEvent.Message, webSocketOnMessageStub)
      webSocket.on(WebSocketAdapterEvent.Broadcast, webSocketOnBroadcastStub)
    })

    describe('when every guard passes', () => {
      it('emits exactly one claim event followed by EOSE', async () => {
        await request([{ kinds: [28935] }])

        const messages = emittedMessages()
        expect(messages).to.have.lengthOf(2)
        expect(messages[0][0]).to.equal('EVENT')
        expect(messages[0][1]).to.equal(subscriptionId)
        expect(messages[1]).to.deep.equal(['EOSE', subscriptionId])
      })

      it('emits a kind 28935 event carrying the minted claim code', async () => {
        await request([{ kinds: [28935] }])

        const [event] = claimEvents()
        const claim = event.tags.find((tag) => tag[0] === EventTags.Claim)

        expect(event.kind).to.equal(28935)
        expect(event.content).to.equal('')
        expect(claim?.[1]).to.equal(inviteCodeRepositoryCreateStub.firstCall.args[0])
      })

      it('signs the event as the derived relay pubkey with a valid id and signature', async () => {
        await request([{ kinds: [28935] }])

        const [event] = claimEvents()

        expect(event.pubkey).to.equal(relayPubkey)
        expect(getRelayPrivateKeyStub).to.have.been.calledWith('wss://relay.example.com')
        expect(await eventUtils.isEventIdValid(event)).to.equal(true)
        expect(await eventUtils.isEventSignatureValid(event)).to.equal(true)
      })

      it('tags the event as NIP-70 protected', async () => {
        await request([{ kinds: [28935] }])

        expect(claimEvents()[0].tags).to.deep.include([EventTags.Protected])
      })

      it('adds a NIP-40 expiration tag mirroring inviteCodeExpirySeconds', async () => {
        await request([{ kinds: [28935] }])

        const [event] = claimEvents()
        const expiration = event.tags.find((tag) => tag[0] === EventTags.Expiration)
        const expiresAt: Date = inviteCodeRepositoryCreateStub.firstCall.args[1].expiresAt

        expect(expiration?.[1]).to.equal(String(Math.floor(expiresAt.getTime() / 1000)))
      })

      it('omits the expiration tag when codes never expire', async () => {
        settingsFactory.returns(settingsWith({ nip43: nip43Settings({ inviteCodeExpirySeconds: 0 }) }))

        await request([{ kinds: [28935] }])

        expect(claimEvents()[0].tags.some((tag) => tag[0] === EventTags.Expiration)).to.equal(false)
      })

      it('records the requesting pubkey as createdBy', async () => {
        await request([{ kinds: [28935] }])

        expect(inviteCodeRepositoryCreateStub).to.have.been.calledOnce
        expect(inviteCodeRepositoryCreateStub.firstCall.args[1]).to.include({ createdBy: requester, remainingUses: 1 })
      })

      it('never persists the claim event', async () => {
        await request([{ kinds: [28935] }])

        expect(eventRepository.create).to.not.have.been.called
      })

      it('never broadcasts the claim event', async () => {
        await request([{ kinds: [28935] }])

        expect(webSocketOnBroadcastStub).to.not.have.been.called
      })

      it('mints for a pubkey on a non-empty inviteRequestWhitelist', async () => {
        settingsFactory.returns(
          settingsWith({ nip43: nip43Settings({ inviteRequestWhitelist: [stranger, requester] }) }),
        )

        await request([{ kinds: [28935] }])

        expect(claimEvents()).to.have.lengthOf(1)
      })

      it('mints when info.self matches the derived signing pubkey', async () => {
        settingsFactory.returns(settingsWith({ info: { relay_url: 'wss://relay.example.com', self: relayPubkey } }))

        await request([{ kinds: [28935] }])

        expect(claimEvents()).to.have.lengthOf(1)
      })
    })

    // Every guard fails the same way: no claim event, no error to the client, and
    // EOSE still sent. A REQ has no OK channel to report a reason on.
    describe('guards', () => {
      const expectSkipped = () => {
        expect(claimEvents()).to.have.lengthOf(0)
        expect(inviteCodeRepositoryCreateStub).to.not.have.been.called
        expect(sentEOSE()).to.equal(true)
      }

      it('skips when info.self does not match the derived signing pubkey', async () => {
        settingsFactory.returns(settingsWith({ info: { relay_url: 'wss://relay.example.com', self: 'f'.repeat(64) } }))

        await request([{ kinds: [28935] }])

        expectSkipped()
      })

      it('skips when info.self is a malformed npub', async () => {
        settingsFactory.returns(
          settingsWith({ info: { relay_url: 'wss://relay.example.com', self: 'npub1notavalidbech32string' } }),
        )

        await request([{ kinds: [28935] }])

        expectSkipped()
      })

      it('skips when NIP-43 is disabled', async () => {
        settingsFactory.returns(settingsWith({ nip43: nip43Settings({ enabled: false }) }))

        await request([{ kinds: [28935] }])

        expectSkipped()
      })

      it('skips when allowInviteRequests is not enabled', async () => {
        settingsFactory.returns(settingsWith({ nip43: nip43Settings({ allowInviteRequests: false }) }))

        await request([{ kinds: [28935] }])

        expectSkipped()
      })

      it('skips when the nip43 block is absent entirely', async () => {
        settingsFactory.returns(settingsWith({ nip43: undefined }))

        await request([{ kinds: [28935] }])

        expectSkipped()
      })

      it('skips when the requester is not NIP-42 authenticated', async () => {
        webSocket.getAuthenticatedPubkeys = sandbox.stub().returns(new Set())

        await request([{ kinds: [28935] }])

        expectSkipped()
      })

      it('skips when a non-empty inviteRequestWhitelist does not include the requester', async () => {
        settingsFactory.returns(settingsWith({ nip43: nip43Settings({ inviteRequestWhitelist: [stranger] }) }))

        await request([{ kinds: [28935] }])

        expectSkipped()
      })

      it('skips when the per-pubkey rate limit is exceeded', async () => {
        settingsFactory.returns(
          settingsWith({
            limits: { client: { subscription: {} }, invite: { rateLimits: [{ period: 3600000, rate: 5 }] } },
          }),
        )
        rateLimiterHitStub.resolves(true)

        await request([{ kinds: [28935] }])

        expect(rateLimiterHitStub).to.have.been.calledOnceWithExactly(`${requester}:invites:3600000`, 1, {
          period: 3600000,
          rate: 5,
        })
        expectSkipped()
      })

      it('fails closed when the rate limiter is unavailable', async () => {
        settingsFactory.returns(
          settingsWith({
            limits: { client: { subscription: {} }, invite: { rateLimits: [{ period: 3600000, rate: 5 }] } },
          }),
        )
        rateLimiterHitStub.rejects(new Error('redis is down'))

        await request([{ kinds: [28935] }])

        expectSkipped()
      })

      it('does not consult the rate limiter when no invite rate limits are configured', async () => {
        await request([{ kinds: [28935] }])

        expect(rateLimiterHitStub).to.not.have.been.called
        expect(claimEvents()).to.have.lengthOf(1)
      })
    })

    describe('boundaries', () => {
      it('does not mint for a REQ that does not ask for kind 28935', async () => {
        await request([{ kinds: [1] }])

        expect(inviteCodeRepositoryCreateStub).to.not.have.been.called
        expect(claimEvents()).to.have.lengthOf(0)
        expect(sentEOSE()).to.equal(true)
      })

      it('does not mint for a filter with no kinds at all', async () => {
        await request([{ authors: [requester] }])

        expect(inviteCodeRepositoryCreateStub).to.not.have.been.called
      })

      // uniqWith(equals) upstream only collapses byte-identical filters, so this
      // pair survives deduplication and would mint twice without an explicit guard.
      it('mints exactly one code for two non-identical filters naming 28935', async () => {
        await request([{ kinds: [28935] }, { kinds: [28935], limit: 1 }])

        expect(inviteCodeRepositoryCreateStub).to.have.been.calledOnce
        expect(claimEvents()).to.have.lengthOf(1)
      })

      it('serves stored events alongside the claim event on a mixed filter', async () => {
        const storedEvent: Event = {
          id: 'b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef',
          pubkey: '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793',
          created_at: 1648339664,
          kind: 1,
          tags: [],
          content: 'learning terraform rn!',
          sig: 'ec8b2bc640c8c7e92fbc0e0a6f539da2635068a99809186f15106174d727456132977c78f3371d0ab01c108173df75750f33d8e04c4d7980bbb3fb70ba1e3848',
        }

        await request([{ kinds: [1, 28935] }], [toDbEvent(storedEvent)])

        expect(claimEvents()).to.have.lengthOf(1)
        expect(emittedEvents().filter((event) => event.kind === 1)).to.deep.equal([storedEvent])
        expect(sentEOSE()).to.equal(true)
      })

      it('still sends EOSE when the invite code repository throws', async () => {
        inviteCodeRepositoryCreateStub.rejects(new Error('unique violation on invite_codes_pkey'))

        await request([{ kinds: [28935] }])

        expect(claimEvents()).to.have.lengthOf(0)
        expect(sentEOSE()).to.equal(true)
      })

      it('still sends EOSE when the relay private key cannot be derived', async () => {
        getRelayPrivateKeyStub.throws(new Error('SECRET environment variable not set'))

        await request([{ kinds: [28935] }])

        expect(claimEvents()).to.have.lengthOf(0)
        expect(sentEOSE()).to.equal(true)
      })
    })
  })

  describe('#fetchAndSend', () => {
    let event: Event
    let clock: Sinon.SinonFakeTimers
    let webSocketOnMessageStub: Sinon.SinonStub
    let webSocketOnSubscribeStub: Sinon.SinonStub
    let isClientSubscribedToEventStub: Sinon.SinonStub

    beforeEach(() => {
      clock = Sinon.useFakeTimers(1665546189000)
      event = {
        id: 'b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef',
        pubkey: '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793',
        created_at: 1648339664,
        kind: 1,
        tags: [],
        content: 'learning terraform rn!',
        sig: 'ec8b2bc640c8c7e92fbc0e0a6f539da2635068a99809186f15106174d727456132977c78f3371d0ab01c108173df75750f33d8e04c4d7980bbb3fb70ba1e3848',
      }

      isClientSubscribedToEventStub = sandbox.stub(SubscribeMessageHandler, 'isClientSubscribedToEvent' as any)

      webSocketOnMessageStub = sandbox.stub()
      webSocketOnSubscribeStub = sandbox.stub()
      webSocket.on(WebSocketAdapterEvent.Message, webSocketOnMessageStub)
      webSocket.on(WebSocketAdapterEvent.Subscribe, webSocketOnSubscribeStub)
      //streamEndSpy = sandbox.spy(Stream, '_end' as any)
    })

    afterEach(() => {
      clock.restore()
    })

    it('does not send event if client is not subscribed to it', async () => {
      isClientSubscribedToEventStub.returns(always(false))

      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      stream.write(toDbEvent(event))
      stream.end()

      await promise

      expect(eventRepositoryFindByFiltersStub).to.have.been.calledOnceWithExactly(filters)
    })

    it('sends event if client is subscribed', async () => {
      isClientSubscribedToEventStub.returns(always(true))

      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      stream.write(toDbEvent(event))
      stream.end()

      await promise

      expect(eventRepositoryFindByFiltersStub).to.have.been.calledOnceWithExactly(filters)
      expect(webSocketOnMessageStub).to.have.been.calledWithExactly(['EVENT', subscriptionId, event])
    })

    it('does not send expired events', async () => {
      isClientSubscribedToEventStub.returns(always(true))

      const now = Math.floor(clock.now / 1000)
      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      const expiredEvent: Event = {
        ...event,
        tags: [['expiration', String(now - 1)] as any],
      }

      stream.write(toDbEvent(expiredEvent))
      stream.end()

      await promise

      expect(eventRepositoryFindByFiltersStub).to.have.been.calledOnceWithExactly(filters)
      expect(webSocketOnMessageStub).to.have.been.calledOnceWithExactly(['EOSE', subscriptionId])
    })

    it('sends event if expiration is in the future', async () => {
      isClientSubscribedToEventStub.returns(always(true))

      const now = Math.floor(clock.now / 1000)
      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      const eventWithFutureExpiration: Event = {
        ...event,
        tags: [['expiration', String(now + 60)] as any],
      }

      stream.write(toDbEvent(eventWithFutureExpiration))
      stream.end()

      await promise

      expect(eventRepositoryFindByFiltersStub).to.have.been.calledOnceWithExactly(filters)
      expect(webSocketOnMessageStub).to.have.been.calledWithExactly([
        'EVENT',
        subscriptionId,
        eventWithFutureExpiration,
      ])
      expect(webSocketOnMessageStub).to.have.been.calledWithExactly(['EOSE', subscriptionId])
    })

    it('does not send restricted-kind events to unauthenticated clients', async () => {
      isClientSubscribedToEventStub.returns(always(true))
      settingsFactory.returns({ nip42: { restrictedReads: { enabled: true } } })
      webSocket.getAuthenticatedPubkeys = sandbox.stub().returns(new Set())

      const restrictedEvent: Event = {
        ...event,
        kind: 4,
        tags: [['p', 'f'.repeat(64)] as any],
      }

      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      stream.write(toDbEvent(restrictedEvent))
      stream.end()

      await promise

      expect(webSocketOnMessageStub).to.have.been.calledOnceWithExactly(['EOSE', subscriptionId])
    })

    it('sends restricted-kind events to the authenticated recipient', async () => {
      const recipient = 'f'.repeat(64)
      isClientSubscribedToEventStub.returns(always(true))
      settingsFactory.returns({ nip42: { restrictedReads: { enabled: true } } })
      webSocket.getAuthenticatedPubkeys = sandbox.stub().returns(new Set([recipient]))

      const restrictedEvent: Event = {
        ...event,
        kind: 1059,
        tags: [['p', recipient] as any],
      }

      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      stream.write(toDbEvent(restrictedEvent))
      stream.end()

      await promise

      expect(webSocketOnMessageStub).to.have.been.calledWithExactly(['EVENT', subscriptionId, restrictedEvent])
    })

    it('sends restricted-kind events to the authenticated author', async () => {
      isClientSubscribedToEventStub.returns(always(true))
      settingsFactory.returns({ nip42: { restrictedReads: { enabled: true } } })
      webSocket.getAuthenticatedPubkeys = sandbox.stub().returns(new Set([event.pubkey]))

      const restrictedEvent: Event = {
        ...event,
        kind: 4,
        tags: [['p', 'f'.repeat(64)] as any],
      }

      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      stream.write(toDbEvent(restrictedEvent))
      stream.end()

      await promise

      expect(webSocketOnMessageStub).to.have.been.calledWithExactly(['EVENT', subscriptionId, restrictedEvent])
    })

    it('sends EOSE', async () => {
      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      stream.end()

      await promise

      expect(webSocketOnMessageStub).to.have.been.calledWithExactly(['EOSE', subscriptionId])
    })

    it('ends event stream if error occurs', async () => {
      const error = new Error('mistakes were made')
      isClientSubscribedToEventStub.returns(always(true))

      const fetch = () => (handler as any).fetchAndSend(subscriptionId, filters)

      const promise = fetch()

      stream.emit('error', error)

      const closeSpy = sandbox.spy()
      stream.once('close', closeSpy)

      await expect(promise).to.eventually.be.rejectedWith(error)
      expect(closeSpy).to.have.been.called
    })

    it('destroys event stream if aborted', async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      isClientSubscribedToEventStub.returns(always(true))

      const fetch = () => (handler as any).fetchAndSend(subscriptionId, filters)
      const destroySpy = sandbox.spy(stream, 'destroy')

      const promise = fetch()

      stream.emit('error', error)

      await expect(promise).to.eventually.be.rejectedWith(error)
      expect(destroySpy).to.have.been.called
    })

    it('aborts and destroys the event stream when abort() is called', async () => {
      isClientSubscribedToEventStub.returns(always(true))

      const destroySpy = sandbox.spy(stream, 'destroy')

      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      handler.abort()

      await expect(promise).to.eventually.be.rejected
      expect(destroySpy).to.have.been.called
    })
  })

  describe('.isClientSubscribedToEvent', () => {
    it('returns false if event matches no filter', () => {
      const filters: SubscriptionFilter[] = [{ ids: ['aa'] }]
      const event: Event = { id: 'bb' } as any

      expect((SubscribeMessageHandler as any).isClientSubscribedToEvent(filters)(event)).to.be.false
    })

    it('returns true if event matches filter', () => {
      const filters: SubscriptionFilter[] = [{ ids: ['aa'] }]
      const event: Event = { id: 'aa' } as any

      expect((SubscribeMessageHandler as any).isClientSubscribedToEvent(filters)(event)).to.be.true
    })
  })

  describe('#canSubscribe', () => {
    it('returns undefined if subscription & filter count are allowed', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxSubscriptions: 1,
              maxFilters: 1,
            },
          },
        },
      })

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.be.undefined
    })

    it('returns undefined if max subscription limit is disabled', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxSubscriptions: 0,
            },
          },
        },
      })

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.be.undefined
    })

    it('returns undefined if filters limit is disabled', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxFilters: 0,
            },
          },
        },
      })
      filters = [{}]

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.be.undefined
    })

    it('returns reason if client is sending a duplicate subscription', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxSubscriptions: 1,
            },
          },
        },
      })
      filters = [{ authors: ['aa'] }]
      subscriptions.set(subscriptionId, filters)

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.equal(
        'Duplicate subscription subscriptionId: Ignoring',
      )
    })

    it('returns reason if client subscriptions exceed limits', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxSubscriptions: 1,
            },
          },
        },
      })
      subscriptions.set('other-sub', [])

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.equal(
        'Too many subscriptions: Number of subscriptions must be less than or equal to 1',
      )
    })

    it('returns reason if filter count exceeds limit', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxFilters: 1,
            },
          },
        },
      })
      filters = [{}, {}]

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.equal(
        'Too many filters: Number of filters per susbscription must be less then or equal to 1',
      )
    })

    it('returns reason if filter limit exceeds max limit', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxLimit: 50,
            },
          },
        },
      })
      filters = [{ limit: 100 }]

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.equal(
        'Limit too high: Filter limit must be less than or equal to 50',
      )
    })

    it('returns reason if subscription id is too long', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxSubscriptionIdLength: 5,
            },
          },
        },
      })

      expect((handler as any).canSubscribe('123456', filters)).to.equal(
        'Subscription ID too long: Subscription ID must be less or equal to 5',
      )
    })

    it('returns undefined if subscription id matches max length', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxSubscriptionIdLength: 6,
            },
          },
        },
      })

      expect((handler as any).canSubscribe('123456', filters)).to.be.undefined
    })
  })
})
