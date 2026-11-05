import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { ICacheAdapter } from '../../../src/@types/adapters'
import { PEERING_REQUEST_STATS_INDEX_KEY, PeeringRequestStatsStore } from '../../../src/utils/peering-request-stats'

chai.use(sinonChai)
const { expect } = chai

describe('PeeringRequestStatsStore', () => {
  let sandbox: Sinon.SinonSandbox
  let evalStub: Sinon.SinonStub
  let getSetMembersStub: Sinon.SinonStub
  let store: PeeringRequestStatsStore

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    evalStub = sandbox.stub().resolves(1)
    getSetMembersStub = sandbox.stub().resolves([])
    store = new PeeringRequestStatsStore({
      eval: evalStub,
      getSetMembers: getSetMembersStub,
    } as unknown as ICacheAdapter)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('records a request with its type and timestamp', async () => {
    const pubkey = 'A'.repeat(64)

    await store.recordRequest(pubkey, 'REQ')

    const [, keys, args] = evalStub.firstCall.args
    expect(keys).to.deep.equal([`admin:peering:requests:${pubkey.toLowerCase()}`, PEERING_REQUEST_STATS_INDEX_KEY])
    expect(args[0]).to.equal('1')
    expect(args[1]).to.equal('0')
    expect(args[2]).to.equal(pubkey.toLowerCase())
    expect(args[3]).to.be.a('string')
    expect(args[4]).to.equal('REQ')
  })

  it('adds events served without counting another request', async () => {
    await store.addEventsServed('a'.repeat(64), 5)

    const [, , args] = evalStub.firstCall.args
    expect(args[0]).to.equal('0')
    expect(args[1]).to.equal('5')
    expect(args[3]).to.equal('')
  })

  it('reads and parses all recorded peers', async () => {
    const pubkey = 'a'.repeat(64)
    getSetMembersStub.resolves([pubkey])
    evalStub.resolves([
      'pubkey',
      pubkey,
      'requests',
      '3',
      'eventsServed',
      '9',
      'lastRequestAt',
      '2026-01-01T00:00:00.000Z',
      'lastRequestType',
      'REQ',
    ])

    const result = await store.list()

    expect(result).to.deep.equal([
      {
        pubkey,
        requests: 3,
        eventsServed: 9,
        lastRequestAt: '2026-01-01T00:00:00.000Z',
        lastRequestType: 'REQ',
      },
    ])
  })

  it('prunes index members whose hash expired in the same read', async () => {
    const pubkey = 'a'.repeat(64)
    getSetMembersStub.resolves([pubkey])
    evalStub.resolves([])

    const result = await store.list()

    expect(result).to.deep.equal([])
    expect(evalStub).to.have.been.calledOnce
    expect(evalStub.firstCall.args[1]).to.deep.equal([
      `admin:peering:requests:${pubkey}`,
      PEERING_REQUEST_STATS_INDEX_KEY,
    ])
    expect(evalStub.firstCall.args[2]).to.deep.equal([pubkey])
  })

  it('returns an empty list when the stats index cannot be read', async () => {
    getSetMembersStub.rejects(new Error('redis down'))

    const result = await store.list()

    expect(result).to.deep.equal([])
    expect(evalStub).not.to.have.been.called
  })

  it('does not fail the request path when accounting storage is unavailable', async () => {
    evalStub.rejects(new Error('redis down'))

    await store.recordRequest('a'.repeat(64), 'REQ')
    await store.addEventsServed('a'.repeat(64), 2)
  })
})
