import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

import { RedisAdapter } from '../../../src/adapters/redis-adapter'

describe('RedisAdapter', () => {
  let sandbox: Sinon.SinonSandbox
  let client: any
  let adapter: RedisAdapter

  let originalConsoleError: typeof console.error

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    originalConsoleError = console.error
    console.error = () => undefined

    client = {
      connect: sandbox.stub().resolves(),
      on: sandbox.stub().returnsThis(),
      exists: sandbox.stub(),
      get: sandbox.stub(),
      set: sandbox.stub(),
      zRemRangeByScore: sandbox.stub(),
      zRange: sandbox.stub(),
      expire: sandbox.stub(),
      zAdd: sandbox.stub(),
      removeListener: sandbox.stub(),
      once: sandbox.stub(),
    }

    adapter = new RedisAdapter(client)
  })

  afterEach(() => {
    console.error = originalConsoleError
    sandbox.restore()
  })

  describe('constructor', () => {
    it('calls client.connect()', () => {
      expect(client.connect).to.have.been.calledOnce
    })

    it('registers event listeners for connect, ready, error, and reconnecting', () => {
      expect(client.on).to.have.been.calledWith('connect')
      expect(client.on).to.have.been.calledWith('ready')
      expect(client.on).to.have.been.calledWith('error')
      expect(client.on).to.have.been.calledWith('reconnecting')
    })
  })

  describe('constructor error handling', () => {
    it('handles connection rejection without throwing', () => {
      const failingClient = {
        connect: sandbox.stub().rejects(new Error('connection refused')),
        on: sandbox.stub().returnsThis(),
      }

      expect(() => new RedisAdapter(failingClient as any)).not.to.throw()
    })
  })

  describe('hasKey', () => {
    it('awaits connection and calls client.exists with the key', async () => {
      client.exists.returns(1)

      const result = await adapter.hasKey('test-key')

      expect(client.exists).to.have.been.calledOnceWithExactly('test-key')
      expect(result).to.be.true
    })

    it('returns false when key does not exist', async () => {
      client.exists.returns(0)

      const result = await adapter.hasKey('missing-key')

      expect(result).to.be.false
    })
  })

  describe('getKey', () => {
    it('awaits connection and calls client.get with the key', async () => {
      client.get.resolves('test-value')

      const result = await adapter.getKey('test-key')

      expect(client.get).to.have.been.calledOnceWithExactly('test-key')
      expect(result).to.equal('test-value')
    })

    it('returns null when key does not exist', async () => {
      client.get.resolves(null)

      const result = await adapter.getKey('missing-key')

      expect(result).to.be.null
    })
  })

  describe('setKey', () => {
    it('returns true when client.set returns OK', async () => {
      client.set.resolves('OK')

      const result = await adapter.setKey('key', 'value')

      expect(client.set).to.have.been.calledOnceWithExactly('key', 'value')
      expect(result).to.be.true
    })

    it('returns false when client.set does not return OK', async () => {
      client.set.resolves(null)

      const result = await adapter.setKey('key', 'value')

      expect(result).to.be.false
    })
  })

  describe('removeRangeByScoreFromSortedSet', () => {
    it('calls client.zRemRangeByScore with correct arguments', async () => {
      client.zRemRangeByScore.resolves(3)

      const result = await adapter.removeRangeByScoreFromSortedSet('sorted-key', 10, 20)

      expect(client.zRemRangeByScore).to.have.been.calledOnceWithExactly('sorted-key', 10, 20)
      expect(result).to.equal(3)
    })
  })

  describe('getRangeFromSortedSet', () => {
    it('calls client.zRange with correct arguments', async () => {
      client.zRange.resolves(['a', 'b', 'c'])

      const result = await adapter.getRangeFromSortedSet('sorted-key', 0, 10)

      expect(client.zRange).to.have.been.calledOnceWithExactly('sorted-key', 0, 10)
      expect(result).to.deep.equal(['a', 'b', 'c'])
    })

    it('returns empty array when set is empty', async () => {
      client.zRange.resolves([])

      const result = await adapter.getRangeFromSortedSet('empty-key', 0, 10)

      expect(result).to.deep.equal([])
    })
  })

  describe('setKeyExpiry', () => {
    it('calls client.expire with correct arguments', async () => {
      client.expire.resolves(true)

      await adapter.setKeyExpiry('key', 3600)

      expect(client.expire).to.have.been.calledOnceWithExactly('key', 3600)
    })
  })

  describe('addToSortedSet', () => {
    it('transforms record entries to score/value members and calls client.zAdd', async () => {
      client.zAdd.resolves(2)

      const set = { 'member1': '100', 'member2': '200' }
      const result = await adapter.addToSortedSet('sorted-key', set)

      expect(client.zAdd).to.have.been.calledOnce
      const callArgs = client.zAdd.firstCall.args
      expect(callArgs[0]).to.equal('sorted-key')
      expect(callArgs[1]).to.deep.include.members([
        { score: 100, value: 'member1' },
        { score: 200, value: 'member2' },
      ])
      expect(result).to.equal(2)
    })

    it('handles a single entry', async () => {
      client.zAdd.resolves(1)

      const set = { 'only-member': '50' }
      const result = await adapter.addToSortedSet('sorted-key', set)

      const callArgs = client.zAdd.firstCall.args
      expect(callArgs[1]).to.deep.equal([{ score: 50, value: 'only-member' }])
      expect(result).to.equal(1)
    })
  })
})
