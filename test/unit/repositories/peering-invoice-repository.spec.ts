import { expect } from 'chai'

import { PeeringInvoiceStatus } from '../../../src/@types/peering'
import { PeeringInvoiceRepository } from '../../../src/repositories/peering-invoice-repository'
import { createRecordingKnex } from './recording-knex'

const rejection = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

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
    payment_attempt_id: null,
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
    paymentAttemptId: null,
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
    recording.respondWith([], [row], [{ ...row, seen_count: 3, updated_at: now }])

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
      budgetPeriodStart: now,
      budgetPeriodEnd: new Date(now.getTime() + 60_000),
      termPeriodSeconds: 60,
    })

    expect(result?.status).to.equal(PeeringInvoiceStatus.PAID)
    expect(recording.queries[0].sql).to.include('"status"')
    expect(recording.queries[0].sql).to.include('"paid_at"')
    expect(recording.queries[0].sql).to.include('"auto_paid"')
    expect(recording.queries[0].sql).to.include('"budget_period_start"')
    expect(recording.queries[0].sql).to.include('"budget_period_end"')
    expect(recording.queries[0].sql).to.include('"term_period_seconds"')
    const bindings = recording.queries[0].bindings as unknown[]
    expect((bindings[5] as Date).getTime()).to.equal(now.getTime())
    expect((bindings[6] as Date).getTime()).to.equal(now.getTime() + 60_000)
    expect(bindings[7]).to.equal(60)
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

  it('claims an invoice for a new payment attempt', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([{ ...row, status: 'paying', payment_attempt_id: 'attempt-1' }])

    const result = await repository.claimForAttempt(
      'hash-1',
      [PeeringInvoiceStatus.HELD],
      PeeringInvoiceStatus.PAYING,
      'attempt-1',
      { autoPaid: false },
    )

    expect(result?.paymentAttemptId).to.equal('attempt-1')
    expect(recording.queries[0].sql).to.include('"payment_attempt_id"')
    for (const column of [
      'budget_period_start',
      'budget_period_end',
      'global_budget_period_start',
      'global_budget_period_end',
    ]) {
      expect(recording.queries[0].sql).to.include(`"${column}"`)
    }
    expect(recording.queries[0].bindings).to.include('attempt-1')
  })

  it('transitions only the invoice still owned by the attempt', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([{ ...row, status: 'paid', payment_attempt_id: 'attempt-1', paid_at: now }])

    const result = await repository.transitionAttempt(
      'hash-1',
      'attempt-1',
      [PeeringInvoiceStatus.PAYING],
      PeeringInvoiceStatus.PAID,
      { paidAt: now },
    )

    expect(result?.status).to.equal(PeeringInvoiceStatus.PAID)
    expect(recording.queries[0].sql).to.include('"payment_attempt_id"')
    // A pending attempt must be able to persist its own PAYING row, but only
    // while the invoice is still PAYING.
    expect(recording.queries[0].sql).to.include('"status" in')
    expect(recording.queries[0].sql).not.to.include('"status" not in')
    expect(recording.queries[0].bindings).to.include('attempt-1')
  })

  it('does not transition an invoice owned by a newer attempt', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([])

    expect(
      await repository.transitionAttempt(
        'hash-1',
        'attempt-1',
        [PeeringInvoiceStatus.PAYING],
        PeeringInvoiceStatus.PAID,
      ),
    ).to.equal(undefined)
    expect(recording.queries[0].bindings).to.include('attempt-1')
  })

  it('holds only a PAYING attempt that has been idle long enough', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([{ ...row, status: 'held' }])

    const result = await repository.transitionStale(
      'hash-1',
      'attempt-1',
      now,
      PeeringInvoiceStatus.HELD,
    )

    expect(result?.status).to.equal(PeeringInvoiceStatus.HELD)
    expect(recording.queries[0].sql).to.include('"payment_attempt_id"')
    expect(recording.queries[0].sql).to.include('"status" in')
    expect(recording.queries[0].sql).to.include('"updated_at" <')
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

  it('throws when a duplicate row disappears before the fallback read', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([], [])

    expect(await rejection(repository.insertIfNew(invoice))).to.equal('Unable to load peering invoice hash-1')
    expect(recording.queries).to.have.length(2)
    expect(recording.queries[0].sql).to.include('insert into "peering_invoices"')
    expect(recording.queries[1].sql).to.include('select')
  })

  it('re-reads a duplicate row when the counter update returns no row', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([], [row], [], [{ ...row, seen_count: 2 }])

    const result = await repository.insertIfNew(invoice)

    expect(result.inserted).to.equal(false)
    expect(result.invoice.seenCount).to.equal(2)
  })

  it('rejects a negative budget reservation', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)

    expect(await rejection(repository.reserveBudget(`peer:${peerPubkey}`, now, now, -1n, 1_000n, recording.db))).to.equal(
      'budget reservation amount must be non-negative',
    )
    expect(recording.queries).to.be.empty
  })

  it('counts invoices in a budget window without a capped list', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([{ received: '2', paid: '1', held: '1' }])

    const counts = await repository.countInWindow(peerPubkey, now, new Date(now.getTime() + 60_000))

    expect(counts).to.deep.equal({ received: 2, paid: 1, held: 1 })
    expect(recording.queries[0].sql.toLowerCase()).to.include('filter (where status =')
  })

  it('records manual spend, releases it and reads budget rows', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith(
      [{ spent_msats: '500000000' }],
      1,
      [{ scope: `peer:${peerPubkey}`, period_start: now, period_end: now, spent_msats: '500000000' }],
    )

    const spent = await repository.addBudgetSpend(`peer:${peerPubkey}`, now, now, 250_000_000n, recording.db)
    await repository.releaseBudget(`peer:${peerPubkey}`, now, 250_000_000n, recording.db)
    const rows = await repository.listBudgets()

    expect(spent).to.equal(500_000_000n)
    expect(rows[0].spentMsats).to.equal(500_000_000n)
  })

  it('rejects negative manual spend and release amounts', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)

    expect(await rejection(repository.addBudgetSpend(`peer:${peerPubkey}`, now, now, -1n, recording.db))).to.equal(
      'budget spend amount must be non-negative',
    )
    expect(await rejection(repository.releaseBudget(`peer:${peerPubkey}`, now, -1n, recording.db))).to.equal(
      'budget release amount must be non-negative',
    )
    expect(recording.queries).to.be.empty
  })

  it('refuses a first reservation that already exceeds the limit', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([])

    const result = await repository.reserveBudget(
      `peer:${peerPubkey}`,
      now,
      new Date(now.getTime() + 86_400_000),
      2_000n,
      1_000n,
      recording.db,
    )

    expect(result).to.be.undefined
    expect(recording.queries[0].sql).to.include('WHERE CAST(')
    expect(recording.queries[0].sql).to.include('<= CAST(')
  })

  it('reserves a budget while the total stays inside the limit', async () => {
    const recording = createRecordingKnex()
    const repository = new PeeringInvoiceRepository(recording.db)
    recording.respondWith([{ spent_msats: '250000000' }])

    const reserved = await repository.reserveBudget(
      `peer:${peerPubkey}`,
      now,
      new Date(now.getTime() + 86_400_000),
      250_000_000n,
      1_000_000_000n,
      recording.db,
    )

    expect(reserved).to.equal(250_000_000n)
    expect(recording.queries[0].sql.toLowerCase()).to.include('on conflict')
    expect(recording.queries[0].sql).to.include('<=')
    expect(recording.queries[0].bindings).to.have.length(8)
    expect(recording.queries[0].bindings[6]).to.equal('1000000000')
  })
})
