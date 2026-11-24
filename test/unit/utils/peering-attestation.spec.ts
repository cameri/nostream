import { expect } from 'chai'

import type { PeeringScope, PeeringTerm } from '../../../src/@types/settings'
import { getPublicKey, identifyEvent, signEvent } from '../../../src/utils/event'
import { toBech32 } from '../../../src/utils/transform'
import {
  buildPeeringAcceptanceEvent,
  buildPeeringRequestEvent,
  normalizePeeringRelayUrl,
  peeringTermsHash,
  samePeeringScopes,
  samePeeringTerms,
  verifyPeeringAcceptanceEvent,
  verifyPeeringRequestEvent,
} from '../../../src/utils/peering-attestation'

const ownerKey = '1'.repeat(64)
const relayKey = '2'.repeat(64)
const receiverKey = '3'.repeat(64)
const ownerPubkey = getPublicKey(ownerKey)
const relayPubkey = getPublicKey(relayKey)
const receiverPubkey = getPublicKey(receiverKey)
const now = new Date('2026-11-23T12:00:00.000Z')
const createdAt = Math.floor(now.getTime() / 1000)

const scopes: PeeringScope[] = [{ kinds: [1, [10000, 19999]] }]
const terms: PeeringTerm[] = [{ amount: 21000, unit: 'msats', period: 2592000 }]

const buildRequest = (overrides: Partial<Parameters<typeof buildPeeringRequestEvent>[0]> = {}) =>
  buildPeeringRequestEvent({
    ownerPrivateKey: ownerKey,
    relayPubkey,
    relayUrl: 'wss://requester.example.com',
    receiverPubkey,
    scopes,
    terms,
    createdAt,
    ...overrides,
  })

const signedEvent = async (kind: number, content: string, tags: string[][], key = ownerKey) =>
  signEvent(key)(
    await identifyEvent({
      pubkey: getPublicKey(key),
      created_at: createdAt,
      kind,
      tags: tags as never,
      content,
    }),
  )

const verifyOptions = (overrides: Partial<Parameters<typeof verifyPeeringRequestEvent>[1]> = {}) => ({
  authenticatedPubkeys: [relayPubkey],
  receiverPubkey,
  offeredScopes: scopes,
  offeredTerms: terms,
  now,
  ...overrides,
})

