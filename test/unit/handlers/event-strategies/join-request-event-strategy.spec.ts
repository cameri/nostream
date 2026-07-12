import { expect } from 'chai'
import sinon from 'sinon'

import { EventKinds, EventTags } from '../../../../src/constants/base'
import { ICacheAdapter, IWebSocketAdapter } from '../../../../src/@types/adapters'
import { IInviteCodeRepository, IUserRepository } from '../../../../src/@types/repositories'
import { admissionCacheKey } from '../../../../src/constants/caching'
import { Event } from '../../../../src/@types/event'
import { JoinRequestEventStrategy } from '../../../../src/handlers/event-strategies/join-request-event-strategy'
import { Settings } from '../../../../src/@types/settings'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

describe('JoinRequestEventStrategy', () => {
  let adapter: IWebSocketAdapter
  let inviteCodeRepository: IInviteCodeRepository
  let userRepository: IUserRepository
  let cache: ICacheAdapter
  let settings: () => Settings
  let strategy: JoinRequestEventStrategy
  let emitStub: sinon.SinonStub
  let event: Event

  beforeEach(() => {
    emitStub = sinon.stub()
    adapter = {
      emit: emitStub,
      getAuthenticatedPubkeys: sinon.stub().returns(new Set(['aabbccdd'])),
    } as any

    inviteCodeRepository = {
      claimCode: sinon.stub(),
    } as any

    userRepository = {
      findByPubkey: sinon.stub(),
      admitUser: sinon.stub(),
    } as any

    cache = {
      deleteKey: sinon.stub().resolves(1),
    } as any

    settings = () => ({
      info: { relay_url: 'wss://test.relay' },
      nip43: { enabled: true },
    } as any)

    strategy = new JoinRequestEventStrategy(adapter, inviteCodeRepository, userRepository, cache, settings)

    event = {
      id: 'eventid123',
      kind: EventKinds.NIP43_JOIN_REQUEST,
      pubkey: 'aabbccdd',
      tags: [[EventTags.Claim, 'valid-code']],
      content: '',
      created_at: Math.floor(Date.now() / 1000),
      sig: 'sig',
    } as any
  })

  it('rejects when NIP-43 is disabled', async () => {
    settings = () => ({ info: { relay_url: 'wss://test.relay' }, nip43: { enabled: false } } as any)
    strategy = new JoinRequestEventStrategy(adapter, inviteCodeRepository, userRepository, cache, settings)

    await strategy.execute(event)

    expect(emitStub.calledOnce).to.be.true
    const [eventName, result] = emitStub.firstCall.args
    expect(eventName).to.equal(WebSocketAdapterEvent.Message)
    expect(result[1]).to.equal(event.id)
    expect(result[2]).to.be.false
    expect(result[3]).to.contain('NIP-43 is not enabled')
  })

  it('rejects requests with stale created_at', async () => {
    event.created_at = Math.floor(Date.now() / 1000) - 3600

    await strategy.execute(event)

    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.false
    expect(result[3]).to.contain('created_at is too far from the current time')
  })

  it('rejects unauthenticated requests with auth-required prefix', async () => {
    ;(adapter.getAuthenticatedPubkeys as sinon.SinonStub).returns(new Set())

    await strategy.execute(event)

    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.false
    expect(result[3]).to.contain('auth-required:')
    expect(result[3]).to.contain('authentication required')
  })

  it('rejects events missing the claim tag', async () => {
    event.tags = []

    await strategy.execute(event)

    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.false
    expect(result[3]).to.contain('claim tag')
  })

  it('returns duplicate when user is already admitted', async () => {
    ;(userRepository.findByPubkey as sinon.SinonStub).resolves({ isAdmitted: true })

    await strategy.execute(event)

    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.true
    expect(result[3]).to.contain('duplicate:')
  })

  it('rejects when invite code is invalid or expired', async () => {
    ;(userRepository.findByPubkey as sinon.SinonStub).resolves(undefined)
    ;(inviteCodeRepository.claimCode as sinon.SinonStub).resolves(false)

    await strategy.execute(event)

    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.false
    expect(result[3]).to.contain('restricted:')
    expect(result[3]).to.contain('invalid or expired')
  })

  it('admits user and invalidates admission cache on valid claim', async () => {
    ;(userRepository.findByPubkey as sinon.SinonStub).resolves(undefined)
    ;(inviteCodeRepository.claimCode as sinon.SinonStub).resolves(true)
    ;(userRepository.admitUser as sinon.SinonStub).resolves()

    await strategy.execute(event)

    expect((inviteCodeRepository.claimCode as sinon.SinonStub).calledOnceWith('valid-code', 'aabbccdd')).to.be.true
    expect((userRepository.admitUser as sinon.SinonStub).calledOnce).to.be.true
    expect((cache.deleteKey as sinon.SinonStub).calledOnceWith(admissionCacheKey('aabbccdd'))).to.be.true

    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.true
    expect(result[3]).to.contain('welcome to')
  })

  it('still admits user when cache invalidation fails', async () => {
    ;(userRepository.findByPubkey as sinon.SinonStub).resolves(undefined)
    ;(inviteCodeRepository.claimCode as sinon.SinonStub).resolves(true)
    ;(userRepository.admitUser as sinon.SinonStub).resolves()
    ;(cache.deleteKey as sinon.SinonStub).rejects(new Error('cache down'))

    await strategy.execute(event)

    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.true
    expect(result[3]).to.contain('welcome to')
  })
})
