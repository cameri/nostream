import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { isAdminRateLimited } from '../../../src/utils/admin-rate-limit'

chai.use(sinonChai)
const { expect } = chai

describe('isAdminRateLimited', () => {
  const baseSettings = {
    network: {
      remoteIpHeader: 'x-forwarded-for',
    },
    limits: {
      admin: {
        rateLimits: [{ rate: 30, period: 60000 }],
        loginRateLimits: [{ rate: 10, period: 900000 }],
        ipWhitelist: [],
      },
    },
  }

  const makeRequest = (remoteAddress = '1.2.3.4') =>
    ({
      headers: {},
      connection: { remoteAddress },
      socket: { remoteAddress },
    }) as any

  it('returns false when no rate limits are configured', async () => {
    const rateLimiter = { hit: sinon.stub().resolves(false) }
    const settings = { ...baseSettings, limits: { admin: { ipWhitelist: [] } } }

    const limited = await isAdminRateLimited(makeRequest(), settings as any, () => rateLimiter, 'admin')

    expect(limited).to.equal(false)
    expect(rateLimiter.hit).not.to.have.been.called
  })

  it('returns true when login rate limit is exceeded', async () => {
    const rateLimiter = { hit: sinon.stub().resolves(true) }

    const limited = await isAdminRateLimited(makeRequest(), baseSettings as any, () => rateLimiter, 'login')

    expect(limited).to.equal(true)
    expect(rateLimiter.hit).to.have.been.calledOnceWithExactly('1.2.3.4:admin-login:900000', 1, {
      period: 900000,
      rate: 10,
    })
  })

  it('returns true when admin route rate limit is exceeded', async () => {
    const rateLimiter = { hit: sinon.stub().resolves(true) }

    const limited = await isAdminRateLimited(makeRequest(), baseSettings as any, () => rateLimiter, 'admin')

    expect(limited).to.equal(true)
    expect(rateLimiter.hit).to.have.been.calledOnceWithExactly('1.2.3.4:admin-admin:60000', 1, {
      period: 60000,
      rate: 30,
    })
  })
})
