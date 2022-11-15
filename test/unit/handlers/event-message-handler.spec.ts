import EventEmitter from 'events'

import Sinon, { SinonFakeTimers, SinonStub } from 'sinon'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'

chai.use(chaiAsPromised)

import { EventLimits, ISettings } from '../../../src/@types/settings'
import { IncomingEventMessage, MessageType } from '../../../src/@types/messages'
import { Event } from '../../../src/@types/event'
import { EventMessageHandler } from '../../../src/handlers/event-message-handler'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'

const { expect } = chai

describe('EventMessageHandler', () => {
  let webSocket: EventEmitter
  let handler: EventMessageHandler
  let event: Event
  let message: IncomingEventMessage
  let sandbox: Sinon.SinonSandbox

  let originalConsoleWarn: (message?: any, ...optionalParams: any[]) => void | undefined = undefined

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
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

    beforeEach(() => {
      canAcceptEventStub = sandbox.stub(EventMessageHandler.prototype, 'canAcceptEvent' as any)
      isEventValidStub = sandbox.stub(EventMessageHandler.prototype, 'isEventValid' as any)
      strategyExecuteStub = sandbox.stub()
      strategyFactoryStub = sandbox.stub().returns({
        execute: strategyExecuteStub,
      })
      onMessageSpy = sandbox.fake.returns(undefined)
      webSocket = new EventEmitter()
      webSocket.on(WebSocketAdapterEvent.Message, onMessageSpy)
      message = [MessageType.EVENT, event]
      isRateLimitedStub = sandbox.stub(EventMessageHandler.prototype, 'isRateLimited' as any)
      handler = new EventMessageHandler(
        webSocket as any,
        strategyFactoryStub,
        () => ({}) as any,
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
      isEventValidStub.returns('reason')

      await handler.handleMessage(message)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).not.to.have.been.calledOnceWithExactly()
      expect(strategyFactoryStub).not.to.have.been.called
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
    let settings: ISettings
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
          minLeadingZeroBits: 0,
          blacklist: [],
          whitelist: [],
        },
      }
      settings = {
        limits: {
          event: eventLimits,
        },
      } as any
      handler = new EventMessageHandler(
        {} as any,
        () => null,
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
          event.kind = 6
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
          event.kind = 6
          expect(
            (handler as any).canAcceptEvent(event)
          ).to.equal('blocked: event kind 6 not allowed')
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
    let settings: ISettings
    let rateLimiterHitStub: SinonStub

    beforeEach(() => {
      eventLimits = {
        rateLimits: [],
      }
      settings = {
        limits: {
          event: eventLimits,
        },
      } as any
      rateLimiterHitStub = sandbox.stub()
      handler = new EventMessageHandler(
        {} as any,
        () => null,
        () => settings,
        () => ({ hit: rateLimiterHitStub })
      )
    })

    it('returns undefined if rate limits setting is not set', async () => {
      eventLimits.rateLimits = undefined
      return expect((handler as any).isRateLimited(event)).to.eventually.be.undefined
    })

    it('returns undefined if rate limits setting is empty', async () => {
      eventLimits.rateLimits = []
      return expect((handler as any).isRateLimited(event)).to.eventually.be.undefined
    })

    it('calls hit with given rate limit settings', async () => {
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
          kinds: [[10, 20]],
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
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:events:60000:[0]',
        1,
        {
          period: 60000,
          rate: 2,
        }
      )
      expect(rateLimiterHitStub.thirdCall).to.have.been.calledWithExactly(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:events:86400000:[[10,20]]',
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
        {
          kinds: [[10, 20]],
          period: 86400000,
          rate: 3,
        },
      ]

      rateLimiterHitStub.resolves(false)

      const actualResult = await (handler as any).isRateLimited(event)

      expect(rateLimiterHitStub).to.have.been.calledThrice
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
          kinds: [[10, 20]],
          period: 86400000,
          rate: 3,
        },
      ]

      rateLimiterHitStub.onFirstCall().resolves(false)
      rateLimiterHitStub.onSecondCall().resolves(true)
      rateLimiterHitStub.onThirdCall().resolves(false)

      const actualResult = await (handler as any).isRateLimited(event)

      expect(rateLimiterHitStub).to.have.been.calledThrice
      expect(actualResult).to.be.true
    })
  })
})
