import { createHash } from 'crypto'
import { expect } from 'chai'

import { Event } from '../../../src/@types/event'
import { EventKinds, EventTags } from '../../../src/constants/base'
import { getPublicKey, identifyEvent, signEvent } from '../../../src/utils/event'
import {
  isNip98UrlMatch,
  parseNip98AuthorizationHeader,
  verifyNip98AuthorizationHeader,
  verifyNip98Event,
} from '../../../src/utils/nip98'
import { Tag } from '../../../src/@types/base'

describe('NIP-98', () => {
  const privkey = 'a'.repeat(64)
  const pubkey = getPublicKey(privkey)
  const requestUrl = 'https://relay.example.com/admin/login'
  const requestMethod = 'POST'
  const now = Math.floor(Date.now() / 1000)

  async function createHttpAuthEvent(overrides: {
    kind?: number
    url?: string
    method?: string
    payload?: string
    created_at?: number
    omitUrlTag?: boolean
    omitMethodTag?: boolean
    invalidId?: boolean
    invalidSig?: boolean
  } = {}): Promise<Event> {
    const tags: Tag[] = []
    if (!overrides.omitUrlTag) {
      tags.push([EventTags.Url, overrides.url ?? requestUrl] as Tag)
    }
    if (!overrides.omitMethodTag) {
      tags.push([EventTags.Method, overrides.method ?? requestMethod] as Tag)
    }
    if (typeof overrides.payload === 'string') {
      tags.push([EventTags.Payload, overrides.payload] as Tag)
    }

    const identified = await identifyEvent({
      pubkey,
      created_at: overrides.created_at ?? now,
      kind: overrides.kind ?? EventKinds.HTTP_AUTH,
      tags,
      content: '',
    })

    if (overrides.invalidId) {
      identified.id = 'f'.repeat(64)
    }

    if (overrides.invalidSig) {
      return { ...identified, sig: '0'.repeat(128) } as Event
    }

    return signEvent(privkey)(identified)
  }

  const toHeader = (event: Event, scheme = 'Nostr'): string =>
    `${scheme} ${Buffer.from(JSON.stringify(event)).toString('base64')}`

  const context = { url: requestUrl, method: requestMethod }

  describe('parseNip98AuthorizationHeader', () => {
    it('rejects a missing header', () => {
      const result = parseNip98AuthorizationHeader(undefined)

      expect(result.ok).to.be.false
    })

    it('rejects non-Nostr schemes', () => {
      const result = parseNip98AuthorizationHeader('Bearer some-token')

      expect(result.ok).to.be.false
    })

    it('rejects tokens with invalid base64 characters', () => {
      const result = parseNip98AuthorizationHeader('Nostr $$$$')

      expect(result.ok).to.be.false
    })

    it('rejects tokens with invalid base64 length', () => {
      const result = parseNip98AuthorizationHeader('Nostr abc')

      expect(result.ok).to.be.false
    })

    it('rejects tokens that do not decode to JSON', () => {
      const token = Buffer.from('not json', 'utf8').toString('base64')
      const result = parseNip98AuthorizationHeader(`Nostr ${token}`)

      expect(result.ok).to.be.false
    })

    it('rejects events that fail schema validation', async () => {
      const event = await createHttpAuthEvent()
      const token = Buffer.from(JSON.stringify({ ...event, extra: 'key' })).toString('base64')
      const result = parseNip98AuthorizationHeader(`Nostr ${token}`)

      expect(result.ok).to.be.false
    })

    it('accepts a case-insensitive scheme', async () => {
      const event = await createHttpAuthEvent()
      const result = parseNip98AuthorizationHeader(toHeader(event, 'nostr'))

      expect(result.ok).to.be.true
    })

    it('parses a valid header', async () => {
      const event = await createHttpAuthEvent()
      const result = parseNip98AuthorizationHeader(toHeader(event))

      expect(result.ok).to.be.true
      if (result.ok) {
        expect(result.event.pubkey).to.equal(pubkey)
        expect(result.event.kind).to.equal(EventKinds.HTTP_AUTH)
      }
    })
  })

  describe('isNip98UrlMatch', () => {
    it('accepts an exact match', () => {
      expect(isNip98UrlMatch(requestUrl, requestUrl)).to.be.true
    })

    it('accepts host case differences', () => {
      expect(isNip98UrlMatch('https://RELAY.EXAMPLE.COM/admin/login', requestUrl)).to.be.true
    })

    it('accepts default port normalization', () => {
      expect(isNip98UrlMatch('https://relay.example.com:443/admin/login', requestUrl)).to.be.true
    })

    it('rejects path mismatches', () => {
      expect(isNip98UrlMatch('https://relay.example.com/admin/health', requestUrl)).to.be.false
    })

    it('rejects trailing slash differences', () => {
      expect(isNip98UrlMatch('https://relay.example.com/admin/login/', requestUrl)).to.be.false
    })

    it('rejects scheme mismatches', () => {
      expect(isNip98UrlMatch('http://relay.example.com/admin/login', requestUrl)).to.be.false
    })

    it('rejects query string mismatches', () => {
      expect(isNip98UrlMatch(`${requestUrl}?a=1`, requestUrl)).to.be.false
      expect(isNip98UrlMatch(`${requestUrl}?a=1&b=2`, `${requestUrl}?b=2&a=1`)).to.be.false
    })

    it('accepts matching query strings', () => {
      expect(isNip98UrlMatch(`${requestUrl}?a=1&b=2`, `${requestUrl}?a=1&b=2`)).to.be.true
    })

    it('rejects unparseable URLs', () => {
      expect(isNip98UrlMatch('not a url', requestUrl)).to.be.false
    })
  })

  describe('verifyNip98Event', () => {
    it('accepts a valid event', async () => {
      const event = await createHttpAuthEvent()
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.true
      if (result.ok) {
        expect(result.event.pubkey).to.equal(pubkey)
      }
    })

    it('rejects wrong event kinds', async () => {
      const event = await createHttpAuthEvent({ kind: EventKinds.AUTH })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.false
    })

    it('rejects tampered event ids', async () => {
      const event = await createHttpAuthEvent({ invalidId: true })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.false
    })

    it('rejects invalid signatures', async () => {
      const event = await createHttpAuthEvent({ invalidSig: true })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.false
    })

    it('rejects stale timestamps', async () => {
      const event = await createHttpAuthEvent({ created_at: now - 61 })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.false
    })

    it('rejects future timestamps', async () => {
      const event = await createHttpAuthEvent({ created_at: now + 61 })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.false
    })

    it('accepts timestamps within tolerance', async () => {
      const event = await createHttpAuthEvent({ created_at: now - 59 })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.true
    })

    it('honors a custom timestamp tolerance', async () => {
      const event = await createHttpAuthEvent({ created_at: now - 120 })
      const result = await verifyNip98Event(event, context, { now, timestampToleranceSeconds: 300 })

      expect(result.ok).to.be.true
    })

    it('rejects events without a u tag', async () => {
      const event = await createHttpAuthEvent({ omitUrlTag: true })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.false
    })

    it('rejects u tag mismatches', async () => {
      const event = await createHttpAuthEvent({ url: 'https://relay.example.com/admin/health' })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.false
    })

    it('rejects events without a method tag', async () => {
      const event = await createHttpAuthEvent({ omitMethodTag: true })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.false
    })

    it('rejects method tag mismatches', async () => {
      const event = await createHttpAuthEvent({ method: 'GET' })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.false
    })

    it('accepts case-insensitive method tags', async () => {
      const event = await createHttpAuthEvent({ method: 'post' })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.true
    })

    it('accepts a matching payload tag', async () => {
      const body = 'request body'
      const bodySha256Hex = createHash('sha256').update(body).digest('hex')
      const event = await createHttpAuthEvent({ payload: bodySha256Hex })
      const result = await verifyNip98Event(event, { ...context, bodySha256Hex }, { now })

      expect(result.ok).to.be.true
    })

    it('rejects payload tag mismatches', async () => {
      const event = await createHttpAuthEvent({ payload: 'a'.repeat(64) })
      const bodySha256Hex = createHash('sha256').update('other body').digest('hex')
      const result = await verifyNip98Event(event, { ...context, bodySha256Hex }, { now })

      expect(result.ok).to.be.false
    })

    it('rejects a payload tag when no body hash is available', async () => {
      const event = await createHttpAuthEvent({ payload: 'a'.repeat(64) })
      const result = await verifyNip98Event(event, context, { now })

      expect(result.ok).to.be.false
    })

    it('accepts a body without a payload tag', async () => {
      const bodySha256Hex = createHash('sha256').update('ignored body').digest('hex')
      const event = await createHttpAuthEvent()
      const result = await verifyNip98Event(event, { ...context, bodySha256Hex }, { now })

      expect(result.ok).to.be.true
    })
  })

  describe('verifyNip98AuthorizationHeader', () => {
    it('verifies a valid header end to end', async () => {
      const event = await createHttpAuthEvent()
      const result = await verifyNip98AuthorizationHeader(toHeader(event), context, { now })

      expect(result.ok).to.be.true
    })

    it('propagates parse failures', async () => {
      const result = await verifyNip98AuthorizationHeader('Bearer token', context, { now })

      expect(result.ok).to.be.false
    })
  })
})
