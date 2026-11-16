import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { ICacheAdapter } from '../../../src/@types/adapters'
import {
  adminSessionRevocationCacheKey,
  CacheAdminSessionRevocations,
} from '../../../src/utils/admin-session-revocations'

chai.use(sinonChai)

const { expect } = chai

describe('CacheAdminSessionRevocations', () => {
  let sandbox: Sinon.SinonSandbox
  let setKey: Sinon.SinonStub
  let hasKey: Sinon.SinonStub
  let revocations: CacheAdminSessionRevocations

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    setKey = sandbox.stub().resolves(true)
    hasKey = sandbox.stub().resolves(false)
    revocations = new CacheAdminSessionRevocations(() => ({ setKey, hasKey }) as unknown as ICacheAdapter)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('keeps a revoked session id until the token would have expired', async () => {
    await revocations.revoke('abc', 3600)

    expect(setKey).to.have.been.calledOnceWithExactly(adminSessionRevocationCacheKey('abc'), '1', 3600)
  })

  it('keeps a revoked session id for at least a second', async () => {
    await revocations.revoke('abc', 0)
    await revocations.revoke('def', Number.NaN)

    expect(setKey.firstCall.args[2]).to.equal(1)
    expect(setKey.secondCall.args[2]).to.equal(1)
  })

  it('keys each session separately', () => {
    expect(adminSessionRevocationCacheKey('abc')).to.not.equal(adminSessionRevocationCacheKey('def'))
  })

  it('reports whether a session id was revoked', async () => {
    hasKey.withArgs(adminSessionRevocationCacheKey('revoked')).resolves(true)

    expect(await revocations.isRevoked('revoked')).to.equal(true)
    expect(await revocations.isRevoked('live')).to.equal(false)
  })

  it('does not hide a cache failure', async () => {
    setKey.rejects(new Error('redis is down'))
    hasKey.rejects(new Error('redis is down'))

    await revocations.revoke('abc', 60).then(
      () => expect.fail('revoke should reject'),
      (error: Error) => expect(error.message).to.equal('redis is down'),
    )
    await revocations.isRevoked('abc').then(
      () => expect.fail('isRevoked should reject'),
      (error: Error) => expect(error.message).to.equal('redis is down'),
    )
  })

  describe('when the cache never answers', () => {
    const neverSettles = () => new Promise<never>(() => undefined)

    beforeEach(() => {
      revocations = new CacheAdminSessionRevocations(() => ({ setKey, hasKey }) as unknown as ICacheAdapter, 10)
    })

    it('stops waiting for a revocation that is never stored', async () => {
      setKey.callsFake(neverSettles)

      await revocations.revoke('abc', 60).then(
        () => expect.fail('revoke should reject'),
        (error: Error) => expect(error.message).to.match(/timed out after 10 ms/),
      )
    })

    it('stops waiting for a revocation check that is never answered', async () => {
      hasKey.callsFake(neverSettles)

      await revocations.isRevoked('abc').then(
        () => expect.fail('isRevoked should reject'),
        (error: Error) => expect(error.message).to.match(/timed out after 10 ms/),
      )
    })

    it('rejects when the cache cannot even be created', async () => {
      revocations = new CacheAdminSessionRevocations(() => {
        throw new Error('no redis client')
      }, 10)

      await revocations.isRevoked('abc').then(
        () => expect.fail('isRevoked should reject'),
        (error: Error) => expect(error.message).to.equal('no redis client'),
      )
    })
  })
})
