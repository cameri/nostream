import { expect } from 'chai'

import { PeeringInvoiceStatus } from '../../../src/@types/peering'
import { PeeringInvoiceRepository } from '../../../src/repositories/peering-invoice-repository'
import { createRecordingKnex } from './recording-knex'

describe('PeeringInvoiceRepository', () => {
  const peerPubkey = 'a'.repeat(64)
  const now = new Date('2026-11-18T12:00:00.000Z')

  const row = {
    payment_hash: 'hash-1',
    event_id: 'event-1',
    peer_pubkey: Buffer.from(peerPubkey, 'hex'),
    bolt11: 'lnbc1invoice',
    amount_msats: '250000000',
    status: PeeringInvoiceStatus.HELD,
    reason: 'budget_exceeded',
    auto_paid: false,
    budget_period_start: now,
    budget_period_end: new Date(now.getTime() + 86_400_000),
    term_period_seconds: 86_400,
    expires_at: new Date(now.getTime() + 60_000),
    seen_count: 2,
    paid_at: null,
    created_at: now,
    updated_at: now,
  }

  const invoice = {
    paymentHash: 'hash-1',
    eventId: 'event-1',
    peerPubkey,
    bolt11: 'lnbc1invoice',
    amountMsats: 250_000_000n,
    status: PeeringInvoiceStatus.RECEIVED,
    reason: null,
    autoPaid: false,
    budgetPeriodStart: null,
    budgetPeriodEnd: null,
    termPeriodSeconds: null,
    expiresAt: null,
    seenCount: 1,
    paidAt: null,
    createdAt: now,
    updatedAt: now,
  }

  it('inserts a new invoice and maps it back', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([row])

    const result = await repository.insertIfNew(invoice)

    expect(result.inserted).to.equal(true)
    expect(result.invoice.amountMsats).to.equal(250_000_000n)
    expect(result.invoice.reason).to.equal('budget_exceeded')
    expect(recording.queries[0].sql).to.include('insert into "peering_invoices"')
    expect(recording.queries[0].sql).to.include('on conflict')
  })

  it('counts a duplicate payment hash without inserting twice', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([], [row], 1)

    const result = await repository.insertIfNew(invoice)

    expect(result.inserted).to.equal(false)
    expect(result.invoice.seenCount).to.equal(3)
    expect(recording.queries[1].sql).to.include('"peering_invoices"')
    expect(recording.queries[2].sql).to.include('"seen_count"')
  })

  it('updates only the provided invoice fields', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([{ ...row, status: 'paid', reason: null, auto_paid: true }])

    const result = await repository.update('hash-1', {
      status: PeeringInvoiceStatus.PAID,
      reason: null,
      autoPaid: true,
      paidAt: now,
    })

    expect(result?.status).to.equal(PeeringInvoiceStatus.PAID)
    expect(recording.queries[0].sql).to.include('"status"')
    expect(recording.queries[0].sql).to.include('"paid_at"')
    expect(recording.queries[0].sql).to.include('"auto_paid"')
  })

  it('claims a state transition atomically', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([{ ...row, status: 'paying' }])

    const result = await repository.claim(
      'hash-1',
      [PeeringInvoiceStatus.HELD],
      PeeringInvoiceStatus.PAYING,
    )

    expect(result?.status).to.equal(PeeringInvoiceStatus.PAYING)
    expect(recording.queries[0].sql).to.include('"status" in')
  })

  it('lists invoices filtered by status', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([row])

    const result = await repository.list([PeeringInvoiceStatus.HELD], 10)

    expect(result).to.have.length(1)
    expect(recording.queries[0].sql).to.include('"status" in')
    expect(recording.queries[0].sql).to.include('limit')
  })

  it('lists current budget counters for the admin console', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([
      {
        scope: `peer:${peerPubkey}`,
        period_start: now,
        period_end: new Date(now.getTime() + 86_400_000),
        spent_msats: '250000000',
      },
    ])

    const result = await repository.listBudgets()

    expect(result[0]).to.deep.include({ scope: `peer:${peerPubkey}`, spentMsats: 250_000_000n })
  })

  it('reserves and releases a budget atomically', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([{ spent_msats: '250000000' }], [{ spent_msats: '250000000' }], 1)

    const reserved = await repository.reserveBudget(
      `peer:${peerPubkey}`,
      now,
      new Date(now.getTime() + 86_400_000),
      250_000_000n,
      1_000_000_000n,
      recording.db,
    )
    const manual = await repository.addBudgetSpend(
      `peer:${peerPubkey}`,
      now,
      new Date(now.getTime() + 86_400_000),
      250_000_000n,
      recording.db,
    )
    await repository.releaseBudget(`peer:${peerPubkey}`, now, 250_000_000n, recording.db)

    expect(reserved).to.equal(250_000_000n)
    expect(manual).to.equal(250_000_000n)
    expect(recording.queries[0].sql.toLowerCase()).to.include('on conflict')
    expect(recording.queries[0].sql).to.include('<=')
    expect(recording.queries[2].sql.toLowerCase()).to.include('greatest')
  })
})
