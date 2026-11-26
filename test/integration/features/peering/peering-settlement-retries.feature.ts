import { After, Before, Given, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import { randomBytes, randomUUID } from 'node:crypto'

import { Invoice, InvoicePurpose, InvoiceStatus, InvoiceUnit } from '../../../../src/@types/invoice'
import { Settings } from '../../../../src/@types/settings'
import { getMasterDbClient } from '../../../../src/database/client'
import { InvoiceRepository } from '../../../../src/repositories/invoice-repository'
import { NotificationOutboxRepository } from '../../../../src/repositories/notification-outbox-repository'
import { PeeringPaymentRepository } from '../../../../src/repositories/peering-payment-repository'
import { PaymentsService } from '../../../../src/services/payments-service'

const TERM_MSATS = 21000n
const TERM_SECONDS = 60
const THRESHOLD = 2

const rejects = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise
  } catch {
    return
  }

  throw new Error('expected the settlement to fail')
}

const makeCompletedInvoice = (id: string, pubkey: string): Invoice => {
  const now = new Date()
  return {
    id,
    pubkey,
    bolt11: 'lnbc1settlementretry',
    amountRequested: TERM_MSATS,
    amountPaid: TERM_MSATS,
    unit: InvoiceUnit.MSATS,
    status: InvoiceStatus.COMPLETED,
    description: 'settlement retry test',
    confirmedAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
    updatedAt: now,
    createdAt: now,
    purpose: InvoicePurpose.PEERING,
    planId: null,
    termAmountMsats: TERM_MSATS,
    termPeriodSeconds: TERM_SECONDS,
  }
}

Before({ tags: '@peering-settlement-retries' }, function (this: World<Record<string, any>>) {
  const db = getMasterDbClient()
  const invoiceRepository = new InvoiceRepository(db)
  const peeringPaymentRepository = new PeeringPaymentRepository(db)
  const notificationOutboxRepository = new NotificationOutboxRepository(db)
  const settings = {
    info: { name: 'Retry Relay', relay_url: 'wss://retry.example.com' },
    payments: { enabled: true, invoiceExpirySeconds: 3600 },
    peering: { enabled: true, settlementFailureThreshold: THRESHOLD },
  } as Settings

  const service = new PaymentsService(
    db,
    {} as any,
    {} as any,
    invoiceRepository,
    {} as any,
    () => settings,
    notificationOutboxRepository,
    undefined,
    peeringPaymentRepository,
  )

  this.parameters.settlementDb = db
  this.parameters.settlementService = service
  this.parameters.settlementInvoiceId = randomUUID()
  this.parameters.settlementPeer = randomBytes(32).toString('hex')
})

After({ tags: '@peering-settlement-retries' }, async function (this: World<Record<string, any>>) {
  const db = this.parameters.settlementDb
  const id = this.parameters.settlementInvoiceId
  if (db) {
    await db('invoices').where({ id }).delete()
    await db('notification_outbox')
      .where({ event_type: 'peering.payment.failed' })
      .whereRaw("payload->>'invoiceId' = ?", [id])
      .delete()
  }
  this.parameters.settlementDb = undefined
  this.parameters.settlementService = undefined
  this.parameters.settlementInvoiceId = undefined
  this.parameters.settlementPeer = undefined
})

Given('a completed peering invoice without a term snapshot', async function (this: World<Record<string, any>>) {
  const db = this.parameters.settlementDb
  const id = this.parameters.settlementInvoiceId as string
  const peer = this.parameters.settlementPeer as string
  const now = new Date()

  await db('invoices').insert({
    id,
    pubkey: Buffer.from(peer, 'hex'),
    bolt11: 'lnbc1settlementretry',
    amount_requested: TERM_MSATS.toString(),
    amount_paid: TERM_MSATS.toString(),
    unit: InvoiceUnit.MSATS,
    status: InvoiceStatus.COMPLETED,
    description: 'settlement retry test',
    confirmed_at: null,
    expires_at: new Date(now.getTime() + 3_600_000),
    updated_at: now,
    created_at: now,
    verify_url: null,
    purpose: InvoicePurpose.PEERING,
    plan_id: null,
    period_start: null,
    period_end: null,
    term_amount_msats: null,
    term_period_seconds: TERM_SECONDS,
  })

  this.parameters.settlementInvoice = makeCompletedInvoice(id, peer)
})

When('its settlement fails twice', async function (this: World<Record<string, any>>) {
  const service = this.parameters.settlementService as PaymentsService
  const invoice = this.parameters.settlementInvoice as Invoice

  await rejects(service.confirmInvoice(invoice))
  await rejects(service.confirmInvoice(invoice))
})

Then('the invoice has two settlement attempts and one alert', async function (this: World<Record<string, any>>) {
  const db = this.parameters.settlementDb
  const id = this.parameters.settlementInvoiceId as string
  const row = await db('invoices').where({ id }).first()

  expect(row.settlement_attempts).to.equal(2)
  expect(row.last_settlement_error).to.include('no term snapshot')
  expect(row.confirmed_at).to.equal(null)
  expect(row.settlement_alerted_at).to.be.instanceOf(Date)

  const alerts = await db('notification_outbox')
    .where({ event_type: 'peering.payment.failed' })
    .whereRaw("payload->>'invoiceId' = ?", [id])
  expect(alerts).to.have.length(1)
  expect(alerts[0].payload).to.include({
    invoiceId: id,
    attempts: 2,
  })
})

When('its settlement fails once more', async function (this: World<Record<string, any>>) {
  const service = this.parameters.settlementService as PaymentsService
  const invoice = this.parameters.settlementInvoice as Invoice

  await rejects(service.confirmInvoice(invoice))
})

Then('the invoice still has only one settlement alert', async function (this: World<Record<string, any>>) {
  const db = this.parameters.settlementDb
  const id = this.parameters.settlementInvoiceId as string
  const row = await db('invoices').where({ id }).first()
  const alerts = await db('notification_outbox')
    .where({ event_type: 'peering.payment.failed' })
    .whereRaw("payload->>'invoiceId' = ?", [id])

  expect(row.settlement_attempts).to.equal(3)
  expect(alerts).to.have.length(1)
})
