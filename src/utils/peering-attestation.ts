import { createHash } from 'crypto'
import { z } from 'zod'

import type { Tag } from '../@types/base'
import type { Event, UnidentifiedEvent, UnsignedEvent } from '../@types/event'
import type { PeeringAcceptancePayload, PeeringRequestPayload } from '../@types/peering'
import type { PeeringScope, PeeringTerm } from '../@types/settings'
import { EventKinds, EventTags } from '../constants/base'
import {
  getEventProofOfWork,
  getPublicKey,
  identifyEvent,
  isEventIdValid,
  isEventSignatureValid,
  signEvent,
} from './event'

export const PEERING_REQUEST_TOPIC = 'peering-request'
export const PEERING_ACCEPTANCE_TOPIC = 'peering-acceptance'
/** A request older than this is stale and must be built again. */
export const PEERING_REQUEST_MAX_AGE_SECONDS = 10 * 60

const hexPubkey = z.string().regex(/^[0-9a-fA-F]{64}$/)
const relayUrl = z
  .string()
  .url()
  .refine((value) => ['ws:', 'wss:'].includes(new URL(value).protocol), 'relay_url must be ws:// or wss://')

const peeringTermSchema = z.object({
  amount: z.number().finite().nonnegative(),
  unit: z.string().min(1),
  period: z.number().int().positive(),
})

const peeringScopeSchema = z
  .object({
    kinds: z
      .array(
        z.union([
          z.number().int().min(0).max(65535),
          z.tuple([z.number().int().min(0).max(65535), z.number().int().min(0).max(65535)]),
        ]),
      )
      .min(1),
    since: z.number().int().min(0).optional(),
    until: z.number().int().min(0).optional(),
    windowSeconds: z.number().int().positive().optional(),
  })
  .strict()

const requestPayloadSchema = z
  .object({
    relay_pubkey: hexPubkey,
    relay_url: relayUrl,
    scopes: z.array(peeringScopeSchema).min(1),
    terms: z.array(peeringTermSchema),
    terms_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  })
  .strict()

const acceptancePayloadSchema = z
  .object({
    request_id: z.string().regex(/^[0-9a-fA-F]{64}$/),
    relay_pubkey: hexPubkey,
    relay_url: relayUrl,
    terms_hash: z.string().regex(/^[0-9a-fA-F]{64}$/),
    accepted_at: z.number().int().min(0),
  })
  .strict()

const kindStart = (kind: number | [number, number]): number => (Array.isArray(kind) ? kind[0] : kind)
const kindEnd = (kind: number | [number, number]): number => (Array.isArray(kind) ? kind[1] : kind)

const canonicalKind = (kind: number | [number, number]): number | [number, number] =>
  Array.isArray(kind) ? [kind[0], kind[1]] : kind

/** Stable terms shape used for hashing and equality checks. */
export const canonicalPeeringTerms = (terms: PeeringTerm[]): PeeringTerm[] =>
  terms
    .map((term) => ({
      amount: term.amount,
      unit: term.unit,
      period: term.period,
    }))
    .sort((left, right) => {
      if (left.period !== right.period) {
        return left.period - right.period
      }
      if (left.amount !== right.amount) {
        return left.amount - right.amount
      }
      return left.unit.localeCompare(right.unit)
    })

/** Stable scope shape used for equality checks. */
export const canonicalPeeringScopes = (scopes: PeeringScope[]): PeeringScope[] =>
  scopes
    .map((scope) => ({
      kinds: [...scope.kinds]
        .map(canonicalKind)
        .sort((left, right) => kindStart(left) - kindStart(right) || kindEnd(left) - kindEnd(right)),
      ...(scope.since !== undefined ? { since: scope.since } : {}),
      ...(scope.until !== undefined ? { until: scope.until } : {}),
      ...(scope.windowSeconds !== undefined ? { windowSeconds: scope.windowSeconds } : {}),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))

export const peeringTermsHash = (terms: PeeringTerm[]): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalPeeringTerms(terms)))
    .digest('hex')

export const samePeeringTerms = (left: PeeringTerm[], right: PeeringTerm[]): boolean =>
  JSON.stringify(canonicalPeeringTerms(left)) === JSON.stringify(canonicalPeeringTerms(right))

export const samePeeringScopes = (left: PeeringScope[], right: PeeringScope[]): boolean =>
  JSON.stringify(canonicalPeeringScopes(left)) === JSON.stringify(canonicalPeeringScopes(right))

const nonceTags = (tags: Tag[], nonce: number, difficulty: number): Tag[] => [
  ...tags.filter((tag) => tag[0] !== 'nonce'),
  ['nonce', String(nonce), String(difficulty)],
]

