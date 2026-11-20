import { After, Before, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import Sinon from 'sinon'

import { PeeringInvoice, PeeringInvoiceStatus } from '../../../../src/@types/peering'
import { PeeringPeer, Settings } from '../../../../src/@types/settings'
import { GetAdminPeeringController } from '../../../../src/controllers/admin/get-admin-peering-controller'
import { PostAdminPeeringInvoiceDecisionController } from '../../../../src/controllers/admin/post-admin-peering-invoice-decision-controller'
import { getMasterDbClient } from '../../../../src/database/client'
import { PeeringInvoiceRepository } from '../../../../src/repositories/peering-invoice-repository'
import { PeeringBuyerService } from '../../../../src/services/peering-buyer-service'

const response = () => {
  const res: any = {
    status: Sinon.stub().returnsThis(),
    setHeader: Sinon.stub().returnsThis(),
    send: Sinon.stub(),
  }
  return res
}

const heldInvoice = (peerPubkey: string, paymentHash: string, now: Date): PeeringInvoice => ({
  paymentHash,
  eventId: `event-${paymentHash}`,
  peerPubkey,
  bolt11: 'lnbc1invoice',
  amountMsats: 1_000n,
  status: PeeringInvoiceStatus.HELD,
  reason: 'budget_exceeded',
  autoPaid: false,
  budgetPeriodStart: null,
  budgetPeriodEnd: null,
  globalBudgetPeriodStart: null,
  globalBudgetPeriodEnd: null,
  termPeriodSeconds: 3600,
  expiresAt: null,
  seenCount: 1,
  paidAt: null,
  createdAt: now,
  updatedAt: now,
})

const setup = (world: World<Record<string, any>>) => {
  const db = getMasterDbClient()
  const peerPubkey = randomBytes(32).toString('hex')
  const peer: PeeringPeer = {
    pubkey: peerPubkey,
    relayUrl: 'wss://peer.example.com',
    budget: { amount: 1000, unit: 'sats', period: 3600 },
  }
  const settings = {
    info: { name: 'Test Relay', relay_url: 'wss://relay.example.com' },
    payments: { enabled: true },
    peering: { enabled: false, autoPay: { enabled: true }, peers: [peer] },
  } as Settings
  const repository = new PeeringInvoiceRepository(db)
  const payInvoice = Sinon.stub().callsFake(async (bolt11: string) => {
    const invoice = world.parameters.adminPayHash as string
    void bolt11
    return invoice
  })
  const service = new PeeringBuyerService(
    db,
    repository,
    { payInvoice, getInvoiceFromPaymentsProcessor: Sinon.stub().resolves({ status: 'completed' }) } as any,
    { enqueue: Sinon.stub().resolves() } as any,
    () => settings,
    () => 'b'.repeat(64),
  )

  world.parameters.adminDb = db
  world.parameters.adminPeers = [peerPubkey]
  world.parameters.adminRepository = repository
  world.parameters.adminService = service
  world.parameters.adminSettings = settings
  world.parameters.adminPeer = peer

  return { peerPubkey, service, repository }
}

Before({ tags: '@peering-admin' }, function (this: World<Record<string, any>>) {
  this.parameters.adminPeers = []
  this.parameters.adminSandbox = Sinon.createSandbox()
})

After({ tags: '@peering-admin' }, async function (this: World<Record<string, any>>) {
  const db = this.parameters.adminDb
  if (db) {
    await db('peering_invoices').whereIn('peer_pubkey', this.parameters.adminPeers.map((p: string) => Buffer.from(p, 'hex'))).delete()
    await db('peering_budgets').whereIn('scope', this.parameters.adminPeers.map((p: string) => `peer:${p}`)).delete()
  }
  this.parameters.adminSandbox?.restore()
  this.parameters.adminDb = undefined
  this.parameters.adminPeers = []
  this.parameters.adminPeerPubkey = undefined
  this.parameters.adminPayHash = undefined
})

When('the admin rejects a held buyer invoice', async function (this: World<Record<string, any>>) {
  const { peerPubkey, repository } = setup(this)
  const hash = randomBytes(32).toString('hex')
  this.parameters.adminPeerPubkey = peerPubkey
  this.parameters.adminRejectHash = hash
  await repository.insertIfNew(heldInvoice(peerPubkey, hash, new Date()))
  const controller = new PostAdminPeeringInvoiceDecisionController(this.parameters.adminService)
  this.parameters.adminResponse = response()
  await controller.handleRequest({ body: { paymentHash: hash, action: 'reject' } } as any, this.parameters.adminResponse)
})

Then('the invoice is marked rejected', async function (this: World<Record<string, any>>) {
  const row = await this.parameters.adminDb('peering_invoices')
    .where('payment_hash', this.parameters.adminRejectHash)
    .first()
  expect(row.status).to.equal('rejected')
  Sinon.assert.calledWith(this.parameters.adminResponse.status, 200)
})

When('the admin approves another held invoice', async function (this: World<Record<string, any>>) {
  const { peerPubkey, repository } = setup(this)
  const hash = randomBytes(32).toString('hex')
  this.parameters.adminPeerPubkey = peerPubkey
  this.parameters.adminPayHash = hash
  await repository.insertIfNew(heldInvoice(peerPubkey, hash, new Date()))
  const controller = new PostAdminPeeringInvoiceDecisionController(this.parameters.adminService)
  this.parameters.adminResponse = response()
  await controller.handleRequest({ body: { paymentHash: hash, action: 'approve' } } as any, this.parameters.adminResponse)
})

Then('the invoice is paid through the wallet', async function (this: World<Record<string, any>>) {
  const row = await this.parameters.adminDb('peering_invoices')
    .where('payment_hash', this.parameters.adminPayHash)
    .first()
  expect(row.status).to.equal('paid')
  expect(row.auto_paid).to.equal(false)
})

When('the admin peering payload is loaded', async function (this: World<Record<string, any>>) {
  const { peerPubkey, repository } = setup(this)
  const hash = randomBytes(32).toString('hex')
  this.parameters.adminPeerPubkey = peerPubkey
  this.parameters.adminPayHash = hash
  await repository.insertIfNew(heldInvoice(peerPubkey, hash, new Date()))
  const controller = new GetAdminPeeringController(
    { list: Sinon.stub().resolves([]) } as any,
    () => this.parameters.adminSettings,
    { list: Sinon.stub().resolves([]) } as any,
    { list: Sinon.stub().resolves([]) } as any,
    this.parameters.adminService,
  )
  this.parameters.adminResponse = response()
  await controller.handleRequest({} as any, this.parameters.adminResponse)
})

Then('it contains the held invoice and the current budget', function (this: World<Record<string, any>>) {
  const payload = this.parameters.adminResponse.send.firstCall.args[0]
  expect(payload.invoices.some((invoice: any) => invoice.paymentHash === this.parameters.adminPayHash)).to.equal(true)
  expect(payload.budgets.some((budget: any) => budget.scope === 'peer')).to.equal(true)
})