describe('peering attestation', () => {
  it('verifies an owner-signed request against the AUTH identity and advertised terms', async () => {
    const event = await buildRequest()

    const result = await verifyPeeringRequestEvent(event, verifyOptions())

    expect(result.ok).to.equal(true)
    if (result.ok) {
      expect(result.request.relay_pubkey).to.equal(relayPubkey)
      expect(result.request.terms_hash).to.equal(peeringTermsHash(terms))
      expect(result.powDifficulty).to.be.greaterThanOrEqual(0)
    }
  })

  it('accepts an npub form of the configured owner key', async () => {
    const event = await buildRequest()

    const result = await verifyPeeringRequestEvent(
      event,
      verifyOptions({ expectedOwnerPubkey: toBech32('npub')(ownerPubkey) }),
    )

    expect(result.ok).to.equal(true)
  })

  it('rejects a request signed by an owner other than the configured one', async () => {
    const event = await buildRequest()

    const result = await verifyPeeringRequestEvent(
      event,
      verifyOptions({ expectedOwnerPubkey: getPublicKey('4'.repeat(64)) }),
    )

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('owner')
    }
  })

  it('rejects a request whose relay key did not authenticate on the connection', async () => {
    const event = await buildRequest()

    const result = await verifyPeeringRequestEvent(
      event,
      verifyOptions({ authenticatedPubkeys: [getPublicKey('4'.repeat(64))] }),
    )

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('not authenticated')
    }
  })

  it('rejects a request built against changed terms', async () => {
    const event = await buildRequest()

    const result = await verifyPeeringRequestEvent(
      event,
      verifyOptions({ offeredTerms: [{ amount: 22000, unit: 'msats', period: 2592000 }] }),
    )

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('terms changed')
    }
  })

  it('rejects a scope the relay does not offer', async () => {
    const event = await buildRequest()

    const result = await verifyPeeringRequestEvent(event, verifyOptions({ offeredScopes: [{ kinds: [7] }] }))

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('scope')
    }
  })

  it('rejects a stale request', async () => {
    const event = await buildRequest()

    const result = await verifyPeeringRequestEvent(
      event,
      verifyOptions({ now: new Date(now.getTime() + 11 * 60 * 1000) }),
    )

    expect(result).to.include({ ok: false })
  })

  it('requires the advertised proof-of-work from unconfigured peers', async () => {
    const event = await buildRequest()
    const options = verifyOptions({ minPowDifficulty: 8 })

    const result = await verifyPeeringRequestEvent(event, options)

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('pow:')
    }
  })

  it('waives proof-of-work for configured peers by default', async () => {
    const event = await buildRequest()

    const result = await verifyPeeringRequestEvent(
      event,
      verifyOptions({ minPowDifficulty: 8, isConfiguredPeer: true }),
    )

    expect(result.ok).to.equal(true)
  })

  it('accepts a correctly ground request', async () => {
    const event = await buildRequest({ powDifficulty: 4 })

    const result = await verifyPeeringRequestEvent(event, verifyOptions({ minPowDifficulty: 4 }))

    expect(result.ok).to.equal(true)
  })

  it('rejects malformed relay or receiver pubkeys when building', async () => {
    let error: unknown
    try {
      await buildRequest({ relayPubkey: 'not-a-pubkey' })
    } catch (caught) {
      error = caught
    }

    expect((error as Error).message).to.include('32-byte hex')
  })

  it('fails when proof-of-work cannot be found in the attempt budget', async () => {
    let error: unknown
    try {
      await buildRequest({ powDifficulty: 200, maxPowAttempts: 1 })
    } catch (caught) {
      error = caught
    }

    expect((error as Error).message).to.include('proof-of-work')
  })

  it('rejects an event with the wrong kind', async () => {
    const event = await signedEvent(1, '{}', [])

    const result = await verifyPeeringRequestEvent(event, verifyOptions())

    expect(result).to.include({ ok: false, reason: 'not a peering request' })
  })

  it('rejects malformed request content', async () => {
    const event = await signedEvent(28937, 'not-json', [
      ['p', receiverPubkey],
      ['t', 'peering-request'],
    ])

    const result = await verifyPeeringRequestEvent(event, verifyOptions())

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('malformed')
    }
  })

  it('rejects a request that does not target this relay', async () => {
    const payload = JSON.parse((await buildRequest()).content)
    const event = await signedEvent(28937, JSON.stringify(payload), [
      ['p', getPublicKey('4'.repeat(64))],
      ['t', 'peering-request'],
    ])

    const result = await verifyPeeringRequestEvent(event, verifyOptions())

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('target')
    }
  })

  it('rejects a malformed configured owner key', async () => {
    const event = await buildRequest()

    const result = await verifyPeeringRequestEvent(event, verifyOptions({ expectedOwnerPubkey: 'nope' }))

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('configured owner')
    }
  })

  it('produces a relay-signed acceptance for the exact request', async () => {
    const request = await buildRequest()
    const requestPayload = await verifyPeeringRequestEvent(request, verifyOptions())
    expect(requestPayload.ok).to.equal(true)
    if (!requestPayload.ok) {
      return
    }

    const acceptance = await buildPeeringAcceptanceEvent({
      request,
      acceptance: requestPayload.request,
      relayPrivateKey: receiverKey,
      relayUrl: 'wss://receiver.example.com',
      createdAt,
    })
    const verified = await verifyPeeringAcceptanceEvent(acceptance, request)

    expect(acceptance.pubkey).to.equal(receiverPubkey)
    expect(verified.ok).to.equal(true)
    if (verified.ok) {
      expect(verified.acceptance.request_id).to.equal(request.id)
      expect(verified.acceptance.terms_hash).to.equal(peeringTermsHash(terms))
    }
  })

  it('normalizes http relay URLs for signed payloads', () => {
    expect(normalizePeeringRelayUrl('https://peer.example.com')).to.equal('wss://peer.example.com')
    expect(normalizePeeringRelayUrl('http://peer.example.com')).to.equal('ws://peer.example.com')
    expect(normalizePeeringRelayUrl('wss://peer.example.com')).to.equal('wss://peer.example.com')
  })

  it('treats a singleton kind range as the same kind', () => {
    expect(samePeeringScopes([{ kinds: [[1, 1]] }], [{ kinds: [1] }])).to.equal(true)
  })

  it('treats term and scope order as insignificant', () => {
    const reversedTerms = [...terms].reverse()
    const scopesA: PeeringScope[] = [{ kinds: [[10000, 19999], 1] }]
    const scopesB: PeeringScope[] = [{ kinds: [1, [10000, 19999]] }]

    expect(samePeeringTerms(terms, reversedTerms)).to.equal(true)
    expect(samePeeringScopes(scopesA, scopesB)).to.equal(true)
  })
})

describe('peering acceptance verification', () => {
  it('rejects an acceptance with the wrong kind', async () => {
    const request = await buildRequest()
    const event = await signedEvent(1, '{}', [], receiverKey)

    const result = await verifyPeeringAcceptanceEvent(event, request)

    expect(result).to.include({ ok: false, reason: 'not a peering acceptance' })
  })

  it('rejects an acceptance that does not reference the request', async () => {
    const request = await buildRequest()
    const event = await signedEvent(
      28938,
      JSON.stringify({
        request_id: request.id,
        relay_pubkey: receiverPubkey,
        relay_url: 'wss://receiver.example.com',
        terms_hash: peeringTermsHash(terms),
        accepted_at: createdAt,
      }),
      [['p', ownerPubkey]],
      receiverKey,
    )

    const result = await verifyPeeringAcceptanceEvent(event, request)

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('reference')
    }
  })

  it('rejects malformed acceptance content', async () => {
    const request = await buildRequest()
    const event = await signedEvent(28938, 'not-json', [['e', request.id]], receiverKey)

    const result = await verifyPeeringAcceptanceEvent(event, request)

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('malformed')
    }
  })

  it('rejects an acceptance whose signer does not match its relay key', async () => {
    const request = await buildRequest()
    const event = await signedEvent(
      28938,
      JSON.stringify({
        request_id: request.id,
        relay_pubkey: relayPubkey,
        relay_url: 'wss://receiver.example.com',
        terms_hash: peeringTermsHash(terms),
        accepted_at: createdAt,
      }),
      [['e', request.id]],
      receiverKey,
    )

    const result = await verifyPeeringAcceptanceEvent(event, request)

    expect(result).to.include({ ok: false })
    if (result.ok === false) {
      expect(result.reason).to.include('signer')
    }
  })
})
