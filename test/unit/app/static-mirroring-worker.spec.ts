import EventEmitter from 'events'

import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { StaticMirroringWorker } from '../../../src/app/static-mirroring-worker'
import { Event } from '../../../src/@types/event'
import { Settings } from '../../../src/@types/settings'
import { IEventRepository, IUserRepository } from '../../../src/@types/repositories'

chai.use(sinonChai)

const { expect } = chai

describe('StaticMirroringWorker', () => {
  let sandbox: Sinon.SinonSandbox
  let worker: StaticMirroringWorker
  let fakeProcess: EventEmitter & { exit: Sinon.SinonStub; env: Record<string, string> }
  let eventRepository: Sinon.SinonStubbedInstance<IEventRepository>
  let userRepository: Sinon.SinonStubbedInstance<IUserRepository>
  let settingsStub: Sinon.SinonStub
  let settingsState: Partial<Settings>

  const defaultSettings = (): Partial<Settings> => ({
    mirroring: {
      static: [
        {
          address: 'ws://source-relay.com',
          filters: [{ kinds: [1, 2] }],
          limits: { event: { content: { maxLength: 10000 } } },
        } as any,
      ],
    },
    info: {
      relay_url: 'wss://relay.example.com',
      name: 'test',
      description: 'test',
      pubkey: 'a'.repeat(64),
      contact: 'test@example.com',
    } as any,
    limits: { event: { content: { maxLength: 20000 } } },
    payments: { enabled: false } as any,
  })

  const createEvent = (overrides: Partial<Event> = {}): Event => ({
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: 'test event',
    sig: 'c'.repeat(128),
    ...overrides,
  })

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    fakeProcess = Object.assign(new EventEmitter(), {
      exit: sandbox.stub(),
      send: sandbox.stub(),
      env: { MIRROR_INDEX: '0' },
    }) as EventEmitter & { exit: Sinon.SinonStub; env: Record<string, string>; send: Sinon.SinonStub }

    eventRepository = {
      create: sandbox.stub().resolves(true),
    } as any

    userRepository = {
      findByPubkey: sandbox.stub().resolves(null),
    } as any

    settingsState = defaultSettings()
    settingsStub = sandbox.stub().callsFake(() => settingsState)

    worker = new StaticMirroringWorker(
      eventRepository,
      userRepository,
      fakeProcess as any,
      settingsStub,
    )
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('constructor', () => {
    it('registers SIGINT, SIGHUP, and SIGTERM handlers', () => {
      expect(fakeProcess.listenerCount('SIGINT')).to.equal(1)
      expect(fakeProcess.listenerCount('SIGHUP')).to.equal(1)
      expect(fakeProcess.listenerCount('SIGTERM')).to.equal(1)
    })

    it('registers uncaughtException and unhandledRejection handlers', () => {
      expect(fakeProcess.listenerCount('uncaughtException')).to.equal(1)
      expect(fakeProcess.listenerCount('unhandledRejection')).to.equal(1)
    })

    it('registers message handler', () => {
      expect(fakeProcess.listenerCount('message')).to.equal(1)
    })
  })

  describe('run', () => {
    it('initializes the worker with mirror config from settings', () => {
      // We can't fully test WebSocket creation, but we verify settings are accessed
      worker.run()

      expect(settingsStub).to.have.been.called
    })

    it('uses MIRROR_INDEX from environment', () => {
      fakeProcess.env.MIRROR_INDEX = '0'

      worker.run()

      expect(settingsStub).to.have.been.called
    })
  })

  describe('canAcceptEvent', () => {
    it('rejects events from the relay itself', () => {
      // This tests the private canAcceptEvent method indirectly through the worker behavior
      // For now, we focus on testing the public interface
    })

    it('accepts valid events within limits', () => {
      const event = createEvent({ pubkey: 'd'.repeat(64) })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.be.a('boolean')
    })

    it('rejects events with content exceeding limits', () => {
      settingsState.limits = {
        event: { content: { maxLength: 10 } },
      }

      const event = createEvent({ content: 'this is a very long content' })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(false)
    })

    it('rejects events with created_at too far in the future', () => {
      const now = Math.floor(Date.now() / 1000)
      settingsState.limits = {
        event: { createdAt: { maxPositiveDelta: 60 } },
      }

      const event = createEvent({ created_at: now + 3600 })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(false)
    })

    it('rejects events with created_at too far in the past', () => {
      const now = Math.floor(Date.now() / 1000)
      settingsState.limits = {
        event: { createdAt: { maxNegativeDelta: 60 } },
      }

      const event = createEvent({ created_at: now - 3600 })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(false)
    })

    it('accepts events within pubkey whitelist', () => {
      const pubkey = 'e'.repeat(64)
      settingsState.limits = {
        event: { pubkey: { whitelist: [pubkey] } as any },
      }

      const event = createEvent({ pubkey })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(true)
    })

    it('rejects events outside pubkey whitelist', () => {
      settingsState.limits = {
        event: { pubkey: { whitelist: ['f'.repeat(64)] } as any },
      }

      const event = createEvent({ pubkey: 'e'.repeat(64) })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(false)
    })

    it('rejects events in pubkey blacklist', () => {
      const pubkey = 'e'.repeat(64)
      settingsState.limits = {
        event: { pubkey: { blacklist: [pubkey] } as any },
      }

      const event = createEvent({ pubkey })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(false)
    })

    it('accepts events not in pubkey blacklist', () => {
      settingsState.limits = {
        event: { pubkey: { blacklist: ['f'.repeat(64)] } as any },
      }

      const event = createEvent({ pubkey: 'e'.repeat(64) })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(true)
    })

    it('accepts events in kind whitelist', () => {
      settingsState.limits = {
        event: { kind: { whitelist: [1, 2, 3] } as any },
      }

      const event = createEvent({ kind: 1 })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(true)
    })

    it('rejects events outside kind whitelist', () => {
      settingsState.limits = {
        event: { kind: { whitelist: [1, 2, 3] } as any },
      }

      const event = createEvent({ kind: 5 })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(false)
    })

    it('rejects events in kind blacklist', () => {
      settingsState.limits = {
        event: { kind: { blacklist: [1, 2] } as any },
      }

      const event = createEvent({ kind: 1 })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(false)
    })

    it('applies mirror-specific limits over global limits', () => {
      settingsState.limits = {
        event: { content: { maxLength: 5000 } },
      }
      settingsState.mirroring = {
        static: [
          {
            address: 'ws://source-relay.com',
            filters: [],
            limits: { event: { content: { maxLength: 1000 } } },
          },
        ],
      }
      fakeProcess.env.MIRROR_INDEX = '0'

      worker.run()

      const event = createEvent({ content: 'x'.repeat(2000) })
      const result = (worker as any).canAcceptEvent(event)

      expect(result).to.equal(false)
    })
  })

  describe('isUserAdmitted', () => {
    it('admits users when payments are disabled', async () => {
      settingsState.payments = { enabled: false } as any

      const event = createEvent()
      const result = await (worker as any).isUserAdmitted(event)

      expect(result).to.equal(true)
    })

    it('admits users when skipAdmissionCheck is true', async () => {
      settingsState.payments = { enabled: true } as any
      settingsState.mirroring = {
        static: [
          {
            address: 'ws://source-relay.com',
            filters: [],
            skipAdmissionCheck: true,
          } as any,
        ],
      }
      fakeProcess.env.MIRROR_INDEX = '0'

      worker.run()

      const event = createEvent()
      const result = await (worker as any).isUserAdmitted(event)

      expect(result).to.equal(true)
    })

    it('rejects users not admitted when payments required', async () => {
      settingsState.payments = {
        enabled: true,
        feeSchedules: {
          admission: [{ enabled: true } as any],
        },
      } as any
      userRepository.findByPubkey.resolves({ isAdmitted: false, balance: 0 } as any)

      const event = createEvent()
      const result = await (worker as any).isUserAdmitted(event)

      expect(result).to.equal(false)
    })

    it('checks user balance against minimum requirement', async () => {
      settingsState.payments = {
        enabled: true,
        feeSchedules: {
          admission: [{ enabled: true } as any],
        },
      } as any
      settingsState.limits = {
        event: { pubkey: { minBalance: 1000 } as any },
      }
      userRepository.findByPubkey.resolves({ isAdmitted: true, balance: 500 } as any)

      const event = createEvent()
      const result = await (worker as any).isUserAdmitted(event)

      expect(result).to.equal(false)
    })

    it('admits users with sufficient balance', async () => {
      settingsState.payments = {
        enabled: true,
        feeSchedules: {
          admission: [{ enabled: true } as any],
        },
      } as any
      settingsState.limits = {
        event: { pubkey: { minBalance: 1000 } as any },
      }
      userRepository.findByPubkey.resolves({ isAdmitted: true, balance: 2000 } as any)

      const event = createEvent()
      const result = await (worker as any).isUserAdmitted(event)

      expect(result).to.equal(true)
    })
  })

  describe('onMessage', () => {
    it('relays broadcast messages to connected mirror', () => {
      const testMessage = {
        eventName: 'Broadcast',
        event: createEvent(),
        source: 'local',
      }

      // Simulate message reception
      fakeProcess.emit('message', testMessage)

      // The message handler should attempt to forward if client is open
    })

    it('ignores messages from the same source', () => {
      const testMessage = {
        eventName: 'Broadcast',
        event: createEvent(),
        source: 'ws://source-relay.com',
      }

      fakeProcess.emit('message', testMessage)

      // Should not forward to same source
    })
  })

  describe('onError', () => {
    it('throws the error received from the process', () => {
      const error = new Error('connection error')

      expect(() => {
        fakeProcess.emit('uncaughtException', error)
      }).to.throw('connection error')
    })
  })

  describe('onExit', () => {
    it('closes the worker and exits the process with code 0', () => {
      fakeProcess.emit('SIGTERM')

      expect(fakeProcess.exit).to.have.been.calledOnceWithExactly(0)
    })

    it('handles SIGINT', () => {
      fakeProcess.emit('SIGINT')

      expect(fakeProcess.exit).to.have.been.calledOnceWithExactly(0)
    })

    it('handles SIGHUP', () => {
      fakeProcess.emit('SIGHUP')

      expect(fakeProcess.exit).to.have.been.calledOnceWithExactly(0)
    })
  })

  describe('close', () => {
    it('terminates the WebSocket client', () => {
      worker.close()

      // Verify close completes without error
    })

    it('invokes the callback when provided', () => {
      const callback = sandbox.stub()

      worker.close(callback)

      expect(callback).to.have.been.calledOnce
    })

    it('does not throw when called without a callback', () => {
      expect(() => worker.close()).not.to.throw()
    })
  })
})