const identifyWithOptionalPow = async (
  unsigned: Omit<UnidentifiedEvent, 'id'>,
  difficulty: number,
  maxAttempts: number,
): Promise<UnsignedEvent> => {
  if (difficulty <= 0) {
    return identifyEvent(unsigned)
  }

  for (let nonce = 0; nonce < maxAttempts; nonce += 1) {
    const candidate = await identifyEvent({
      ...unsigned,
      tags: nonceTags(unsigned.tags as Tag[], nonce, difficulty),
    })
    if (getEventProofOfWork(candidate.id) >= difficulty) {
      return candidate
    }
  }

  throw new Error(`unable to find ${difficulty}-bit proof-of-work within ${maxAttempts} attempts`)
}

export interface BuildPeeringRequestOptions {
  /** The operator's key. It is only used to sign the establishment request. */
  ownerPrivateKey: string
  relayPubkey: string
  relayUrl: string
  receiverPubkey: string
  scopes: PeeringScope[]
  terms: PeeringTerm[]
  powDifficulty?: number
  createdAt?: number
  maxPowAttempts?: number
}

/**
 * Builds the owner-signed request a relay presents once at establishment. It
 * never includes an operational event, and the owner key is not stored.
 */
export const buildPeeringRequestEvent = async (options: BuildPeeringRequestOptions): Promise<Event> => {
  const ownerPubkey = getPublicKey(options.ownerPrivateKey)
  const relayPubkey = options.relayPubkey.toLowerCase()
  const receiverPubkey = options.receiverPubkey.toLowerCase()

  if (!/^[0-9a-f]{64}$/.test(relayPubkey) || !/^[0-9a-f]{64}$/.test(receiverPubkey)) {
    throw new Error('relay and receiver pubkeys must be 32-byte hex keys')
  }

  const payload: PeeringRequestPayload = {
    relay_pubkey: relayPubkey,
    relay_url: options.relayUrl,
    scopes: canonicalPeeringScopes(options.scopes),
    terms: canonicalPeeringTerms(options.terms),
    terms_hash: peeringTermsHash(options.terms),
  }

  const identified = await identifyWithOptionalPow(
    {
      pubkey: ownerPubkey,
      created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
      kind: EventKinds.PEERING_REQUEST,
      tags: [
        [EventTags.Pubkey, receiverPubkey],
        [EventTags.Tag, PEERING_REQUEST_TOPIC],
      ] as Tag[],
      content: JSON.stringify(payload),
    },
    Math.max(0, Math.floor(options.powDifficulty ?? 0)),
    Math.max(1, options.maxPowAttempts ?? 5_000_000),
  )

  return signEvent(options.ownerPrivateKey)(identified)
}

export const parsePeeringRequestPayload = (event: Event): PeeringRequestPayload | undefined => {
  try {
    return requestPayloadSchema.parse(JSON.parse(event.content)) as PeeringRequestPayload
  } catch {
    return undefined
  }
}

export interface VerifyPeeringRequestOptions {
  /** Pubkeys proven by NIP-42 on the connection that delivered the event. */
  authenticatedPubkeys: Iterable<string>
  /** This relay's own pubkey, which the request must target. */
  receiverPubkey: string
  offeredScopes: PeeringScope[]
  offeredTerms: PeeringTerm[]
  minPowDifficulty?: number
  isConfiguredPeer?: boolean
  waivePowForConfiguredPeers?: boolean
  /** When configured, only this owner key may sign the request. */
  expectedOwnerPubkey?: string
  now?: Date
}

export type PeeringRequestVerification =
  | { ok: true; request: PeeringRequestPayload; powDifficulty: number }
  | { ok: false; reason: string }

/**
 * Verifies the two-part establishment proof: the owner signature on the
 * request, and the relay key proven by NIP-42 on the same connection. Terms
 * and scopes must match this relay's current advertisement, so a stale request
 * cannot silently accept changed terms.
 */
