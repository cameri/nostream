import { expect } from 'chai'
import sinon from 'sinon'

import { Event } from '../../../../src/@types/event'
import { EventKinds } from '../../../../src/constants/base'
import { IUserRepository } from '../../../../src/@types/repositories'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { LeaveRequestEventStrategy } from '../../../../src/handlers/event-strategies/leave-request-event-strategy'
import { Settings } from '../../../../src/@types/settings'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

describe('LeaveRequestEventStrategy', () => {
  let adapter: IWebSocketAdapter
  let userRepository: IUserRepository
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
      upsert: sinon.stub().resolves(1),
    } as any

    settings = () => ({
      info: { relay_url: 'wss://test.relay' },
      nip43: { enabled: true },
    } as any)

    strategy = new LeaveRequestEventStrategy(adapter, userRepository, settings)

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
    strategy = new LeaveRequestEventStrategy(adapter, userRepository, settings)

    await strategy.execute(event)

    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.false
    expect(result[3]).to.contain('NIP-43 is not enabled')
  })

  it('rejects unauthenticated requests', async () => {
    ;(adapter.getAuthenticatedPubkeys as sinon.SinonStub).returns(new Set())

    await strategy.execute(event)

    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.false
    expect(result[3]).to.contain('authentication required')
  })

  it('succeeds with no-op when user is not currently admitted', async () => {
    ;(userRepository.findByPubkey as sinon.SinonStub).resolves(undefined)

    await strategy.execute(event)

    expect((userRepository.upsert as sinon.SinonStub).called).to.be.false
    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.true
  })

  it('succeeds with no-op when user exists but is not admitted', async () => {
    ;(userRepository.findByPubkey as sinon.SinonStub).resolves({ isAdmitted: false })

    await strategy.execute(event)

    expect((userRepository.upsert as sinon.SinonStub).called).to.be.false
    expect(emitStub.calledOnce).to.be.true
    const result = emitStub.firstCall.args[1]
    expect(result[2]).to.be.true
  })

  it('revokes admission successfully', async () => {
    await strategy.execute(event)

    expect((userRepository.upsert as sinon.SinonStub).calledOnce).to.be.true
    const upsertArg = (userRepository.upsert as sinon.SinonStub).firstCall.args[0]
    expect(upsertArg.pubkey).to.equal('aabbccdd')
    expect(upsertArg.isAdmitted).to.be.false

    expect(emitStub.calledOnce).to.be.true
    const [eventName, result] = emitStub.firstCall.args
    expect(eventName).to.equal(WebSocketAdapterEvent.Message)
    expect(result[2]).to.be.true
  })
})
