import { expect } from 'chai'
import { Tag } from '../../../src/@types/base'
import { EventKinds, EventTags } from '../../../src/constants/base'
import { getPublicKey, identifyEvent, signEvent } from '../../../src/utils/event'
import {
  DEFAULT_NIP98_MAX_AUTHORIZATION_HEADER_LENGTH,
  DEFAULT_NIP98_MAX_SKEW_SECONDS,
  hashNip98Payload,
  verifyNip98Auth,
} from '../../../src/utils/nip98'

describe('nip98', () => {
  // Deterministic fixture key — not a production secret.
  const privkey = 'a'.repeat(64)
  const pubkey = getPublicKey(privkey)
  const url = 'https://relay.example.com/admin/settings'
  const method = 'GET'
  const now = 1_700_000_000

  async function createAuthEvent(
    overrides: {
      kind?: number
      url?: string
      method?: string
      payload?: string
      includePayload?: boolean
      created_at?: number
      content?: string
      invalidId?: boolean
      invalidSig?: boolean
      tags?: Tag[]
      extraTags?: Tag[]
    } = {},
  ) {
    const tags: Tag[] = overrides.tags ?? [
      [EventTags.Url, overrides.url ?? url],
      [EventTags.Method, overrides.method ?? method],
    ]

    if (overrides.tags === undefined) {
      if (overrides.payload !== undefined || overrides.includePayload) {
        tags.push([EventTags.Payload, overrides.payload ?? hashNip98Payload('')])
      }

      if (overrides.extraTags) {
        tags.push(...overrides.extraTags)
      }
    }

    const identified = await identifyEvent({
      pubkey,
      created_at: overrides.created_at ?? now,
      kind: overrides.kind ?? EventKinds.HTTP_AUTH,
      tags,
      content: overrides.content ?? '',
    })

    if (overrides.invalidId) {
      identified.id = 'f'.repeat(64)
    }

    const signed = overrides.invalidSig ? { ...identified, sig: '0'.repeat(128) } : await signEvent(privkey)(identified)

    return signed
  }

  const toAuthorizationHeader = (event: object, scheme = 'Nostr'): string =>
    `${scheme} ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`

  describe('hashNip98Payload', () => {
    it('hashes utf8 strings, buffers and views identically without requiring copies', () => {
      const text = '{"hello":"world"}'
      const buffer = Buffer.from(text, 'utf8')
      const view = new Uint8Array(buffer)

      expect(hashNip98Payload(text)).to.equal(hashNip98Payload(buffer))
      expect(hashNip98Payload(text)).to.equal(hashNip98Payload(view))
      expect(hashNip98Payload(text)).to.match(/^[0-9a-f]{64}$/)
    })
  })

  describe('verifyNip98Auth', () => {
    it('accepts a valid Authorization header from a locally signed fixture', async () => {
      const event = await createAuthEvent()
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
      })

      expect(result.ok).to.equal(true)
      if (result.ok) {
        expect(result.pubkey).to.equal(pubkey)
        expect(result.event.id).to.equal(event.id)
        expect(result.event.kind).to.equal(EventKinds.HTTP_AUTH)
      }
    })

    it('accepts case-insensitive Nostr scheme', async () => {
      const event = await createAuthEvent()
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event, 'nostr'),
        url,
        method,
        nowSeconds: now,
      })

      expect(result.ok).to.equal(true)
    })

    it('rejects missing authorization header', async () => {
      const result = await verifyNip98Auth({
        authorizationHeader: undefined,
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'missing authorization header' })
    })

    it('rejects oversized authorization headers before decoding', async () => {
      const result = await verifyNip98Auth({
        authorizationHeader: `Nostr ${'A'.repeat(DEFAULT_NIP98_MAX_AUTHORIZATION_HEADER_LENGTH)}`,
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'invalid authorization header' })
    })

    it('rejects non-Nostr schemes', async () => {
      const event = await createAuthEvent()
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event, 'Bearer'),
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'invalid authorization header' })
    })

    it('rejects invalid base64 tokens', async () => {
      const result = await verifyNip98Auth({
        authorizationHeader: 'Nostr !!!not-base64!!!',
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'invalid authorization header' })
    })

    it('rejects tokens with internal whitespace instead of stripping it', async () => {
      const event = await createAuthEvent()
      const token = Buffer.from(JSON.stringify(event), 'utf8').toString('base64')
      const result = await verifyNip98Auth({
        authorizationHeader: `Nostr ${token.slice(0, 8)} ${token.slice(8)}`,
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'invalid authorization header' })
    })

    it('rejects invalid event json', async () => {
      const result = await verifyNip98Auth({
        authorizationHeader: `Nostr ${Buffer.from('{not-json', 'utf8').toString('base64')}`,
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'invalid authorization event json' })
    })

    it('rejects events that fail schema validation', async () => {
      const result = await verifyNip98Auth({
        authorizationHeader: `Nostr ${Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64')}`,
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'invalid authorization event' })
    })

    it('rejects non-27235 kinds before signature work is useful to an attacker', async () => {
      const event = await createAuthEvent({ kind: EventKinds.AUTH })
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'invalid: auth event must be kind 27235' })
    })

    it('rejects stale created_at outside the default skew window', async () => {
      const event = await createAuthEvent({ created_at: now - DEFAULT_NIP98_MAX_SKEW_SECONDS - 1 })
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({
        ok: false,
        reason: 'invalid: created_at is too far from the current time',
      })
    })

    it('accepts created_at at the skew boundary', async () => {
      const event = await createAuthEvent({ created_at: now - DEFAULT_NIP98_MAX_SKEW_SECONDS })
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
      })

      expect(result.ok).to.equal(true)
    })

    it('rejects mismatched u tags', async () => {
      const event = await createAuthEvent({ url: `${url}?other=1` })
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'invalid: u tag does not match request url' })
    })

    it('rejects mismatched method tags', async () => {
      const event = await createAuthEvent({ method: 'POST' })
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({
        ok: false,
        reason: 'invalid: method tag does not match request method',
      })
    })

    it('requires a matching payload tag when a non-empty body is provided', async () => {
      const body = '{"enabled":true}'
      const payload = hashNip98Payload(body)

      const ok = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(await createAuthEvent({ method: 'PATCH', payload })),
        url,
        method: 'PATCH',
        body,
        nowSeconds: now,
      })
      const missing = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(await createAuthEvent({ method: 'PATCH' })),
        url,
        method: 'PATCH',
        body,
        nowSeconds: now,
      })
      const wrong = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(
          await createAuthEvent({ method: 'PATCH', payload: hashNip98Payload('other') }),
        ),
        url,
        method: 'PATCH',
        body,
        nowSeconds: now,
      })

      expect(ok.ok).to.equal(true)
      expect(missing).to.deep.equal({ ok: false, reason: 'invalid: missing payload tag' })
      expect(wrong).to.deep.equal({
        ok: false,
        reason: 'invalid: payload tag does not match request body',
      })
    })

    it('rejects non-hex payload tags without relying on digest compare fast-paths', async () => {
      const body = '{"enabled":true}'
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(
          await createAuthEvent({ method: 'PATCH', payload: 'not-a-sha256-digest' }),
        ),
        url,
        method: 'PATCH',
        body,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({
        ok: false,
        reason: 'invalid: payload tag does not match request body',
      })
    })

    it('can use verify-if-present payload policy for non-empty bodies', async () => {
      const body = '{"enabled":true}'
      const withoutPayload = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(await createAuthEvent({ method: 'PATCH' })),
        url,
        method: 'PATCH',
        body,
        payloadPolicy: 'verify-if-present',
        nowSeconds: now,
      })
      const withWrongPayload = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(
          await createAuthEvent({ method: 'PATCH', payload: hashNip98Payload('other') }),
        ),
        url,
        method: 'PATCH',
        body,
        payloadPolicy: 'verify-if-present',
        nowSeconds: now,
      })

      expect(withoutPayload.ok).to.equal(true)
      expect(withWrongPayload).to.deep.equal({
        ok: false,
        reason: 'invalid: payload tag does not match request body',
      })
    })

    it('rejects missing u or method tags', async () => {
      const withoutUrl = await createAuthEvent({
        tags: [[EventTags.Method, method]],
      })
      const withoutMethod = await createAuthEvent({
        tags: [[EventTags.Url, url]],
      })

      expect(
        await verifyNip98Auth({
          authorizationHeader: toAuthorizationHeader(withoutUrl),
          url,
          method,
          nowSeconds: now,
        }),
      ).to.deep.equal({ ok: false, reason: 'invalid: missing u tag' })

      expect(
        await verifyNip98Auth({
          authorizationHeader: toAuthorizationHeader(withoutMethod),
          url,
          method,
          nowSeconds: now,
        }),
      ).to.deep.equal({ ok: false, reason: 'invalid: missing method tag' })
    })

    it('skips payload checks when body is omitted', async () => {
      const event = await createAuthEvent()
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
      })

      expect(result.ok).to.equal(true)
    })

    it('allows empty bodies without a payload tag', async () => {
      const event = await createAuthEvent({ method: 'POST' })
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method: 'POST',
        body: '',
        nowSeconds: now,
      })

      expect(result.ok).to.equal(true)
    })

    it('rejects invalid event ids', async () => {
      const event = await createAuthEvent({ invalidId: true })
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'invalid: event id does not match' })
    })

    it('rejects invalid signatures', async () => {
      const event = await createAuthEvent({ invalidSig: true })
      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
      })

      expect(result).to.deep.equal({
        ok: false,
        reason: 'invalid: event signature verification failed',
      })
    })

    it('rejects the published NIP-98 example because its event id does not match', async () => {
      // Spec example has a signature that verifies against the stated id, but the
      // id is not the hash of the event — NIP-01 invalid. We must reject it.
      const event = {
        id: 'fe964e758903360f28d8424d092da8494ed207cba823110be3a57dfe4b578734',
        pubkey: '63fe6318dc58583cfe16810f86dd09e18bfd76aabc24a0081ce2856f330504ed',
        content: '',
        kind: 27235,
        created_at: 1682327852,
        tags: [
          ['u', 'https://api.snort.social/api/v1/n5sp/list'],
          ['method', 'GET'],
        ],
        sig: '5ed9d8ec958bc854f997bdc24ac337d005af372324747efe4a00e24f4c30437ff4dd8308684bed467d9d6be3e5a517bb43b1732cc7d33949a3aaf86705c22184',
      }

      const result = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url: 'https://api.snort.social/api/v1/n5sp/list',
        method: 'GET',
        nowSeconds: 1682327852,
      })

      expect(result).to.deep.equal({ ok: false, reason: 'invalid: event id does not match' })
    })

    it('respects a custom maxSkewSeconds', async () => {
      const event = await createAuthEvent({ created_at: now - 5 })
      const rejected = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
        maxSkewSeconds: 1,
      })
      const accepted = await verifyNip98Auth({
        authorizationHeader: toAuthorizationHeader(event),
        url,
        method,
        nowSeconds: now,
        maxSkewSeconds: 5,
      })

      expect(rejected.ok).to.equal(false)
      expect(accepted.ok).to.equal(true)
    })
  })
})