export const verifyPeeringRequestEvent = async (
  event: Event,
  options: VerifyPeeringRequestOptions,
): Promise<PeeringRequestVerification> => {
  if (!event || event.kind !== EventKinds.PEERING_REQUEST) {
    return { ok: false, reason: 'not a peering request' }
  }

  if (!(await isEventIdValid(event)) || !(await isEventSignatureValid(event))) {
    return { ok: false, reason: 'invalid: event signature verification failed' }
  }

  const now = options.now ?? new Date()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (Math.abs(nowSeconds - event.created_at) > PEERING_REQUEST_MAX_AGE_SECONDS) {
    return { ok: false, reason: 'invalid: peering request is stale' }
  }

  const payload = parsePeeringRequestPayload(event)
  if (!payload) {
    return { ok: false, reason: 'invalid: malformed peering request payload' }
  }

  const relayPubkey = payload.relay_pubkey.toLowerCase()
  const authenticated = new Set([...options.authenticatedPubkeys].map((pubkey) => pubkey.toLowerCase()))
  if (!authenticated.has(relayPubkey)) {
    return { ok: false, reason: 'auth-required: peering request relay key is not authenticated' }
  }

  if (options.expectedOwnerPubkey && event.pubkey.toLowerCase() !== options.expectedOwnerPubkey.toLowerCase()) {
    return { ok: false, reason: 'invalid: request owner does not match the configured owner' }
  }

  const target = event.tags.find(
    (tag) => tag[0] === EventTags.Pubkey && tag[1]?.toLowerCase() === options.receiverPubkey.toLowerCase(),
  )
  if (!target) {
    return { ok: false, reason: 'invalid: peering request does not target this relay' }
  }

  if (!samePeeringTerms(payload.terms, options.offeredTerms)) {
    return { ok: false, reason: 'invalid: peering terms changed; request peering again' }
  }

  if (payload.terms_hash.toLowerCase() !== peeringTermsHash(options.offeredTerms)) {
    return { ok: false, reason: 'invalid: peering terms hash does not match' }
  }

  if (!samePeeringScopes(payload.scopes, options.offeredScopes)) {
    return { ok: false, reason: 'invalid: requested scope is not offered by this relay' }
  }

  const waived = options.isConfiguredPeer === true && options.waivePowForConfiguredPeers !== false
  const requiredPow = waived ? 0 : Math.max(0, Math.floor(options.minPowDifficulty ?? 0))
  const powDifficulty = getEventProofOfWork(event.id)
  if (powDifficulty < requiredPow) {
    return {
      ok: false,
      reason: `pow: peering request needs ${requiredPow} leading zero bits`,
    }
  }

  return { ok: true, request: { ...payload, relay_pubkey: relayPubkey }, powDifficulty }
}

export interface BuildPeeringAcceptanceOptions {
  request: Event
  acceptance: PeeringRequestPayload
  relayPrivateKey: string
  relayUrl: string
  createdAt?: number
}

/** The receiving relay's signed record of what it accepted and on which terms. */
export const buildPeeringAcceptanceEvent = async (options: BuildPeeringAcceptanceOptions): Promise<Event> => {
  const relayPubkey = getPublicKey(options.relayPrivateKey)
  const payload: PeeringAcceptancePayload = {
    request_id: options.request.id,
    relay_pubkey: relayPubkey,
    relay_url: options.relayUrl,
    terms_hash: options.acceptance.terms_hash,
    accepted_at: options.createdAt ?? Math.floor(Date.now() / 1000),
  }

  const unidentified: UnidentifiedEvent = {
    pubkey: relayPubkey,
    created_at: payload.accepted_at,
    kind: EventKinds.PEERING_ACCEPTANCE,
    tags: [
      [EventTags.Event, options.request.id],
      [EventTags.Pubkey, options.request.pubkey],
      [EventTags.Tag, PEERING_ACCEPTANCE_TOPIC],
    ] as Tag[],
    content: JSON.stringify(payload),
  }

  return signEvent(options.relayPrivateKey)(await identifyEvent(unidentified))
}

export const verifyPeeringAcceptanceEvent = async (
  event: Event,
  request: Event,
): Promise<{ ok: true; acceptance: PeeringAcceptancePayload } | { ok: false; reason: string }> => {
  if (!event || event.kind !== EventKinds.PEERING_ACCEPTANCE) {
    return { ok: false, reason: 'not a peering acceptance' }
  }
  if (!(await isEventIdValid(event)) || !(await isEventSignatureValid(event))) {
    return { ok: false, reason: 'invalid: acceptance signature verification failed' }
  }
  if (!event.tags.some((tag) => tag[0] === EventTags.Event && tag[1] === request.id)) {
    return { ok: false, reason: 'invalid: acceptance does not reference the request' }
  }

  let acceptance: PeeringAcceptancePayload
  try {
    acceptance = acceptancePayloadSchema.parse(JSON.parse(event.content)) as PeeringAcceptancePayload
  } catch {
    return { ok: false, reason: 'invalid: malformed peering acceptance' }
  }

  if (acceptance.request_id !== request.id) {
    return { ok: false, reason: 'invalid: acceptance request id does not match' }
  }
  if (acceptance.relay_pubkey.toLowerCase() !== event.pubkey.toLowerCase()) {
    return { ok: false, reason: 'invalid: acceptance signer does not match its relay key' }
  }

  const requestPayload = parsePeeringRequestPayload(request)
  if (!requestPayload || acceptance.terms_hash.toLowerCase() !== requestPayload.terms_hash.toLowerCase()) {
    return { ok: false, reason: 'invalid: acceptance terms do not match the request' }
  }

  return { ok: true, acceptance }
}

export const isPeeringRequestEvent = (event: Event): boolean => event.kind === EventKinds.PEERING_REQUEST

export const isPeeringAcceptanceEvent = (event: Event): boolean => event.kind === EventKinds.PEERING_ACCEPTANCE
