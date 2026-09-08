import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import * as adminHealth from '../../../../src/utils/admin-health'
import {
  buildReadyzSnapshot,
  getReadyzRequestHandler,
} from '../../../../src/handlers/request-handlers/get-readyz-request-handler'

chai.use(sinonChai)
const { expect } = chai

describe('buildReadyzSnapshot', () => {
  it('returns ok when database and redis are healthy', () => {
    expect(buildReadyzSnapshot({ ok: true }, { ok: true })).to.deep.equal({
      status: 'ok',
      database: { ok: true },
      redis: { ok: true },
    })
  })

  it('returns unavailable when either dependency is unhealthy', () => {
    expect(buildReadyzSnapshot({ ok: false }, { ok: true })).to.deep.equal({
      status: 'unavailable',
      database: { ok: false },
      redis: { ok: true },
    })
  })
})

describe('getReadyzRequestHandler', () => {
  let sandbox: sinon.SinonSandbox
  let collectAdminHealthSnapshotStub: sinon.SinonStub

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    collectAdminHealthSnapshotStub = sandbox.stub(adminHealth, 'collectAdminHealthSnapshot')
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('responds with 200 JSON when dependencies are ready', async () => {
    collectAdminHealthSnapshotStub.resolves({
      status: 'ok',
      uptimeSeconds: 42,
      worker: { type: 'primary' },
      database: { ok: true },
      redis: { ok: true },
    })

    const req = {} as any
    const res = {
      status: sinon.stub().returnsThis(),
      setHeader: sinon.stub().returnsThis(),
      send: sinon.stub().returnsThis(),
    } as any
    const next = sinon.stub()

    await getReadyzRequestHandler(req, res, next)

    expect(res.status).to.have.been.calledOnceWithExactly(200)
    expect(res.setHeader).to.have.been.calledOnceWithExactly('content-type', 'application/json; charset=utf-8')
    expect(res.send).to.have.been.calledOnceWithExactly({
      status: 'ok',
      database: { ok: true },
      redis: { ok: true },
    })
    expect(next).to.have.been.calledOnce
  })

  it('responds with 503 JSON when a dependency is unavailable', async () => {
    collectAdminHealthSnapshotStub.resolves({
      status: 'degraded',
      uptimeSeconds: 42,
      worker: { type: 'primary' },
      database: { ok: true },
      redis: { ok: false },
    })

    const req = {} as any
    const res = {
      status: sinon.stub().returnsThis(),
      setHeader: sinon.stub().returnsThis(),
      send: sinon.stub().returnsThis(),
    } as any
    const next = sinon.stub()

    await getReadyzRequestHandler(req, res, next)

    expect(res.status).to.have.been.calledOnceWithExactly(503)
    expect(res.send).to.have.been.calledOnceWithExactly({
      status: 'unavailable',
      database: { ok: true },
      redis: { ok: false },
    })
    expect(next).to.have.been.calledOnce
  })

  it('responds with 503 JSON when dependency collection throws', async () => {
    collectAdminHealthSnapshotStub.rejects(new Error('boom'))

    const req = {} as any
    const res = {
      status: sinon.stub().returnsThis(),
      setHeader: sinon.stub().returnsThis(),
      send: sinon.stub().returnsThis(),
    } as any
    const next = sinon.stub()

    await getReadyzRequestHandler(req, res, next)

    expect(res.status).to.have.been.calledOnceWithExactly(503)
    expect(res.send).to.have.been.calledOnceWithExactly({
      status: 'unavailable',
      database: { ok: false },
      redis: { ok: false },
    })
    expect(next).to.have.been.calledOnce
  })
})
