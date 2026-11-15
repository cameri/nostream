import { After, Before, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import { randomBytes, randomUUID } from 'node:crypto'
import Sinon from 'sinon'

import { adminNotificationsPatchBodySchema } from '../../../../src/schemas/admin-notifications-schema'
import { getMasterDbClient } from '../../../../src/database/client'
import { InvoiceStatus, InvoiceUnit } from '../../../../src/@types/invoice'
import { InvoiceRepository } from '../../../../src/repositories/invoice-repository'
import { PeeringPaymentRepository } from '../../../../src/repositories/peering-payment-repository'
import { PaymentsService } from '../../../../src/services/payments-service'
import { SettingsStatic } from '../../../../src/utils/settings'
import * as eventUtils from '../../../../src/utils/event'
import {
  InvalidPeeringTermError,
  isPeeringAccessActive,
  isPeeringInvoiceRequest,
  peeringInvoiceDescription,
  peeringPeriodEnd,
  resolvePaidPeeringTerm,
} from '../../../../src/utils/peering-billing'

const TERM_MSATS = 21000n
const TERM_SECONDS = 60

const randomPeer = () => randomBytes(32).toString('hex')

const rejects = async (promise: Promise<unknown>): Promise<boolean> => {
  try {
    await promise
    return false
  } catch {
    return true
  }
}

const createService = (world: World<Record<string, any>>): void => {
  const db = getMasterDbClient()
  const invoiceRepository = new InvoiceRepository(db)
  const peeringPaymentRepository = new PeeringPaymentRepository(db)

  const eventRepository = {
    findByFilters: async () => world.parameters.peeringEvents.map(() => ({ event_id: Buffer.alloc(32) })),
    create: async (event: unknown) => {
      world.parameters.peeringEvents.push(event)
      world.parameters.peeringEventCreates = (world.parameters.peeringEventCreates ?? 0) + 1
      return 1
    },
  } as any

  const userRepository = {
    upsert: async () => {
      throw new Error('peering must not upsert a user')
    },
    admitUser: async () => {
      throw new Error('peering must not admit a user')
    },
    getBalanceByPubkey: async () => 0n,
  } as any

  const notificationOutboxRepository = {
    enqueue: async () => ({}),
  } as any

  const paymentsProcessor = {
    createInvoice: async (request: any) => {
      world.parameters.peeringInvoiceCreates = (world.parameters.peeringInvoiceCreates ?? 0) + 1
      return {
        id: `peering-${randomUUID()}`,
        pubkey: request.requestId,
        bolt11: `lnbc${Math.max(1, Number(request.amount / 1000n))}n1peering`,
        amountRequested: request.amount,
        description: request.description,
        unit: InvoiceUnit.MSATS,
        status: InvoiceStatus.PENDING,
        expiresAt: new Date(Date.now() + 900_000),
        createdAt: new Date(),
      }
    },
    getInvoice: async () => {
      throw new Error('processor lookup is not used by the ledger test')
    },
  } as any

  world.parameters.peeringDb = db
  world.parameters.peeringInvoiceRepository = invoiceRepository
  world.parameters.peeringPaymentRepository = peeringPaymentRepository
  world.parameters.peeringService = new PaymentsService(
    db,
    paymentsProcessor,
    userRepository,
    invoiceRepository,
    eventRepository,
    () => SettingsStatic._settings as any,
    notificationOutboxRepository,
    undefined,
    peeringPaymentRepository,
  )
}

const createInvoice = async (
  world: World<Record<string, any>>,
  peer: string,
  amountMsats = TERM_MSATS,
  periodSeconds = TERM_SECONDS,
) => {
  const service = world.parameters.peeringService as PaymentsService
  const repository = world.parameters.peeringPaymentRepository as PeeringPaymentRepository
  const db = world.parameters.peeringDb

  const invoice = await service.createPeeringInvoice(
    peer,
    amountMsats,
    'paid peering integration test',
    periodSeconds,
  )

  world.parameters.peeringInvoiceIds.push(invoice.id)
  if (!world.parameters.peeringPeerPubkeys.includes(peer)) {
    world.parameters.peeringPeerPubkeys.push(peer)
  }

  if (!world.parameters.peeringUserPubkeys.includes(peer)) {
    await db('users').insert({ pubkey: Buffer.from(peer, 'hex') }).onConflict('pubkey').ignore()
    world.parameters.peeringUserPubkeys.push(peer)
  }

  await repository.ensureRow(peer, db)

  return invoice
}

const payInvoice = async (
  world: World<Record<string, any>>,
  invoice: any,
  amountPaid: bigint = invoice.amountRequested,
) => {
  const service = world.parameters.peeringService as PaymentsService
  await service.confirmInvoice({
    ...invoice,
    status: InvoiceStatus.COMPLETED,
    confirmedAt: new Date(),
    amountPaid,
  })
}

const peerRow = (world: World<Record<string, any>>, peer: string) =>
  world.parameters.peeringDb('peering_payments').where('peer_pubkey', Buffer.from(peer, 'hex')).first()

Before({ tags: '@paid-peering-ledger' }, function (this: World<Record<string, any>>) {
  this.parameters.peeringPreviousSettings = SettingsStatic._settings
  this.parameters.peeringPeerPubkeys = []
  this.parameters.peeringInvoiceIds = []
  this.parameters.peeringUserPubkeys = []
  this.parameters.peeringEvents = []
  this.parameters.peeringEventCreates = 0
  this.parameters.peeringInvoiceCreates = 0
  this.parameters.peeringSandbox = Sinon.createSandbox()
  this.parameters.peeringSandbox.stub(eventUtils, 'broadcastEvent').resolves()

  const settings = SettingsStatic._settings as any
  SettingsStatic._settings = {
    ...settings,
    peering: {
      ...(settings?.peering ?? {}),
      enabled: true,
      terms: [{ amount: Number(TERM_MSATS), unit: 'msats', period: TERM_SECONDS }],
    },
  } as any

  createService(this)
})

After({ tags: '@paid-peering-ledger' }, async function (this: World<Record<string, any>>) {
  const db = this.parameters.peeringDb
  const peers: string[] = this.parameters.peeringPeerPubkeys ?? []
  const invoices: string[] = this.parameters.peeringInvoiceIds ?? []
  const users: string[] = this.parameters.peeringUserPubkeys ?? []

  try {
    if (db && peers.length > 0) {
      await db('peering_payments')
        .whereIn(
          'peer_pubkey',
          peers.map((peer) => Buffer.from(peer, 'hex')),
        )
        .delete()
    }
    if (db && invoices.length > 0) {
      await db('invoices').whereIn('id', invoices).delete()
    }
    if (db && users.length > 0) {
      await db('users')
        .whereIn(
          'pubkey',
          users.map((peer) => Buffer.from(peer, 'hex')),
        )
        .delete()
    }
  } finally {
    this.parameters.peeringSandbox?.restore()
    if (this.parameters.peeringPreviousSettings) {
      SettingsStatic._settings = this.parameters.peeringPreviousSettings
    }

    this.parameters.peeringDb = undefined
    this.parameters.peeringInvoiceRepository = undefined
    this.parameters.peeringPaymentRepository = undefined
    this.parameters.peeringService = undefined
    this.parameters.peeringPreviousSettings = undefined
    this.parameters.peeringSandbox = undefined
    this.parameters.peeringEvents = []
    this.parameters.peeringPeerPubkeys = []
    this.parameters.peeringInvoiceIds = []
    this.parameters.peeringUserPubkeys = []
    this.parameters.peeringInvoice = undefined
    this.parameters.peeringPeer = undefined
    this.parameters.peeringFirstPeriodEnd = undefined
    this.parameters.peeringUnderpaidInvoice = undefined
    this.parameters.peeringUnderpaidPeer = undefined
    this.parameters.peeringRetryInvoice = undefined
    this.parameters.peeringRetryPeer = undefined
    this.parameters.peeringNotificationInvoice = undefined
    this.parameters.peeringNotificationPeer = undefined
  }
})

When('the peer pays a {int} msat peering invoice', async function (this: World<Record<string, any>>, amount: number) {
  const peer = randomPeer()
  const invoice = await createInvoice(this, peer, BigInt(amount))

  await payInvoice(this, invoice)

  this.parameters.peeringPeer = peer
  this.parameters.peeringInvoice = invoice
})

Then(
  'the peer has an active peering period for {int} seconds',
  async function (this: World<Record<string, any>>, seconds: number) {
    const peer = this.parameters.peeringPeer as string
    const invoice = this.parameters.peeringInvoice as any
    const row = await peerRow(this, peer)

    expect(row).to.exist
    expect(row.status).to.equal('active')
    expect(row.last_settled_invoice_id).to.equal(invoice.id)
    expect(row.period_start).to.be.instanceOf(Date)
    expect(row.period_end).to.be.instanceOf(Date)
    expect(Math.round((row.period_end.getTime() - row.period_start.getTime()) / 1000)).to.equal(seconds)
    expect(row.period_end.getTime()).to.be.greaterThan(Date.now())

    const invoiceRow = await this.parameters.peeringDb('invoices').where('id', invoice.id).first()
    expect(invoiceRow.confirmed_at).to.be.instanceOf(Date)
    expect(invoiceRow.period_start).to.be.instanceOf(Date)
    expect(invoiceRow.period_end).to.be.instanceOf(Date)

    const repository = this.parameters.peeringPaymentRepository as PeeringPaymentRepository
    const found = await repository.findByPeer(peer)
    expect(found?.status).to.equal('active')

    const listed = await repository.list()
    expect(listed.some((payment) => payment.peerPubkey === peer)).to.equal(true)

    const before = new Date(Date.now() + 2 * seconds * 1000)
    const due = await repository.findDueForRenewal(before, 10, 0)
    expect(due.some((payment) => payment.peerPubkey === peer)).to.equal(true)

    const ended = await repository.findPeriodEnded(before, 10, 0)
    expect(ended.some((payment) => payment.peerPubkey === peer)).to.equal(true)
  },
)

Then('the peering payment did not credit a user balance', async function (this: World<Record<string, any>>) {
  const peer = this.parameters.peeringPeer as string
  const user = await this.parameters.peeringDb('users').where('pubkey', Buffer.from(peer, 'hex')).first()

  expect(user).to.exist
  expect(String(user.balance)).to.equal('0')
  expect(user.is_admitted).to.equal(false)
})

When('the same peering invoice is paid again', async function (this: World<Record<string, any>>) {
  const peer = this.parameters.peeringPeer as string
  const row = await peerRow(this, peer)
  this.parameters.peeringFirstPeriodEnd = row.period_end

  await payInvoice(this, this.parameters.peeringInvoice)
})

Then('the peer period did not change', async function (this: World<Record<string, any>>) {
  const peer = this.parameters.peeringPeer as string
  const row = await peerRow(this, peer)

  expect(row.period_end.getTime()).to.equal(this.parameters.peeringFirstPeriodEnd.getTime())
  expect(row.last_settled_invoice_id).to.equal(this.parameters.peeringInvoice.id)
})

When(
  'the peer underpays a {int} msat peering invoice with {int} msats',
  async function (this: World<Record<string, any>>, amount: number, paid: number) {
    const peer = randomPeer()
    const invoice = await createInvoice(this, peer, BigInt(amount))

    await payInvoice(this, invoice, BigInt(paid))

    this.parameters.peeringUnderpaidPeer = peer
    this.parameters.peeringUnderpaidInvoice = invoice
  },
)

Then(
  'the underpayment is recorded without activating the peer',
  async function (this: World<Record<string, any>>) {
    const peer = this.parameters.peeringUnderpaidPeer as string
    const invoice = this.parameters.peeringUnderpaidInvoice as any
    const row = await peerRow(this, peer)

    expect(row).to.exist
    expect(row.status).to.equal('unpaid')
    expect(row.period_end).to.equal(null)
    expect(row.last_settled_invoice_id).to.equal(null)
    expect(row.last_error).to.include('underpaid')

    const invoiceRow = await this.parameters.peeringDb('invoices').where('id', invoice.id).first()
    expect(invoiceRow.confirmed_at).to.be.instanceOf(Date)
    expect(invoiceRow.period_end).to.equal(null)
  },
)

When(
  'a peering invoice is marked completed without a confirmation',
  async function (this: World<Record<string, any>>) {
    const peer = randomPeer()
    const invoice = await createInvoice(this, peer)

    await this.parameters.peeringInvoiceRepository.updateStatus({
      id: invoice.id,
      status: InvoiceStatus.COMPLETED,
    })

    this.parameters.peeringRetryPeer = peer
    this.parameters.peeringRetryInvoice = invoice
  },
)

Then('the unconfirmed peering invoice is returned for retry', async function (this: World<Record<string, any>>) {
  const service = this.parameters.peeringService as PaymentsService
  const invoice = this.parameters.peeringRetryInvoice as any
  const retryable = await service.getUnconfirmedPeeringInvoices(100, 0)

  expect(retryable.some((candidate) => candidate.id === invoice.id)).to.equal(true)
})

When('the retryable peering invoice is paid', async function (this: World<Record<string, any>>) {
  await payInvoice(this, this.parameters.peeringRetryInvoice)
})

Then(
  'the unconfirmed peering invoice is no longer returned for retry',
  async function (this: World<Record<string, any>>) {
    const service = this.parameters.peeringService as PaymentsService
    const invoice = this.parameters.peeringRetryInvoice as any
    const retryable = await service.getUnconfirmedPeeringInvoices(100, 0)

    expect(retryable.some((candidate) => candidate.id === invoice.id)).to.equal(false)
  },
)

When('I parse the paid peering terms', function () {
  const base = SettingsStatic._settings as any
  const withTerms = (terms: unknown[]) => ({
    ...base,
    peering: {
      ...(base?.peering ?? {}),
      terms,
    },
  })

  const valid = [
    { amount: 21000, unit: 'msats', period: 60, amountMsats: 21000n },
    { amount: 21, unit: 'sats', period: 60, amountMsats: 21000n },
    { amount: 1, unit: 'btc', period: 60, amountMsats: 100_000_000_000n },
  ]

  for (const term of valid) {
    expect(resolvePaidPeeringTerm(withTerms([term]))).to.deep.equal({
      amountMsats: term.amountMsats,
      periodSeconds: term.period,
    })
  }

  expect(resolvePaidPeeringTerm(withTerms([{ amount: 0, unit: 'msats', period: 60 }]))).to.be.undefined

  const invalid = [
    { amount: -1, unit: 'msats', period: 60 },
    { amount: 1500, unit: 'msats', period: 60 },
    { amount: 1, unit: 'usd', period: 60 },
    { amount: 100_000_000, unit: 'btc', period: 60 },
    { amount: 21000, unit: 'msats', period: 0 },
  ]

  for (const term of invalid) {
    expect(() => resolvePaidPeeringTerm(withTerms([term]))).to.throw(InvalidPeeringTermError)
  }

  const start = new Date('2026-01-01T00:00:00.000Z')
  expect(peeringPeriodEnd(start, 60).getTime() - start.getTime()).to.equal(60_000)
  expect(
    peeringInvoiceDescription(base, randomPeer(), { amountMsats: 21000n, periodSeconds: 86_400 }),
  ).to.include('21000 msats')

  const now = new Date()
  expect(isPeeringAccessActive('active', new Date(now.getTime() + 60_000), now)).to.equal(true)
  expect(isPeeringAccessActive('active', new Date(now.getTime() - 60_000), now)).to.equal(false)
  expect(isPeeringAccessActive('lapsed', new Date(now.getTime() + 60_000), now)).to.equal(false)
  expect(isPeeringAccessActive('renewal_pending', new Date(now.getTime() + 60_000), now)).to.equal(true)
})

Then('only all-invoice peering requests are exempt', function () {
  const peer = randomPeer()
  const invoiceFilter = { kinds: [402], '#p': [peer], '#t': ['peering'] }

  expect(isPeeringInvoiceRequest([invoiceFilter], peer)).to.equal(true)
  expect(isPeeringInvoiceRequest([invoiceFilter, { kinds: [1] }], peer)).to.equal(false)
  expect(isPeeringInvoiceRequest([], peer)).to.equal(false)
  expect(isPeeringInvoiceRequest([{ ...invoiceFilter, '#p': [randomPeer()] }], peer)).to.equal(false)
  expect(isPeeringInvoiceRequest([{ kinds: [402], '#t': ['peering'] }], peer)).to.equal(false)
  expect(isPeeringInvoiceRequest([{ kinds: [402, 1], '#p': [peer], '#t': ['peering'] }], peer)).to.equal(false)
})

Then('the peering notification switches are accepted', function () {
  const accepted = adminNotificationsPatchBodySchema.safeParse({
    events: {
      'peering.invoice.created': false,
      'peering.invoice.paid': false,
      'peering.invoice.failed': false,
      'peering.access.lapsed': false,
    },
  })
  expect(accepted.success).to.equal(true)

  const rejected = adminNotificationsPatchBodySchema.safeParse({
    events: { 'peering.unknown': false },
  })
  expect(rejected.success).to.equal(false)
})

Then(
  'the peering invoice creation boundary rejects invalid terms',
  async function (this: World<Record<string, any>>) {
    const service = this.parameters.peeringService as PaymentsService
    const peer = randomPeer()
    const before = this.parameters.peeringInvoiceCreates
    const invalid: [bigint, number][] = [
      [0n, 60],
      [1500n, 60],
      [-1000n, 60],
      [10n ** 19n, 60],
      [21000n, 0],
    ]

    for (const [amount, period] of invalid) {
      expect(await rejects(service.createPeeringInvoice(peer, amount, 'invalid', period))).to.equal(true)
    }

    expect(this.parameters.peeringInvoiceCreates).to.equal(before)
  },
)

When(
  'the peering invoice notification is published',
  async function (this: World<Record<string, any>>) {
    const peer = randomPeer()
    const invoice = await createInvoice(this, peer)
    const service = this.parameters.peeringService as PaymentsService

    await service.ensurePeeringInvoiceNotification(invoice)
    await service.ensurePeeringInvoiceNotification(invoice)

    this.parameters.peeringNotificationPeer = peer
    this.parameters.peeringNotificationInvoice = invoice
  },
)

Then(
  'the invoice notification is published once with peering tags',
  function (this: World<Record<string, any>>) {
    expect(this.parameters.peeringEventCreates).to.equal(1)

    const event = this.parameters.peeringEvents[0] as any
    const tags = event.tags as string[][]

    expect(event.kind).to.equal(402)
    expect(tags).to.deep.include(['p', this.parameters.peeringNotificationPeer])
    expect(tags).to.deep.include(['t', 'peering'])
    expect(tags).to.deep.include(['i', this.parameters.peeringNotificationInvoice.id])
    expect(tags).to.deep.include(['bolt11', this.parameters.peeringNotificationInvoice.bolt11])
    expect(tags.some(([name]) => name === 'expiration')).to.equal(true)
  },
)
