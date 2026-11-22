import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { PaymentsProcessorOutcomeUnknownError } from '../../../src/@types/clients'
import { Event } from '../../../src/@types/event'
import {
  PeeringInvoice,
  PeeringInvoiceReason,
  PeeringInvoiceStatus,
} from '../../../src/@types/peering'
import { PeeringPeer, Settings } from '../../../src/@types/settings'
import { PeeringBuyerService } from '../../../src/services/peering-buyer-service'
import { peeringBudgetWindow } from '../../../src/utils/peering-billing'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

const INVOICE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'
const PAYMENT_HASH = '0001020304050607080900010203040506070809000102030405060708090102'
const SELF = 'b'.repeat(64)
const PEER = 'a'.repeat(64)

describe('PeeringBuyerService', () => {
  const now = new Date('2026-11-18T12:00:00.000Z')
  let sandbox: Sinon.SinonSandbox
  let service: PeeringBuyerService
  let dbClient: any
  let trx: { commit: Sinon.SinonStub; rollback: Sinon.SinonStub }
  let invoiceRepository: any
  let paymentsService: any
  let notificationOutboxRepository: any
  let settings: Settings
  let peer: PeeringPeer
  let event: Event

  const invoice = (overrides: Partial<PeeringInvoice> = {}): PeeringInvoice => ({
    paymentHash: PAYMENT_HASH,
    eventId: 'event-1',
    peerPubkey: PEER,
    bolt11: INVOICE,
    amountMsats: 250_000_000n,
    status: PeeringInvoiceStatus.RECEIVED,
    reason: null,
    autoPaid: false,
    budgetPeriodStart: null,
    budgetPeriodEnd: null,
    termPeriodSeconds: 2592000,
    expiresAt: new Date(now.getTime() + 60_000),
    seenCount: 1,
    paidAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })

  const advertisement = {
    enabled: true,
    scopes: [{ kinds: [1] }],
    terms: [{ amount: 250_000_000, unit: 'msats', period: 2592000 }],
    supportedNips: [77],
  }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    trx = { commit: sandbox.stub().resolves(), rollback: sandbox.stub().resolves() }
    dbClient = { transaction: sandbox.stub().resolves(trx) }

    invoiceRepository = {
      insertIfNew: sandbox.stub().resolves({ inserted: true, invoice: invoice() }),
      findByHash: sandbox.stub().resolves(invoice()),
      update: sandbox.stub().callsFake(async (_hash, changes) => invoice(changes)),
      claim: sandbox.stub().resolves(invoice({ status: PeeringInvoiceStatus.PAYING })),
      claimForAttempt: sandbox.stub().callsFake(async (_hash, _from, to, attemptId, changes) =>
        invoice({ ...changes, status: to, paymentAttemptId: attemptId }),
      ),
      transitionAttempt: sandbox.stub().callsFake(async (_hash, attemptId, to, changes) =>
        invoice({ ...changes, status: to, paymentAttemptId: attemptId }),
      ),
      list: sandbox.stub().resolves([]),
      reserveBudget: sandbox.stub().resolves(250_000_000n),
      addBudgetSpend: sandbox.stub().resolves(250_000_000n),
      releaseBudget: sandbox.stub().resolves(),
      listBudgets: sandbox.stub().resolves([]),
      countInWindow: sandbox.stub().resolves({ received: 0, paid: 0, held: 0 }),
    }

    paymentsService = {
      payInvoice: sandbox.stub().resolves({ paymentHash: PAYMENT_HASH, settled: true }),
    }

    notificationOutboxRepository = { enqueue: sandbox.stub().resolves() }

    settings = {
      info: { name: 'relay', relay_url: 'wss://relay.example.com' },
      payments: { enabled: true },
      peering: {
        enabled: true,
        autoPay: {
          enabled: true,
          globalBudget: { amount: 10_000_000_000, unit: 'msats', period: 2592000 },
        },
        peers: [
          {
            pubkey: PEER,
            relayUrl: 'wss://peer.example.com',
            budget: { amount: 1_000_000_000, unit: 'msats', period: 2592000 },
          },
        ],
      },
    } as Settings

    peer = settings.peering!.peers![0]
    event = {
      id: 'event-1',
      pubkey: PEER,
      created_at: Math.floor(now.getTime() / 1000),
      kind: 402,
      tags: [
        ['p', SELF],
        ['t', 'peering'],
        ['bolt11', INVOICE],
        ['i', 'seller-invoice-1'],
        ['expiration', String(Math.floor(now.getTime() / 1000) + 60)],
      ],
      content: '',
      sig: 'c'.repeat(128),
    }

    service = new PeeringBuyerService(
      dbClient,
      invoiceRepository,
      paymentsService,
      notificationOutboxRepository,
      () => settings,
      () => SELF,
    )
  })

  afterEach(() => sandbox.restore())

  it('auto-pays a trusted invoice that matches the advertised term', async () => {
    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(paymentsService.payInvoice).to.have.been.calledOnceWith(INVOICE)
    expect(invoiceRepository.reserveBudget).to.have.been.calledTwice
    expect(invoiceRepository.transitionAttempt).to.have.been.calledWith(
      PAYMENT_HASH,
      Sinon.match.any,
      PeeringInvoiceStatus.PAID,
      Sinon.match({ autoPaid: true, reason: null }),
    )
    expect(result.status).to.equal(PeeringInvoiceStatus.PAID)
  })

  it('holds an invoice over the per-peer budget without paying', async () => {
    invoiceRepository.reserveBudget.resolves(undefined)

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(result.status).to.equal(PeeringInvoiceStatus.HELD)
    expect(result.reason).to.equal(PeeringInvoiceReason.BUDGET_EXCEEDED)
  })

  it('holds an invoice whose amount does not match the advertised term', async () => {
    const result = await service.handleInvoice(
      peer,
      { ...advertisement, terms: [{ amount: 21_000, unit: 'sats', period: 2592000 }] },
      event,
      now,
    )

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(result.reason).to.equal(PeeringInvoiceReason.AMOUNT_MISMATCH)
  })

  it('holds an invoice when auto-pay is disabled', async () => {
    settings.peering!.autoPay!.enabled = false

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(result.reason).to.equal(PeeringInvoiceReason.AUTO_PAY_DISABLED)
  })

  it('holds an invoice from an unconfigured pubkey', async () => {
    event.pubkey = 'd'.repeat(64)

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(result.reason).to.equal(PeeringInvoiceReason.UNKNOWN_PEER)
  })

  it('does not pay a duplicate payment hash twice', async () => {
    invoiceRepository.insertIfNew.resolves({
      inserted: false,
      invoice: invoice({ status: PeeringInvoiceStatus.PAID, paidAt: now }),
    })

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(result.status).to.equal(PeeringInvoiceStatus.PAID)
  })

  it('holds and releases the budget when the wallet payment fails', async () => {
    paymentsService.payInvoice.rejects(new Error('insufficient balance'))

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(invoiceRepository.releaseBudget).to.have.been.calledTwice
    expect(result.status).to.equal(PeeringInvoiceStatus.HELD)
    expect(result.reason).to.equal(PeeringInvoiceReason.PAYMENT_FAILED)
  })

  it('approves a held invoice and records manual spend', async () => {
    invoiceRepository.findByHash.resolves(invoice({ status: PeeringInvoiceStatus.HELD }))
    invoiceRepository.claimForAttempt.resolves(
      invoice({ status: PeeringInvoiceStatus.PAYING, paymentAttemptId: 'attempt-1' }),
    )

    const result = await service.approve(PAYMENT_HASH, now)

    expect(paymentsService.payInvoice).to.have.been.calledOnce
    expect(invoiceRepository.claimForAttempt).to.have.been.calledWith(
      PAYMENT_HASH,
      [PeeringInvoiceStatus.HELD, PeeringInvoiceStatus.FAILED],
      PeeringInvoiceStatus.PAYING,
      Sinon.match.string,
    )
    expect(invoiceRepository.addBudgetSpend).to.have.been.calledTwice
    expect(invoiceRepository.transitionAttempt).to.have.been.calledWith(
      PAYMENT_HASH,
      Sinon.match.any,
      PeeringInvoiceStatus.PAID,
      Sinon.match({ autoPaid: false }),
    )
    expect(result.status).to.equal(PeeringInvoiceStatus.PAID)
  })

  it('rejects a held invoice', async () => {
    invoiceRepository.claim.resolves(invoice({ status: PeeringInvoiceStatus.REJECTED }))

    const result = await service.reject(PAYMENT_HASH)

    expect(result.status).to.equal(PeeringInvoiceStatus.REJECTED)
    expect(paymentsService.payInvoice).not.to.have.been.called
  })


  it('holds an invoice when the peer advertises an invalid term', async () => {
    const result = await service.handleInvoice(
      peer,
      {
        ...advertisement,
        terms: [
          { amount: 1000, unit: 'msats', period: 3600 },
          { amount: 2000, unit: 'msats', period: 3600 },
        ],
      },
      event,
      now,
    )

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(result.reason).to.equal(PeeringInvoiceReason.AMOUNT_MISMATCH)
  })

  it('holds an invoice when the peer has no budget configured', async () => {
    peer.budget = undefined

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(result.reason).to.equal(PeeringInvoiceReason.BUDGET_NOT_CONFIGURED)
  })

  it('holds an expired invoice without reserving a budget', async () => {
    event.tags = event.tags.map((tag) =>
      tag[0] === 'expiration' ? ['expiration', String(Math.floor(now.getTime() / 1000) - 1)] : tag,
    )

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(invoiceRepository.reserveBudget).not.to.have.been.called
    expect(result.reason).to.equal(PeeringInvoiceReason.EXPIRED)
  })

  it('holds when the global budget has no room even if the peer budget does', async () => {
    invoiceRepository.reserveBudget.onFirstCall().resolves(250_000_000n)
    invoiceRepository.reserveBudget.onSecondCall().resolves(undefined)

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(result.reason).to.equal(PeeringInvoiceReason.BUDGET_EXCEEDED)
  })

  it('holds when the processor reports a different payment hash', async () => {
    paymentsService.payInvoice.resolves({ paymentHash: 'f'.repeat(64), settled: true })

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(invoiceRepository.releaseBudget).not.to.have.been.called
    expect(result.status).to.equal(PeeringInvoiceStatus.PAYING)
    expect(result.reason).to.equal(PeeringInvoiceReason.PAYMENT_FAILED)
  })

  it('keeps the charge when the wallet paid but the paid update fails', async () => {
    invoiceRepository.transitionAttempt
      .onFirstCall()
      .resolves(invoice({ status: PeeringInvoiceStatus.PAYING }))
      .onSecondCall()
      .rejects(new Error('database down'))

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(invoiceRepository.releaseBudget).not.to.have.been.called
    expect(result.status).to.equal(PeeringInvoiceStatus.PAYING)
  })

  it('recovers a paying invoice from the wallet result', async () => {
    invoiceRepository.list.resolves([invoice({ status: PeeringInvoiceStatus.PAYING })])
    paymentsService.getInvoiceFromPaymentsProcessor = sandbox.stub().resolves({ status: 'completed' })

    expect(await service.recover(now)).to.equal(1)
    expect(invoiceRepository.update).to.have.been.calledWith(
      PAYMENT_HASH,
      Sinon.match({ status: PeeringInvoiceStatus.PAID, autoPaid: false }),
    )
  })

  it('releases and holds a paying invoice the wallet reports expired', async () => {
    invoiceRepository.list.resolves([
      invoice({
        status: PeeringInvoiceStatus.PAYING,
        autoPaid: true,
        budgetPeriodStart: now,
        budgetPeriodEnd: new Date(now.getTime() + 60_000),
        globalBudgetPeriodStart: now,
        globalBudgetPeriodEnd: new Date(now.getTime() + 60_000),
      }),
    ])
    paymentsService.getInvoiceFromPaymentsProcessor = sandbox.stub().resolves({ status: 'expired' })
    invoiceRepository.claim.resolves(invoice({ status: PeeringInvoiceStatus.HELD }))

    expect(await service.recover(now)).to.equal(1)
    expect(invoiceRepository.claim).to.have.been.calledWith(
      PAYMENT_HASH,
      [PeeringInvoiceStatus.PAYING],
      PeeringInvoiceStatus.HELD,
    )
    expect(invoiceRepository.releaseBudget).to.have.been.calledTwice
    expect(invoiceRepository.update).to.have.been.calledWith(
      PAYMENT_HASH,
      Sinon.match({ reason: PeeringInvoiceReason.PAYMENT_FAILED, autoPaid: false }),
    )
  })

  it('leaves a newer attempt alone when an old recovery finds the invoice expired', async () => {
    invoiceRepository.list.resolves([
      invoice({
        status: PeeringInvoiceStatus.PAYING,
        paymentAttemptId: 'attempt-1',
        budgetPeriodStart: now,
        budgetPeriodEnd: new Date(now.getTime() + 60_000),
      }),
    ])
    paymentsService.getInvoiceFromPaymentsProcessor = sandbox.stub().resolves({ status: 'expired' })
    invoiceRepository.transitionAttempt.resolves(undefined)

    expect(await service.recover(now)).to.equal(0)
    expect(invoiceRepository.transitionAttempt).to.have.been.calledWith(
      PAYMENT_HASH,
      'attempt-1',
      PeeringInvoiceStatus.HELD,
    )
    expect(invoiceRepository.releaseBudget).not.to.have.been.called
    expect(invoiceRepository.claim).not.to.have.been.called
  })

  it('still records a payment when the notification outbox fails', async () => {
    notificationOutboxRepository.enqueue.rejects(new Error('outbox down'))

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(result.status).to.equal(PeeringInvoiceStatus.PAID)
  })

  it('throws when approving an unknown or already-decided invoice', async () => {
    invoiceRepository.findByHash.resolves(undefined)
    await expect(service.approve(PAYMENT_HASH, now)).to.be.rejectedWith('not found')

    invoiceRepository.findByHash.resolves(invoice({ status: PeeringInvoiceStatus.PAID }))
    expect((await service.approve(PAYMENT_HASH, now)).status).to.equal(PeeringInvoiceStatus.PAID)

    invoiceRepository.findByHash.resolves(invoice({ status: PeeringInvoiceStatus.HELD }))
    invoiceRepository.claimForAttempt.resolves(undefined)
    await expect(service.approve(PAYMENT_HASH, now)).to.be.rejectedWith('not awaiting approval')
    invoiceRepository.claim.resolves(undefined)
    await expect(service.reject(PAYMENT_HASH)).to.be.rejectedWith('not awaiting a decision')
  })


  it('records a malformed invoice instead of dropping it', async () => {
    event.tags = event.tags.filter((tag) => tag[0] !== 'bolt11')

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(result.reason).to.equal(PeeringInvoiceReason.INVALID_INVOICE)
    expect(invoiceRepository.insertIfNew).to.have.been.calledWith(
      Sinon.match({ paymentHash: Sinon.match(/^invalid:/), amountMsats: 0n }),
    )
  })

  it('persists the known period when holding an invoice', async () => {
    settings.peering!.autoPay!.enabled = false

    await service.handleInvoice(peer, advertisement, event, now)

    expect(invoiceRepository.update).to.have.been.calledWith(
      PAYMENT_HASH,
      Sinon.match({ status: PeeringInvoiceStatus.HELD, termPeriodSeconds: 2592000 }),
    )
  })

  it('records manual global spend when the peer has no budget', async () => {
    peer.budget = undefined
    const held = await service.handleInvoice(peer, advertisement, event, now)
    expect(held.reason).to.equal(PeeringInvoiceReason.BUDGET_NOT_CONFIGURED)

    invoiceRepository.findByHash.resolves(invoice({ status: PeeringInvoiceStatus.HELD }))
    invoiceRepository.claim.resolves(invoice({ status: PeeringInvoiceStatus.PAYING }))
    await service.approve(PAYMENT_HASH, now)

    expect(invoiceRepository.addBudgetSpend).to.have.been.calledOnceWith(
      'global',
      Sinon.match.any,
      Sinon.match.any,
      250_000_000n,
      Sinon.match.any,
    )
  })


  it('does not pay a manual invoice when recording spend fails', async () => {
    peer.budget = undefined
    const held = await service.handleInvoice(peer, advertisement, event, now)
    expect(held.reason).to.equal(PeeringInvoiceReason.BUDGET_NOT_CONFIGURED)

    invoiceRepository.findByHash.resolves(invoice({ status: PeeringInvoiceStatus.HELD }))
    invoiceRepository.claimForAttempt.resolves(
      invoice({ status: PeeringInvoiceStatus.PAYING, paymentAttemptId: 'attempt-1' }),
    )
    invoiceRepository.addBudgetSpend.rejects(new Error('budget store down'))

    const result = await service.approve(PAYMENT_HASH, now)

    expect(paymentsService.payInvoice).not.to.have.been.called
    expect(result.status).to.equal(PeeringInvoiceStatus.HELD)
    expect(result.reason).to.equal(PeeringInvoiceReason.BUDGET_EXCEEDED)
  })

  it('keeps a failed payment recoverable when the refund also fails', async () => {
    paymentsService.payInvoice.rejects(new Error('wallet down'))
    invoiceRepository.releaseBudget.rejects(new Error('budget store down'))

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(result.status).to.equal(PeeringInvoiceStatus.PAYING)
    expect(result.reason).to.equal(PeeringInvoiceReason.PAYMENT_FAILED)
    expect(invoiceRepository.update).not.to.have.been.calledWith(
      PAYMENT_HASH,
      Sinon.match({ status: PeeringInvoiceStatus.HELD }),
    )
  })


  it('recovers a paying invoice when the peer redelivers it', async () => {
    invoiceRepository.insertIfNew.resolves({
      inserted: false,
      invoice: invoice({ status: PeeringInvoiceStatus.PAYING }),
    })
    paymentsService.getInvoiceFromPaymentsProcessor = sandbox.stub().resolves({ status: 'completed' })

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(result.status).to.equal(PeeringInvoiceStatus.PAID)
    expect(invoiceRepository.update).to.have.been.calledWith(
      PAYMENT_HASH,
      Sinon.match({ status: PeeringInvoiceStatus.PAID }),
    )
  })

  it('recovers a paying invoice before an operator approval', async () => {
    invoiceRepository.findByHash.resolves(invoice({ status: PeeringInvoiceStatus.PAYING }))
    paymentsService.getInvoiceFromPaymentsProcessor = sandbox.stub().resolves({ status: 'completed' })

    const result = await service.approve(PAYMENT_HASH, now)

    expect(result.status).to.equal(PeeringInvoiceStatus.PAID)
    expect(paymentsService.payInvoice).not.to.have.been.called
  })


  it('recovers a PAYING row when the claim is lost to a restart', async () => {
    invoiceRepository.claimForAttempt.resolves(undefined)
    invoiceRepository.findByHash.resolves(invoice({ status: PeeringInvoiceStatus.PAYING }))
    paymentsService.getInvoiceFromPaymentsProcessor = sandbox.stub().resolves({ status: 'completed' })

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(result.status).to.equal(PeeringInvoiceStatus.PAID)
    expect(paymentsService.payInvoice).not.to.have.been.called
  })


  it('refuses to approve a malformed invoice', async () => {
    invoiceRepository.findByHash.resolves(
      invoice({ paymentHash: 'invalid:abc', amountMsats: 0n, status: PeeringInvoiceStatus.HELD }),
    )

    await expect(service.approve('invalid:abc', now)).to.be.rejectedWith('no decodable payment')
    expect(paymentsService.payInvoice).not.to.have.been.called
  })


  it('returns the current row when the failed-payment claim is lost', async () => {
    invoiceRepository.transitionAttempt
      .onFirstCall()
      .resolves(invoice({ status: PeeringInvoiceStatus.PAYING }))
      .onSecondCall()
      .resolves(undefined)
    paymentsService.payInvoice.rejects(new Error('wallet down'))
    invoiceRepository.findByHash.resolves(invoice({ status: PeeringInvoiceStatus.HELD }))

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(result.status).to.equal(PeeringInvoiceStatus.HELD)
    expect(invoiceRepository.releaseBudget).not.to.have.been.called
  })


  it('keeps a pending wallet payment reserved for recovery', async () => {
    paymentsService.payInvoice.resolves({ paymentHash: PAYMENT_HASH, settled: false })

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(result.status).to.equal(PeeringInvoiceStatus.PAYING)
    expect(invoiceRepository.releaseBudget).not.to.have.been.called
  })

  it('keeps an unknown wallet outcome reserved for recovery', async () => {
    paymentsService.payInvoice.rejects(new PaymentsProcessorOutcomeUnknownError())

    const result = await service.handleInvoice(peer, advertisement, event, now)

    expect(result.status).to.equal(PeeringInvoiceStatus.PAYING)
    expect(invoiceRepository.releaseBudget).not.to.have.been.called
  })

  it('summarizes per-peer and global budget spend', async () => {
    const window = peeringBudgetWindow(now, 2592000)
    invoiceRepository.countInWindow.resolves({ received: 2, paid: 1, held: 1 })
    invoiceRepository.listBudgets.resolves([
      { scope: `peer:${PEER}`, periodStart: window.start, periodEnd: window.end, spentMsats: 250_000_000n },
      { scope: 'global', periodStart: window.start, periodEnd: window.end, spentMsats: 250_000_000n },
    ])

    const summaries = await service.budgetSummary(now)
    const peerSummary = summaries.find((summary) => summary.scope === 'peer')
    const globalSummary = summaries.find((summary) => summary.scope === 'global')

    expect(peerSummary).to.include({
      peerPubkey: PEER,
      spentMsats: 250_000_000n,
      remainingMsats: 750_000_000n,
      received: 2,
      paid: 1,
      held: 1,
    })
    expect(globalSummary?.remainingMsats).to.equal(9_750_000_000n)
  })
})
