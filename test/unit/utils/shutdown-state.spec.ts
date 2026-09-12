import chai from 'chai'

import {
  beginDraining,
  getWsDrainTimeoutMs,
  isDraining,
  resetDrainingState,
} from '../../../src/utils/shutdown-state'

const { expect } = chai

describe('shutdown-state', () => {
  const originalTimeout = process.env.WS_DRAIN_TIMEOUT_MS

  afterEach(() => {
    resetDrainingState()
    if (originalTimeout === undefined) {
      delete process.env.WS_DRAIN_TIMEOUT_MS
    } else {
      process.env.WS_DRAIN_TIMEOUT_MS = originalTimeout
    }
  })

  it('tracks draining state', () => {
    expect(isDraining()).to.equal(false)
    beginDraining()
    expect(isDraining()).to.equal(true)
  })

  it('defaults WS drain timeout to 30s', () => {
    delete process.env.WS_DRAIN_TIMEOUT_MS
    expect(getWsDrainTimeoutMs()).to.equal(30_000)
  })

  it('reads WS drain timeout from env', () => {
    process.env.WS_DRAIN_TIMEOUT_MS = '5000'
    expect(getWsDrainTimeoutMs()).to.equal(5000)
  })

  it('falls back to default for invalid WS drain timeout', () => {
    process.env.WS_DRAIN_TIMEOUT_MS = 'invalid'
    expect(getWsDrainTimeoutMs()).to.equal(30_000)
  })
})
