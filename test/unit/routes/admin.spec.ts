import axios from 'axios'
import { expect } from 'chai'
import express from 'express'
import Sinon from 'sinon'

import * as getAdminHealthControllerFactory from '../../../src/factories/controllers/get-admin-health-controller-factory'
import { hashAdminPassword } from '../../../src/utils/admin-password'
import * as adminRateLimitMiddleware from '../../../src/handlers/request-handlers/admin-rate-limit-middleware'
import * as rateLimiterMiddleware from '../../../src/handlers/request-handlers/rate-limiter-middleware'
import * as settingsFactory from '../../../src/factories/settings-factory'

describe('admin router', () => {
  const originalSecret = process.env.SECRET
  const originalAdminPassword = process.env.ADMIN_PASSWORD
  let createGetAdminHealthControllerStub: Sinon.SinonStub
  let createSettingsStub: Sinon.SinonStub
  let rateLimiterMiddlewareStub: Sinon.SinonStub
  let adminRateLimitMiddlewareStub: Sinon.SinonStub
  let adminLoginRateLimitMiddlewareStub: Sinon.SinonStub
  let server: any

  const loadAdminRouter = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    delete require.cache[require.resolve('../../../src/routes/admin/index')]
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    delete require.cache[require.resolve('../../../src/routes/admin')]
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../../src/routes/admin').default
  }

  const startServer = async (settings: Record<string, unknown>) => {
    createGetAdminHealthControllerStub = Sinon.stub(getAdminHealthControllerFactory, 'createGetAdminHealthController').returns({
      handleRequest: async (_request: any, response: any) => {
        response
          .status(200)
          .setHeader('content-type', 'application/json')
          .send(
            JSON.stringify({
              status: 'ok',
              uptimeSeconds: 1,
              worker: { type: 'primary' },
              database: { ok: true },
              redis: { ok: true },
            }),
          )
      },
    } as any)
    createSettingsStub = Sinon.stub(settingsFactory, 'createSettings').returns(settings as any)
    const passthrough = async (_request: any, _response: any, next: any) => {
      next()
    }
    rateLimiterMiddlewareStub = Sinon.stub(rateLimiterMiddleware, 'rateLimiterMiddleware').callsFake(passthrough)
    adminRateLimitMiddlewareStub = Sinon.stub(adminRateLimitMiddleware, 'adminRateLimitMiddleware').callsFake(passthrough)
    adminLoginRateLimitMiddlewareStub = Sinon.stub(adminRateLimitMiddleware, 'adminLoginRateLimitMiddleware').callsFake(passthrough)
    const router = loadAdminRouter()
    const app = express()
    app.use('/admin', router)

    server = await new Promise((resolve) => {
      const listeningServer = app.listen(0, () => resolve(listeningServer))
    })

    return `http://127.0.0.1:${server.address().port}/admin`
  }

  const stopServer = async () => {
    createGetAdminHealthControllerStub?.restore()
    createSettingsStub?.restore()
    rateLimiterMiddlewareStub?.restore()
    adminRateLimitMiddlewareStub?.restore()
    adminLoginRateLimitMiddlewareStub?.restore()
    delete require.cache[require.resolve('../../../src/routes/admin/index')]
    delete require.cache[require.resolve('../../../src/routes/admin')]

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
      server = undefined
    }
  }

  before(() => {
    process.env.SECRET = 'test-admin-secret-value'
  })

  after(() => {
    if (originalSecret === undefined) {
      delete process.env.SECRET
    } else {
      process.env.SECRET = originalSecret
    }

    if (originalAdminPassword === undefined) {
      delete process.env.ADMIN_PASSWORD
    } else {
      process.env.ADMIN_PASSWORD = originalAdminPassword
    }
  })

  afterEach(async () => {
    delete process.env.ADMIN_PASSWORD
    await stopServer()
  })

  it('returns 404 when admin is disabled', async () => {
    const baseUrl = await startServer({ admin: { enabled: false } })

    const response = await axios.get(`${baseUrl}/health`, { validateStatus: () => true })

    expect(response.status).to.equal(404)
    expect(response.data).to.equal('Not Found')
  })

  it('returns 401 for protected routes without a session', async () => {
    const baseUrl = await startServer({ admin: { enabled: true } })

    const sessionResponse = await axios.get(`${baseUrl}/session`, { validateStatus: () => true })
    const healthResponse = await axios.get(`${baseUrl}/health`, { validateStatus: () => true })

    expect(sessionResponse.status).to.equal(401)
    expect(healthResponse.status).to.equal(401)
  })

  it('rejects invalid login credentials', async () => {
    process.env.ADMIN_PASSWORD = 'correct-password'
    const baseUrl = await startServer({ admin: { enabled: true } })

    const response = await axios.post(
      `${baseUrl}/login`,
      { password: 'wrong-password' },
      {
        headers: { 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )

    expect(response.status).to.equal(401)
  })

  it('authenticates with ADMIN_PASSWORD and exposes session and health', async () => {
    process.env.ADMIN_PASSWORD = 'correct-password'
    const baseUrl = await startServer({ admin: { enabled: true, sessionTtlSeconds: 3600 } })

    const loginResponse = await axios.post(
      `${baseUrl}/login`,
      { password: 'correct-password' },
      {
        headers: { 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )

    expect(loginResponse.status).to.equal(200)
    expect(loginResponse.data.authenticated).to.equal(true)
    expect(loginResponse.data.expiresAt).to.be.a('number')
    expect(loginResponse.headers['set-cookie']?.[0]).to.include('admin_session=')

    const cookie = loginResponse.headers['set-cookie']?.[0]?.split(';')[0]

    const sessionResponse = await axios.get(`${baseUrl}/session`, {
      headers: { cookie },
      validateStatus: () => true,
    })
    expect(sessionResponse.status).to.equal(200)
    expect(sessionResponse.data.authenticated).to.equal(true)

    const healthResponse = await axios.get(`${baseUrl}/health`, {
      headers: { cookie },
      validateStatus: () => true,
    })
    expect(healthResponse.status).to.equal(200)
    expect(healthResponse.data).to.include.keys('status', 'uptimeSeconds', 'worker', 'database', 'redis')
  })

  it('authenticates with passwordHash from settings', async () => {
    const passwordHash = hashAdminPassword('settings-password')
    const baseUrl = await startServer({
      admin: { enabled: true, passwordHash, sessionTtlSeconds: 3600 },
    })

    const loginResponse = await axios.post(
      `${baseUrl}/login`,
      { password: 'settings-password' },
      {
        headers: { 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )

    expect(loginResponse.status).to.equal(200)

    const token = loginResponse.headers['set-cookie']?.[0]?.split(';')[0]?.split('=')[1]
    const sessionResponse = await axios.get(`${baseUrl}/session`, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    })

    expect(sessionResponse.status).to.equal(200)
  })
})
