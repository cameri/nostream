import WebSocket from 'ws'
import { setTimeout as sleep } from 'node:timers/promises'

import { After, Given, Then, When, World } from '@cucumber/cucumber'
import axios, { AxiosResponse } from 'axios'
import { expect } from 'chai'
import * as secp256k1 from '@noble/secp256k1'
import { nwc } from '@getalby/sdk'

import { getMasterDbClient } from '../../../../src/database/client'
import { SettingsStatic } from '../../../../src/utils/settings'

;(globalThis as any).WebSocket = WebSocket

const INVOICES_URL = 'http://localhost:18808/invoices'
const ADMISSION_FEE_MSATS = 1000000

const randomHex = () => secp256k1.utils.bytesToHex(secp256k1.utils.randomPrivateKey())

const buildNwcUrl = (scheme: string, walletPubkey: string, clientSecret: string) => {
  const encodedRelay = encodeURIComponent('ws://localhost:18808')
  return `${scheme}://${walletPubkey}?relay=${encodedRelay}&secret=${clientSecret}`
}

Given('NWC payments are enabled with URI scheme {string}', async function (this: World<Record<string, any>>, scheme: string) {
  const settings = SettingsStatic._settings as any

  this.parameters.previousNwcSettings = settings
  this.parameters.previousNwcUrl = process.env.NWC_URL
  this.parameters.nwcUriScheme = scheme

  const walletSecret = randomHex()
  const clientSecret = randomHex()
  const clientPubkey = secp256k1.utils.bytesToHex(secp256k1.getPublicKey(clientSecret, true).subarray(1))
  const walletPubkey = secp256k1.utils.bytesToHex(secp256k1.getPublicKey(walletSecret, true).subarray(1))

  this.parameters.nwcWalletSecret = walletSecret
  this.parameters.nwcClientSecret = clientSecret
  this.parameters.nwcClientPubkey = clientPubkey
  this.parameters.nwcWalletPubkey = walletPubkey

  const nwcUrl = buildNwcUrl(scheme, walletPubkey, clientSecret)
  process.env.NWC_URL = nwcUrl

  const admission = Array.isArray(settings?.payments?.feeSchedules?.admission)
    ? settings.payments.feeSchedules.admission
    : []

  SettingsStatic._settings = {
    ...settings,
    payments: {
      ...(settings?.payments ?? {}),
      enabled: true,
      processor: 'nwc',
      feeSchedules: {
        ...(settings?.payments?.feeSchedules ?? {}),
        admission: [
          {
            ...(admission[0] ?? {}),
            enabled: true,
            amount: ADMISSION_FEE_MSATS,
            whitelists: {},
          },
        ],
      },
    },
    paymentsProcessors: {
      ...(settings?.paymentsProcessors ?? {}),
      nwc: {
        invoiceExpirySeconds: 900,
        replyTimeoutMs: 10000,
        ...(settings?.paymentsProcessors?.nwc ?? {}),
      },
    },
  }

  const walletService = new nwc.NWCWalletService({ relayUrl: 'ws://localhost:18808' })
  const keypair = new nwc.NWCWalletServiceKeyPair(walletSecret, clientPubkey)

  const dbClient = getMasterDbClient()
  await dbClient('users')
    .insert([
      {
        pubkey: Buffer.from(walletPubkey, 'hex'),
        is_admitted: true,
      },
      {
        pubkey: Buffer.from(clientPubkey, 'hex'),
        is_admitted: true,
      },
    ])
    .onConflict('pubkey')
    .merge({ is_admitted: true })

  await walletService.publishWalletServiceInfoEvent(walletSecret, ['make_invoice', 'lookup_invoice', 'get_info'], [])

  this.parameters.nwcWalletService = walletService
  this.parameters.nwcWalletKeypair = keypair
  this.parameters.nwcWalletInvoices = new Map<string, any>()
  this.parameters.nwcInsertedInvoiceIds = []
  this.parameters.nwcTestPubkeys = [walletPubkey, clientPubkey]
})

