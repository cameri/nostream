import { After, Before, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import Sinon from 'sinon'

import { MessageType } from '../../../../src/@types/messages'
import { Settings } from '../../../../src/@types/settings'
import { getMasterDbClient } from '../../../../src/database/client'
import { AuthMessageHandler } from '../../../../src/handlers/auth-message-handler'
import { PeeringRequestEventStrategy } from '../../../../src/handlers/event-strategies/peering-request-event-strategy'
import { PeeringAttestationRepository } from '../../../../src/repositories/peering-attestation-repository'
import { getPublicKey } from '../../../../src/utils/event'
import { buildPeeringAuthEvent } from '../../../../src/utils/peering-auth'
import { buildPeeringRequestEvent } from '../../../../src/utils/peering-attestation'

const ownerKey = '1'.repeat(64)
const relayKey = '2'.repeat(64)
const receiverKey = '3'.repeat(64)
const ownerPubkey = getPublicKey(ownerKey)
const relayPubkey = getPublicKey(relayKey)
const receiverPubkey = getPublicKey(receiverKey)
const relayUrl = 'wss://receiver.example.com'
const challenge = 'integration-peering-challenge'

const settingsFor = (): Settings =>
  ({
    info: { name: 'Receiver', relay_url: relayUrl, self: receiverPubkey },
    peering: {
      enabled: true,
      ownerAttestation: 'required',
      scopes: [{ kinds: [1] }],
      terms: [{ amount: 21000, unit: 'msats', period: 2592000 }],
      peers: [
        {
          pubkey: relayPubkey,
          relayUrl: 'wss://requester.example.com',
          ownerPubkey,
        },
      ],
    },
  }) as Settings

const adapterFor = (authenticated: string[] = []) => {
  const setPeerPubkey = Sinon.stub()
  const emit = Sinon.stub()
  const adapter = {
    emit,
    setPeerPubkey,
    getPeerPubkey: Sinon.stub().returns(undefined),
    getAuthenticatedPubkeys: Sinon.stub().returns(new Set(authenticated)),
    getChallenge: Sinon.stub().returns(challenge),
    addAuthenticatedPubkey: Sinon.stub().returns(true),
  }

  return { adapter, setPeerPubkey, emit }
}

Before({ tags: '@peering-owner-attestation' }, async function (this: World<Record<string, any>>) {
  this.parameters.attestationSandbox = Sinon.createSandbox()
  this.parameters.attestationDb = getMasterDbClient()
  await this.parameters
    .attestationDb('peering_attestations')
    .where('relay_pubkey', Buffer.from(relayPubkey, 'hex'))
    .delete()
})

After({ tags: '@peering-owner-attestation' }, async function (this: World<Record<string, any>>) {
  const db = this.parameters.attestationDb
  if (db) {
    await db('peering_attestations').where('relay_pubkey', Buffer.from(relayPubkey, 'hex')).delete()
  }
  this.parameters.attestationSandbox?.restore()
  this.parameters.attestationDb = undefined
})

When('a configured relay presents an owner-signed peering request', async function (this: World<Record<string, any>>) {
  const settings = settingsFor()
  const repository = new PeeringAttestationRepository(this.parameters.attestationDb)
  const now = new Date()
  const request = await buildPeeringRequestEvent({
    ownerPrivateKey: ownerKey,
    relayPubkey,
    relayUrl: 'wss://requester.example.com',
    receiverPubkey,
    scopes: settings.peering!.scopes!,
    terms: settings.peering!.terms!,
    createdAt: Math.floor(now.getTime() / 1000),
  })
  const { adapter, setPeerPubkey } = adapterFor([relayPubkey])
  const strategy = new PeeringRequestEventStrategy(
    adapter as any,
    () => settings,
    repository,
    () => now,
    () => receiverKey,
  )

  await strategy.execute(request)

  this.parameters.attestationRepository = repository
  this.parameters.attestationSettings = settings
  this.parameters.attestationRequest = request
  this.parameters.attestationSetPeerPubkey = setPeerPubkey
})

Then('the request is stored as an accepted attestation', async function (this: World<Record<string, any>>) {
  const repository = this.parameters.attestationRepository as PeeringAttestationRepository
  const attestation = await repository.findByRelayPubkey(relayPubkey)

  expect(attestation).to.exist
  expect(attestation?.ownerPubkey).to.equal(ownerPubkey)
  expect(attestation?.requestEventId).to.equal(this.parameters.attestationRequest.id)
  expect(attestation?.termsHash).to.equal(JSON.parse(this.parameters.attestationRequest.content).terms_hash)
  Sinon.assert.calledWith(this.parameters.attestationSetPeerPubkey, relayPubkey)
})

Then(
  'a later AUTH from that relay is recognized without repeating the request',
  async function (this: World<Record<string, any>>) {
    const authEvent = await buildPeeringAuthEvent({
      relayUrl,
      challenge,
      privateKey: relayKey,
      createdAt: Math.floor(Date.now() / 1000),
    })
    const { adapter, setPeerPubkey } = adapterFor()
    const handler = new AuthMessageHandler(
      adapter as any,
      () => this.parameters.attestationSettings,
      this.parameters.attestationRepository,
    )

    await handler.handleMessage([MessageType.AUTH, authEvent] as any)

    Sinon.assert.calledWith(setPeerPubkey, relayPubkey)
  },
)
