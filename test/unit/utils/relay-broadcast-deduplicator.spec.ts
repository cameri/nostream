import chai from 'chai'
import sinon from 'sinon'

import { RelayBroadcastDeduplicator } from '../../../src/utils/relay-broadcast-deduplicator'

const { expect } = chai

describe('RelayBroadcastDeduplicator', () => {
  let clock: sinon.SinonFakeTimers

  beforeEach(() => {
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
  })

  it('tracks event ids for the configured ttl', () => {
    const deduplicator = new RelayBroadcastDeduplicator(1000)

    deduplicator.mark('abc')
    expect(deduplicator.has('abc')).to.equal(true)

    clock.tick(1001)
    expect(deduplicator.has('abc')).to.equal(false)
  })
})
