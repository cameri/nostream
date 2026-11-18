import { After, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { PeeringInvoiceStatus } from '../../../../src/@types/peering'
import { getMasterDbClient } from '../../../../src/database/client'
import { PeeringInvoiceRepository } from '../../../../src/repositories/peering-invoice-repository'
import { decodeBolt11 } from '../../../../src/utils/bolt11'

const INVOICE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'
const now = new Date('2026-11-18T12:00:00.000Z')
When(
  'the buyer ingests one invoice twice and reserves against a {int} msat budget',
  async function (this: World<Record<string, any>>, limit: number) {
    const db = getMasterDbClient()
    const repository = new PeeringInvoiceRepository(db)
    const peerPubkey = randomBytes(32).toString('hex')
    const paymentHash = randomBytes(32).toString('hex')
    const scope = `peer:${peerPubkey}`
    this.parameters.ledgerPaymentHash = paymentHash
    this.parameters.ledgerDb = db
    this.parameters.ledgerScopes = [scope]
    this.parameters.ledgerInvoice = {
      paymentHash,
      eventId: `event-${peerPubkey}`,
      peerPubkey,
      bolt11: INVOICE,
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

    const first = await repository.insertIfNew(this.parameters.ledgerInvoice)
    const second = await repository.insertIfNew(this.parameters.ledgerInvoice)
    this.parameters.ledgerInserted = [first.inserted, second.inserted]
    this.parameters.ledgerSeen = second.invoice.seenCount
    this.parameters.ledgerFirst = await repository.reserveBudget(scope, now, new Date(now.getTime() + 60_000), 600n, BigInt(limit), db)
    this.parameters.ledgerSecond = await repository.reserveBudget(scope, now, new Date(now.getTime() + 60_000), 600n, BigInt(limit), db)
  },
)
Then(
  'the ledger has one row with two sightings and the second reservation is refused',
  async function (this: World<Record<string, any>>) {
    const db = this.parameters.ledgerDb
    const scope = this.parameters.ledgerScopes[0]
    const rows = await db('peering_invoices').where('payment_hash', this.parameters.ledgerPaymentHash)
    const budget = await db('peering_budgets').where('scope', scope).first()
    const decoded = decodeBolt11(INVOICE)

    expect(this.parameters.ledgerInserted).to.deep.equal([true, false])
    expect(this.parameters.ledgerSeen).to.equal(2)
    expect(rows).to.have.length(1)
    expect(rows[0].seen_count).to.equal(2)
    expect(this.parameters.ledgerFirst).to.equal(600n)
    expect(this.parameters.ledgerSecond).to.be.undefined
    expect(String(budget.spent_msats)).to.equal('600')
    expect(decoded.paymentHash).to.equal('0001020304050607080900010203040506070809000102030405060708090102')
    expect(decoded.amountMsats).to.equal(250_000_000n)
  },
)

After({ tags: '@peering-buyer-ledger' }, async function (this: World<Record<string, any>>) {
  const db = this.parameters.ledgerDb
  if (!db) return
  if (this.parameters.ledgerPaymentHash) {
    await db('peering_invoices').where('payment_hash', this.parameters.ledgerPaymentHash).delete()
  }
  if (this.parameters.ledgerScopes?.length) {
    await db('peering_budgets').whereIn('scope', this.parameters.ledgerScopes).delete()
  }
  this.parameters.ledgerDb = undefined
  this.parameters.ledgerScopes = []
  this.parameters.ledgerPaymentHash = undefined
})
