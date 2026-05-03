import EventEmitter from 'events'

import Sinon, { SinonFakeTimers, SinonStub } from 'sinon'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import { EventLimits, Settings } from '../../../src/@types/settings'
import { identifyEvent, signEvent } from '../../../src/utils/event'
import { IncomingEventMessage, MessageType } from '../../../src/@types/messages'
import { CacheAdmissionState } from '../../../src/constants/caching'
import { Event } from '../../../src/@types/event'
import { EventKinds, EventExpirationTimeMetadataKey, EventTags } from '../../../src/constants/base'
import { EventMessageHandler } from '../../../src/handlers/event-message-handler'
import { IUserRepository } from '../../../src/@types/repositories'
import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'

import * as nip05Utils from '../../../src/utils/nip05'

const { expect } = chai

describe('EventMessageHandler', () => {
  let webSocket: IWebSocketAdapter
  let handler: EventMessageHandler
  let userRepository: IUserRepository
  let eventRepository: any
  let event: Event
  let message: IncomingEventMessage
  let sandbox: Sinon.SinonSandbox
  let origEnv: NodeJS.ProcessEnv

  let originalConsoleWarn: (message?: any, ...optionalParams: any[]) => void | undefined = undefined

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    origEnv = { ...process.env }
    process.env = {
      // deepcode ignore HardcodedNonCryptoSecret/test: <please specify a reason of ignoring this>
      SECRET: 'changeme',
    }
    originalConsoleWarn = console.warn
    console.warn = () => undefined
    event = {
      content: 'hello',
      created_at: 1665546189,
      id: 'f'.repeat(64),
      kind: 1,
      pubkey: 'f'.repeat(64),
      sig: 'f'.repeat(128),
      tags: [],
    }
    userRepository = {
      isVanished: async () => false,
    } as any
  })

  afterEach(() => {
    process.env = origEnv
    console.warn = originalConsoleWarn
    sandbox.restore()
  })

  describe('handleMessage', () => {
    let canAcceptEventStub: Sinon.SinonStub
    let isEventValidStub: Sinon.SinonStub
    let strategyFactoryStub: Sinon.SinonStub
    let onMessageSpy: Sinon.SinonSpy
    let strategyExecuteStub: Sinon.SinonStub
    let isRateLimitedStub: Sinon.SinonStub
    let isUserAdmitted: Sinon.SinonStub

    beforeEach(() => {
      canAcceptEventStub = sandbox.stub(EventMessageHandler.prototype, 'canAcceptEvent' as any)
      isEventValidStub = sandbox.stub(EventMessageHandler.prototype, 'isEventValid' as any)
      isUserAdmitted = sandbox.stub(EventMessageHandler.prototype, 'isUserAdmitted' as any)
      eventRepository = {} as any
      userRepository = {
        isVanished: sandbox.stub().resolves(false),
      } as any
      strategyExecuteStub = sandbox.stub()
      strategyFactoryStub = sandbox.stub().returns({
        execute: strategyExecuteStub,
      })
      onMessageSpy = sandbox.fake.returns(undefined)
      webSocket = new EventEmitter() as any
      webSocket.on(WebSocketAdapterEvent.Message, onMessageSpy)
      message = [MessageType.EVENT, event]
      isRateLimitedStub = sandbox.stub(EventMessageHandler.prototype, 'isRateLimited' as any)
      handler = new EventMessageHandler(
        webSocket as any,
        strategyFactoryStub,
        eventRepository,
        userRepository,
        () =>
          ({
            info: { relay_url: 'relay_url' },
          }) as any,
        {} as any,
        { hasKey: async () => false, setKey: async () => true } as any,
        () => ({ hit: async () => false }),
      )
    })

    afterEach(() => {
      isEventValidStub.restore()
      canAcceptEventStub.restore()
      webSocket.removeAllListeners()
    })

    it("rejects event if it can't be accepted", async () => {
      canAcceptEventStub.returns('reason')

      await handler.handleMessage(message)

      expect(canAcceptEventStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).to.have.been.calledOnceWithExactly([MessageType.OK, event.id, false, 'reason'])
      expect(strategyFactoryStub).not.to.have.been.called
    })

    it('rejects event if rate-limited', async () => {
      isRateLimitedStub.resolves(true)

      await handler.handleMessage(message)

      expect(isRateLimitedStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).to.have.been.calledOnceWithExactly([
        MessageType.OK,
        event.id,
        false,
        'rate-limited: slow down',
      ])
      expect(strategyFactoryStub).not.to.have.been.called
    })

    it('rejects event if request to vanish is active for pubkey', async () => {
      canAcceptEventStub.returns(undefined)
      isEventValidStub.resolves(undefined)
      ;(userRepository.isVanished as any).resolves(true)

      await handler.handleMessage(message)

      expect(userRepository.isVanished as any).to.have.been.calledOnceWithExactly(event.pubkey)
      expect(onMessageSpy).to.have.been.calledOnceWithExactly([
        MessageType.OK,
        event.id,
        false,
        'blocked: request to vanish active for pubkey',
      ])
      expect(strategyFactoryStub).not.to.have.been.called
    })

    it('rejects event if invalid', async () => {
      isEventValidStub.resolves('reason')

      await handler.handleMessage(message)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).not.to.have.been.calledOnceWithExactly()
      expect(strategyFactoryStub).not.to.have.been.called
    })

    it('rejects event if user is not admitted', async () => {
      isUserAdmitted.resolves('reason')

      await handler.handleMessage(message)

      expect(isUserAdmitted).to.have.been.calledWithExactly(event)
      expect(strategyFactoryStub).not.to.have.been.called
    })

    it('rejects event if NIP-05 verification is required', async () => {
      canAcceptEventStub.returns(undefined)
      isEventValidStub.resolves(undefined)
      isUserAdmitted.resolves(undefined)
      sandbox.stub(EventMessageHandler.prototype, 'checkNip05Verification' as any).resolves('blocked: NIP-05 verification required')

      await handler.handleMessage(message)

      expect(onMessageSpy).to.have.been.calledOnceWithExactly([
        MessageType.OK,
        event.id,
        false,
        'blocked: NIP-05 verification required',
      ])
      expect(strategyFactoryStub).not.to.have.been.called
    })

    it('rejects event if it is expired', async () => {
      isEventValidStub.resolves(undefined)

      const expiredEvent = {
        ...event,
        tags: [['expiration', '1600000']],
      }

      const expiredEventMessage: any = [MessageType.EVENT, expiredEvent]

      await handler.handleMessage(expiredEventMessage)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(expiredEvent)

      expect(onMessageSpy).to.have.been.calledOnceWithExactly([MessageType.OK, event.id, false, 'event is expired'])
      expect(strategyExecuteStub).not.to.have.been.called
    })

    it('does not call strategy if none given', async () => {
      isEventValidStub.returns(undefined)
      canAcceptEventStub.returns(undefined)
      strategyFactoryStub.returns(undefined)

      await handler.handleMessage(message)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).not.to.have.been.calledOnceWithExactly()
      expect(strategyFactoryStub).to.have.been.calledOnceWithExactly([event, webSocket])
      expect(strategyExecuteStub).not.to.have.been.called
    })

    it('calls strategy with event', async () => {
      isEventValidStub.returns(undefined)
      canAcceptEventStub.returns(undefined)

      await handler.handleMessage(message)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).not.to.have.been.calledOnceWithExactly()
      expect(strategyFactoryStub).to.have.been.calledOnceWithExactly([event, webSocket])
      expect(strategyExecuteStub).to.have.been.calledOnceWithExactly(event)
    })

    it('does not reject if strategy rejects', async () => {
      isEventValidStub.returns(undefined)
      canAcceptEventStub.returns(undefined)

      strategyExecuteStub.rejects()

      return expect(handler.handleMessage(message)).to.eventually.be.fulfilled
    })
  })

  describe('canAcceptEvent', () => {
    let eventLimits: EventLimits
    let settings: Settings
    let clock: SinonFakeTimers

    beforeEach(() => {
      clock = Sinon.useFakeTimers(1665546189000)

      eventLimits = {
        createdAt: {
          maxNegativeDelta: 100000,
          maxPositiveDelta: 100000,
        },
        eventId: {
          minLeadingZeroBits: 0,
        },
        kind: {
          blacklist: [],
          whitelist: [],
        },
        pubkey: {
          minBalance: 0n,
          minLeadingZeroBits: 0,
          blacklist: [],
          whitelist: [],
        },
        content: {
          maxLength: 0,
        },
      }
      settings = {
        info: {
          relay_url: 'relay_url',
        },
        limits: {
          event: eventLimits,
        },
      } as any
      handler = new EventMessageHandler(
        {} as any,
        () => null,
        {} as any,
        userRepository,
        () => settings,
        {} as any,
        { hasKey: async () => false, setKey: async () => true } as any,
        () => ({ hit: async () => false }),
      )
    })

    afterEach(() => {
      clock.restore()
    })

    describe('createdAt', () => {
      it('returns undefined if event pubkey equals relay public key', () => {
        sandbox.stub(EventMessageHandler.prototype, 'getRelayPublicKey' as any).returns(event.pubkey)
        eventLimits.createdAt.maxPositiveDelta = 1
        event.created_at += 999

        expect((handler as any).canAcceptEvent(event)).to.be.undefined
      })

      describe('maxPositiveDelta', () => {
        it('returns undefined if maxPositiveDelta is zero', () => {
          eventLimits.createdAt.maxPositiveDelta = 0

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if createdDate is too far in the future', () => {
          eventLimits.createdAt.maxPositiveDelta = 100
          event.created_at += 101

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('rejected: created_at is more than 100 seconds in the future')
        })
      })

      describe('maxNegativeDelta', () => {
        it('returns undefined if maxNegativeDelta is zero', () => {
          eventLimits.createdAt.maxNegativeDelta = 0

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if createdDate is too far in the past', () => {
          eventLimits.createdAt.maxNegativeDelta = 100
          event.created_at -= 101

          expect((handler as any).canAcceptEvent(event)).to.equal(
            'rejected: created_at is more than 100 seconds in the past',
          )
        })
      })
    })

    describe('content', () => {
      describe('maxLength', () => {
        it('returns undefined if maxLength is disabled', () => {
          eventLimits.content = [{ maxLength: 0 }]

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefned if content is not too long', () => {
          eventLimits.content = [{ maxLength: 1 }]
          event.content = 'x'.repeat(1)

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if kind does not match', () => {
          eventLimits.content = [{ kinds: [EventKinds.SET_METADATA], maxLength: 1 }]
          event.content = 'x'

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if kind matches but content is short', () => {
          eventLimits.content = [{ kinds: [EventKinds.TEXT_NOTE], maxLength: 1 }]
          event.content = 'x'

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if kind matches but content is too long', () => {
          eventLimits.content = [{ kinds: [EventKinds.TEXT_NOTE], maxLength: 1 }]
          event.content = 'xx'

          expect((handler as any).canAcceptEvent(event)).to.equal('rejected: content is longer than 1 bytes')
        })

        it('returns reason if content is too long', () => {
          eventLimits.content = [{ maxLength: 1 }]
          event.content = 'x'.repeat(2)

          expect((handler as any).canAcceptEvent(event)).to.equal('rejected: content is longer than 1 bytes')
        })
      })

      describe('maxLength (deprecated)', () => {
        it('returns undefined if maxLength is zero', () => {
          eventLimits.content = { maxLength: 0 }

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if content is short', () => {
          eventLimits.content = { maxLength: 100 }
          event.content = 'x'.repeat(100)

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if content is too long', () => {
          eventLimits.content = { maxLength: 1 }
          event.content = 'xx'

          expect((handler as any).canAcceptEvent(event)).to.equal('rejected: content is longer than 1 bytes')
        })

        it('returns undefined if kind matches and content is short', () => {
          eventLimits.content = { kinds: [EventKinds.TEXT_NOTE], maxLength: 1 }
          event.content = 'x'

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if kind does not match and content is too long', () => {
          eventLimits.content = { kinds: [EventKinds.SET_METADATA], maxLength: 1 }
          event.content = 'xx'

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if content is too long', () => {
          eventLimits.content = { maxLength: 1 }
          event.content = 'xx'

          expect((handler as any).canAcceptEvent(event)).to.equal('rejected: content is longer than 1 bytes')
        })

        it('returns undefined if content is not set', () => {
          eventLimits.content = undefined
          event.content = 'xx'

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })
      })

      describe('maxNegativeDelta', () => {
        it('returns undefined if maxNegativeDelta is zero', () => {
          eventLimits.createdAt.maxNegativeDelta = 0

          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if createdDate is too far in the past', () => {
          eventLimits.createdAt.maxNegativeDelta = 100
          event.created_at -= 101

          expect((handler as any).canAcceptEvent(event)).to.equal(
            'rejected: created_at is more than 100 seconds in the past',
          )
        })
      })
    })

    describe('eventId', () => {
      describe('minLeadingZeroBits', () => {
        it('returns undefined if minLeadingZeroBits is zero', () => {
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if eventId has sufficient proof of work ', () => {
          eventLimits.eventId.minLeadingZeroBits = 15
          event.id = '0001' + 'f'.repeat(60)
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if eventId has insufficient proof of work ', () => {
          eventLimits.eventId.minLeadingZeroBits = 16
          event.id = '00' + 'f'.repeat(62)
          expect((handler as any).canAcceptEvent(event)).to.equal('pow: difficulty 8<16')
        })
      })
    })

    describe('pubkey', () => {
      describe('minLeadingZeroBits', () => {
        it('returns undefined if minLeadingZeroBits is zero', () => {
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if pubkey has sufficient proof of work ', () => {
          eventLimits.pubkey.minLeadingZeroBits = 17
          event.pubkey = '00007' + 'f'.repeat(59)
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if pubkey has insufficient proof of work ', () => {
          eventLimits.pubkey.minLeadingZeroBits = 16
          event.pubkey = '0'.repeat(2) + 'f'.repeat(62)
          expect((handler as any).canAcceptEvent(event)).to.equal('pow: pubkey difficulty 8<16')
        })
      })

      describe('blacklist', () => {
        it('returns undefined if blacklist is empty', () => {
          eventLimits.pubkey.blacklist = []
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if pubkey is not blacklisted', () => {
          eventLimits.pubkey.blacklist = ['aabbcc']
          event.pubkey = 'fffff'
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if pubkey is not an exact match in the blacklist', () => {
          eventLimits.pubkey.blacklist = ['aa55']
          event.pubkey = 'aabbcc'
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if pubkey is blacklisted', () => {
          eventLimits.pubkey.blacklist = ['aabbcc']
          event.pubkey = 'aabbcc'
          expect((handler as any).canAcceptEvent(event)).to.equal('blocked: pubkey not allowed')
        })

        it('returns undefined if pubkey extends a blacklist entry but is not an exact match', () => {
          eventLimits.pubkey.blacklist = ['aa55']
          event.pubkey = 'aa55ccddeeff'
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })
      })

      describe('whitelist', () => {
        it('returns undefined if whitelist is empty', () => {
          eventLimits.pubkey.whitelist = []
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if pubkey is whitelisted', () => {
          eventLimits.pubkey.whitelist = ['aabbcc']
          event.pubkey = 'aabbcc'
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if pubkey is not an exact match in the whitelist', () => {
          eventLimits.pubkey.whitelist = ['aa55']
          event.pubkey = 'aa55ccddeeff'
          expect((handler as any).canAcceptEvent(event)).to.equal('blocked: pubkey not allowed')
        })

        it('returns reason if pubkey is not whitelisted', () => {
          eventLimits.pubkey.whitelist = ['ffffff']
          event.pubkey = 'aabbcc'
          expect((handler as any).canAcceptEvent(event)).to.equal('blocked: pubkey not allowed')
        })

        it('returns reason if pubkey is not whitelisted by exact match', () => {
          eventLimits.pubkey.whitelist = ['aa55']
          event.pubkey = 'aabbccddeeff'
          expect((handler as any).canAcceptEvent(event)).to.equal('blocked: pubkey not allowed')
        })
      })
    })

    describe('kind', () => {
      describe('blacklist', () => {
        it('returns undefined if blacklist is empty', () => {
          eventLimits.kind.blacklist = []
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if kind is not blacklisted', () => {
          eventLimits.kind.blacklist = [5]
          event.kind = 4
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if kind is not blacklisted in range', () => {
          eventLimits.kind.blacklist = [[1, 5]]
          event.kind = EventKinds.REACTION
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if kind is blacklisted in range', () => {
          eventLimits.kind.blacklist = [[1, 5]]
          event.kind = 4
          expect((handler as any).canAcceptEvent(event)).to.equal('blocked: event kind 4 not allowed')
        })
      })

      describe('whitelist', () => {
        it('returns undefined if whitelist is empty', () => {
          eventLimits.kind.whitelist = []
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if kind is whitelisted', () => {
          eventLimits.kind.whitelist = [5]
          event.kind = 5
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns undefined if kind is whitelisted in range', () => {
          eventLimits.kind.whitelist = [[1, 5]]
          event.kind = 3
          expect((handler as any).canAcceptEvent(event)).to.be.undefined
        })

        it('returns reason if kind is blacklisted and whitelisted in range', () => {
          eventLimits.kind.blacklist = [3]
          eventLimits.kind.whitelist = [[1, 5]]
          event.kind = 3
          expect((handler as any).canAcceptEvent(event)).to.equal('blocked: event kind 3 not allowed')
        })

        it('returns reason if kind is blacklisted and whitelisted', () => {
          eventLimits.kind.blacklist = [3]
          eventLimits.kind.whitelist = [3]
          event.kind = 3
          expect((handler as any).canAcceptEvent(event)).to.equal('blocked: event kind 3 not allowed')
        })

        it('returns reason if kind is not whitelisted', () => {
          eventLimits.kind.whitelist = [5]
          event.kind = 4
          expect((handler as any).canAcceptEvent(event)).to.equal('blocked: event kind 4 not allowed')
        })

        it('returns reason if kind is not whitelisted in range', () => {
          eventLimits.kind.whitelist = [[1, 5]]
          event.kind = EventKinds.REACTION
          expect((handler as any).canAcceptEvent(event)).to.equal('blocked: event kind 7 not allowed')
        })
      })
    })
  })

  describe('isEventValid', () => {
    beforeEach(() => {
      event = {
        id: 'e527fe8b0f64a38c6877f943a9e8841074056ba72aceb31a4c85e6d10b27095a',
        pubkey: '55b702c167c85eb1c2d5ab35d68bedd1a35b94c01147364d2395c2f66f35a503',
        created_at: 1564498626,
        kind: 0,
        tags: [],
        content:
          '{"name":"ottman@minds.io","about":"","picture":"https://feat-2311-nostr.minds.io/icon/1002952989368913934/medium/1564498626/1564498626/1653379539"}',
        sig: 'd1de98733de2b412549aa64454722d9b66ab3c68e9e0d0f9c5d42e7bd54c30a06174364b683d2c8dbb386ff47f31e6cb7e2f3c3498d8819ee80421216c8309a9',
      }
    })

    it('returns reason if request to vanish relay tag does not match relay URL', async () => {
      const privkey = '0000000000000000000000000000000000000000000000000000000000000001'
      const unsignedEvent = await identifyEvent({
        pubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        created_at: 1700000000,
        kind: EventKinds.REQUEST_TO_VANISH,
        tags: [[EventTags.Relay, 'wss://another-relay.example']],
        content: '',
      })
      const vanishEvent = await signEvent(privkey)(unsignedEvent)

      return expect((handler as any).isEventValid(vanishEvent)).to.eventually.equal(
        'invalid: request to vanish relay tag invalid',
      )
    })

    it('returns undefined if event is valid', () => {
      return expect((handler as any).isEventValid(event)).to.eventually.be.undefined
    })

    it('returns reason if event id is not valid', () => {
      event.id = 'wrong'
      return expect((handler as any).isEventValid(event)).to.eventually.equal('invalid: event id does not match')
    })

    it('returns reason if event signature is not valid', () => {
      event.sig = 'wrong'
      return expect((handler as any).isEventValid(event)).to.eventually.equal(
        'invalid: event signature verification failed',
      )
    })

    describe('NIP-17 inner event blocking', () => {
      // Use a known private key to generate valid events for kinds 13, 14, 15.
      // The private key is the smallest valid secp256k1 scalar (value = 1).
      const PRIVKEY = '0000000000000000000000000000000000000000000000000000000000000001'

      async function makeValidEvent(kind: EventKinds): Promise<Event> {
        const unsigned = await identifyEvent({
          pubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
          created_at: 1700000000,
          kind,
          tags: [],
          content: '',
        })
        return signEvent(PRIVKEY)(unsigned)
      }

      it('blocks kind 13 (Seal) with a clear rejection message', async () => {
        const sealEvent = await makeValidEvent(EventKinds.SEAL)
        const reason = await (handler as any).isEventValid(sealEvent)
        expect(reason).to.include('blocked')
        expect(reason).to.include('13')
      })

      it('blocks kind 14 (Direct Message) with a clear rejection message', async () => {
        const dmEvent = await makeValidEvent(EventKinds.DIRECT_MESSAGE)
        const reason = await (handler as any).isEventValid(dmEvent)
        expect(reason).to.include('blocked')
        expect(reason).to.include('14')
      })

      it('blocks kind 15 (File Message) with a clear rejection message', async () => {
        const fileEvent = await makeValidEvent(EventKinds.FILE_MESSAGE)
        const reason = await (handler as any).isEventValid(fileEvent)
        expect(reason).to.include('blocked')
        expect(reason).to.include('15')
      })

      it('does not block a regular kind 1 event', async () => {
        const textNote = await makeValidEvent(EventKinds.TEXT_NOTE)
        const reason = await (handler as any).isEventValid(textNote)
        expect(reason).to.be.undefined
      })

      it('does not block a kind 1059 (Gift Wrap) event', async () => {
        const giftWrap = await makeValidEvent(EventKinds.GIFT_WRAP)
        const reason = await (handler as any).isEventValid(giftWrap)
        expect(reason).to.be.undefined
      })

      it('blocks kind 444 (Marmot Welcome rumor) with a clear rejection message', async () => {
        const welcomeRumor = await makeValidEvent(EventKinds.MARMOT_WELCOME_RUMOR)
        const reason = await (handler as any).isEventValid(welcomeRumor)
        expect(reason).to.include('blocked')
        expect(reason).to.include('444')
      })

      it('does not block a kind 445 (Marmot Group Event)', async () => {
        const groupEvent = await makeValidEvent(EventKinds.MARMOT_GROUP_EVENT)
        const reason = await (handler as any).isEventValid(groupEvent)
        expect(reason).to.be.undefined
      })
    })
  })

  describe('isBlockedByRequestToVanish', () => {
    beforeEach(() => {
      handler = new EventMessageHandler(
        {} as any,
        () => null,
        {} as any,
        userRepository,
        () =>
          ({
            info: { relay_url: 'relay_url' },
          }) as any,
        {} as any,
        { hasKey: async () => false, setKey: async () => true } as any,
        () => ({ hit: async () => false }),
      )
    })

    it('returns undefined for request to vanish events', async () => {
      event.kind = EventKinds.REQUEST_TO_VANISH

      return expect((handler as any).isBlockedByRequestToVanish(event)).to.eventually.be.undefined
    })

    it("returns undefined if event pubkey equals relay's own public key", async () => {
      sandbox.stub(EventMessageHandler.prototype, 'getRelayPublicKey' as any).returns(event.pubkey)

      return expect((handler as any).isBlockedByRequestToVanish(event)).to.eventually.be.undefined
    })
  })

  describe('isRateLimited', () => {
    let eventLimits: EventLimits
    let settings: Settings
    let rateLimiterHitStub: SinonStub
    let userRepository: IUserRepository
    let getClientAddressStub: Sinon.SinonStub
    let webSocket: IWebSocketAdapter

    beforeEach(() => {
      eventLimits = {
        rateLimits: [],
      }
      settings = {
        info: {
          relay_url: 'relay_url',
        },
        limits: {
          event: eventLimits,
        },
      } as any
      rateLimiterHitStub = sandbox.stub()
      getClientAddressStub = sandbox.stub()
      webSocket = {
        getClientAddress: getClientAddressStub,
      } as any
      userRepository = {
        isVanished: async () => false,
      } as any
      handler = new EventMessageHandler(
        webSocket,
        () => null,
        {} as any,
        userRepository,
        () => settings,
        {} as any,
        { hasKey: async () => false, setKey: async () => true } as any,
        () => ({ hit: rateLimiterHitStub }),
      )
    })

    it('fulfills with false if limits setting is not set', async () => {
      settings.limits = undefined
      return expect((handler as any).isRateLimited(event)).to.eventually.be.false
    })

    it('fulfills with false if event limits setting is not set', async () => {
      settings.limits.event = undefined
      return expect((handler as any).isRateLimited(event)).to.eventually.be.false
    })

    it('fulfills with false if rate limits setting is not set', async () => {
      eventLimits.rateLimits = undefined
      return expect((handler as any).isRateLimited(event)).to.eventually.be.false
    })

    it('fulfills with false if rate limits setting is empty', async () => {
      eventLimits.rateLimits = []
      return expect((handler as any).isRateLimited(event)).to.eventually.be.false
    })

    it("fulfills with false if event pubkey equals relay's own public key", async () => {
      sandbox.stub(EventMessageHandler.prototype, 'getRelayPublicKey' as any).returns(event.pubkey)
      eventLimits.rateLimits = [
        {
          period: 60000,
          rate: 1,
        },
      ]

      const actualResult = await (handler as any).isRateLimited(event)

      expect(actualResult).to.be.false
      expect(rateLimiterHitStub).not.to.have.been.called
    })

    it('skips rate limiter if IP is whitelisted', async () => {
      eventLimits.rateLimits = [
        {
          period: 60000,
          rate: 1,
        },
      ]
      eventLimits.whitelists = {}
      eventLimits.whitelists.ipAddresses = ['2604:a880:cad:d0::e7e:7001']
      getClientAddressStub.returns('2604:a880:cad:d0::e7e:7001')

      const actualResult = await (handler as any).isRateLimited(event)

      expect(actualResult).to.be.false
      expect(rateLimiterHitStub).not.to.have.been.called
    })

    it('calls rate limiter if IP is not whitelisted', async () => {
      eventLimits.rateLimits = [
        {
          period: 60000,
          rate: 1,
        },
      ]
      eventLimits.whitelists = {}
      eventLimits.whitelists.ipAddresses = ['::1']
      getClientAddressStub.returns('2604:a880:cad:d0::e7e:7001')

      await (handler as any).isRateLimited(event)

      expect(rateLimiterHitStub).to.have.been.called
    })

    it('skips rate limiter if pubkey is whitelisted', async () => {
      eventLimits.rateLimits = [
        {
          period: 60000,
          rate: 1,
        },
      ]
      eventLimits.whitelists = {}
      eventLimits.whitelists.pubkeys = [event.pubkey]

      const actualResult = await (handler as any).isRateLimited(event)

      expect(actualResult).to.be.false
      expect(rateLimiterHitStub).not.to.have.been.called
    })

    it('calls rate limiter if pubkey is not whitelisted', async () => {
      eventLimits.rateLimits = [
        {
          period: 60000,
          rate: 1,
        },
      ]
      eventLimits.whitelists = {}
      eventLimits.whitelists.pubkeys = ['other']

      await (handler as any).isRateLimited(event)

      expect(rateLimiterHitStub).to.have.been.called
    })

    it('calls hit with given rate limit settings', async () => {
      eventLimits.rateLimits = [
        {
          period: 60000,
          rate: 1,
        },
        {
          kinds: [1],
          period: 60000,
          rate: 2,
        },
        {
          kinds: [[0, 3]],
          period: 86400000,
          rate: 3,
        },
      ]

      await (handler as any).isRateLimited(event)

      expect(rateLimiterHitStub).to.have.been.calledThrice
      expect(rateLimiterHitStub.firstCall).to.have.been.calledWithExactly(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:events:60000',
        1,
        {
          period: 60000,
          rate: 1,
        },
      )
      expect(rateLimiterHitStub.secondCall).to.have.been.calledWithExactly(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:events:60000:[1]',
        1,
        {
          period: 60000,
          rate: 2,
        },
      )
      expect(rateLimiterHitStub.thirdCall).to.have.been.calledWithExactly(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:events:86400000:[[0,3]]',
        1,
        {
          period: 86400000,
          rate: 3,
        },
      )
    })

    it('fulfills with false if not rate limited', async () => {
      eventLimits.rateLimits = [
        {
          period: 60000,
          rate: 1,
        },
        {
          kinds: [0],
          period: 60000,
          rate: 2,
        },
      ]

      rateLimiterHitStub.resolves(false)

      const actualResult = await (handler as any).isRateLimited(event)

      expect(rateLimiterHitStub).to.have.been.calledOnceWithExactly(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:events:60000',
        1,
        {
          period: 60000,
          rate: 1,
        },
      )
      expect(actualResult).to.be.false
    })

    it('fulfills with true if rate limited by second rate limit setting', async () => {
      eventLimits.rateLimits = [
        {
          period: 60000,
          rate: 1,
        },
        {
          kinds: [0],
          period: 60000,
          rate: 2,
        },
        {
          kinds: [[0, 5]],
          period: 180,
          rate: 3,
        },
      ]

      rateLimiterHitStub.onFirstCall().resolves(false)
      rateLimiterHitStub.onSecondCall().resolves(true)

      const actualResult = await (handler as any).isRateLimited(event)

      expect(rateLimiterHitStub.firstCall).to.have.been.calledWithExactly(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:events:60000',
        1,
        {
          period: 60000,
          rate: 1,
        },
      )
      expect(rateLimiterHitStub.secondCall).to.have.been.calledWithExactly(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:events:180:[[0,5]]',
        1,
        {
          period: 180,
          rate: 3,
        },
      )
      expect(actualResult).to.be.true
    })
  })

  describe('isUserAdmitted', () => {
    let settings: Settings
    let userRepository: IUserRepository
    let getClientAddressStub: SinonStub
    let webSocket: IWebSocketAdapter
    let getRelayPublicKeyStub: SinonStub
    let userRepositoryFindByPubkeyStub: SinonStub
    let cacheStub: any

    beforeEach(() => {
      settings = {
        info: {
          relay_url: 'relay_url',
        },
        payments: {
          enabled: true,
          feeSchedules: {
            admission: [
              {
                enabled: true,
                amount: 1000n,
                whitelists: {
                  pubkeys: [],
                  event_kinds: [],
                },
              },
            ],
          },
        },
        limits: {
          event: {
            pubkey: {
              minBalance: 0n,
            },
          },
        },
      } as any
      event = {
        content: 'hello',
        created_at: 1665546189,
        id: 'f'.repeat(64),
        kind: 1,
        pubkey: 'f'.repeat(64),
        sig: 'f'.repeat(128),
        tags: [],
      }
      getRelayPublicKeyStub = sandbox.stub(EventMessageHandler.prototype, 'getRelayPublicKey' as any)
      getClientAddressStub = sandbox.stub()
      userRepositoryFindByPubkeyStub = sandbox.stub()
      webSocket = {
        getClientAddress: getClientAddressStub,
      } as any
      userRepository = {
        findByPubkey: userRepositoryFindByPubkeyStub,
        isVanished: async () => false,
      } as any
      cacheStub = {
        hasKey: sandbox.stub().resolves(false),
        getKey: sandbox.stub().resolves(null),
        setKey: sandbox.stub().resolves(true),
      }
      handler = new EventMessageHandler(
        webSocket,
        () => null,
        {} as any,
        userRepository,
        () => settings,
        {} as any,
        cacheStub,
        () => ({ hit: async () => false }),
      )
    })

    it('fulfills with undefined if payments are disabled', async () => {
      settings.payments.enabled = false

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    it("fulfills with undefined if event pubkey equals relay's own public key", async () => {
      getRelayPublicKeyStub.returns(event.pubkey)

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    it('fulfills with undefined if fee schedules are not set', async () => {
      settings.payments.feeSchedules = undefined

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    it('fulfills with undefined if admission fee schedules are not set', async () => {
      settings.payments.feeSchedules.admission = undefined

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    it('fulfills with undefined if there are no admission fee schedules', async () => {
      settings.payments.feeSchedules.admission = []

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    it('fulfills with undefined if there are no enabled admission fee schedules', async () => {
      settings.payments.feeSchedules.admission[0].enabled = false

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    it('fulfills with undefined if admission fee schedule is waived for pubkey', async () => {
      settings.payments.feeSchedules.admission[0].whitelists.pubkeys.push(event.pubkey)

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    it('fulfills with undefined if admission fee schedule is waived for event kind', async () => {
      event.kind = EventKinds.ZAP_RECEIPT
      settings.payments.feeSchedules.admission[0].whitelists.event_kinds.push(EventKinds.ZAP_RECEIPT)

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    it('fulfills with undefined if admission fee schedule is waived for event kind range', async () => {
      event.kind = EventKinds.TEXT_NOTE
      settings.payments.feeSchedules.admission[0].whitelists.event_kinds.push([
        EventKinds.SET_METADATA,
        EventKinds.RECOMMEND_SERVER,
      ])

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    it('fulfills with reason if admission fee schedule is not waived for event kind range', async () => {
      event.kind = EventKinds.CONTACT_LIST
      settings.payments.feeSchedules.admission[0].whitelists.event_kinds.push([
        EventKinds.SET_METADATA,
        EventKinds.RECOMMEND_SERVER,
      ])

      return expect((handler as any).isUserAdmitted(event)).to.eventually.equal('blocked: pubkey not admitted')
    })

    it('fulfills with reason if user is not found', async () => {
      return expect((handler as any).isUserAdmitted(event)).to.eventually.equal('blocked: pubkey not admitted')
    })

    it('fulfills with reason if user is not admitted', async () => {
      userRepositoryFindByPubkeyStub.resolves({ isAdmitted: false, isVanished: false })

      return expect((handler as any).isUserAdmitted(event)).to.eventually.equal('blocked: pubkey not admitted')
    })

    it('fulfills with reason if user is not admitted', async () => {
      userRepositoryFindByPubkeyStub.resolves({ isAdmitted: false, isVanished: false })

      return expect((handler as any).isUserAdmitted(event)).to.eventually.equal('blocked: pubkey not admitted')
    })

    it('fulfills with reason if user does not meet minimum balance', async () => {
      settings.limits.event.pubkey.minBalance = 1000n
      userRepositoryFindByPubkeyStub.resolves({ isAdmitted: true, isVanished: false, balance: 999n })

      return expect((handler as any).isUserAdmitted(event)).to.eventually.equal('blocked: insufficient balance')
    })

    it('fulfills with undefined if user is admitted', async () => {
      settings.limits.event.pubkey.minBalance = 0n
      userRepositoryFindByPubkeyStub.resolves({ isAdmitted: true, isVanished: false })

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    describe('caching', () => {
      it('falls back to repository lookup when cache read fails', async () => {
        cacheStub.getKey.rejects(new Error('cache unavailable'))
        settings.limits.event.pubkey.minBalance = 100n
        userRepositoryFindByPubkeyStub.resolves({ isAdmitted: true, balance: 150n })

        await expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined

        expect(userRepositoryFindByPubkeyStub).to.have.been.calledOnceWithExactly(event.pubkey)
        expect(cacheStub.setKey).to.have.been.calledWith(`${event.pubkey}:is-admitted`, CacheAdmissionState.ADMITTED, 300)
      })

      it('fulfills with undefined and uses cache hit for admitted user without hitting DB', async () => {
        cacheStub.getKey.resolves(CacheAdmissionState.ADMITTED)

        await expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
        expect(userRepositoryFindByPubkeyStub).not.to.have.been.called
      })

      it('fulfills with reason and uses cache hit for blocked user without hitting DB', async () => {
        cacheStub.getKey.resolves(CacheAdmissionState.BLOCKED_NOT_ADMITTED)

        await expect((handler as any).isUserAdmitted(event)).to.eventually.equal('blocked: pubkey not admitted')
        expect(userRepositoryFindByPubkeyStub).not.to.have.been.called
      })

      it('fulfills with reason and uses cache hit for insufficient balance without hitting DB', async () => {
        cacheStub.getKey.resolves(CacheAdmissionState.BLOCKED_INSUFFICIENT_BALANCE)

        await expect((handler as any).isUserAdmitted(event)).to.eventually.equal('blocked: insufficient balance')
        expect(userRepositoryFindByPubkeyStub).not.to.have.been.called
      })

      it('caches blocked status with 60s ttl when user is not found', async () => {
        userRepositoryFindByPubkeyStub.resolves(undefined)

        await (handler as any).isUserAdmitted(event)
        expect(cacheStub.setKey).to.have.been.calledWith(
          `${event.pubkey}:is-admitted`,
          CacheAdmissionState.BLOCKED_NOT_ADMITTED,
          60,
        )
      })

      it('caches insufficient balance status with 60s ttl when user balance is too low', async () => {
        settings.limits.event.pubkey.minBalance = 100n
        userRepositoryFindByPubkeyStub.resolves({ isAdmitted: true, balance: 50n })

        await (handler as any).isUserAdmitted(event)
        expect(cacheStub.setKey).to.have.been.calledWith(
          `${event.pubkey}:is-admitted`,
          CacheAdmissionState.BLOCKED_INSUFFICIENT_BALANCE,
          60,
        )
      })

      it('caches admitted status with 300s ttl when user is admitted and has balance', async () => {
        settings.limits.event.pubkey.minBalance = 100n
        userRepositoryFindByPubkeyStub.resolves({ isAdmitted: true, balance: 150n })

        await (handler as any).isUserAdmitted(event)
        expect(cacheStub.setKey).to.have.been.calledWith(
          `${event.pubkey}:is-admitted`,
          CacheAdmissionState.ADMITTED,
          300,
        )
      })
    })
  })

  describe('checkNip05Verification', () => {
    let settings: Settings
    let nip05VerificationRepository: any
    let getRelayPublicKeyStub: Sinon.SinonStub

    beforeEach(() => {
      settings = {
        info: {
          relay_url: 'relay_url',
        },
        nip05: {
          mode: 'enabled',
          verifyExpiration: 86400000,
          verifyUpdateFrequency: 3600000,
          maxConsecutiveFailures: 10,
          domainWhitelist: [],
          domainBlacklist: [],
        },
      } as any
      event = {
        content: 'hello',
        created_at: 1665546189,
        id: 'f'.repeat(64),
        kind: 1,
        pubkey: 'f'.repeat(64),
        sig: 'f'.repeat(128),
        tags: [],
      }
      nip05VerificationRepository = {
        findByPubkey: sandbox.stub(),
        upsert: sandbox.stub(),
        deleteByPubkey: sandbox.stub(),
        findPendingVerifications: sandbox.stub(),
      }
      getRelayPublicKeyStub = sandbox.stub(EventMessageHandler.prototype, 'getRelayPublicKey' as any)
      handler = new EventMessageHandler(
        {} as any,
        () => null,
        { hasActiveRequestToVanish: async () => false } as any,
        userRepository,
        () => settings,
        nip05VerificationRepository,
        { hasKey: async () => false, setKey: async () => true, getKey: async () => null } as any,
        () => ({ hit: async () => false }),
      )
    })

    it('returns undefined if nip05 settings are not set', async () => {
      settings.nip05 = undefined

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns undefined if nip05 mode is disabled', async () => {
      settings.nip05.mode = 'disabled'

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns undefined if nip05 mode is passive', async () => {
      settings.nip05.mode = 'passive'

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns undefined for kind 0 events (SET_METADATA)', async () => {
      event.kind = 0

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns undefined if event pubkey equals relay public key', async () => {
      getRelayPublicKeyStub.returns(event.pubkey)

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns reason if no verification found for pubkey', async () => {
      nip05VerificationRepository.findByPubkey.resolves(undefined)

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 verification required',
      )
    })

    it('returns reason if verification exists but has no lastVerifiedAt', async () => {
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: false,
        lastVerifiedAt: null,
        domain: 'example.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 verification required',
      )
    })

    it('treats isVerified=true with null lastVerifiedAt as unverified (historical/bad data)', async () => {
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: null,
        domain: 'example.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 verification required',
      )
    })

    it('returns reason if verification is expired', async () => {
      const expired = new Date(Date.now() - 86400001)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: expired,
        domain: 'example.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 verification expired',
      )
    })

    it('returns undefined if verification is valid and not expired', async () => {
      const recent = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: recent,
        domain: 'example.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('allows author when lastVerifiedAt is recent even if isVerified is false (transient re-check failure)', async () => {
      const recent = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: false,
        lastVerifiedAt: recent,
        domain: 'example.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns reason if domain is blacklisted', async () => {
      settings.nip05.domainBlacklist = ['spam.com']
      const recent = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: recent,
        domain: 'spam.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 domain not allowed',
      )
    })

    it('returns reason if domain is not in whitelist', async () => {
      settings.nip05.domainWhitelist = ['allowed.com']
      const recent = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: recent,
        domain: 'other.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 domain not allowed',
      )
    })

    it('returns undefined if domain is in whitelist', async () => {
      settings.nip05.domainWhitelist = ['allowed.com']
      const recent = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: recent,
        domain: 'allowed.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })
  })

  describe('addExpirationMetadata', () => {
    beforeEach(() => {
      handler = new EventMessageHandler(
        {} as any,
        () => null,
        {} as any,
        userRepository,
        () =>
          ({
            info: { relay_url: 'relay_url' },
          }) as any,
        {} as any,
        { hasKey: async () => false, setKey: async () => true } as any,
        () => ({ hit: async () => false }),
      )
    })

    it('adds expiration metadata when expiration tag is present', () => {
      const expiringEvent: Event = {
        ...event,
        tags: [[EventTags.Expiration, '1665547000']],
      }

      const enriched = (handler as any).addExpirationMetadata(expiringEvent)

      expect((enriched as any)[EventExpirationTimeMetadataKey]).to.equal(1665547000)
    })
  })

  describe('processNip05Metadata', () => {
    let settings: Settings
    let nip05VerificationRepository: any
    let verifyStub: Sinon.SinonStub

    beforeEach(() => {
      settings = {
        info: {
          relay_url: 'relay_url',
        },
        nip05: {
          mode: 'enabled',
          verifyExpiration: 86400000,
          verifyUpdateFrequency: 3600000,
          maxConsecutiveFailures: 10,
          domainWhitelist: [],
          domainBlacklist: [],
        },
      } as any
      nip05VerificationRepository = {
        findByPubkey: sandbox.stub(),
        upsert: sandbox.stub().resolves(1),
        deleteByPubkey: sandbox.stub().resolves(1),
        findPendingVerifications: sandbox.stub(),
      }
      verifyStub = sandbox.stub(nip05Utils, 'verifyNip05Identifier')
      handler = new EventMessageHandler(
        {} as any,
        () => null,
        { hasActiveRequestToVanish: async () => false } as any,
        userRepository,
        () => settings,
        nip05VerificationRepository,
        { hasKey: async () => false, setKey: async () => true, getKey: async () => null } as any,
        () => ({ hit: async () => false }),
      )
    })

    it('does nothing when nip05 settings are undefined', async () => {
      settings.nip05 = undefined
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).not.to.have.been.called
    })

    it('does nothing when nip05 mode is disabled', async () => {
      settings.nip05.mode = 'disabled'
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).not.to.have.been.called
    })

    it('does nothing for non-kind-0 events', async () => {
      event.kind = EventKinds.TEXT_NOTE
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).not.to.have.been.called
    })

    it('deletes verification when kind-0 has no nip05 in content', async () => {
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ name: 'alice' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(nip05VerificationRepository.deleteByPubkey).to.have.been.calledOnceWithExactly(event.pubkey)
      expect(verifyStub).not.to.have.been.called
    })

    it('ignores delete errors when kind-0 has no nip05 in content', async () => {
      nip05VerificationRepository.deleteByPubkey.rejects(new Error('db down'))
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ name: 'alice' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(nip05VerificationRepository.deleteByPubkey).to.have.been.calledOnceWithExactly(event.pubkey)
      expect(verifyStub).not.to.have.been.called
    })

    it('does nothing when nip05 identifier is unparseable', async () => {
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'invalid-no-at-sign' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).not.to.have.been.called
      expect(nip05VerificationRepository.deleteByPubkey).not.to.have.been.called
    })

    it('does nothing when domain is not allowed', async () => {
      settings.nip05.domainBlacklist = ['blocked.com']
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@blocked.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).not.to.have.been.called
    })

    it('verifies and upserts on successful verification', async () => {
      nip05VerificationRepository.findByPubkey.resolves(undefined)
      verifyStub.resolves({ status: 'verified' })
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).to.have.been.calledOnceWithExactly('alice@example.com', event.pubkey)
      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.pubkey).to.equal(event.pubkey)
      expect(upsertArg.nip05).to.equal('alice@example.com')
      expect(upsertArg.domain).to.equal('example.com')
      expect(upsertArg.isVerified).to.be.true
      expect(upsertArg.failureCount).to.equal(0)
      expect(upsertArg.lastVerifiedAt).to.be.an.instanceOf(Date)
    })

    it('upserts with unverified state and nulls lastVerifiedAt on definitive mismatch', async () => {
      nip05VerificationRepository.findByPubkey.resolves(undefined)
      verifyStub.resolves({ status: 'mismatch' })
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).to.have.been.calledOnce
      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.isVerified).to.be.false
      expect(upsertArg.failureCount).to.equal(1)
      expect(upsertArg.lastVerifiedAt).to.be.null
    })

    it('increments failureCount from existing row on definitive mismatch', async () => {
      const priorVerifiedAt = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        pubkey: event.pubkey,
        nip05: 'alice@example.com',
        domain: 'example.com',
        isVerified: true,
        lastVerifiedAt: priorVerifiedAt,
        lastCheckedAt: priorVerifiedAt,
        failureCount: 2,
        createdAt: priorVerifiedAt,
        updatedAt: priorVerifiedAt,
      })
      verifyStub.resolves({ status: 'mismatch' })
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.failureCount).to.equal(3)
      expect(upsertArg.isVerified).to.be.false
      expect(upsertArg.lastVerifiedAt).to.be.null
    })

    it('preserves prior isVerified/lastVerifiedAt on transient error', async () => {
      const priorVerifiedAt = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        pubkey: event.pubkey,
        nip05: 'alice@example.com',
        domain: 'example.com',
        isVerified: true,
        lastVerifiedAt: priorVerifiedAt,
        lastCheckedAt: priorVerifiedAt,
        failureCount: 1,
        createdAt: priorVerifiedAt,
        updatedAt: priorVerifiedAt,
      })
      verifyStub.resolves({ status: 'error', reason: 'ETIMEDOUT' })
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.isVerified).to.be.true
      expect(upsertArg.lastVerifiedAt).to.equal(priorVerifiedAt)
      expect(upsertArg.failureCount).to.equal(2)
      expect(upsertArg.lastCheckedAt).to.be.an.instanceOf(Date)
    })

    it('handles verification errors gracefully (thrown by verifier)', async () => {
      nip05VerificationRepository.findByPubkey.resolves(undefined)
      verifyStub.rejects(new Error('network error'))
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(nip05VerificationRepository.upsert).not.to.have.been.called
    })

    it('works correctly in passive mode', async () => {
      settings.nip05.mode = 'passive'
      nip05VerificationRepository.findByPubkey.resolves(undefined)
      verifyStub.resolves({ status: 'verified' })
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).to.have.been.calledOnce
      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce
    })
  })

  describe('checkNip05Verification', () => {
    let settings: Settings
    let nip05VerificationRepository: any
    let getRelayPublicKeyStub: Sinon.SinonStub

    beforeEach(() => {
      settings = {
        info: {
          relay_url: 'relay_url',
        },
        nip05: {
          mode: 'enabled',
          verifyExpiration: 86400000,
          verifyUpdateFrequency: 3600000,
          maxConsecutiveFailures: 10,
          domainWhitelist: [],
          domainBlacklist: [],
        },
      } as any
      event = {
        content: 'hello',
        created_at: 1665546189,
        id: 'f'.repeat(64),
        kind: 1,
        pubkey: 'f'.repeat(64),
        sig: 'f'.repeat(128),
        tags: [],
      }
      nip05VerificationRepository = {
        findByPubkey: sandbox.stub(),
        upsert: sandbox.stub(),
        deleteByPubkey: sandbox.stub(),
        findPendingVerifications: sandbox.stub(),
      }
      getRelayPublicKeyStub = sandbox.stub(EventMessageHandler.prototype, 'getRelayPublicKey' as any)
      handler = new EventMessageHandler(
        {} as any,
        () => null,
        { hasActiveRequestToVanish: async () => false } as any,
        userRepository,
        () => settings,
        nip05VerificationRepository,
        { hasKey: async () => false, setKey: async () => true, getKey: async () => null } as any,
        () => ({ hit: async () => false }),
      )
    })

    it('returns undefined if nip05 settings are not set', async () => {
      settings.nip05 = undefined

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns undefined if nip05 mode is disabled', async () => {
      settings.nip05.mode = 'disabled'

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns undefined if nip05 mode is passive', async () => {
      settings.nip05.mode = 'passive'

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns undefined for kind 0 events (SET_METADATA)', async () => {
      event.kind = 0

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns undefined if event pubkey equals relay public key', async () => {
      getRelayPublicKeyStub.returns(event.pubkey)

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns reason if no verification found for pubkey', async () => {
      nip05VerificationRepository.findByPubkey.resolves(undefined)

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 verification required',
      )
    })

    it('returns reason if verification exists but has no lastVerifiedAt', async () => {
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: false,
        lastVerifiedAt: null,
        domain: 'example.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 verification required',
      )
    })

    it('treats isVerified=true with null lastVerifiedAt as unverified (historical/bad data)', async () => {
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: null,
        domain: 'example.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 verification required',
      )
    })

    it('returns reason if verification is expired', async () => {
      const expired = new Date(Date.now() - 86400001)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: expired,
        domain: 'example.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 verification expired',
      )
    })

    it('returns undefined if verification is valid and not expired', async () => {
      const recent = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: recent,
        domain: 'example.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('allows author when lastVerifiedAt is recent even if isVerified is false (transient re-check failure)', async () => {
      const recent = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: false,
        lastVerifiedAt: recent,
        domain: 'example.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })

    it('returns reason if domain is blacklisted', async () => {
      settings.nip05.domainBlacklist = ['spam.com']
      const recent = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: recent,
        domain: 'spam.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 domain not allowed',
      )
    })

    it('returns reason if domain is not in whitelist', async () => {
      settings.nip05.domainWhitelist = ['allowed.com']
      const recent = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: recent,
        domain: 'other.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.equal(
        'blocked: NIP-05 domain not allowed',
      )
    })

    it('returns undefined if domain is in whitelist', async () => {
      settings.nip05.domainWhitelist = ['allowed.com']
      const recent = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        isVerified: true,
        lastVerifiedAt: recent,
        domain: 'allowed.com',
      })

      return expect((handler as any).checkNip05Verification(event)).to.eventually.be.undefined
    })
  })

  describe('processNip05Metadata', () => {
    let settings: Settings
    let nip05VerificationRepository: any
    let verifyStub: Sinon.SinonStub

    beforeEach(() => {
      settings = {
        info: {
          relay_url: 'relay_url',
        },
        nip05: {
          mode: 'enabled',
          verifyExpiration: 86400000,
          verifyUpdateFrequency: 3600000,
          maxConsecutiveFailures: 10,
          domainWhitelist: [],
          domainBlacklist: [],
        },
      } as any
      nip05VerificationRepository = {
        findByPubkey: sandbox.stub(),
        upsert: sandbox.stub().resolves(1),
        deleteByPubkey: sandbox.stub().resolves(1),
        findPendingVerifications: sandbox.stub(),
      }
      verifyStub = sandbox.stub(nip05Utils, 'verifyNip05Identifier')
      handler = new EventMessageHandler(
        {} as any,
        () => null,
        { hasActiveRequestToVanish: async () => false } as any,
        userRepository,
        () => settings,
        nip05VerificationRepository,
        { hasKey: async () => false, setKey: async () => true, getKey: async () => null } as any,
        () => ({ hit: async () => false }),
      )
    })

    it('does nothing when nip05 settings are undefined', async () => {
      settings.nip05 = undefined
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).not.to.have.been.called
    })

    it('does nothing when nip05 mode is disabled', async () => {
      settings.nip05.mode = 'disabled'
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).not.to.have.been.called
    })

    it('does nothing for non-kind-0 events', async () => {
      event.kind = EventKinds.TEXT_NOTE
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).not.to.have.been.called
    })

    it('deletes verification when kind-0 has no nip05 in content', async () => {
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ name: 'alice' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(nip05VerificationRepository.deleteByPubkey).to.have.been.calledOnceWithExactly(event.pubkey)
      expect(verifyStub).not.to.have.been.called
    })

    it('does nothing when nip05 identifier is unparseable', async () => {
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'invalid-no-at-sign' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).not.to.have.been.called
      expect(nip05VerificationRepository.deleteByPubkey).not.to.have.been.called
    })

    it('does nothing when domain is not allowed', async () => {
      settings.nip05.domainBlacklist = ['blocked.com']
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@blocked.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).not.to.have.been.called
    })

    it('verifies and upserts on successful verification', async () => {
      nip05VerificationRepository.findByPubkey.resolves(undefined)
      verifyStub.resolves({ status: 'verified' })
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).to.have.been.calledOnceWithExactly('alice@example.com', event.pubkey)
      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.pubkey).to.equal(event.pubkey)
      expect(upsertArg.nip05).to.equal('alice@example.com')
      expect(upsertArg.domain).to.equal('example.com')
      expect(upsertArg.isVerified).to.be.true
      expect(upsertArg.failureCount).to.equal(0)
      expect(upsertArg.lastVerifiedAt).to.be.an.instanceOf(Date)
    })

    it('upserts with unverified state and nulls lastVerifiedAt on definitive mismatch', async () => {
      nip05VerificationRepository.findByPubkey.resolves(undefined)
      verifyStub.resolves({ status: 'mismatch' })
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).to.have.been.calledOnce
      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.isVerified).to.be.false
      expect(upsertArg.failureCount).to.equal(1)
      expect(upsertArg.lastVerifiedAt).to.be.null
    })

    it('increments failureCount from existing row on definitive mismatch', async () => {
      const priorVerifiedAt = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        pubkey: event.pubkey,
        nip05: 'alice@example.com',
        domain: 'example.com',
        isVerified: true,
        lastVerifiedAt: priorVerifiedAt,
        lastCheckedAt: priorVerifiedAt,
        failureCount: 2,
        createdAt: priorVerifiedAt,
        updatedAt: priorVerifiedAt,
      })
      verifyStub.resolves({ status: 'mismatch' })
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.failureCount).to.equal(3)
      expect(upsertArg.isVerified).to.be.false
      expect(upsertArg.lastVerifiedAt).to.be.null
    })

    it('preserves prior isVerified/lastVerifiedAt on transient error', async () => {
      const priorVerifiedAt = new Date(Date.now() - 1000)
      nip05VerificationRepository.findByPubkey.resolves({
        pubkey: event.pubkey,
        nip05: 'alice@example.com',
        domain: 'example.com',
        isVerified: true,
        lastVerifiedAt: priorVerifiedAt,
        lastCheckedAt: priorVerifiedAt,
        failureCount: 1,
        createdAt: priorVerifiedAt,
        updatedAt: priorVerifiedAt,
      })
      verifyStub.resolves({ status: 'error', reason: 'ETIMEDOUT' })
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      const upsertArg = nip05VerificationRepository.upsert.firstCall.args[0]
      expect(upsertArg.isVerified).to.be.true
      expect(upsertArg.lastVerifiedAt).to.equal(priorVerifiedAt)
      expect(upsertArg.failureCount).to.equal(2)
      expect(upsertArg.lastCheckedAt).to.be.an.instanceOf(Date)
    })

    it('handles verification errors gracefully (thrown by verifier)', async () => {
      nip05VerificationRepository.findByPubkey.resolves(undefined)
      verifyStub.rejects(new Error('network error'))
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(nip05VerificationRepository.upsert).not.to.have.been.called
    })

    it('works correctly in passive mode', async () => {
      settings.nip05.mode = 'passive'
      nip05VerificationRepository.findByPubkey.resolves(undefined)
      verifyStub.resolves({ status: 'verified' })
      event.kind = EventKinds.SET_METADATA
      event.content = JSON.stringify({ nip05: 'alice@example.com' })

      ;(handler as any).processNip05Metadata(event)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(verifyStub).to.have.been.calledOnce
      expect(nip05VerificationRepository.upsert).to.have.been.calledOnce
    })
  })
})
