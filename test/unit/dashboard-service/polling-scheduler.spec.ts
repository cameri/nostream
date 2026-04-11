import { expect } from 'chai'
import Sinon from 'sinon'

import { PollingScheduler } from '../../../src/dashboard-service/polling/polling-scheduler'

describe('PollingScheduler', () => {
  let clock: Sinon.SinonFakeTimers

  beforeEach(() => {
    clock = Sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
  })

  /**
   * The scheduler uses recursive setTimeout (not setInterval), so each tick
   * is only enqueued after the previous one resolves.  With instant-resolving
   * stubs the sequence is:
   *   T=0     start() → schedules tick at T=1000
   *   T=1000  tick #1 resolves → schedules tick at T=2000
   *   T=2000  tick #2 resolves → schedules tick at T=3000
   *   T=3000  tick #3 resolves → schedules tick at T=4000
   * tickAsync drives the microtask queue between timer firings, so all three
   * ticks complete inside tickAsync(3000).
   */
  it('runs tick callback on interval while running', async () => {
    const tick = Sinon.stub().resolves(undefined)
    const scheduler = new PollingScheduler(1000, tick)

    scheduler.start()
    await clock.tickAsync(3000)

    expect(tick.callCount).to.equal(3)
    scheduler.stop()
  })

  it('stops running when stop is called', async () => {
    const tick = Sinon.stub().resolves(undefined)
    const scheduler = new PollingScheduler(500, tick)

    scheduler.start()
    await clock.tickAsync(1000)   // ticks at 500ms, 1000ms → 2 calls
    scheduler.stop()
    await clock.tickAsync(1000)   // no more ticks after stop

    expect(tick.callCount).to.equal(2)
  })

  it('does not overlap ticks when callback is slow', async () => {
    // Tick takes 1500ms — longer than the 1000ms interval.
    // With setInterval this would cause overlap; with recursive setTimeout it must not.
    let running = 0
    let maxConcurrent = 0

    const tick = Sinon.stub().callsFake(async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await clock.tickAsync(1500)
      running--
    })

    const scheduler = new PollingScheduler(1000, tick)
    scheduler.start()
    // Drive enough time for two potential overlapping cycles
    await clock.tickAsync(4000)
    scheduler.stop()

    expect(maxConcurrent).to.equal(1, 'ticks must not run concurrently')
  })

  it('continues scheduling after a failed tick', async () => {
    const tick = Sinon.stub()
      .onFirstCall().rejects(new Error('transient error'))
      .resolves(undefined)

    const scheduler = new PollingScheduler(1000, tick)
    scheduler.start()
    await clock.tickAsync(3000)
    scheduler.stop()

    // First tick rejects, but the scheduler must recover and run two more.
    expect(tick.callCount).to.be.greaterThanOrEqual(2)
  })

  it('isRunning reflects scheduler state', () => {
    const tick = Sinon.stub().resolves(undefined)
    const scheduler = new PollingScheduler(1000, tick)

    expect(scheduler.isRunning()).to.equal(false)
    scheduler.start()
    expect(scheduler.isRunning()).to.equal(true)
    scheduler.stop()
    expect(scheduler.isRunning()).to.equal(false)
  })
})
