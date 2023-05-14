import EventEmitter from 'events'

import Sinon, { SinonFakeTimers, SinonStub } from 'sinon'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import { EventLimits, Settings } from '../../../src/@types/settings'
import { IncomingEventMessage, MessageType } from '../../../src/@types/messages'
import { Event } from '../../../src/@types/event'
import { EventKinds } from '../../../src/constants/base'
import { EventMessageHandler } from '../../../src/handlers/event-message-handler'
import { IUserRepository } from '../../../src/@types/repositories'
import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'

const { expect } = chai

describe('EventMessageHandler', () => {
  let webSocket: IWebSocketAdapter
  let handler: EventMessageHandler
  let userRepository: IUserRepository
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
        userRepository,
        () => ({
          info: { relay_url: 'relay_url' },
        }) as any,
        () => ({ hit: async () => false })
      )
    })

    afterEach(() => {
      isEventValidStub.restore()
      canAcceptEventStub.restore()
      webSocket.removeAllListeners()
    })

    it('rejects event if it can\'t be accepted', async () => {
      canAcceptEventStub.returns('reason')

      await handler.handleMessage(message)

      expect(canAcceptEventStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).to.have.been.calledOnceWithExactly(
        [MessageType.OK, event.id, false, 'reason'],
      )
      expect(strategyFactoryStub).not.to.have.been.called
    })

    it('rejects event if rate-limited', async () => {
      isRateLimitedStub.resolves(true)

      await handler.handleMessage(message)

      expect(isRateLimitedStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).to.have.been.calledOnceWithExactly(
        [MessageType.OK, event.id, false, 'rate-limited: slow down'],
      )
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

    it('rejects event if it is expired', async () => {
      isEventValidStub.resolves(undefined)

      const expiredEvent = {
        ...event,
        tags: [
          ['expiration', '1600000'],
        ],
      }

      const expiredEventMessage: any = [MessageType.EVENT, expiredEvent]

      await handler.handleMessage(expiredEventMessage)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(expiredEvent)

      expect(onMessageSpy).to.have.been.calledOnceWithExactly(
        [MessageType.OK, event.id, false, 'event is expired'],
      )
      expect(strategyExecuteStub).not.to.have.been.called
    })

    it('does not call strategy if none given', async () => {
      isEventValidStub.returns(undefined)
      canAcceptEventStub.returns(undefined)
      strategyFactoryStub.returns(undefined)

      await handler.handleMessage(message)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).not.to.have.been.calledOnceWithExactly()
      expect(strategyFactoryStub).to.have.been.calledOnceWithExactly([
        event,
        webSocket,
      ])
      expect(strategyExecuteStub).not.to.have.been.called
    })

    it('calls strategy with event', async () => {
      isEventValidStub.returns(undefined)
      canAcceptEventStub.returns(undefined)

      await handler.handleMessage(message)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).not.to.have.been.calledOnceWithExactly()
      expect(strategyFactoryStub).to.have.been.calledOnceWithExactly([
        event,
        webSocket,
      ])
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
        userRepository,
        () => settings,
        () => ({ hit: async () => false })
      )
    })

    afterEach(() => {
      clock.restore()
    })

    describe('createdAt', () => {
      describe('maxPositiveDelta', () => {
        it('returns undefined if maxPositiveDelta is zero', () => {
          eventLimits.createdAt.maxPositiveDelta = 0

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
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

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if createdDate is too far in the past', () => {
          eventLimits.createdAt.maxNegativeDelta = 100
          event.created_at -= 101

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('rejected: created_at is more than 100 seconds in the past')
        })
      })
    })

    describe('content', () => {
      describe('maxLength', () => {
        it('returns undefined if maxLength is disabled', () => {
          eventLimits.content = [{ maxLength: 0 }]

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefned if content is not too long', () => {
          eventLimits.content = [{ maxLength: 1 }]
          event.content = 'x'.repeat(1)

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if kind does not match', () => {
          eventLimits.content = [{ kinds: [EventKinds.SET_METADATA], maxLength: 1 }]
          event.content = 'x'

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if kind matches but content is short', () => {
          eventLimits.content = [{ kinds: [EventKinds.TEXT_NOTE], maxLength: 1 }]
          event.content = 'x'

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if kind matches but content is too long', () => {
          eventLimits.content = [{ kinds: [EventKinds.TEXT_NOTE], maxLength: 1 }]
          event.content = 'xx'

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('rejected: content is longer than 1 bytes')
        })

        it('returns reason if content is too long', () => {
          eventLimits.content = [{ maxLength: 1 }]
          event.content = 'x'.repeat(2)

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('rejected: content is longer than 1 bytes')
        })
      })

      describe('maxLength (deprecated)', () => {
        it('returns undefined if maxLength is zero', () => {
          eventLimits.content = { maxLength: 0 }

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if content is short', () => {
          eventLimits.content = { maxLength: 100 }
          event.content = 'x'.repeat(100)

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if content is too long', () => {
          eventLimits.content = { maxLength: 1 }
          event.content = 'xx'

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('rejected: content is longer than 1 bytes')
        })

        it('returns undefined if kind matches and content is short', () => {
          eventLimits.content = { kinds: [EventKinds.TEXT_NOTE], maxLength: 1 }
          event.content = 'x'

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if kind does not match and content is too long', () => {
          eventLimits.content = { kinds: [EventKinds.SET_METADATA], maxLength: 1 }
          event.content = 'xx'

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if content is too long', () => {
          eventLimits.content = { maxLength: 1 }
          event.content = 'xx'

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('rejected: content is longer than 1 bytes')
        })

        it('returns undefined if content is not set', () => {
          eventLimits.content = undefined
          event.content = 'xx'

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })
      })

      describe('maxNegativeDelta', () => {
        it('returns undefined if maxNegativeDelta is zero', () => {
          eventLimits.createdAt.maxNegativeDelta = 0

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if createdDate is too far in the past', () => {
          eventLimits.createdAt.maxNegativeDelta = 100
          event.created_at -= 101

          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('rejected: created_at is more than 100 seconds in the past')
        })
      })
    })

    describe('eventId', () => {
      describe('minLeadingZeroBits', () => {
        it('returns undefined if minLeadingZeroBits is zero', () => {
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if eventId has sufficient proof of work ', () => {
          eventLimits.eventId.minLeadingZeroBits = 15
          event.id = '0001' + 'f'.repeat(60)
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if eventId has insufficient proof of work ', () => {
          eventLimits.eventId.minLeadingZeroBits = 16
          event.id = '00' + 'f'.repeat(62)
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('pow: difficulty 8<16')
        })
      })
    })

    describe('pubkey', () => {
      describe('minLeadingZeroBits', () => {
        it('returns undefined if minLeadingZeroBits is zero', () => {
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if pubkey has sufficient proof of work ', () => {
          eventLimits.pubkey.minLeadingZeroBits = 17
          event.pubkey = '00007' + 'f'.repeat(59)
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if pubkey has insufficient proof of work ', () => {
          eventLimits.pubkey.minLeadingZeroBits = 16
          event.pubkey = '0'.repeat(2) + 'f'.repeat(62)
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('pow: pubkey difficulty 8<16')
        })
      })

      describe('blacklist', () => {
        it('returns undefined if blacklist is empty', () => {
          eventLimits.pubkey.blacklist = []
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if pubkey is not blacklisted', () => {
          eventLimits.pubkey.blacklist = ['aabbcc']
          event.pubkey = 'fffff'
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if pubkey is not blacklisted by prefix', () => {
          eventLimits.pubkey.blacklist = ['aa55']
          event.pubkey = 'aabbcc'
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if pubkey is blacklisted', () => {
          eventLimits.pubkey.blacklist = ['aabbcc']
          event.pubkey = 'aabbcc'
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('blocked: pubkey not allowed')
        })

        it('returns reason if pubkey is blacklisted by prefix', () => {
          eventLimits.pubkey.blacklist = ['aa55']
          event.pubkey = 'aa55ccddeeff'
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('blocked: pubkey not allowed')
        })
      })

      describe('whitelist', () => {
        it('returns undefined if whitelist is empty', () => {
          eventLimits.pubkey.whitelist = []
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if pubkey is whitelisted', () => {
          eventLimits.pubkey.whitelist = ['aabbcc']
          event.pubkey = 'aabbcc'
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if pubkey is whitelisted by prefix', () => {
          eventLimits.pubkey.whitelist = ['aa55']
          event.pubkey = 'aa55ccddeeff'
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if pubkey is not whitelisted', () => {
          eventLimits.pubkey.whitelist = ['ffffff']
          event.pubkey = 'aabbcc'
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('blocked: pubkey not allowed')
        })

        it('returns reason if pubkey is not whitelisted by prefix', () => {
          eventLimits.pubkey.whitelist = ['aa55']
          event.pubkey = 'aabbccddeeff'
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('blocked: pubkey not allowed')
        })
      })
    })

    describe('kind', () => {
      describe('blacklist', () => {
        it('returns undefined if blacklist is empty', () => {
          eventLimits.kind.blacklist = []
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if kind is not blacklisted', () => {
          eventLimits.kind.blacklist = [5]
          event.kind = 4
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if kind is not blacklisted in range', () => {
          eventLimits.kind.blacklist = [[1, 5]]
          event.kind = EventKinds.REACTION
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if kind is blacklisted in range', () => {
          eventLimits.kind.blacklist = [[1, 5]]
          event.kind = 4
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('blocked: event kind 4 not allowed')
        })
      })

      describe('whitelist', () => {
        it('returns undefined if whitelist is empty', () => {
          eventLimits.kind.whitelist = []
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if kind is whitelisted', () => {
          eventLimits.kind.whitelist = [5]
          event.kind = 5
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns undefined if kind is whitelisted in range', () => {
          eventLimits.kind.whitelist = [[1, 5]]
          event.kind = 3
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.be.undefined
        })

        it('returns reason if kind is blacklisted and whitelisted in range', () => {
          eventLimits.kind.blacklist = [3]
          eventLimits.kind.whitelist = [[1, 5]]
          event.kind = 3
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('blocked: event kind 3 not allowed')
        })

        it('returns reason if kind is blacklisted and whitelisted', () => {
          eventLimits.kind.blacklist = [3]
          eventLimits.kind.whitelist = [3]
          event.kind = 3
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('blocked: event kind 3 not allowed')
        })

        it('returns reason if kind is not whitelisted', () => {
          eventLimits.kind.whitelist = [5]
          event.kind = 4
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('blocked: event kind 4 not allowed')
        })

        it('returns reason if kind is not whitelisted in range', () => {
          eventLimits.kind.whitelist = [[1, 5]]
          event.kind = EventKinds.REACTION
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('blocked: event kind 7 not allowed')
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
        content: '{"name":"ottman@minds.io","about":"","picture":"https://feat-2311-nostr.minds.io/icon/1002952989368913934/medium/1564498626/1564498626/1653379539"}',
        sig: 'd1de98733de2b412549aa64454722d9b66ab3c68e9e0d0f9c5d42e7bd54c30a06174364b683d2c8dbb386ff47f31e6cb7e2f3c3498d8819ee80421216c8309a9',
      }
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
      return expect((handler as any).isEventValid(event)).to.eventually.equal('invalid: event signature verification failed')
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
      handler = new EventMessageHandler(
        webSocket,
        () => null,
        userRepository,
        () => settings,
        () => ({ hit: rateLimiterHitStub })
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
        }
      )
      expect(rateLimiterHitStub.secondCall).to.have.been.calledWithExactly(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:events:60000:[1]',
        1,
        {
          period: 60000,
          rate: 2,
        }
      )
      expect(rateLimiterHitStub.thirdCall).to.have.been.calledWithExactly(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:events:86400000:[[0,3]]',
        1,
        {
          period: 86400000,
          rate: 3,
        }
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
      } as any
      handler = new EventMessageHandler(
        webSocket,
        () => null,
        userRepository,
        () => settings,
        () => ({ hit: async () => false })
      )
    })

    it ('fulfills with undefined if payments are disabled', async () => {
      settings.payments.enabled = false

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })

    it('fulfills with undefined if event pubkey equals relay\'s own public key', async () => {
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
      userRepositoryFindByPubkeyStub.resolves({ isAdmitted: false })

      return expect((handler as any).isUserAdmitted(event)).to.eventually.equal('blocked: pubkey not admitted')
    })

    it('fulfills with reason if user is not admitted', async () => {
      userRepositoryFindByPubkeyStub.resolves({ isAdmitted: false })

      return expect((handler as any).isUserAdmitted(event)).to.eventually.equal('blocked: pubkey not admitted')
    })

    it('fulfills with reason if user does not meet minimum balance', async () => {
      settings.limits.event.pubkey.minBalance = 1000n
      userRepositoryFindByPubkeyStub.resolves({ isAdmitted: true, balance: 999n })

      return expect((handler as any).isUserAdmitted(event)).to.eventually.equal('blocked: insufficient balance')
    })

    it('fulfills with undefined if user is admitted', async () => {
      settings.limits.event.pubkey.minBalance = 0n
      userRepositoryFindByPubkeyStub.resolves({ isAdmitted: true })

      return expect((handler as any).isUserAdmitted(event)).to.eventually.be.undefined
    })
  })
})
