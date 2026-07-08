import { createHash } from 'crypto'
import axios from 'axios'
import { expect } from 'chai'
import express from 'express'
import Sinon from 'sinon'

import * as getAdminHealthControllerFactory from '../../../src/factories/controllers/get-admin-health-controller-factory'
import * as adminRateLimitMiddleware from '../../../src/handlers/request-handlers/admin-rate-limit-middleware'
import * as cacheClientModule from '../../../src/cache/client'
import * as rateLimiterMiddleware from '../../../src/handlers/request-handlers/rate-limiter-middleware'
import * as settingsFactory from '../../../src/factories/settings-factory'
import { EventKinds, EventTags } from '../../../src/constants/base'
import { getPublicKey, identifyEvent, signEvent } from '../../../src/utils/event'
import { Event } from '../../../src/@types/event'
import { Tag } from '../../../src/@types/base'
import { toBech32 } from '../../../src/utils/transform'

describe('admin router', () => {
  const originalSecret = process.env.SECRET
  const privkey = 'a'.repeat(64)
  const pubkey = getPublicKey(privkey)
  let createGetAdminHealthControllerStub: Sinon.SinonStub
  let createSettingsStub: Sinon.SinonStub
  let getCacheClientStub: Sinon.SinonStub
  let rateLimiterMiddlewareStub: Sinon.SinonStub
  let adminRateLimitMiddlewareStub: Sinon.SinonStub
  let adminLoginRateLimitMiddlewareStub: Sinon.SinonStub
  let server: any
  let seenReplayKeys: Set<string>

  // The auth middleware builds its provider at module load, capturing the
  // active createSettings and getCacheClient stubs, so these modules must be
  // re-required after each round of stubbing.
  const adminModulePaths = [
    '../../../src/routes/admin/index',
    '../../../src/handlers/request-handlers/admin-auth-middleware',
    '../../../src/factories/admin-auth-provider-factory',
  ]

  const bustAdminModules = () => {
    for (const modulePath of adminModulePaths) {
      delete require.cache[require.resolve(modulePath)]
    }
  }

  const loadAdminRouter = () => {
    bustAdminModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../../src/routes/admin/index').default
  }

  const startServer = async (settings: Record<string, unknown>) => {
    createGetAdminHealthControllerStub = Sinon.stub(
      getAdminHealthControllerFactory,
      'createGetAdminHealthController',
    ).returns({
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
    seenReplayKeys = new Set()
    getCacheClientStub = Sinon.stub(cacheClientModule, 'getCacheClient').returns({
      isOpen: true,
      set: async (key: string, _value: string, _options: unknown) => {
        if (seenReplayKeys.has(key)) {
          return null
        }
        seenReplayKeys.add(key)
        return 'OK'
      },
    } as any)
    const passthrough = async (_request: any, _response: any, next: any) => {
      next()
    }
    rateLimiterMiddlewareStub = Sinon.stub(rateLimiterMiddleware, 'rateLimiterMiddleware').callsFake(passthrough)
    adminRateLimitMiddlewareStub = Sinon.stub(adminRateLimitMiddleware, 'adminRateLimitMiddleware').callsFake(
      passthrough,
    )
    adminLoginRateLimitMiddlewareStub = Sinon.stub(adminRateLimitMiddleware, 'adminLoginRateLimitMiddleware').callsFake(
      passthrough,
    )
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
    getCacheClientStub?.restore()
    rateLimiterMiddlewareStub?.restore()
    adminRateLimitMiddlewareStub?.restore()
    adminLoginRateLimitMiddlewareStub?.restore()
    bustAdminModules()

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

  const createHttpAuthEvent = async (overrides: {
    kind?: number
    url?: string
    method?: string
    payload?: string
    created_at?: number
    privkey?: string
  } = {}): Promise<Event> => {
    const signingKey = overrides.privkey ?? privkey
    const tags: Tag[] = [
      [EventTags.Url, overrides.url ?? ''] as Tag,
      [EventTags.Method, overrides.method ?? 'POST'] as Tag,
    ]
    if (typeof overrides.payload === 'string') {
      tags.push([EventTags.Payload, overrides.payload] as Tag)
    }

    const identified = await identifyEvent({
      pubkey: getPublicKey(signingKey),
      created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
      kind: overrides.kind ?? EventKinds.HTTP_AUTH,
      tags,
      content: '',
    })

    return signEvent(signingKey)(identified)
  }

  const toAuthorizationHeader = (event: Event): string =>
    `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`

  const loginHeader = async (baseUrl: string, overrides: Parameters<typeof createHttpAuthEvent>[0] = {}) =>
    toAuthorizationHeader(await createHttpAuthEvent({ url: `${baseUrl}/login`, method: 'POST', ...overrides }))

  before(() => {
    process.env.SECRET = 'test-admin-secret-value'
  })

  after(() => {
    if (originalSecret === undefined) {
      delete process.env.SECRET
    } else {
      process.env.SECRET = originalSecret
    }
  })

  afterEach(async () => {
    await stopServer()
  })

  it('returns 404 when admin is disabled', async () => {
    const baseUrl = await startServer({ admin: { enabled: false } })

    const response = await axios.get(`${baseUrl}/health`, { validateStatus: () => true })

    expect(response.status).to.equal(404)
    expect(response.data).to.equal('Not Found')
    expect(rateLimiterMiddlewareStub.calledOnce).to.be.true
  })

  it('returns 401 for protected routes without credentials', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const sessionResponse = await axios.get(`${baseUrl}/session`, { validateStatus: () => true })
    const healthResponse = await axios.get(`${baseUrl}/health`, { validateStatus: () => true })

    expect(sessionResponse.status).to.equal(401)
    expect(healthResponse.status).to.equal(401)
    expect(rateLimiterMiddlewareStub.calledTwice).to.be.true
  })

  it('rejects a login without an authorization header', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const response = await axios.post(`${baseUrl}/login`, undefined, { validateStatus: () => true })

    expect(response.status).to.equal(401)
    expect(response.data).to.deep.equal({ error: 'Unauthorized' })
    expect(adminLoginRateLimitMiddlewareStub.calledOnce).to.be.true
  })

  it('rejects a login signed by a non-allowlisted pubkey', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const response = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: await loginHeader(baseUrl, { privkey: 'b'.repeat(64) }) },
      validateStatus: () => true,
    })

    expect(response.status).to.equal(401)
  })

  it('rejects a login when the u tag does not match the request URL', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const response = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: await loginHeader(baseUrl, { url: `${baseUrl}/health` }) },
      validateStatus: () => true,
    })

    expect(response.status).to.equal(401)
  })

  it('rejects a login when the method tag does not match', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const response = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: await loginHeader(baseUrl, { method: 'GET' }) },
      validateStatus: () => true,
    })

    expect(response.status).to.equal(401)
  })

  it('rejects a login with a stale timestamp', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const response = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: await loginHeader(baseUrl, { created_at: Math.floor(Date.now() / 1000) - 120 }) },
      validateStatus: () => true,
    })

    expect(response.status).to.equal(401)
  })

  it('returns 500 when SECRET is missing during login', async () => {
    delete process.env.SECRET
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const response = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: await loginHeader(baseUrl) },
      validateStatus: () => true,
    })

    expect(response.status).to.equal(500)
    expect(response.data).to.deep.equal({ error: 'Internal Server Error' })

    process.env.SECRET = 'test-admin-secret-value'
    expect(rateLimiterMiddlewareStub.calledOnce).to.be.true
    expect(adminLoginRateLimitMiddlewareStub.calledOnce).to.be.true
  })

  it('returns 500 when SECRET is missing during session validation', async () => {
    delete process.env.SECRET
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const response = await axios.get(`${baseUrl}/session`, {
      headers: { cookie: 'admin_session=9999999999.deadbeef' },
      validateStatus: () => true,
    })

    expect(response.status).to.equal(500)
    expect(response.data).to.deep.equal({ error: 'Internal Server Error' })

    process.env.SECRET = 'test-admin-secret-value'
    expect(rateLimiterMiddlewareStub.calledOnce).to.be.true
    expect(adminRateLimitMiddlewareStub.calledOnce).to.be.true
  })

  it('authenticates with a NIP-98 login and exposes session and health', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey], sessionTtlSeconds: 3600 } })

    const loginResponse = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: await loginHeader(baseUrl) },
      validateStatus: () => true,
    })

    expect(loginResponse.status).to.equal(200)
    expect(loginResponse.data.authenticated).to.equal(true)
    expect(loginResponse.data.expiresAt).to.be.a('number')
    expect(loginResponse.data.pubkey).to.equal(pubkey)
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

    expect(rateLimiterMiddlewareStub.callCount).to.equal(3)
    expect(adminLoginRateLimitMiddlewareStub.calledOnce).to.be.true
    expect(adminRateLimitMiddlewareStub.calledTwice).to.be.true
  })

  it('accepts the session token as a bearer token', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey], sessionTtlSeconds: 3600 } })

    const loginResponse = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: await loginHeader(baseUrl) },
      validateStatus: () => true,
    })

    expect(loginResponse.status).to.equal(200)

    const token = loginResponse.headers['set-cookie']?.[0]?.split(';')[0]?.split('=')[1]
    const sessionResponse = await axios.get(`${baseUrl}/session`, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    })

    expect(sessionResponse.status).to.equal(200)
  })

  it('authenticates protected routes with a per-request NIP-98 header', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const event = await createHttpAuthEvent({ url: `${baseUrl}/health`, method: 'GET' })
    const response = await axios.get(`${baseUrl}/health`, {
      headers: { Authorization: toAuthorizationHeader(event) },
      validateStatus: () => true,
    })

    expect(response.status).to.equal(200)
    expect(response.data).to.include.keys('status', 'uptimeSeconds', 'worker', 'database', 'redis')
  })

  it('rejects a replayed authorization header', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const header = await loginHeader(baseUrl)

    const firstResponse = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: header },
      validateStatus: () => true,
    })
    const secondResponse = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: header },
      validateStatus: () => true,
    })

    expect(firstResponse.status).to.equal(200)
    expect(secondResponse.status).to.equal(401)
  })

  it('verifies the payload tag against the raw request body', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const body = JSON.stringify({ hello: 'world' })
    const payload = createHash('sha256').update(body).digest('hex')

    const response = await axios.post(`${baseUrl}/login`, body, {
      headers: {
        Authorization: await loginHeader(baseUrl, { payload }),
        'content-type': 'application/json',
      },
      validateStatus: () => true,
    })

    expect(response.status).to.equal(200)

    const mismatchResponse = await axios.post(`${baseUrl}/login`, JSON.stringify({ hello: 'tampered' }), {
      headers: {
        Authorization: await loginHeader(baseUrl, { payload }),
        'content-type': 'application/json',
      },
      validateStatus: () => true,
    })

    expect(mismatchResponse.status).to.equal(401)
  })

  it('authenticates pubkeys allowlisted as npub', async () => {
    const npub = toBech32('npub')(pubkey)
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [npub], sessionTtlSeconds: 3600 } })

    const response = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: await loginHeader(baseUrl) },
      validateStatus: () => true,
    })

    expect(response.status).to.equal(200)
    expect(response.data.pubkey).to.equal(pubkey)
  })

  it('serves the login page without authentication', async () => {
    const baseUrl = await startServer({
      admin: { enabled: true, pubkeys: [pubkey] },
      info: { name: 'Test Relay' },
    })

    const response = await axios.get(`${baseUrl}/login`, {
      headers: { Accept: 'text/html' },
      validateStatus: () => true,
    })

    expect(response.status).to.equal(200)
    expect(response.headers['content-type']).to.include('text/html')
    expect(response.data).to.include('Test Relay')
    expect(response.data).to.include('window.nostr')
    expect(response.data).to.include('Sign in with Nostr')
  })

  it('redirects unauthenticated browser navigations to the login page', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const rootResponse = await axios.get(`${baseUrl}/`, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      maxRedirects: 0,
      validateStatus: () => true,
    })
    const unknownPathResponse = await axios.get(`${baseUrl}/some/unknown/page`, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      maxRedirects: 0,
      validateStatus: () => true,
    })

    expect(rootResponse.status).to.equal(302)
    expect(rootResponse.headers.location).to.equal('/admin/login')
    expect(unknownPathResponse.status).to.equal(302)
    expect(unknownPathResponse.headers.location).to.equal('/admin/login')
  })

  it('returns 401 for unauthenticated non-browser requests to any admin path', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey] } })

    const response = await axios.get(`${baseUrl}/some/unknown/path`, { validateStatus: () => true })

    expect(response.status).to.equal(401)
    expect(response.data).to.deep.equal({ error: 'Unauthorized' })
  })

  it('serves the dashboard to authenticated browsers and 404s unknown paths', async () => {
    const baseUrl = await startServer({
      admin: { enabled: true, pubkeys: [pubkey], sessionTtlSeconds: 3600 },
      info: { name: 'Test Relay' },
    })

    const loginResponse = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: await loginHeader(baseUrl) },
      validateStatus: () => true,
    })
    expect(loginResponse.status).to.equal(200)
    const cookie = loginResponse.headers['set-cookie']?.[0]?.split(';')[0]

    const dashboardResponse = await axios.get(`${baseUrl}/`, {
      headers: { Accept: 'text/html', cookie },
      validateStatus: () => true,
    })
    expect(dashboardResponse.status).to.equal(200)
    expect(dashboardResponse.headers['content-type']).to.include('text/html')
    expect(dashboardResponse.data).to.include('Admin Console')

    const unknownResponse = await axios.get(`${baseUrl}/some/unknown/page`, {
      headers: { Accept: 'text/html', cookie },
      validateStatus: () => true,
    })
    expect(unknownResponse.status).to.equal(404)
  })

  it('clears the session cookie on logout', async () => {
    const baseUrl = await startServer({ admin: { enabled: true, pubkeys: [pubkey], sessionTtlSeconds: 3600 } })

    const loginResponse = await axios.post(`${baseUrl}/login`, undefined, {
      headers: { Authorization: await loginHeader(baseUrl) },
      validateStatus: () => true,
    })
    expect(loginResponse.status).to.equal(200)
    const cookie = loginResponse.headers['set-cookie']?.[0]?.split(';')[0]

    const logoutResponse = await axios.post(`${baseUrl}/logout`, undefined, {
      headers: { cookie },
      validateStatus: () => true,
    })

    expect(logoutResponse.status).to.equal(200)
    expect(logoutResponse.data).to.deep.equal({ authenticated: false })
    const logoutCookie = logoutResponse.headers['set-cookie']?.[0]
    expect(logoutCookie).to.include('admin_session=;')
    expect(logoutCookie).to.include('Max-Age=0')
  })
})
