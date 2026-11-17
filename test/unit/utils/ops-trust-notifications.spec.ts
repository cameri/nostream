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

  it('enqueues probe failed alerts from atomic transition action', async () => {
    const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
    const cache = createCacheStub({
      eval: async () => 'failed',
    })

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

    it('records the new status only after the alert is stored', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const setKey = Sinon.stub().resolves(true)
      const deleteKey = Sinon.stub().resolves(1)
      const cache = createCacheStub({ eval: async () => 'failed', setKey, deleteKey })

      await notifyProbeRunTransition(cache, snapshot)

      expect(setKey.calledOnceWith('admin:trust:probe:last_status', 'failed')).to.equal(true)
      expect(deleteKey.calledOnceWith('admin:trust:probe:alert_claim')).to.equal(true)
    })

    it('does not record the status when the alert could not be stored, so the next run retries it', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(false)
      const setKey = Sinon.stub().resolves(true)
      const deleteKey = Sinon.stub().resolves(1)
      const cache = createCacheStub({ eval: async () => 'failed', setKey, deleteKey })

      await notifyProbeRunTransition(cache, snapshot)

      expect(setKey.called).to.equal(false)
      expect(deleteKey.calledOnceWith('admin:trust:probe:alert_claim')).to.equal(true)
    })

    it('does not record the status when storing the alert throws, and still releases the claim', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').rejects(new Error('db down'))
      const setKey = Sinon.stub().resolves(true)
      const deleteKey = Sinon.stub().resolves(1)
      const cache = createCacheStub({ eval: async () => 'recovered', setKey, deleteKey })

      await notifyProbeRunTransition(cache, { ...snapshot, status: 'ok' })

      expect(setKey.called).to.equal(false)
      expect(deleteKey.calledOnceWith('admin:trust:probe:alert_claim')).to.equal(true)
    })

    it('sends the recovered alert and records the status', async () => {
      const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const setKey = Sinon.stub().resolves(true)
      const cache = createCacheStub({ eval: async () => 'recovered', setKey })

      await notifyProbeRunTransition(cache, { ...snapshot, status: 'ok' })

      expect(enqueue.firstCall.args[0]).to.equal(OperatorNotificationEventType.PROBE_RECOVERED)
      expect(setKey.calledOnceWith('admin:trust:probe:last_status', 'ok')).to.equal(true)
    })

    it('neither alerts nor claims when the transition script returns no action', async () => {
      const enqueue = Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const setKey = Sinon.stub().resolves(true)
      const deleteKey = Sinon.stub().resolves(1)
      const cache = createCacheStub({ eval: async () => '', setKey, deleteKey })

      await notifyProbeRunTransition(cache, snapshot)

      expect(enqueue.called).to.equal(false)
      expect(setKey.called).to.equal(false)
      expect(deleteKey.called).to.equal(false)
    })

    it('passes the status key, the claim key and the claim ttl to the script', async () => {
      Sinon.stub(enqueueModule, 'enqueueOperatorNotification').resolves(true)
      const evalStub = Sinon.stub().resolves('')
      const cache = createCacheStub({ eval: evalStub })

      await notifyProbeRunTransition(cache, snapshot)

      expect(evalStub.firstCall.args[1]).to.deep.equal(['admin:trust:probe:last_status', 'admin:trust:probe:alert_claim'])
      expect(evalStub.firstCall.args[2]).to.deep.equal(['failed', String(86400 * 30), '60'])
    })
  })
})
