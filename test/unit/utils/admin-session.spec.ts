import { expect } from 'chai'

import {
  buildAdminSessionCookieHeader,
  createAdminSessionToken,
  getAdminSessionTokenFromRequest,
  isValidAdminSessionToken,
  parseAdminSessionToken,
  resolveAdminSessionTtlSeconds,
} from '../../../src/utils/admin-session'

describe('admin-session', () => {
  const originalSecret = process.env.SECRET

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

  it('creates and validates a signed session token', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const token = createAdminSessionToken(expiresAt)

    expect(isValidAdminSessionToken(token)).to.equal(true)
    expect(isValidAdminSessionToken(`${expiresAt}.deadbeef`)).to.equal(false)
  })

  describe('the session id in a token', () => {
    const expiresAt = () => Math.floor(Date.now() / 1000) + 3600

    it('differs between two tokens made for the same expiry', () => {
      const at = expiresAt()
      const first = createAdminSessionToken(at)
      const second = createAdminSessionToken(at)

      expect(first).to.not.equal(second)
      expect(parseAdminSessionToken(first)?.sessionId).to.not.equal(parseAdminSessionToken(second)?.sessionId)
      expect(isValidAdminSessionToken(first)).to.equal(true)
      expect(isValidAdminSessionToken(second)).to.equal(true)
    })

    it('is read back with the expiry', () => {
      const at = expiresAt()
      const token = createAdminSessionToken(at)

      expect(parseAdminSessionToken(token)).to.deep.equal({ expiresAt: at, sessionId: token.split('.')[1] })
    })

    it('is signed, so another id under the same signature is refused', () => {
      const at = expiresAt()
      const [, , signature] = createAdminSessionToken(at).split('.')

      expect(isValidAdminSessionToken(`${at}.${'0'.repeat(32)}.${signature}`)).to.equal(false)
    })

    it('is signed with the expiry, so a later expiry under the same id is refused', () => {
      const at = expiresAt()
      const [, sessionId, signature] = createAdminSessionToken(at).split('.')

      expect(isValidAdminSessionToken(`${at + 3600}.${sessionId}.${signature}`)).to.equal(false)
    })

    it('refuses the old token without a session id, which cannot be revoked', () => {
      const at = expiresAt()
      const [, , signature] = createAdminSessionToken(at).split('.')

      expect(isValidAdminSessionToken(`${at}.${signature}`)).to.equal(false)
      expect(parseAdminSessionToken(`${at}.${signature}`)).to.equal(undefined)
    })

    it('refuses an id that is not 32 hex characters, and extra parts', () => {
      const at = expiresAt()
      const [, sessionId, signature] = createAdminSessionToken(at).split('.')

      expect(parseAdminSessionToken(`${at}.${sessionId.slice(1)}.${signature}`)).to.equal(undefined)
      expect(parseAdminSessionToken(`${at}.${sessionId.toUpperCase()}.${signature}`)).to.equal(undefined)
      expect(parseAdminSessionToken(`${at}.${sessionId}.${signature}.extra`)).to.equal(undefined)
    })

    it('refuses an expired token', () => {
      const past = Math.floor(Date.now() / 1000) - 1

      expect(isValidAdminSessionToken(createAdminSessionToken(past))).to.equal(false)
    })
  })

  it('reads bearer and cookie session tokens from request headers', () => {
    expect(getAdminSessionTokenFromRequest('Bearer abc.def', undefined)).to.equal('abc.def')
    expect(getAdminSessionTokenFromRequest(undefined, 'admin_session=abc.def; other=value')).to.equal('abc.def')
  })

  it('falls back to the default ttl for invalid sessionTtlSeconds values', () => {
    expect(resolveAdminSessionTtlSeconds(undefined)).to.equal(86400)
    expect(resolveAdminSessionTtlSeconds(0)).to.equal(86400)
    expect(resolveAdminSessionTtlSeconds(-1)).to.equal(86400)
    expect(resolveAdminSessionTtlSeconds(Number.NaN)).to.equal(86400)
    expect(resolveAdminSessionTtlSeconds(3600)).to.equal(3600)
  })

  it('builds a secure admin session cookie behind a trusted https proxy', () => {
    const cookie = buildAdminSessionCookieHeader(
      {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-prefix': '/nostream' },
        socket: { remoteAddress: '127.0.0.1' },
      } as any,
      {
        info: { relay_url: 'wss://relay.example.com/nostream' },
        network: { trustedProxies: ['127.0.0.1'] },
      } as any,
      'token-value',
      3600,
    )

    expect(cookie).to.equal(
      'admin_session=token-value; Path=/nostream/admin; HttpOnly; SameSite=Strict; Max-Age=3600; Secure',
    )
  })

  it('omits Secure for local http requests', () => {
    const cookie = buildAdminSessionCookieHeader(
      {
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as any,
      {
        info: { relay_url: 'ws://localhost:8008' },
        network: {},
      } as any,
      'token-value',
      3600,
    )

    expect(cookie).to.equal('admin_session=token-value; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=3600')
  })
})
