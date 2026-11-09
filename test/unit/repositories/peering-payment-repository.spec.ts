import { expect } from 'chai'

import { PeeringPaymentDirection, PeeringPaymentStatus } from '../../../src/@types/peering'
import { PeeringPaymentRepository } from '../../../src/repositories/peering-payment-repository'
import { createRecordingKnex } from './recording-knex'

describe('PeeringPaymentRepository', () => {
  const pubkey = 'a'.repeat(64)
  const now = new Date('2026-11-09T12:00:00.000Z')

  const row = {
    peer_pubkey: Buffer.from(pubkey, 'hex'),
    direction: PeeringPaymentDirection.SELL,
    status: PeeringPaymentStatus.ACTIVE,
    current_invoice_id: 'inv-1',
    renewal_invoice_id: null,
    period_start: now,
    period_end: new Date(now.getTime() + 86_400_000),
    term_amount_msats: '21000',
    term_period_seconds: 86_400,
    last_settled_invoice_id: 'inv-0',
    last_settled_at: now,
    last_checked_at: now,
    last_error: null,
    created_at: now,
    updated_at: now,
  }

  it('maps a stored row to the domain type', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringPaymentRepository(recording.db)
    recording.respondWith([row])

    const result = await repository.findByPeer(pubkey)

    expect(result).to.include({
      peerPubkey: pubkey,
      direction: PeeringPaymentDirection.SELL,
      status: PeeringPaymentStatus.ACTIVE,
      currentInvoiceId: 'inv-1',
      termPeriodSeconds: 86_400,
    })
    expect(result?.termAmountMsats).to.equal(21000n)
    expect(recording.queries[0].sql).to.include('"peering_payments"')
    expect(recording.queries[0].sql).to.include('"peer_pubkey"')
  })

  it('creates a missing row without overwriting an existing one', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringPaymentRepository(recording.db)
    recording.respondWith(0)

    await repository.ensureRow(pubkey, recording.db)

    const sql = recording.queries[0].sql
    expect(sql).to.include('insert into "peering_payments"')
    expect(sql).to.include('on conflict')
    expect(sql).to.include('do nothing')
  })

  it('locks the peer row for update', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringPaymentRepository(recording.db)
    recording.respondWith([row])

    await repository.lockByPeer(pubkey, recording.db)

    expect(recording.queries[0].sql).to.include('for update')
  })

  it('saves the billing state', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringPaymentRepository(recording.db)
    recording.respondWith(1)

    const saved = await repository.save(
      {
        peerPubkey: pubkey,
        direction: PeeringPaymentDirection.SELL,
        status: PeeringPaymentStatus.LAPSED,
        currentInvoiceId: null,
        renewalInvoiceId: null,
        periodStart: now,
        periodEnd: now,
        termAmountMsats: 21000n,
        termPeriodSeconds: 86_400,
        lastSettledInvoiceId: null,
        lastSettledAt: null,
        lastCheckedAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
      recording.db,
    )

    const sql = recording.queries[0].sql
    expect(sql).to.include('update "peering_payments"')
    expect(sql).to.include('"status"')
    expect(saved.status).to.equal(PeeringPaymentStatus.LAPSED)
  })

  it('finds periods due for renewal and periods that ended', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringPaymentRepository(recording.db)
    recording.respondWith([row], [row])

    await repository.findDueForRenewal(now, 10, 0)
    await repository.findPeriodEnded(now, 10, 0)

    expect(recording.queries[0].sql).to.include('"status" in')
    expect(recording.queries[0].sql).to.include('"period_end" <=')
    expect(recording.queries[1].sql).to.include('"status" in')
    expect(recording.queries[1].sql).to.include('"period_end" <=')
  })
})
