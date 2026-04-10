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
    await clock.tickAsync(1000)
    scheduler.stop()
    await clock.tickAsync(1000)

    expect(tick.callCount).to.equal(2)
  })
})
