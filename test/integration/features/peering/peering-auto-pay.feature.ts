import { After, Before, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import Sinon from 'sinon'

import { Event } from '../../../../src/@types/event'
import {
  PeeringInvoiceReason,
  PeeringInvoiceStatus,
} from '../../../../src/@types/peering'
import { PeeringPeer, Settings } from '../../../../src/@types/settings'
import { getMasterDbClient } from '../../../../src/database/client'
import { PeeringInvoiceRepository } from '../../../../src/repositories/peering-invoice-repository'
import { PeeringBuyerService } from '../../../../src/services/peering-buyer-service'
import { getPublicKey, identifyEvent, signEvent } from '../../../../src/utils/event'

const INVOICE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh'
const PAYMENT_HASH = '0001020304050607080900010203040506070809000102030405060708090102'
const TERM_MSATS = 250_000_000n
const TERM_SECONDS = 2592000
const SELF_PRIVATE_KEY = 'c'.repeat(64)
const SELF_PUBKEY = getPublicKey(SELF_PRIVATE_KEY)

const randomPeer = async () => {
  const privateKey = randomBytes(32).toString('hex')
  return { privateKey, pubkey: getPublicKey(privateKey) }
}

const invoiceEvent = async (peerPubkey: string, privateKey: string, createdAt: number): Promise<Event> =>
  signEvent(privateKey)(
    await identifyEvent({
      pubkey: peerPubkey,
      created_at: createdAt,
      kind: 402,
      tags: [
        ['p', SELF_PUBKEY],
        ['t', 'peering'],
        ['bolt11', INVOICE],
        ['i', 'peer-processor-invoice'],
        ['expiration', String(createdAt + 900)],
      ],
      content: '',
    }),
  )

const setupBuyer = (
  world: World<Record<string, any>>,
  budgetSats: number,
): { service: PeeringBuyerService; peer: PeeringPeer; payInvoice: Sinon.SinonStub } => {
  const db = getMasterDbClient()
  const peer = {
    pubkey: world.parameters.autoPayPeerPubkey,
    relayUrl: 'wss://peer.example.com',
    budget: { amount: budgetSats, unit: 'sats', period: TERM_SECONDS },
  }
  const settings = {
    info: { name: 'Test Relay', relay_url: 'wss://relay.example.com' },
    payments: { enabled: true },
    peering: {
      enabled: true,
      autoPay: { enabled: true },
      peers: [peer],
    },
  } as Settings
  const payInvoice = Sinon.stub().resolves(PAYMENT_HASH)
  const notificationOutboxRepository = { enqueue: Sinon.stub().resolves() }
  const repository = new PeeringInvoiceRepository(db)
  const service = new PeeringBuyerService(
    db,
    repository,
    { payInvoice } as any,
    notificationOutboxRepository as any,
    () => settings,
    () => SELF_PUBKEY,
  )

  world.parameters.autoPayService = service
  world.parameters.autoPayRepository = repository
  world.parameters.autoPayPeer = peer
  world.parameters.autoPayPayInvoice = payInvoice
  world.parameters.autoPayAdvertisement = {
    enabled: true,
    scopes: [{ kinds: [1] }],
    terms: [{ amount: Number(TERM_MSATS), unit: 'msats', period: TERM_SECONDS }],
    supportedNips: [77],
  }

  return { service, peer, payInvoice }
}

Before({ tags: '@peering-auto-pay' }, async function (this: World<Record<string, any>>) {
  this.parameters.autoPayDb = getMasterDbClient()
  this.parameters.autoPayPeers = []
  this.parameters.autoPayScopes = []
  this.parameters.autoPaySandbox = Sinon.createSandbox()
})

After({ tags: '@peering-auto-pay' }, async function (this: World<Record<string, any>>) {
  const db = this.parameters.autoPayDb
  const peers: string[] = this.parameters.autoPayPeers ?? []
  const scopes: string[] = this.parameters.autoPayScopes ?? []

  try {
    if (db && peers.length) {
      await db('peering_invoices')
        .whereIn(
          'peer_pubkey',
          peers.map((peer) => Buffer.from(peer, 'hex')),
        )
        .delete()
    }
    if (db && scopes.length) {
      await db('peering_budgets').whereIn('scope', scopes).delete()
    }
  } finally {
    this.parameters.autoPaySandbox?.restore()
    this.parameters.autoPayDb = undefined
    this.parameters.autoPayPeers = []
    this.parameters.autoPayScopes = []
    this.parameters.autoPaySandbox = undefined
    this.parameters.autoPayService = undefined
    this.parameters.autoPayPeer = undefined
    this.parameters.autoPayPayInvoice = undefined
    this.parameters.autoPayResult = undefined
    this.parameters.autoPayEvent = undefined
    this.parameters.autoPayRepository = undefined
  }
})

When(
  'a trusted peer sends a {int} msat invoice with a {int} sat budget',
  async function (this: World<Record<string, any>>, amountMsats: number, budgetSats: number) {
    expect(amountMsats).to.equal(Number(TERM_MSATS))
    const { privateKey, pubkey } = await randomPeer()
    this.parameters.autoPayPeerPubkey = pubkey
    this.parameters.autoPayPeers.push(pubkey)
    this.parameters.autoPayScopes.push(`peer:${pubkey}`)

    const { service, peer } = setupBuyer(this, budgetSats)
    const now = new Date()
    const event = await invoiceEvent(pubkey, privateKey, Math.floor(now.getTime() / 1000))
    this.parameters.autoPayEvent = event
    this.parameters.autoPayResult = await service.handleInvoice(
      peer,
      this.parameters.autoPayAdvertisement,
      event,
      now,
    )
  },
)


When('a paying buyer invoice is recovered from the wallet', async function (this: World<Record<string, any>>) {
  const { privateKey, pubkey } = await randomPeer()
  this.parameters.autoPayPeerPubkey = pubkey
  this.parameters.autoPayPeers.push(pubkey)
  this.parameters.autoPayScopes.push(`peer:${pubkey}`)

  const { service, peer, payInvoice } = setupBuyer(this, 1000000000)
  const now = new Date()
  const repository = this.parameters.autoPayRepository as PeeringInvoiceRepository
  await repository.insertIfNew(
    {
      paymentHash: PAYMENT_HASH,
      eventId: `event-${pubkey}`,
      peerPubkey: pubkey,
      bolt11: INVOICE,
      amountMsats: TERM_MSATS,
      status: PeeringInvoiceStatus.PAYING,
      reason: null,
      autoPaid: true,
      budgetPeriodStart: now,
      budgetPeriodEnd: new Date(now.getTime() + 60_000),
      termPeriodSeconds: TERM_SECONDS,
      expiresAt: null,
      seenCount: 1,
      paidAt: null,
      createdAt: now,
      updatedAt: now,
    },
  )
  await repository.reserveBudget(`peer:${pubkey}`, now, new Date(now.getTime() + 60_000), TERM_MSATS, 1_000_000_000n, this.parameters.autoPayDb)
  ;(service as any).paymentsService.getInvoiceFromPaymentsProcessor = Sinon.stub().resolves({ status: 'completed' })
  this.parameters.autoPayPayInvoice = payInvoice
  this.parameters.autoPayResult = await service.recover(now)
})

Then('the invoice is paid without refunding its budget', async function (this: World<Record<string, any>>) {
  expect(this.parameters.autoPayResult).to.equal(1)
  expect(this.parameters.autoPayPayInvoice).not.to.have.been.called

  const row = await this.parameters.autoPayDb('peering_invoices').where('payment_hash', PAYMENT_HASH).first()
  expect(row.status).to.equal('paid')
  expect(row.auto_paid).to.equal(true)

  const budget = await this.parameters.autoPayDb('peering_budgets')
    .where('scope', `peer:${this.parameters.autoPayPeerPubkey}`)
    .first()
  expect(String(budget.spent_msats)).to.equal(TERM_MSATS.toString())
})

Then(
  'the buyer invoice is paid and the budget records the spend',
  async function (this: World<Record<string, any>>) {
    expect(this.parameters.autoPayResult.status).to.equal(PeeringInvoiceStatus.PAID)
    expect(this.parameters.autoPayPayInvoice).to.have.been.calledOnce

    const row = await this.parameters.autoPayDb('peering_invoices').where('payment_hash', PAYMENT_HASH).first()
    expect(row.status).to.equal('paid')
    expect(row.auto_paid).to.equal(true)

    const budget = await this.parameters.autoPayDb('peering_budgets')
      .where('scope', `peer:${this.parameters.autoPayPeerPubkey}`)
      .first()
    expect(String(budget.spent_msats)).to.equal(TERM_MSATS.toString())
  },
)

Then(
  'the buyer invoice is held for operator approval',
  async function (this: World<Record<string, any>>) {
    expect(this.parameters.autoPayResult.status).to.equal(PeeringInvoiceStatus.HELD)
    expect(this.parameters.autoPayResult.reason).to.equal(PeeringInvoiceReason.BUDGET_EXCEEDED)
    expect(this.parameters.autoPayPayInvoice).not.to.have.been.called

    const row = await this.parameters.autoPayDb('peering_invoices').where('payment_hash', PAYMENT_HASH).first()
    expect(row.status).to.equal('held')
    expect(row.reason).to.equal('budget_exceeded')
  },
)

When('the same invoice event is delivered again', async function (this: World<Record<string, any>>) {
  await this.parameters.autoPayService.handleInvoice(
    this.parameters.autoPayPeer,
    this.parameters.autoPayAdvertisement,
    this.parameters.autoPayEvent,
  )
})

Then('the buyer wallet was called once', function (this: World<Record<string, any>>) {
  expect(this.parameters.autoPayPayInvoice).to.have.been.calledOnce
})

When('the operator approves the held invoice', async function (this: World<Record<string, any>>) {
  this.parameters.autoPayResult = await this.parameters.autoPayService.approve(PAYMENT_HASH)
})

Then(
  'the invoice is paid manually and the spend is recorded',
  async function (this: World<Record<string, any>>) {
    expect(this.parameters.autoPayResult.status).to.equal(PeeringInvoiceStatus.PAID)
    expect(this.parameters.autoPayResult.autoPaid).to.equal(false)
    expect(this.parameters.autoPayPayInvoice).to.have.been.calledOnce

    const budget = await this.parameters.autoPayDb('peering_budgets')
      .where('scope', `peer:${this.parameters.autoPayPeerPubkey}`)
      .first()
    expect(String(budget.spent_msats)).to.equal(TERM_MSATS.toString())
  },
)
