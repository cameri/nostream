import { expect } from 'chai'

import { PeeringAttestationRepository } from '../../../src/repositories/peering-attestation-repository'
import { createRecordingKnex } from './recording-knex'

const peerPubkey = 'a'.repeat(64)
const ownerPubkey = 'b'.repeat(64)
const now = new Date('2026-11-23T12:00:00.000Z')

const row = {
  relay_pubkey: Buffer.from(peerPubkey, 'hex'),
  owner_pubkey: Buffer.from(ownerPubkey, 'hex'),
  relay_url: 'wss://peer.example.com',
  request_event_id: 'c'.repeat(64),
  scopes: [{ kinds: [1] }],
  terms: [{ amount: 21000, unit: 'msats', period: 2592000 }],
  terms_hash: 'd'.repeat(64),
  pow_difficulty: 12,
  accepted_at: now,
  created_at: now,
  updated_at: now,
}

const attestation = {
  relayPubkey: peerPubkey,
  ownerPubkey,
  relayUrl: 'wss://peer.example.com',
  requestEventId: 'c'.repeat(64),
  scopes: [{ kinds: [1] }],
  terms: [{ amount: 21000, unit: 'msats', period: 2592000 }],
  termsHash: 'd'.repeat(64),
  powDifficulty: 12,
  acceptedAt: now,
  createdAt: now,
  updatedAt: now,
}

describe('PeeringAttestationRepository', () => {
  it('maps a stored attestation back to the domain shape', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringAttestationRepository(recording.db)
    recording.respondWith([row])

    const result = await repository.findByRelayPubkey(peerPubkey)

    expect(result).to.deep.equal({
      ...attestation,
      scopes: [{ kinds: [1] }],
      terms: [{ amount: 21000, unit: 'msats', period: 2592000 }],
    })
  })

  it('upserts the latest accepted request for a relay', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringAttestationRepository(recording.db)
    recording.respondWith([row])

    const result = await repository.save(attestation)

    expect(recording.queries[0].sql).to.include('insert into "peering_attestations"')
    expect(recording.queries[0].sql).to.include('on conflict')
    expect(result.relayPubkey).to.equal(peerPubkey)
    expect(result.powDifficulty).to.equal(12)
  })
})
