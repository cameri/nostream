import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import * as RedisAdapterModule from '../../../../src/adapters/redis-adapter'
import { GetAdminModerationStatsController } from '../../../../src/controllers/admin/get-moderation-stats-controller'
import * as cacheClient from '../../../../src/cache/client'
import * as dbClient from '../../../../src/database/client'
import {
  parseModerationStatsLimit,
  parseModerationStatsWindowHours,
} from '../../../../src/utils/admin-moderation-stats'
import * as adminModerationStats from '../../../../src/utils/admin-moderation-stats'
import * as moderationRateLimitStats from '../../../../src/utils/moderation-rate-limit-stats'

chai.use(sinonChai)

const { expect } = chai

describe('GetAdminModerationStatsController', () => {
  let sandbox: Sinon.SinonSandbox
  let response: { status: Sinon.SinonStub; setHeader: Sinon.SinonStub; send: Sinon.SinonStub }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    response = {
      status: sandbox.stub().returnsThis(),
      setHeader: sandbox.stub().returnsThis(),
      send: sandbox.stub().returnsThis(),
    }
    sandbox.stub(dbClient, 'getReadReplicaDbClient').returns({} as any)
    sandbox.stub(adminModerationStats, 'queryTopPublishingPubkeys').resolves([
      { pubkey: 'd'.repeat(64), eventCount: 4 },
    ])
    sandbox.stub(adminModerationStats, 'queryTopClientIps').resolves([{ ip: '127.0.0.1', eventCount: 4 }])
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns stats without rate-limit hits when cache is not configured', async () => {
    sandbox.stub(cacheClient, 'isCacheConfigured').returns(false)

    const controller = new GetAdminModerationStatsController()
    await controller.handleRequest({ query: { windowHours: '168', limit: '10' } } as any, response as any)

    expect(response.status).to.have.been.calledOnceWithExactly(200)
    const payload = response.send.firstCall.args[0]
    expect(payload.windowHours).to.equal(168)
    expect(payload.topPublishingPubkeys).to.have.length(1)
    expect(payload.rateLimitHits).to.deep.equal({ pubkeys: [], ips: [] })
  })

  it('includes rate-limit hits when cache is configured', async () => {
    sandbox.stub(cacheClient, 'isCacheConfigured').returns(true)
    sandbox.stub(cacheClient, 'getCacheClient').returns({} as any)
    sandbox.stub(RedisAdapterModule, 'RedisAdapter').callsFake(() => ({} as any))
    sandbox.stub(moderationRateLimitStats, 'listModerationRateLimitHits').resolves({
      pubkeys: [{ key: 'e'.repeat(64), hits: 2 }],
      ips: [{ key: '127.0.0.1', hits: 2 }],
    })

    const controller = new GetAdminModerationStatsController()
    await controller.handleRequest({ query: {} } as any, response as any)

    expect(moderationRateLimitStats.listModerationRateLimitHits).to.have.been.calledOnce
    expect(response.send.firstCall.args[0].rateLimitHits.pubkeys).to.have.length(1)
  })

  it('returns 400 for invalid windowHours', async () => {
    const controller = new GetAdminModerationStatsController()
    await controller.handleRequest({ query: { windowHours: '0' } } as any, response as any)

    expect(response.status).to.have.been.calledOnceWithExactly(400)
    expect(adminModerationStats.queryTopPublishingPubkeys).to.not.have.been.called
  })


  it('returns 500 when stats queries fail unexpectedly', async () => {
    sandbox.restore()
    sandbox = Sinon.createSandbox()
    response = {
      status: sandbox.stub().returnsThis(),
      setHeader: sandbox.stub().returnsThis(),
      send: sandbox.stub().returnsThis(),
    }
    sandbox.stub(dbClient, 'getReadReplicaDbClient').returns({} as any)
    sandbox.stub(cacheClient, 'isCacheConfigured').returns(false)
    sandbox.stub(adminModerationStats, 'queryTopPublishingPubkeys').rejects(new Error('db exploded'))
    sandbox.stub(adminModerationStats, 'queryTopClientIps').resolves([])

    const controller = new GetAdminModerationStatsController()
    await controller.handleRequest({ query: { windowHours: '24' } } as any, response as any)

    expect(response.status).to.have.been.calledOnceWithExactly(500)
  })
  it('returns 504 when stats queries time out', async () => {
    sandbox.restore()
    sandbox = Sinon.createSandbox()
    response = {
      status: sandbox.stub().returnsThis(),
      setHeader: sandbox.stub().returnsThis(),
      send: sandbox.stub().returnsThis(),
    }
    sandbox.stub(dbClient, 'getReadReplicaDbClient').returns({} as any)
    sandbox.stub(cacheClient, 'isCacheConfigured').returns(false)
    sandbox.stub(adminModerationStats, 'queryTopPublishingPubkeys').rejects(new Error('Query timeout'))
    sandbox.stub(adminModerationStats, 'queryTopClientIps').resolves([])

    const controller = new GetAdminModerationStatsController()
    await controller.handleRequest({ query: { windowHours: '24' } } as any, response as any)

    expect(response.status).to.have.been.calledOnceWithExactly(504)
  })
})

describe('parseModerationStatsWindowHours', () => {
  it('defaults when windowHours is omitted', () => {
    expect(parseModerationStatsWindowHours(undefined)).to.deep.equal({ hours: 168 })
  })

  it('rejects out-of-range values', () => {
    expect(parseModerationStatsWindowHours('0').error).to.be.a('string')
    expect(parseModerationStatsWindowHours('9999').error).to.be.a('string')
  })
})

describe('parseModerationStatsLimit', () => {
  it('defaults invalid limits to 20', () => {
    expect(parseModerationStatsLimit(undefined)).to.equal(20)
    expect(parseModerationStatsLimit('abc')).to.equal(20)
  })
})
