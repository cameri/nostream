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

  // The cache runs two scripts: the transition script and the finish script (record, hand over or release).
  const isTransitionScript = (script: string) => script.includes('local holder')

  const createScriptCache = (options: {
    transition?: string | string[]
    parked?: string | undefined | (string | undefined)[]
    finishRejects?: boolean
  }) => {
    const transitions = Array.isArray(options.transition) ? [...options.transition] : [options.transition ?? '']
    const parkedResults = Array.isArray(options.parked) ? [...options.parked] : undefined
    const evalStub = Sinon.stub().callsFake(async (script: string) => {
      if (isTransitionScript(script)) {
        return transitions.length > 1 ? transitions.shift() : transitions[0]
      }
      if (options.finishRejects) {
        throw new Error('redis down')
      }
      return parkedResults ? (parkedResults.shift() ?? '') : (options.parked ?? '')
    })

    return { cache: createCacheStub({ eval: evalStub }), evalStub }
  }

  const transitionCalls = (evalStub: Sinon.SinonStub) =>
    evalStub.getCalls().filter((call) => isTransitionScript(call.args[0]))
  const finishCalls = (evalStub: Sinon.SinonStub) =>
    evalStub.getCalls().filter((call) => !isTransitionScript(call.args[0]))

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
      expect(finish[0].args[2]).to.deep.equal([token, 'failed', String(86400 * 30), '60', '1'])
    })

    it('does not record the status when the alert could not be stored, so the next run retries it', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(false)
      const { cache, evalStub } = createScriptCache({ transition: 'failed' })

      await notifyProbeRunTransition(cache, snapshot)

      const finish = finishCalls(evalStub)
      expect(finish).to.have.length(1)
      expect(finish[0].args[2][1]).to.equal('')
    })

    it('does not record the status when storing the alert throws, and still lets go of the claim', async () => {
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

    it('neither alerts nor finishes when the transition script returns no action and no claim is held', async () => {
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

    it('handles a parked result while still holding the claim, in the order observed', async () => {
      const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const parked = JSON.stringify({ status: 'ok', runAt: 'newer', targets: ['wss://relay.example'] })
      const { cache, evalStub } = createScriptCache({
        transition: ['failed', 'recovered'],
        parked: [parked, undefined],
      })

      await notifyProbeRunTransition(cache, snapshot)

      expect(enqueue.callCount).to.equal(2)
      expect(enqueue.firstCall.args[0]).to.equal(OperatorNotificationEventType.PROBE_FAILED)
      expect(enqueue.secondCall.args[0]).to.equal(OperatorNotificationEventType.PROBE_RECOVERED)
      expect(enqueue.secondCall.args[1]).to.include({ runAt: 'newer', status: 'ok' })

      // The same token is used for the whole chain, so the claim is never given up in between.
      const tokens = transitionCalls(evalStub).map((call) => call.args[2][3])
      expect(new Set(tokens).size).to.equal(1)
      const finish = finishCalls(evalStub)
      expect(finish).to.have.length(2)
      expect(finish.every((call) => call.args[2][0] === tokens[0])).to.equal(true)
    })

    it('lets go of the claim after a parked result that needs no alert', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const parked = JSON.stringify({ status: 'failed', runAt: 'newer', targets: [] })
      const { cache, evalStub } = createScriptCache({ transition: ['failed', ''], parked: [parked, undefined] })

      await notifyProbeRunTransition(cache, snapshot)

      expect(finishCalls(evalStub)).to.have.length(2)
      expect(transitionCalls(evalStub)).to.have.length(2)
    })

    it('ignores an unreadable parked result', async () => {
      const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const { cache } = createScriptCache({ transition: 'failed', parked: 'not json' })

      await notifyProbeRunTransition(cache, snapshot)

      expect(enqueue.callCount).to.equal(1)
    })

    it('stops after a bounded number of parked results and then lets go without handing over', async () => {
      const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const parked = JSON.stringify({ status: 'failed', runAt: 'again', targets: [] })
      const { cache, evalStub } = createScriptCache({ transition: 'failed', parked })

      await notifyProbeRunTransition(cache, snapshot)

      expect(enqueue.callCount).to.equal(10)
      const finish = finishCalls(evalStub)
      expect(finish.slice(0, -1).every((call) => call.args[2][4] === '1')).to.equal(true)
      expect(finish[finish.length - 1].args[2][4]).to.equal('0')
    })

    it('does not throw when finishing fails', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const { cache } = createScriptCache({ transition: 'failed', finishRejects: true })

      await notifyProbeRunTransition(cache, snapshot)
    })
  })
})
