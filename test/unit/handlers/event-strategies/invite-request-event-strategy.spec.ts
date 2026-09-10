import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { Event } from '../../../../src/@types/event'
import { EventKinds } from '../../../../src/constants/base'
import { InviteRequestEventStrategy } from '../../../../src/handlers/event-strategies/invite-request-event-strategy'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

chai.use(sinonChai)
const { expect } = chai

describe('InviteRequestEventStrategy', () => {
  let adapter: IWebSocketAdapter
  let strategy: InviteRequestEventStrategy
  let emitStub: sinon.SinonStub
  let event: Event

  beforeEach(() => {
    emitStub = sinon.stub()
    adapter = { emit: emitStub } as any
    strategy = new InviteRequestEventStrategy(adapter)

    event = {
      id: 'f'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      kind: EventKinds.NIP43_INVITE_REQUEST,
      tags: [['claim', 'forged-code'] as any],
      content: '',
      sig: 'b'.repeat(128),
    }
  })

  afterEach(() => {
    sinon.restore()
  })

  it('rejects a client-published invite request', async () => {
    await strategy.execute(event)

    expect(emitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
      'OK',
      event.id,
      false,
      'invalid: kind 28935 is issued by the relay, request one with a REQ for kind 28935',
    ])
  })

  // Without this the event reaches EphemeralEventStrategy and is broadcast to
  // every client subscribed to kind 28935 — precisely the clients waiting for a
  // real invite.
  it('never broadcasts the event', async () => {
    await strategy.execute(event)

    expect(emitStub).to.not.have.been.calledWith(WebSocketAdapterEvent.Broadcast)
  })
})
