import chai from 'chai'
import { Request, Response } from 'express'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { IAdminSessionRevocations } from '../../../src/@types/admin'
import { PasswordAdminAuthProvider } from '../../../src/admin/password-admin-auth-provider'
import { createAdminSessionToken } from '../../../src/utils/admin-session'

chai.use(sinonChai)

const { expect } = chai

class FakeRevocations implements IAdminSessionRevocations {
  public readonly revoked = new Map<string, number>()
  public failRevoke = false
  public failCheck = false

  public async revoke(sessionId: string, ttlSeconds: number): Promise<boolean> {
    if (this.failRevoke) {
      throw new Error('redis is down')
    }
    // Check and set in one step, like the cache does with SET NX.
    if (this.revoked.has(sessionId)) {
      return false
    }
    this.revoked.set(sessionId, ttlSeconds)
    return true
  }

  public async isRevoked(sessionId: string): Promise<boolean> {
    if (this.failCheck) {
      throw new Error('redis is down')
    }
    return this.revoked.has(sessionId)
  }
}

describe('PasswordAdminAuthProvider sessions', () => {
  const originalSecret = process.env.SECRET
  const originalPassword = process.env.ADMIN_PASSWORD
  const settings = () => ({ info: { relay_url: 'wss://relay.example.com' }, network: {}, admin: {} }) as any

  let sandbox: Sinon.SinonSandbox
  let revocations: FakeRevocations
  let audit: Sinon.SinonStub
  let provider: PasswordAdminAuthProvider

  before(() => {
    process.env.SECRET = 'test-admin-secret-value'
    process.env.ADMIN_PASSWORD = 'correct horse'
  })

  after(() => {
    if (originalSecret === undefined) {
      delete process.env.SECRET
    } else {
      process.env.SECRET = originalSecret
    }
    if (originalPassword === undefined) {
      delete process.env.ADMIN_PASSWORD
    } else {
      process.env.ADMIN_PASSWORD = originalPassword
    }
  })

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    revocations = new FakeRevocations()
    audit = sandbox.stub()
    provider = new PasswordAdminAuthProvider(settings, audit, revocations)
  })

  afterEach(() => {
    sandbox.restore()
  })

  const mockResponse = () => {
    const headers: Record<string, string> = {}
    const response = {
      statusCode: 0,
      body: undefined as unknown,
      headers,
      status(code: number) {
        response.statusCode = code
        return response
      },
      setHeader(name: string, value: string) {
        headers[name] = value
        return response
      },
      send(body: unknown) {
        response.body = body
        return response
      },
    }
    return response
  }

  const sessionIdOf = (token: string): string => token.split('.')[1]

  const requestWithToken = (token: string, via: 'cookie' | 'bearer' = 'cookie'): Request =>
    ({
      headers: via === 'cookie' ? { cookie: `admin_session=${token}` } : { authorization: `Bearer ${token}` },
      socket: { remoteAddress: '203.0.113.9' },
    }) as unknown as Request

  const login = async (): Promise<string> => {
    const response = mockResponse()
    await provider.handleLogin({ body: { password: 'correct horse' }, headers: {}, socket: {} } as any, response as any)

    expect(response.statusCode).to.equal(200)
    return /admin_session=([^;]+)/.exec(response.headers['Set-Cookie'])?.[1] as string
  }

  const logout = async (token: string, via: 'cookie' | 'bearer' = 'cookie') => {
    const response = mockResponse()
    await provider.handleLogout(requestWithToken(token, via), response as unknown as Response)
    return response
  }

  it('authenticates a token it has just issued', async () => {
    const token = await login()

    expect(await provider.isRequestAuthenticated(requestWithToken(token))).to.equal(true)
    expect(await provider.isRequestAuthenticated(requestWithToken(token, 'bearer'))).to.equal(true)
  })

  it('refuses a retained copy of the token once its owner has logged out', async () => {
    const token = await login()

    const response = await logout(token)

    expect(response.statusCode).to.equal(200)
    expect(response.headers['Set-Cookie']).to.match(/admin_session=;.*Max-Age=0/)
    expect(await provider.isRequestAuthenticated(requestWithToken(token))).to.equal(false)
    expect(await provider.isRequestAuthenticated(requestWithToken(token, 'bearer'))).to.equal(false)
  })

  it('keeps the revocation for as long as the token would have lasted', async () => {
    const token = await login()

    await logout(token)

    const [ttl] = [...revocations.revoked.values()]
    expect(ttl).to.be.within(86400, 86402)
  })

  it('ends only the session that logged out', async () => {
    const first = await login()
    const second = await login()

    await logout(first)

    expect(await provider.isRequestAuthenticated(requestWithToken(first))).to.equal(false)
    expect(await provider.isRequestAuthenticated(requestWithToken(second))).to.equal(true)
  })

  it('ends a session that logged in in the same second as another', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    const first = createAdminSessionToken(expiresAt)
    const second = createAdminSessionToken(expiresAt)

    await logout(first)

    expect(await provider.isRequestAuthenticated(requestWithToken(first))).to.equal(false)
    expect(await provider.isRequestAuthenticated(requestWithToken(second))).to.equal(true)
  })

  it('answers a second logout of the same token the same way', async () => {
    const token = await login()

    await logout(token)
    const again = await logout(token)

    expect(again.statusCode).to.equal(200)
    expect(await provider.isRequestAuthenticated(requestWithToken(token))).to.equal(false)
  })

  it('clears the cookie without revoking anything when there is no valid token', async () => {
    const forged = await logout(`${Math.floor(Date.now() / 1000) + 600}.${'0'.repeat(32)}.${'0'.repeat(64)}`)
    const none = mockResponse()
    await provider.handleLogout({ headers: {}, socket: {} } as any, none as any)

    expect(forged.statusCode).to.equal(200)
    expect(none.statusCode).to.equal(200)
    expect(none.headers['Set-Cookie']).to.match(/admin_session=;.*Max-Age=0/)
    expect(revocations.revoked.size).to.equal(0)
  })

  describe('the audit record of a logout', () => {
    it('is written for a request that presents a valid session, with that request', async () => {
      const token = await login()
      audit.resetHistory()
      const request = requestWithToken(token)

      await provider.handleLogout(request, mockResponse() as unknown as Response)

      expect(audit).to.have.been.calledOnceWithExactly('logout', request)
    })

    it('is also written when the session is presented as a Bearer token', async () => {
      const token = await login()
      audit.resetHistory()

      await logout(token, 'bearer')

      expect(audit).to.have.been.calledOnceWith('logout')
    })

    it('is not written for a request without a token', async () => {
      const response = mockResponse()

      await provider.handleLogout({ headers: {}, socket: {} } as any, response as any)

      expect(response.statusCode).to.equal(200)
      expect(response.headers['Set-Cookie']).to.match(/admin_session=;.*Max-Age=0/)
      expect(audit).not.to.have.been.calledWith('logout')
    })

    it('is not written for a token that was not signed by the relay', async () => {
      const response = await logout(`${Math.floor(Date.now() / 1000) + 600}.${'0'.repeat(32)}.${'0'.repeat(64)}`)

      expect(response.statusCode).to.equal(200)
      expect(response.headers['Set-Cookie']).to.match(/admin_session=;.*Max-Age=0/)
      expect(audit).not.to.have.been.calledWith('logout')
    })

    it('is not written for a malformed token', async () => {
      const response = await logout('abc.def')

      expect(response.statusCode).to.equal(200)
      expect(audit).not.to.have.been.calledWith('logout')
    })

    it('is not written for a token that has expired', async () => {
      const response = await logout(createAdminSessionToken(Math.floor(Date.now() / 1000) - 10))

      expect(response.statusCode).to.equal(200)
      expect(response.headers['Set-Cookie']).to.match(/admin_session=;.*Max-Age=0/)
      expect(audit).not.to.have.been.calledWith('logout')
    })

    it('is written once for the logout that ended the session, not again when the token is sent again', async () => {
      const token = await login()
      audit.resetHistory()

      const first = await logout(token)
      const replay = await logout(token)
      const another = await logout(token, 'bearer')

      expect(first.statusCode).to.equal(200)
      expect(replay.statusCode).to.equal(200)
      expect(replay.headers['Set-Cookie']).to.match(/admin_session=;.*Max-Age=0/)
      expect(another.statusCode).to.equal(200)
      expect(audit).to.have.been.calledOnceWith('logout')
    })

    it('is not written for a replay however many times it is sent', async () => {
      const token = await login()
      await logout(token)
      audit.resetHistory()

      for (let i = 0; i < 20; i++) {
        await logout(token)
      }

      expect(audit).not.to.have.been.called
    })

    it('is written once when the same session is logged out by several requests at the same time', async () => {
      const token = await login()
      audit.resetHistory()

      const responses = await Promise.all([logout(token), logout(token), logout(token), logout(token)])

      expect(responses.map((response) => response.statusCode)).to.deep.equal([200, 200, 200, 200])
      expect(audit).to.have.been.calledOnceWith('logout')
    })

    it('is not written for a session that was revoked elsewhere, for example by another worker', async () => {
      const token = await login()
      revocations.revoked.set(sessionIdOf(token), 3600)
      audit.resetHistory()

      const response = await logout(token)

      expect(response.statusCode).to.equal(200)
      expect(audit).not.to.have.been.called
    })

    it('is written again for a new session of the same administrator', async () => {
      const first = await login()
      await logout(first)
      const second = await login()
      audit.resetHistory()

      await logout(second)

      expect(audit).to.have.been.calledOnceWith('logout')
    })

    it('is not written once for every anonymous request, however many there are', async () => {
      for (let i = 0; i < 20; i++) {
        await provider.handleLogout({ headers: {}, socket: {} } as any, mockResponse() as any)
      }

      expect(audit).not.to.have.been.calledWith('logout')
    })
  })

  it('reports the logout to the audit hook only once the session is revoked', async () => {
    const token = await login()

    await logout(token)

    expect(audit).to.have.been.calledWith('logout')
  })

  it('answers 500 and clears the cookie when the session cannot be revoked', async () => {
    const token = await login()
    revocations.failRevoke = true

    const response = await logout(token)

    expect(response.statusCode).to.equal(500)
    expect(response.headers['Set-Cookie']).to.match(/admin_session=;.*Max-Age=0/)
    expect(audit).not.to.have.been.calledWith('logout')
  })

  it('refuses every token while the revocation list cannot be read', async () => {
    const token = await login()
    revocations.failCheck = true

    expect(await provider.isRequestAuthenticated(requestWithToken(token))).to.equal(false)
  })

  it('refuses a token that is invalid without asking the revocation list', async () => {
    const isRevoked = sandbox.spy(revocations, 'isRevoked')

    expect(await provider.isRequestAuthenticated({ headers: {} } as any)).to.equal(false)
    expect(await provider.isRequestAuthenticated(requestWithToken('abc.def'))).to.equal(false)
    expect(isRevoked).not.to.have.been.called
  })
})
