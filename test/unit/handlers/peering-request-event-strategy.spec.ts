import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import type { IWebSocketAdapter } from '../../../src/@types/adapters'
import type { Settings } from '../../../src/@types/settings'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'
import { PeeringAcceptanceEventStrategy } from '../../../src/handlers/event-strategies/peering-acceptance-event-strategy'
import { PeeringRequestEventStrategy } from '../../../src/handlers/event-strategies/peering-request-event-strategy'
import { buildPeeringRequestEvent } from '../../../src/utils/peering-attestation'
import { getPublicKey } from '../../../src/utils/event'

chai.use(sinonChai)
const { expect } = chai

const ownerKey = '1'.repeat(64)
const receiverKey = '3'.repeat(64)
const relayPubkey = getPublicKey('2'.repeat(64))
const receiverPubkey = getPublicKey(receiverKey)
const now = new Date('2026-11-23T12:00:00.000Z')

const settingsFor = (overrides: Partial<Settings['peering']> = {}): Settings =>
  ({
    info: { relay_url: 'wss://receiver.example.com', self: receiverPubkey },
    peering: {
      enabled: true,
      scopes: [{ kinds: [1] }],
      terms: [{ amount: 21000, unit: 'msats', period: 2592000 }],
      peers: [{ pubkey: relayPubkey, relayUrl: 'wss://requester.example.com' }],
      ownerAttestation: 'preferred',
      ...overrides,
    },
  }) as Settings

const requestFor = () =>
  buildPeeringRequestEvent({
    ownerPrivateKey: ownerKey,
    relayPubkey,
    relayUrl: 'wss://requester.example.com',
    receiverPubkey,
    scopes: [{ kinds: [1] }],
    terms: [{ amount: 21000, unit: 'msats', period: 2592000 }],
    createdAt: Math.floor(now.getTime() / 1000),
  })

