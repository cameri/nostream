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
})
