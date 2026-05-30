import { After, Given, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import axios, { AxiosResponse } from 'axios'
import { assocPath, pipe } from 'ramda'
import { SettingsStatic } from '../../../../src/utils/settings'

const BASE_URL = 'http://localhost:18808'

Given(
  'payments are enabled with processor {string}',
  function (this: World<Record<string, any>>, processor: string) {
    const settings = SettingsStatic._settings as any
    if (!this.parameters.previousResponseTypesSettings) {
      this.parameters.previousResponseTypesSettings = structuredClone(settings)
    }

    const baseSettings = pipe(
      assocPath(['payments', 'enabled'], true),
      assocPath(['payments', 'processor'], processor),
    )(settings) as any

    if (processor === 'zebedee') {
      SettingsStatic._settings = assocPath(['paymentsProcessors', 'zebedee', 'ipWhitelist'], [], baseSettings) as any
      return
    }

    if (processor === 'lnbits') {
      this.parameters.lnbitsApiKeyModified = true
      if (typeof this.parameters.previousLnbitsApiKey === 'undefined') {
        this.parameters.previousLnbitsApiKey = process.env.LNBITS_API_KEY
      }
      process.env.LNBITS_API_KEY = 'integration-lnbits-api-key'

      SettingsStatic._settings = assocPath(
        ['paymentsProcessors', 'lnbits', 'callbackBaseURL'],
        'http://localhost:18808/callbacks/lnbits',
        baseSettings,
      ) as any
      return
    }

    SettingsStatic._settings = baseSettings
  },
)

When(
  'a client requests path {string} with Accept header {string}',
  async function (this: World<Record<string, any>>, requestPath: string, acceptHeader: string) {
    const response: AxiosResponse = await axios.get(`${BASE_URL}${requestPath}`, {
      headers: { Accept: acceptHeader },
      validateStatus: () => true,
    })

    this.parameters.httpResponse = response
  },
)

When('a client requests dynamic path {string}', async function (this: World<Record<string, any>>, requestPath: string) {
  const response: AxiosResponse = await axios.get(`${BASE_URL}${requestPath}`, {
    validateStatus: () => true,
  })

  this.parameters.httpResponse = response
})

When(
  'a client posts {string} to path {string} with Content-Type {string}',
  async function (
    this: World<Record<string, any>>,
    body: string,
    requestPath: string,
    contentTypeHeader: string,
  ) {
    const response: AxiosResponse = await axios.post(`${BASE_URL}${requestPath}`, body, {
      headers: { 'content-type': contentTypeHeader },
      validateStatus: () => true,
    })

    this.parameters.httpResponse = response
  },
)

Then('the HTTP response status is {int}', function (this: World<Record<string, any>>, statusCode: number) {
  expect(this.parameters.httpResponse.status).to.equal(statusCode)
})

Then(
  'the HTTP response Content-Type includes {string}',
  function (this: World<Record<string, any>>, contentType: string) {
    const contentTypeHeader = this.parameters.httpResponse.headers['content-type']
    const headerValue = Array.isArray(contentTypeHeader) ? contentTypeHeader.join(';') : contentTypeHeader
    const normalizedHeader = typeof headerValue === 'string' ? headerValue.toLowerCase() : ''
    expect(normalizedHeader).to.include(contentType.toLowerCase())
  },
)

After({ tags: '@response-types' }, function (this: World<Record<string, any>>) {
  if (this.parameters.previousResponseTypesSettings) {
    SettingsStatic._settings = this.parameters.previousResponseTypesSettings
    this.parameters.previousResponseTypesSettings = undefined
  }

  if (this.parameters.lnbitsApiKeyModified) {
    if (typeof this.parameters.previousLnbitsApiKey === 'undefined') {
      delete process.env.LNBITS_API_KEY
    } else {
      process.env.LNBITS_API_KEY = this.parameters.previousLnbitsApiKey
    }
    this.parameters.previousLnbitsApiKey = undefined
    this.parameters.lnbitsApiKeyModified = false
  }
})