describe('PeeringRequestEventStrategy', () => {
  let emit: Sinon.SinonStub
  let setPeerPubkey: Sinon.SinonStub
  let webSocket: IWebSocketAdapter
  let attestations: { save: Sinon.SinonStub; findByRelayPubkey: Sinon.SinonStub }

  beforeEach(() => {
    emit = Sinon.stub()
    setPeerPubkey = Sinon.stub()
    webSocket = {
      emit,
      setPeerPubkey,
      getPeerPubkey: Sinon.stub().returns(undefined),
      getAuthenticatedPubkeys: Sinon.stub().returns(new Set([relayPubkey])),
    } as any as IWebSocketAdapter
    attestations = {
      save: Sinon.stub().callsFake(async (value) => value),
      findByRelayPubkey: Sinon.stub().resolves(undefined),
    }
  })

  afterEach(() => Sinon.restore())

  it('records a valid request and returns a signed acceptance', async () => {
    const event = await requestFor()
    const strategy = new PeeringRequestEventStrategy(
      webSocket,
      () => settingsFor(),
      attestations,
      () => now,
      () => receiverKey,
    )

    await strategy.execute(event)

    expect(attestations.save).to.have.been.calledOnce
    expect(setPeerPubkey).to.have.been.calledWith(relayPubkey)
    const messages = emit.getCalls().map((call) => call.args[1])
    const ok = messages.find((message) => message[0] === 'OK')
    const acceptance = messages.find((message) => message[0] === 'EVENT')
    expect(ok?.[2]).to.equal(true)
    expect(acceptance?.[2].kind).to.equal(28938)
    expect(acceptance?.[2].pubkey).to.equal(receiverPubkey)
    expect(emit.firstCall.args[0]).to.equal(WebSocketAdapterEvent.Message)
  })

  it('rejects a request signed by an owner other than the configured one', async () => {
    const event = await requestFor()
    const strategy = new PeeringRequestEventStrategy(
      webSocket,
      () =>
        settingsFor({
          peers: [
            { pubkey: relayPubkey, relayUrl: 'wss://requester.example.com', ownerPubkey: getPublicKey('4'.repeat(64)) },
          ],
        }),
      attestations,
      () => now,
      () => receiverKey,
    )

    await strategy.execute(event)

    expect(attestations.save).not.to.have.been.called
    const ok = emit
      .getCalls()
      .map((call) => call.args[1])
      .find((message) => message[0] === 'OK')
    expect(ok?.[2]).to.equal(false)
    expect(ok?.[3]).to.include('owner')
  })

  it('rejects when the attestation store is unavailable', async () => {
    const event = await requestFor()
    const strategy = new PeeringRequestEventStrategy(
      webSocket,
      () => settingsFor(),
      undefined,
      () => now,
      () => receiverKey,
    )

    await strategy.execute(event)

    expect(setPeerPubkey).not.to.have.been.called
    const ok = emit
      .getCalls()
      .map((call) => call.args[1])
      .find((message) => message[0] === 'OK')
    expect(ok?.[3]).to.include('unavailable')
  })

  it('rejects when the attestation cannot be stored', async () => {
    const event = await requestFor()
    attestations.save.rejects(new Error('database down'))
    const strategy = new PeeringRequestEventStrategy(
      webSocket,
      () => settingsFor(),
      attestations,
      () => now,
      () => receiverKey,
    )

    await strategy.execute(event)

    expect(setPeerPubkey).not.to.have.been.called
    const ok = emit
      .getCalls()
      .map((call) => call.args[1])
      .find((message) => message[0] === 'OK')
    expect(ok?.[3]).to.include('unable to record')
  })

  it('rejects a valid request from a relay that is not configured', async () => {
    const event = await requestFor()
    const strategy = new PeeringRequestEventStrategy(
      webSocket,
      () => settingsFor({ peers: [] }),
      attestations,
      () => now,
      () => receiverKey,
    )

    await strategy.execute(event)

    expect(attestations.save).not.to.have.been.called
    expect(setPeerPubkey).not.to.have.been.called
    const ok = emit
      .getCalls()
      .map((call) => call.args[1])
      .find((message) => message[0] === 'OK')
    expect(ok?.[2]).to.equal(false)
    expect(ok?.[3]).to.include('configured')
  })

  it('rejects a request whose terms no longer match the advertisement', async () => {
    const event = await requestFor()
    const strategy = new PeeringRequestEventStrategy(
      webSocket,
      () => settingsFor({ terms: [{ amount: 22000, unit: 'msats', period: 2592000 }] }),
      attestations,
      () => now,
      () => receiverKey,
    )

    await strategy.execute(event)

    expect(attestations.save).not.to.have.been.called
    expect(setPeerPubkey).not.to.have.been.called
    const ok = emit
      .getCalls()
      .map((call) => call.args[1])
      .find((message) => message[0] === 'OK')
    expect(ok?.[2]).to.equal(false)
    expect(ok?.[3]).to.include('terms changed')
  })

  it('rejects when peering is disabled', async () => {
    const event = await requestFor()
    const strategy = new PeeringRequestEventStrategy(
      webSocket,
      () => settingsFor({ enabled: false }),
      attestations,
      () => now,
      () => receiverKey,
    )

    await strategy.execute(event)

    expect(attestations.save).not.to.have.been.called
    const ok = emit
      .getCalls()
      .map((call) => call.args[1])
      .find((message) => message[0] === 'OK')
    expect(ok?.[3]).to.include('peering is not enabled')
  })
})

describe('PeeringAcceptanceEventStrategy', () => {
  it('rejects a client-published acceptance', async () => {
    const emit = Sinon.stub()
    const strategy = new PeeringAcceptanceEventStrategy({ emit } as any)

    await strategy.execute({ id: 'event-1' } as any)

    const ok = emit.firstCall.args[1]
    expect(ok[0]).to.equal('OK')
    expect(ok[2]).to.equal(false)
    expect(ok[3]).to.include('issued by the relay')
  })
})
