import { After, Given, Then, When } from '@cucumber/cucumber'
import axios, { AxiosResponse } from 'axios'
import { expect } from 'chai'
import { randomUUID } from 'crypto'

import { getMasterDbClient } from '../../../../src/database/client'
import { hmacSha256 } from '../../../../src/utils/secret'
import { SettingsStatic } from '../../../../src/utils/settings'

const CALLBACK_URL = 'http://localhost:18808/callbacks/opennode'
const OPENNODE_TEST_API_KEY = 'integration-opennode-api-key'
const TEST_PUBKEY = 'a'.repeat(64)

const postOpenNodeCallback = async (body: Record<string, string>) => {
  const encodedBody = new URLSearchParams(body).toString()

  return axios.post(
    CALLBACK_URL,
    encodedBody,
    {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      validateStatus: () => true,
    },
  )
}

Given('OpenNode callback processing is enabled', function () {
  const settings = SettingsStatic._settings as any

  this.parameters.previousOpenNodeCallbackSettings = settings
  this.parameters.previousOpenNodeApiKey = process.env.OPENNODE_API_KEY

  SettingsStatic._settings = {
    ...settings,
    payments: {
      ...(settings?.payments ?? {}),
      processor: 'opennode',
    },
  }

  process.env.OPENNODE_API_KEY = OPENNODE_TEST_API_KEY
})

Given('a pending OpenNode invoice exists', async function () {
  const dbClient = getMasterDbClient()
  const invoiceId = `integration-opennode-${randomUUID()}`

  await dbClient('invoices').insert({
    id: invoiceId,
    pubkey: Buffer.from(TEST_PUBKEY, 'hex'),
    bolt11: 'lnbc210n1integration',
    amount_requested: '21000',
    unit: 'sats',
    status: 'pending',
    description: 'open node integration callback test',
    expires_at: new Date(Date.now() + 15 * 60 * 1000),
    updated_at: new Date(),
    created_at: new Date(),
  })

  this.parameters.openNodeInvoiceId = invoiceId
  this.parameters.openNodeInvoiceIds = [
    ...(this.parameters.openNodeInvoiceIds ?? []),
    invoiceId,
  ]
})

When('I post a malformed OpenNode callback', async function () {
  this.parameters.openNodeResponse = await postOpenNodeCallback({
    id: 'missing-required-fields',
  })
})

When('I post an OpenNode callback with an invalid signature', async function () {
  this.parameters.openNodeResponse = await postOpenNodeCallback({
    hashed_order: '0'.repeat(64),
    id: `integration-opennode-${randomUUID()}`,
    status: 'paid',
  })
})

When('I post a signed OpenNode callback with status {string}', async function (status: string) {
  const id = this.parameters.openNodeInvoiceId
  const hashedOrder = hmacSha256(OPENNODE_TEST_API_KEY, id).toString('hex')

  this.parameters.openNodeResponse = await postOpenNodeCallback({
    hashed_order: hashedOrder,
    id,
    status,
  })
})

Then('the OpenNode callback response status is {int}', function (statusCode: number) {
  const response = this.parameters.openNodeResponse as AxiosResponse

  expect(response.status).to.equal(statusCode)
})

Then('the OpenNode callback response body is {string}', function (expectedBody: string) {
  const response = this.parameters.openNodeResponse as AxiosResponse

  expect(response.data).to.equal(expectedBody)
})

Then('the OpenNode callback response body is empty', function () {
  const response = this.parameters.openNodeResponse as AxiosResponse

  expect(['', undefined, null]).to.include(response.data)
})

Then('the OpenNode invoice is marked completed', async function () {
  const dbClient = getMasterDbClient()
  const invoiceId = this.parameters.openNodeInvoiceId

  const invoice = await dbClient('invoices')
    .where('id', invoiceId)
    .first('status', 'confirmed_at', 'amount_paid')

  expect(invoice).to.exist
  expect(invoice.status).to.equal('completed')
  expect(invoice.confirmed_at).to.not.equal(null)
  expect(invoice.amount_paid).to.equal('21000')
})

After({ tags: '@opennode-callback' }, async function () {
  SettingsStatic._settings = this.parameters.previousOpenNodeCallbackSettings

  if (typeof this.parameters.previousOpenNodeApiKey === 'undefined') {
    delete process.env.OPENNODE_API_KEY
  } else {
    process.env.OPENNODE_API_KEY = this.parameters.previousOpenNodeApiKey
  }

  const invoiceIds = this.parameters.openNodeInvoiceIds ?? []
  if (invoiceIds.length > 0) {
    const dbClient = getMasterDbClient()
    await dbClient('invoices').whereIn('id', invoiceIds).delete()
  }

  this.parameters.openNodeInvoiceId = undefined
  this.parameters.openNodeInvoiceIds = []
  this.parameters.openNodeResponse = undefined
  this.parameters.previousOpenNodeApiKey = undefined
  this.parameters.previousOpenNodeCallbackSettings = undefined
})
