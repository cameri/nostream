import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { Settings } from '../../../src/@types/settings'
import { getPeerRequestRetryAfterMs } from '../../../src/utils/peer-requests'

chai.use(sinonChai)
const { expect } = chai

describe('peer on-demand request limits', () => {
  let sandbox: Sinon.SinonSandbox
  let hit: Sinon.SinonStub
  const factory = () => ({ hit })

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    hit = sandbox.stub().resolves({ limited: false })
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('does nothing when no peer request limits are configured', async () => {
    const retryAfter = await getPeerRequestRetryAfterMs(factory, {} as Settings, 'a'.repeat(64), 'REQ')

    expect(retryAfter).to.equal(undefined)
    expect(hit).not.to.have.been.called
  })

  it('allows a request under the limit', async () => {
    const retryAfter = await getPeerRequestRetryAfterMs(
      factory,
      { limits: { peer: { request: { rateLimits: [{ period: 60_000, rate: 2 }] } } } } as Settings,
      'a'.repeat(64),
      'REQ',
    )

    expect(retryAfter).to.equal(undefined)
    expect(hit).to.have.been.calledOnceWithExactly('a'.repeat(64) + ':peer-request:60000', 1, {
      period: 60_000,
      rate: 2,
    })
  })

  it('returns the limiter retry-after when refused', async () => {
    hit.resolves({ limited: true, retryAfterMs: 250 })

    const retryAfter = await getPeerRequestRetryAfterMs(
      factory,
      { limits: { peer: { request: { rateLimits: [{ period: 60_000, rate: 1 }] } } } } as Settings,
      'a'.repeat(64),
      'NEG-OPEN',
    )

    expect(retryAfter).to.equal(250)
  })

  it('fails closed when the limiter is unavailable', async () => {
    hit.rejects(new Error('redis down'))

    const retryAfter = await getPeerRequestRetryAfterMs(
      factory,
      { limits: { peer: { request: { rateLimits: [{ period: 60_000, rate: 1 }] } } } } as Settings,
      'a'.repeat(64),
      'COUNT',
    )

    expect(retryAfter).to.equal(60_000)
  })
})
