import { expect } from 'chai'
import sinon from 'sinon'

import { ICacheAdapter, IWebSocketAdapter } from '../../../../src/@types/adapters'
import { admissionCacheKey } from '../../../../src/constants/caching'
import { Event } from '../../../../src/@types/event'
import { EventKinds } from '../../../../src/constants/base'
import { IUserRepository } from '../../../../src/@types/repositories'
import { LeaveRequestEventStrategy } from '../../../../src/handlers/event-strategies/leave-request-event-strategy'
import { Settings } from '../../../../src/@types/settings'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

describe('LeaveRequestEventStrategy', () => {
  let adapter: IWebSocketAdapter
  let userRepository: IUserRepository
  let cache: ICacheAdapter
  let settings: () => Settings
  let strategy: LeaveRequestEventStrategy
  let emitStub: sinon.SinonStub
  let event: Event

  beforeEach(() => {
    emitStub = sinon.stub()
    adapter = {
      emit: emitStub,
      getAuthenticatedPubkeys: sinon.stub().returns(new Set(['aabbccdd'])),
    } as any

    userRepository = {
      findByPubkey: sinon.stub().resolves({ isAdmitted: true }),
      revokeAdmission: sinon.stub().resolves(1),
    } as any

    cache = {
      deleteKey: sinon.stub().resolves(1),
    } as any

    settings = () => ({
      info: { relay_url: 'wss://test.relay' },
      nip43: { enabled: true },
    } as any)

    strategy = new LeaveRequestEventStrategy(adapter, userRepository, cache, settings)

    event = {
      id: 'eventid456',
      kind: EventKinds.NIP43_LEAVE_REQUEST,
      pubkey: 'aabbccdd',
      tags: [['-']],
      content: '',
      created_at: Math.floor(Date.now() / 1000),
      sig: 'sig',
    } as any
  })

  it('rejects when NIP-43 is disabled', async () => {
    settings = () => ({ info: { relay_url: 'wss://test.relay' }, nip43: { enabled: false } } as any)
    strategy = new LeaveRequestEventStrategy(adapter, userRepository, cache, settings)

    await strategy.execute(event)

    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.false
    expect(result[3]).to.contain('NIP-43 is not enabled')
  })

  it('rejects leave requests missing the NIP-70 "-" tag', async () => {
    event.tags = []

    await strategy.execute(event)

    expect((userRepository.revokeAdmission as sinon.SinonStub).called).to.be.false
    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.false
    expect(result[3]).to.contain('"-" tag')
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

  it('succeeds with no-op when user is not currently admitted', async () => {
    ;(userRepository.findByPubkey as sinon.SinonStub).resolves(undefined)

    await strategy.execute(event)

    expect((userRepository.revokeAdmission as sinon.SinonStub).called).to.be.false
    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.true
  })

  it('succeeds with no-op when user exists but is not admitted', async () => {
    ;(userRepository.findByPubkey as sinon.SinonStub).resolves({ isAdmitted: false })

    await strategy.execute(event)

    expect((userRepository.revokeAdmission as sinon.SinonStub).called).to.be.false
    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.true
  })

  it('revokes admission and invalidates admission cache', async () => {
    await strategy.execute(event)

    expect((userRepository.revokeAdmission as sinon.SinonStub).calledOnceWith('aabbccdd')).to.be.true
    expect((cache.deleteKey as sinon.SinonStub).calledOnceWith(admissionCacheKey('aabbccdd'))).to.be.true

    expect(emitStub.calledOnce).to.be.true
    const [eventName, result] = emitStub.firstCall.args
    expect(eventName).to.equal(WebSocketAdapterEvent.Message)
    expect(result[2]).to.be.true
  })

  it('still revokes admission when cache invalidation fails', async () => {
    ;(cache.deleteKey as sinon.SinonStub).rejects(new Error('cache down'))

    await strategy.execute(event)

    expect((userRepository.revokeAdmission as sinon.SinonStub).calledOnce).to.be.true
    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.true
  })
})
