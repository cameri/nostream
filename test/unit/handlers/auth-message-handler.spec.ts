import { expect } from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'
import chai from 'chai'

chai.use(sinonChai)

import { AuthMessage, MessageType } from '../../../src/@types/messages'
import { AuthMessageHandler } from '../../../src/handlers/auth-message-handler'
import { Tag } from '../../../src/@types/base'
import { EventKinds, EventTags } from '../../../src/constants/base'
import { getPublicKey, identifyEvent, signEvent } from '../../../src/utils/event'
import { IMessageHandler } from '../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { Settings } from '../../../src/@types/settings'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'

describe('AuthMessageHandler', () => {
  let handler: IMessageHandler
  let webSocket: IWebSocketAdapter
  let emitStub: Sinon.SinonStub
  let settingsFactory: Sinon.SinonStub

  const challenge = 'test-challenge-string-abc123'
  const relayUrl = 'wss://relay.example.com'
  const privkey = 'a'.repeat(64)
  const pubkey = getPublicKey(privkey)

  async function createAuthEvent(overrides: {
    kind?: number
    challenge?: string
    relayUrl?: string
    created_at?: number
    invalidId?: boolean
    invalidSig?: boolean
  } = {}): Promise<AuthMessage> {
    const kind = overrides.kind ?? EventKinds.AUTH
    const now = overrides.created_at ?? Math.floor(Date.now() / 1000)
    const tags = [
      [EventTags.AuthRelay, overrides.relayUrl ?? relayUrl],
      [EventTags.Challenge, overrides.challenge ?? challenge],
    ] as Tag[]

    const identified = await identifyEvent({
      pubkey,
      created_at: now,
      kind,
      tags,
      content: '',
    })

    if (overrides.invalidId) {
      identified.id = 'f'.repeat(64)
    }

    const signed = overrides.invalidSig
      ? { ...identified, sig: '0'.repeat(128) }
      : await signEvent(privkey)(identified)

    return [
      MessageType.AUTH,
      {
        id: signed.id,
        pubkey,
        created_at: now,
        kind,
        tags,
        content: '',
        sig: signed.sig,
      },
    ] as AuthMessage
  }

  beforeEach(() => {
    emitStub = Sinon.stub()
    webSocket = {
      emit: emitStub,
      getClientId: Sinon.stub().returns('test-client-id'),
      getClientAddress: Sinon.stub().returns('127.0.0.1'),
      getSubscriptions: Sinon.stub().returns(new Map()),
      getChallenge: Sinon.stub().returns(challenge),
      getAuthenticatedPubkeys: Sinon.stub().returns(new Set()),
      addAuthenticatedPubkey: Sinon.stub(),
    } as any as IWebSocketAdapter

    settingsFactory = Sinon.stub().returns({
      info: { relay_url: relayUrl },
    } as Partial<Settings>)

    handler = new AuthMessageHandler(webSocket, settingsFactory)
  })

  afterEach(() => {
    Sinon.restore()
  })

  describe('handleMessage()', () => {
    it('authenticates successfully with a valid AUTH event', async () => {
      const message = await createAuthEvent()

      await handler.handleMessage(message)

      expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).to.have.been.calledOnceWithExactly(pubkey)
      expect(emitStub).to.have.been.calledOnce
      const args = emitStub.firstCall.args
      expect(args[0]).to.equal(WebSocketAdapterEvent.Message)
      expect(args[1][0]).to.equal('OK')
      expect(args[1][2]).to.equal(true)
    })

    it('rejects when kind is not 22242', async () => {
      const message = await createAuthEvent({ kind: 1 })

      await handler.handleMessage(message)

      expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).not.to.have.been.called
      expect(emitStub).to.have.been.calledOnce
      const args = emitStub.firstCall.args
      expect(args[1][2]).to.equal(false)
      expect(args[1][3]).to.include('kind 22242')
    })

    it('rejects when event ID does not match', async () => {
      const message = await createAuthEvent({ invalidId: true })

      await handler.handleMessage(message)

      expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).not.to.have.been.called
      expect(emitStub).to.have.been.calledOnce
      const args = emitStub.firstCall.args
      expect(args[1][2]).to.equal(false)
      expect(args[1][3]).to.include('event id does not match')
    })

    it('rejects when signature is invalid', async () => {
      const message = await createAuthEvent({ invalidSig: true })

      await handler.handleMessage(message)

      expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).not.to.have.been.called
      expect(emitStub).to.have.been.calledOnce
      const args = emitStub.firstCall.args
      expect(args[1][2]).to.equal(false)
      expect(args[1][3]).to.include('signature verification failed')
    })

    it('rejects when created_at is too far in the past', async () => {
      const tooOld = Math.floor(Date.now() / 1000) - 700
      const message = await createAuthEvent({ created_at: tooOld })

      await handler.handleMessage(message)

      expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).not.to.have.been.called
      expect(emitStub).to.have.been.calledOnce
      const args = emitStub.firstCall.args
      expect(args[1][2]).to.equal(false)
      expect(args[1][3]).to.include('created_at is too far')
    })

    it('rejects when created_at is too far in the future', async () => {
      const tooNew = Math.floor(Date.now() / 1000) + 700
      const message = await createAuthEvent({ created_at: tooNew })

      await handler.handleMessage(message)

      expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).not.to.have.been.called
      expect(emitStub).to.have.been.calledOnce
      const args = emitStub.firstCall.args
      expect(args[1][2]).to.equal(false)
      expect(args[1][3]).to.include('created_at is too far')
    })

    it('rejects when challenge tag does not match', async () => {
      const message = await createAuthEvent({ challenge: 'wrong-challenge' })

      await handler.handleMessage(message)

      expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).not.to.have.been.called
      expect(emitStub).to.have.been.calledOnce
      const args = emitStub.firstCall.args
      expect(args[1][2]).to.equal(false)
      expect(args[1][3]).to.include('challenge does not match')
    })

    it('rejects when relay tag does not match', async () => {
      const message = await createAuthEvent({ relayUrl: 'wss://wrong-relay.example.com' })

      await handler.handleMessage(message)

      expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).not.to.have.been.called
      expect(emitStub).to.have.been.calledOnce
      const args = emitStub.firstCall.args
      expect(args[1][2]).to.equal(false)
      expect(args[1][3]).to.include('relay url does not match')
    })

    it('rejects when relay tag has invalid URL', async () => {
      const message = await createAuthEvent({ relayUrl: 'not-a-url' })

      await handler.handleMessage(message)

      expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).not.to.have.been.called
      expect(emitStub).to.have.been.calledOnce
      const args = emitStub.firstCall.args
      expect(args[1][2]).to.equal(false)
      expect(args[1][3]).to.include('relay url does not match')
    })

    it('accepts relay URL with different path but same domain', async () => {
      const message = await createAuthEvent({ relayUrl: 'wss://relay.example.com/v1' })

      await handler.handleMessage(message)

      expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).to.have.been.calledOnceWithExactly(pubkey)
      const args = emitStub.firstCall.args
      expect(args[1][2]).to.equal(true)
    })

    it('accepts timestamp exactly at the 10-minute boundary', async () => {
      const clock = Sinon.useFakeTimers(Date.now())
      try {
        const exactBoundary = Math.floor(Date.now() / 1000) - 600
        const message = await createAuthEvent({ created_at: exactBoundary })

        await handler.handleMessage(message)

        expect((webSocket.addAuthenticatedPubkey as Sinon.SinonStub)).to.have.been.calledOnceWithExactly(pubkey)
      } finally {
        clock.restore()
      }
    })
  })
})
