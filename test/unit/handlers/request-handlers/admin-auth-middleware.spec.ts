import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'
import { Tag } from '../../../../src/@types/base'
import { PasswordAdminAuthProvider } from '../../../../src/admin/password-admin-auth-provider'
import { EventKinds, EventTags } from '../../../../src/constants/base'
import * as settingsFactory from '../../../../src/factories/settings-factory'
import {
  adminAuthGateMiddleware,
  adminAuthMiddleware,
} from '../../../../src/handlers/request-handlers/admin-auth-middleware'
import { AdminRequest } from '../../../../src/handlers/request-handlers/admin-json-body-middleware'
import { getPublicKey, identifyEvent, signEvent } from '../../../../src/utils/event'
import { hashNip98Payload, isNostrAuthorizationHeader } from '../../../../src/utils/nip98'
import * as nip98Replay from '../../../../src/utils/nip98-replay'

chai.use(sinonChai)

const { expect } = chai

describe('adminAuthMiddleware', () => {
  const privkey = 'a'.repeat(64)
  const pubkey = getPublicKey(privkey)
  const stranger = 'b'.repeat(64)
  const now = 1_700_000_000
  // relay_url is wss → public HTTP scheme becomes https
  const url = 'https://relay.example.com/admin/settings'

  let sandbox: Sinon.SinonSandbox
  let isRequestAuthenticated: Sinon.SinonStub
  let claimNip98AuthEventId: Sinon.SinonStub
  let next: Sinon.SinonStub
  let response: {
    status: Sinon.SinonStub
    setHeader: Sinon.SinonStub
    send: Sinon.SinonStub
  }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    isRequestAuthenticated = sandbox.stub(PasswordAdminAuthProvider.prototype, 'isRequestAuthenticated').returns(false)
    claimNip98AuthEventId = sandbox.stub(nip98Replay, 'claimNip98AuthEventId').resolves('claimed')
    next = sandbox.stub()
    response = {
      status: sandbox.stub().returnsThis(),
      setHeader: sandbox.stub().returnsThis(),
      send: sandbox.stub().returnsThis(),
    }
  })

  afterEach(() => {
    sandbox.restore()
  })

  const mockRequest = (overrides: Partial<AdminRequest> & { headers?: Record<string, string> } = {}): AdminRequest => {
    const headers = overrides.headers ?? {}
    return {
      method: 'GET',
      originalUrl: '/admin/settings',
      headers,
      get: (name: string) => {
        if (name.toLowerCase() === 'host') {
          return 'relay.example.com'
        }
        return headers[name]
      },
      socket: { remoteAddress: '127.0.0.1' },
      ...overrides,
    } as any
  }

  async function createAuthHeader(
    overrides: { url?: string; method?: string; payload?: string; created_at?: number } = {},
  ): Promise<string> {
    const tags: Tag[] = [
      [EventTags.Url, overrides.url ?? url],
      [EventTags.Method, overrides.method ?? 'GET'],
    ]
    if (overrides.payload !== undefined) {
      tags.push([EventTags.Payload, overrides.payload])
    }

    const identified = await identifyEvent({
      pubkey,
      created_at: overrides.created_at ?? now,
      kind: EventKinds.HTTP_AUTH,
      tags,
      content: '',
    })
    const signed = await signEvent(privkey)(identified)
    return `Nostr ${Buffer.from(JSON.stringify(signed), 'utf8').toString('base64')}`
  }

  const enableNip98 = (allowedPubkeys: string[] = [pubkey]) => {
    sandbox.stub(settingsFactory, 'createSettings').returns({
      info: { relay_url: 'wss://relay.example.com' },
      network: {},
      admin: {
        enabled: true,
        nip98: {
          enabled: true,
          allowedPubkeys,
          maxSkewSeconds: 60,
        },
      },
    } as any)
  }

  describe('isNostrAuthorizationHeader', () => {
    it('accepts only a complete Nostr scheme and base64 token', () => {
      expect(isNostrAuthorizationHeader('Nostr YQ==')).to.be.true
      expect(isNostrAuthorizationHeader('nostr YQ==')).to.be.true
      expect(isNostrAuthorizationHeader(' Nostr YQ==')).to.be.false
      expect(isNostrAuthorizationHeader('Nostr YQ== ')).to.be.false
      expect(isNostrAuthorizationHeader('Nostr  YQ==')).to.be.false
      expect(isNostrAuthorizationHeader('Nostr not-valid-base64!!!')).to.be.false
    })
  })

  describe('adminAuthGateMiddleware', () => {
    it('continues for session-authenticated requests', async () => {
      isRequestAuthenticated.returns(true)
      const request = mockRequest()

      await adminAuthGateMiddleware(request, response as any, next)

      expect(next).to.have.been.calledOnce
      expect(response.status).not.to.have.been.called
    })

    it('rejects anonymous requests before body parsing when NIP-98 is off', async () => {
      sandbox.stub(settingsFactory, 'createSettings').returns({
        info: { relay_url: 'wss://relay.example.com' },
        network: {},
        admin: { enabled: true, nip98: { enabled: false } },
      } as any)

      await adminAuthGateMiddleware(mockRequest(), response as any, next)

      expect(next).not.to.have.been.called
      expect(response.status).to.have.been.calledWith(401)
    })

    it('allows a cryptographically valid allowlisted NIP-98 header through', async () => {
      enableNip98()
      sandbox.stub(Date, 'now').returns(now * 1000)

      await adminAuthGateMiddleware(
        mockRequest({ headers: { authorization: await createAuthHeader() } }),
        response as any,
        next,
      )

      expect(next).to.have.been.calledOnce
      expect(response.status).not.to.have.been.called
    })

    it('rejects junk Nostr Authorization before body parsing', async () => {
      enableNip98()

      await adminAuthGateMiddleware(
        mockRequest({ headers: { authorization: 'Nostr not-valid-base64!!!' } }),
        response as any,
        next,
      )

      expect(next).not.to.have.been.called
      expect(response.status).to.have.been.calledWith(401)
    })

    it('rejects Host-spoofed URLs because host is pinned to relay_url', async () => {
      enableNip98()
      sandbox.stub(Date, 'now').returns(now * 1000)
      const authorization = await createAuthHeader({ url: 'https://evil.example/admin/settings' })

      await adminAuthGateMiddleware(
        mockRequest({
          headers: { authorization },
          get: (name: string) => (name.toLowerCase() === 'host' ? 'evil.example' : undefined),
        } as any),
        response as any,
        next,
      )

      expect(next).not.to.have.been.called
      expect(response.status).to.have.been.calledWith(401)
    })
  })

  it('allows cookie/session authenticated requests without NIP-98', async () => {
    isRequestAuthenticated.returns(true)
    const request = mockRequest()

    await adminAuthMiddleware(request, response as any, next)

    expect(next).to.have.been.calledOnce
    expect(response.status).not.to.have.been.called
  })

  it('rejects unauthenticated requests when NIP-98 is disabled', async () => {
    sandbox.stub(settingsFactory, 'createSettings').returns({
      info: { relay_url: 'wss://relay.example.com' },
      network: {},
      admin: { enabled: true, nip98: { enabled: false, allowedPubkeys: [pubkey] } },
    } as any)

    await adminAuthMiddleware(
      mockRequest({ headers: { authorization: await createAuthHeader() } }),
      response as any,
      next,
    )

    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(401)
  })

  it('accepts a valid allowlisted NIP-98 Authorization header', async () => {
    enableNip98()
    sandbox.stub(Date, 'now').returns(now * 1000)

    await adminAuthMiddleware(
      mockRequest({
        headers: { authorization: await createAuthHeader() },
      }),
      response as any,
      next,
    )

    expect(next).to.have.been.calledOnce
    expect(response.status).not.to.have.been.called
    expect(claimNip98AuthEventId).to.have.been.calledOnce
    expect(claimNip98AuthEventId.firstCall.args[1]).to.equal(61)
  })

  it('claims a future-dated NIP-98 event until created_at + maxSkew', async () => {
    enableNip98()
    sandbox.stub(Date, 'now').returns(now * 1000)
    const createdAt = now + 60

    await adminAuthMiddleware(
      mockRequest({
        headers: { authorization: await createAuthHeader({ created_at: createdAt }) },
      }),
      response as any,
      next,
    )

    expect(next).to.have.been.calledOnce
    expect(claimNip98AuthEventId).to.have.been.calledOnce
    expect(claimNip98AuthEventId.firstCall.args[1]).to.equal(121)
  })

  it('rejects a valid NIP-98 event from a non-allowlisted pubkey', async () => {
    enableNip98([stranger])
    sandbox.stub(Date, 'now').returns(now * 1000)

    await adminAuthMiddleware(
      mockRequest({
        headers: { authorization: await createAuthHeader() },
      }),
      response as any,
      next,
    )

    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(401)
  })

  it('rejects when allowlist is empty even if NIP-98 is enabled', async () => {
    enableNip98([])
    sandbox.stub(Date, 'now').returns(now * 1000)

    await adminAuthMiddleware(
      mockRequest({
        headers: { authorization: await createAuthHeader() },
      }),
      response as any,
      next,
    )

    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(401)
  })

  it('verifies payload hash for PATCH bodies using rawBody', async () => {
    enableNip98()
    sandbox.stub(Date, 'now').returns(now * 1000)
    const body = '{"path":"info.name","value":"relay"}'
    const authorization = await createAuthHeader({
      method: 'PATCH',
      payload: hashNip98Payload(body),
    })

    await adminAuthMiddleware(
      mockRequest({
        method: 'PATCH',
        headers: { authorization },
        rawBody: Buffer.from(body, 'utf8'),
      }),
      response as any,
      next,
    )

    expect(next).to.have.been.calledOnce
    expect(claimNip98AuthEventId).to.have.been.calledOnce
    expect(claimNip98AuthEventId.firstCall.args[1]).to.equal(61)
  })

  it('rejects PATCH when payload hash does not match rawBody', async () => {
    enableNip98()
    sandbox.stub(Date, 'now').returns(now * 1000)
    const body = '{"path":"info.name","value":"relay"}'
    const authorization = await createAuthHeader({
      method: 'PATCH',
      payload: hashNip98Payload('{"path":"info.name","value":"other"}'),
    })

    await adminAuthMiddleware(
      mockRequest({
        method: 'PATCH',
        headers: { authorization },
        rawBody: Buffer.from(body, 'utf8'),
      }),
      response as any,
      next,
    )

    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(401)
    expect(claimNip98AuthEventId).not.to.have.been.called
  })

  it('rejects replayed NIP-98 auth event ids', async () => {
    enableNip98()
    sandbox.stub(Date, 'now').returns(now * 1000)
    claimNip98AuthEventId.resolves('replay')

    await adminAuthMiddleware(
      mockRequest({
        headers: { authorization: await createAuthHeader() },
      }),
      response as any,
      next,
    )

    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(401)
  })

  it('rejects NIP-98 when replay cache is unavailable', async () => {
    enableNip98()
    sandbox.stub(Date, 'now').returns(now * 1000)
    claimNip98AuthEventId.resolves('unavailable')

    await adminAuthMiddleware(
      mockRequest({
        headers: { authorization: await createAuthHeader() },
      }),
      response as any,
      next,
    )

    expect(next).not.to.have.been.called
    expect(response.status).to.have.been.calledWith(401)
  })
})
