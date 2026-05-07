import { Then, When, World } from '@cucumber/cucumber'
import axios, { AxiosResponse } from 'axios'
import chai from 'chai'

import packageJson from '../../../../package.json'
import { DEFAULT_FILTER_LIMIT } from '../../../../src/constants/base'
import { createSettings } from '../../../../src/factories/settings-factory'

chai.use(require('sinon-chai'))
const { expect } = chai

const BASE_URL = 'http://localhost:18808'

When('a client requests the relay information document', async function(this: World<Record<string, any>>) {
  const response: AxiosResponse = await axios.get(BASE_URL, {
    headers: { Accept: 'application/nostr+json' },
    validateStatus: () => true,
  })
  this.parameters.httpResponse = response
})

When('a client requests the root path with Accept header {string}', async function(
  this: World<Record<string, any>>,
  acceptHeader: string,
) {
  const response: AxiosResponse = await axios.get(BASE_URL, {
    headers: { Accept: acceptHeader },
    validateStatus: () => true,
  })
  this.parameters.httpResponse = response
})

When('a browser requests the root path', async function(this: World<Record<string, any>>) {
  const response: AxiosResponse = await axios.get(BASE_URL, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
    validateStatus: () => true,
  })
  this.parameters.httpResponse = response
})

Then('the response status is {int}', function(this: World<Record<string, any>>, status: number) {
  expect(this.parameters.httpResponse.status).to.equal(status)
})

Then('the response Content-Type includes {string}', function(
  this: World<Record<string, any>>,
  contentType: string,
) {
  expect(this.parameters.httpResponse.headers['content-type']).to.include(contentType)
})

Then('the response Content-Type does not include {string}', function(
  this: World<Record<string, any>>,
  contentType: string,
) {
  expect(this.parameters.httpResponse.headers['content-type']).to.not.include(contentType)
})

Then('the relay information document contains the required fields', function(this: World<Record<string, any>>) {
  const doc = this.parameters.httpResponse.data
  for (const field of ['name', 'description', 'pubkey', 'supported_nips', 'software', 'version']) {
    expect(doc, `expected relay info doc to have field "${field}"`).to.have.property(field)
  }
})

Then('the supported_nips field matches the NIPs declared in package.json', function(this: World<Record<string, any>>) {
  const doc = this.parameters.httpResponse.data
  expect(doc.supported_nips).to.deep.equal(packageJson.supportedNips)
})

Then('the response body is not a relay information document', function(this: World<Record<string, any>>) {
  const body = this.parameters.httpResponse.data
  const isRelayInfoDoc = typeof body === 'object' && body !== null && 'supported_nips' in body
  expect(isRelayInfoDoc).to.equal(false)
})

Then('the limitation object contains a max_filters field', function(this: World<Record<string, any>>) {
  const doc = this.parameters.httpResponse.data
  const expectedMaxFilters = createSettings().limits?.client?.subscription?.maxFilters
  expect(doc.limitation.max_filters).to.equal(expectedMaxFilters)
})

Then('the relay information response includes required NIP-11 CORS headers', function(
  this: World<Record<string, any>>,
) {
  const headers = this.parameters.httpResponse.headers
  expect(headers['access-control-allow-origin']).to.equal('*')
  expect(headers['access-control-allow-headers']).to.equal('*')
  expect(headers['access-control-allow-methods']).to.equal('GET, OPTIONS')
})

Then('the limitation object contains NIP-11 parity fields and values', function(this: World<Record<string, any>>) {
  const doc = this.parameters.httpResponse.data
  const settings = createSettings()
  const eventLimits = settings.limits?.event

  const expectedRestrictedWrites =
    Boolean(settings.payments?.enabled && settings.payments?.feeSchedules?.admission?.some((fee) => fee.enabled)) ||
    (eventLimits?.eventId?.minLeadingZeroBits ?? 0) > 0 ||
    (eventLimits?.pubkey?.minLeadingZeroBits ?? 0) > 0 ||
    (eventLimits?.pubkey?.whitelist?.length ?? 0) > 0 ||
    (eventLimits?.pubkey?.blacklist?.length ?? 0) > 0 ||
    (eventLimits?.kind?.whitelist?.length ?? 0) > 0 ||
    (eventLimits?.kind?.blacklist?.length ?? 0) > 0

  expect(doc.limitation.created_at_lower_limit).to.equal(eventLimits?.createdAt?.maxNegativeDelta)
  expect(doc.limitation.created_at_upper_limit).to.equal(eventLimits?.createdAt?.maxPositiveDelta)
  expect(doc.limitation.default_limit).to.equal(DEFAULT_FILTER_LIMIT)
  expect(doc.limitation.restricted_writes).to.equal(expectedRestrictedWrites)
})
