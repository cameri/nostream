import chai from 'chai'
import Sinon from 'sinon'

import { ICacheAdapter } from '../../../src/@types/adapters'
import { OperatorNotificationEventType } from '../../../src/@types/operator-notifications'
import { notifyProbeRunTransition } from '../../../src/utils/ops-trust-notifications'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const enqueueModule = require('../../../src/utils/operator-notification-enqueue')

const { expect } = chai

const createCacheStub = (overrides: Partial<ICacheAdapter> = {}): ICacheAdapter => ({
  getKey: async () => '',
  hasKey: async () => false,
  setKey: async () => true,
  setKeyIfNotExists: async () => true,
  addToSortedSet: async () => 1,
  removeRangeByScoreFromSortedSet: async () => 0,
  removeRangeByRankFromSortedSet: async () => 0,
  getRangeFromSortedSet: async () => [],
  setKeyExpiry: async () => {},
  deleteKey: async () => 1,
  getHKey: async () => '',
  setHKey: async () => true,
  addToSet: async () => 1,
  getSetMembers: async () => [],
  eval: async () => '',
  ...overrides,
})

describe('ops-trust-notifications', () => {
  afterEach(() => {
    Sinon.restore()
  })

  // The cache runs two scripts: the transition (5 args) and the finish (3 args).
  const createScriptCache = (options: {
    transition?: string | string[]
    parked?: string | undefined
    finishRejects?: boolean
  }) => {
    const transitions = Array.isArray(options.transition) ? [...options.transition] : [options.transition ?? '']
    const evalStub = Sinon.stub().callsFake(async (_script: string, _keys: string[], args: string[]) => {
      if (args.length === 5) {
        return transitions.length > 1 ? transitions.shift() : transitions[0]
      }
      if (options.finishRejects) {
        throw new Error('redis down')
      }
      return options.parked ?? ''
    })

    return { cache: createCacheStub({ eval: evalStub }), evalStub }
  }

  const transitionCalls = (evalStub: Sinon.SinonStub) => evalStub.getCalls().filter((call) => call.args[2].length === 5)
  const finishCalls = (evalStub: Sinon.SinonStub) => evalStub.getCalls().filter((call) => call.args[2].length === 3)

  it('enqueues probe failed alerts from atomic transition action', async () => {
    const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
    const { cache } = createScriptCache({ transition: 'failed' })

    await notifyProbeRunTransition(cache, {
      runAt: new Date().toISOString(),
      targets: ['wss://relay.example'],
      results: [],
      status: 'failed',
    })

    expect(enqueue.calledOnce).to.equal(true)
    expect(enqueue.firstCall.args[0]).to.equal(OperatorNotificationEventType.PROBE_FAILED)
  })

  describe('probe transition alert delivery', () => {
    const snapshot = {
      runAt: new Date().toISOString(),
      targets: ['wss://relay.example'],
      results: [],
      status: 'failed' as const,
    }

    it('records the new status only after the alert is stored, under the claim token', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const { cache, evalStub } = createScriptCache({ transition: 'failed' })

      await notifyProbeRunTransition(cache, snapshot)

      const token = transitionCalls(evalStub)[0].args[2][3]
      const finish = finishCalls(evalStub)
      expect(token).to.be.a('string').and.not.equal('')
      expect(finish).to.have.length(1)
      expect(finish[0].args[2]).to.deep.equal([token, 'failed', String(86400 * 30)])
    })

    it('does not record the status when the alert could not be stored, so the next run retries it', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(false)
      const { cache, evalStub } = createScriptCache({ transition: 'failed' })

      await notifyProbeRunTransition(cache, snapshot)

      const finish = finishCalls(evalStub)
      expect(finish).to.have.length(1)
      expect(finish[0].args[2][1]).to.equal('')
    })

    it('does not record the status when storing the alert throws, and still releases the claim', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').rejects(new Error('db down'))
      const { cache, evalStub } = createScriptCache({ transition: 'recovered' })

      await notifyProbeRunTransition(cache, { ...snapshot, status: 'ok' })

      const finish = finishCalls(evalStub)
      expect(finish).to.have.length(1)
      expect(finish[0].args[2][1]).to.equal('')
    })

    it('sends the recovered alert and records the status', async () => {
      const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const { cache, evalStub } = createScriptCache({ transition: 'recovered' })

      await notifyProbeRunTransition(cache, { ...snapshot, status: 'ok' })

      expect(enqueue.firstCall.args[0]).to.equal(OperatorNotificationEventType.PROBE_RECOVERED)
      expect(finishCalls(evalStub)[0].args[2][1]).to.equal('ok')
    })

    it('neither alerts nor claims when the transition script returns no action', async () => {
      const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const { cache, evalStub } = createScriptCache({ transition: '' })

      await notifyProbeRunTransition(cache, snapshot)

      expect(enqueue.called).to.equal(false)
      expect(finishCalls(evalStub)).to.have.length(0)
    })

    it('passes the keys, the ttls, a claim token and the result to the transition script', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const { cache, evalStub } = createScriptCache({ transition: '' })

      await notifyProbeRunTransition(cache, snapshot)

      const call = transitionCalls(evalStub)[0]
      expect(call.args[1]).to.deep.equal([
        'admin:trust:probe:last_status',
        'admin:trust:probe:alert_claim',
        'admin:trust:probe:pending',
      ])
      expect(call.args[2].slice(0, 3)).to.deep.equal(['failed', String(86400 * 30), '60'])
      expect(JSON.parse(call.args[2][4])).to.deep.equal({
        status: 'failed',
        runAt: snapshot.runAt,
        targets: snapshot.targets,
      })
    })

    it('uses a different claim token for each run', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const first = createScriptCache({ transition: '' })
      const second = createScriptCache({ transition: '' })

      await notifyProbeRunTransition(first.cache, snapshot)
      await notifyProbeRunTransition(second.cache, snapshot)

      expect(transitionCalls(first.evalStub)[0].args[2][3]).to.not.equal(transitionCalls(second.evalStub)[0].args[2][3])
    })

    it('handles a result that another run parked while this one held the claim', async () => {
      const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const parked = JSON.stringify({ status: 'ok', runAt: 'newer', targets: ['wss://relay.example'] })
      const transitions = ['failed', 'recovered']
      const finishes = [parked, '']
      const evalStub = Sinon.stub().callsFake(async (_script: string, _keys: string[], args: string[]) =>
        args.length === 5 ? transitions.shift() : (finishes.shift() ?? ''),
      )

      await notifyProbeRunTransition(createCacheStub({ eval: evalStub }), snapshot)

      expect(enqueue.callCount).to.equal(2)
      expect(enqueue.firstCall.args[0]).to.equal(OperatorNotificationEventType.PROBE_FAILED)
      expect(enqueue.secondCall.args[0]).to.equal(OperatorNotificationEventType.PROBE_RECOVERED)
      expect(enqueue.secondCall.args[1]).to.include({ runAt: 'newer', status: 'ok' })
    })

    it('ignores an unreadable parked result', async () => {
      const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const { cache } = createScriptCache({ transition: 'failed', parked: 'not json' })

      await notifyProbeRunTransition(cache, snapshot)

      expect(enqueue.callCount).to.equal(1)
    })

    it('stops after a bounded number of parked results', async () => {
      const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const parked = JSON.stringify({ status: 'failed', runAt: 'again', targets: [] })
      const { cache } = createScriptCache({ transition: 'failed', parked })

      await notifyProbeRunTransition(cache, snapshot)

      expect(enqueue.callCount).to.equal(3)
    })

    it('does not throw when releasing the claim fails', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const { cache } = createScriptCache({ transition: 'failed', finishRejects: true })

      await notifyProbeRunTransition(cache, snapshot)
    })
  })
})