Given('NWC reply timeout is set to {int} milliseconds', function (this: World<Record<string, any>>, timeoutMs: number) {
  const settings = SettingsStatic._settings as any
  SettingsStatic._settings = {
    ...settings,
    paymentsProcessors: {
      ...(settings?.paymentsProcessors ?? {}),
      nwc: {
        ...(settings?.paymentsProcessors?.nwc ?? {}),
        replyTimeoutMs: timeoutMs,
      },
    },
  }
})

Given('NWC wallet service make_invoice responds with a pending invoice', async function (this: World<Record<string, any>>) {
  const walletService = this.parameters.nwcWalletService as nwc.NWCWalletService
  const keypair = this.parameters.nwcWalletKeypair as nwc.NWCWalletServiceKeyPair
  const invoices = this.parameters.nwcWalletInvoices as Map<string, any>

  this.parameters.nwcWalletUnsubscribe = await walletService.subscribe(keypair, {
    async makeInvoice(request) {
      const now = Math.floor(Date.now() / 1000)
      const paymentHash = `ph-${request.amount}-${now}`
      const invoice = `lnbc${Math.max(1, Math.floor(request.amount / 1000))}n1integration${now}`
      const tx = {
        type: 'incoming',
        state: 'pending',
        invoice,
        description: request.description ?? '',
        description_hash: request.description_hash ?? '',
        preimage: '',
        payment_hash: paymentHash,
        amount: request.amount,
        fees_paid: 0,
        settled_at: 0,
        created_at: now,
        expires_at: now + (request.expiry ?? 900),
      }
      invoices.set(paymentHash, tx)
      return { result: tx as any, error: undefined }
    },
    async lookupInvoice(request) {
      const tx = request.payment_hash ? invoices.get(request.payment_hash) : undefined
      if (!tx) {
        return { result: undefined, error: { code: 'NOT_FOUND', message: 'invoice not found' } }
      }
      return { result: tx, error: undefined }
    },
    async getInfo() {
      return {
        result: {
          alias: 'nwc-test-wallet',
          color: '#000000',
          pubkey: this.parameters.nwcWalletPubkey,
          network: 'regtest',
          block_height: 0,
          block_hash: '00',
          methods: ['make_invoice', 'lookup_invoice'],
        } as any,
        error: undefined,
      }
    },
  })
})

Given('NWC wallet service make_invoice never responds', async function (this: World<Record<string, any>>) {
  const walletService = this.parameters.nwcWalletService as nwc.NWCWalletService
  const keypair = this.parameters.nwcWalletKeypair as nwc.NWCWalletServiceKeyPair

  this.parameters.nwcWalletUnsubscribe = await walletService.subscribe(keypair, {
    async makeInvoice(request) {
      await sleep(120, undefined, { ref: false })
      const now = Math.floor(Date.now() / 1000)
      return {
        result: {
          type: 'incoming',
          state: 'pending',
          invoice: `lnbc${Math.max(1, Math.floor(request.amount / 1000))}n1late${now}`,
          description: request.description ?? '',
          description_hash: request.description_hash ?? '',
          preimage: '',
          payment_hash: `late-ph-${request.amount}-${now}`,
          amount: request.amount,
          fees_paid: 0,
          settled_at: 0,
          created_at: now,
          expires_at: now + (request.expiry ?? 900),
        } as any,
        error: undefined,
      }
    },
    async lookupInvoice() {
      return { result: undefined, error: { code: 'NOT_FOUND', message: 'invoice not found' } }
    },
  })
})
When('I request an admission invoice for pubkey {string}', async function (this: World<Record<string, any>>, pubkey: string) {
  const response: AxiosResponse = await axios.post(
    INVOICES_URL,
    new URLSearchParams({
      tosAccepted: 'yes',
      feeSchedule: 'admission',
      pubkey,
    }).toString(),
    {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      validateStatus: () => true,
    },
  )

  this.parameters.nwcInvoiceHttpResponse = response
  this.parameters.nwcTestPubkeys = [...(this.parameters.nwcTestPubkeys ?? []), pubkey]

  if (response.status === 400) {
    throw new Error(`Unexpected 400 response body: ${String(response.data)}`)
  }
})

Then('the invoice request response status is {int}', function (this: World<Record<string, any>>, statusCode: number) {
  const response = this.parameters.nwcInvoiceHttpResponse as AxiosResponse
  expect(response.status).to.equal(statusCode)
})

Then('an NWC invoice is stored as pending for pubkey {string}', async function (this: World<Record<string, any>>, pubkey: string) {
  const dbClient = getMasterDbClient()
  const row = await dbClient('invoices')
    .where('pubkey', Buffer.from(pubkey, 'hex'))
    .orderBy('created_at', 'desc')
    .first('id', 'status', 'unit', 'amount_requested')

  expect(row).to.exist
  expect(row.status).to.equal('pending')
  expect(row.unit).to.equal('msats')
  expect(row.amount_requested).to.equal(ADMISSION_FEE_MSATS.toString())

  this.parameters.nwcInsertedInvoiceIds = [
    ...(this.parameters.nwcInsertedInvoiceIds ?? []),
    row.id,
  ]
})

Then('no invoice is stored for pubkey {string}', async function (this: World<Record<string, any>>, pubkey: string) {
  const dbClient = getMasterDbClient()
  const row = await dbClient('invoices')
    .where('pubkey', Buffer.from(pubkey, 'hex'))
    .orderBy('created_at', 'desc')
    .first('id')

  const response = this.parameters.nwcInvoiceHttpResponse as AxiosResponse
  expect(response.status).to.equal(500)
  expect(row).to.equal(undefined)

  await sleep(250, undefined, { ref: false })
})

After({ tags: '@nwc-invoice' }, async function (this: World<Record<string, any>>) {
  const unsubscribe = this.parameters.nwcWalletUnsubscribe as (() => Promise<void>) | (() => void) | undefined
  if (typeof unsubscribe === 'function') {
    await unsubscribe()
  }

  const walletService = this.parameters.nwcWalletService as nwc.NWCWalletService | undefined
  if (walletService) {
    walletService.close()
  }

  if (typeof this.parameters.previousNwcUrl === 'undefined') {
    delete process.env.NWC_URL
  } else {
    process.env.NWC_URL = this.parameters.previousNwcUrl
  }

  if (this.parameters.previousNwcSettings) {
    SettingsStatic._settings = this.parameters.previousNwcSettings
  }

  const dbClient = getMasterDbClient()
  const insertedInvoiceIds = this.parameters.nwcInsertedInvoiceIds ?? []
  if (insertedInvoiceIds.length > 0) {
    await dbClient('invoices').whereIn('id', insertedInvoiceIds).delete()
  }

  const testPubkeys = this.parameters.nwcTestPubkeys ?? []
  if (testPubkeys.length > 0) {
    await dbClient('users')
      .whereIn(
        'pubkey',
        testPubkeys.map((p: string) => Buffer.from(p, 'hex')),
      )
      .delete()
  }

  this.parameters.nwcWalletUnsubscribe = undefined
  this.parameters.nwcWalletService = undefined
  this.parameters.nwcWalletKeypair = undefined
  this.parameters.nwcWalletInvoices = undefined
  this.parameters.nwcInvoiceHttpResponse = undefined
  this.parameters.nwcInsertedInvoiceIds = []
  this.parameters.nwcTestPubkeys = []
  this.parameters.previousNwcUrl = undefined
  this.parameters.previousNwcSettings = undefined
  this.parameters.nwcWalletPubkey = undefined
  this.parameters.nwcClientPubkey = undefined
  this.parameters.nwcWalletSecret = undefined
  this.parameters.nwcClientSecret = undefined
  this.parameters.nwcUriScheme = undefined
})
