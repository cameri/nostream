import { createHash, timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { Pubkey } from '../@types/base'
import { Event } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'
import { createdAtSchema, idSchema, kindSchema, pubkeySchema, signatureSchema, tagSchema } from '../schemas/base-schema'
import { isEventIdValid, isEventSignatureValid } from './event'

// NIP-98 suggests a ~60s window for kind 27235 auth events.
export const DEFAULT_NIP98_MAX_SKEW_SECONDS = 60

// A signed kind-27235 event is typically ~1–2KB encoded. Cap well above that to
// reject pathological Authorization headers before JSON.parse / crypto work.
export const DEFAULT_NIP98_MAX_AUTHORIZATION_HEADER_LENGTH = 8192

const NOSTR_AUTH_SCHEME = /^Nostr$/i
const LOWER_HEX_64 = /^[0-9a-f]{64}$/
const BASE64_TOKEN = /^[A-Za-z0-9+/]+={0,2}$/

// Lean NIP-01 shape only — avoids eventSchema superRefine (reactions, geohash, etc.).
const nip98EventSchema = z
  .object({
    id: idSchema,
    pubkey: pubkeySchema,
    created_at: createdAtSchema,
    kind: kindSchema,
    tags: z.array(tagSchema),
    content: z.string(),
    sig: signatureSchema,
  })
  .strict()

export type Nip98AuthSuccess = {
  ok: true
  pubkey: Pubkey
  event: Event
}

export type Nip98AuthFailure = {
  ok: false
  reason: string
}

export type Nip98AuthResult = Nip98AuthSuccess | Nip98AuthFailure

export type Nip98PayloadPolicy =
  // Secure default for mutating admin APIs: non-empty bodies must bind via payload.
  | 'require-when-body'
  // Spec "MAY": only verify payload when the client included the tag.
  | 'verify-if-present'
  | 'ignore'

export type VerifyNip98AuthInput = {
  authorizationHeader: string | undefined | null
  /** Absolute request URL, including query string. Compared exactly to the `u` tag. */
  url: string
  /** HTTP method as received (typically uppercase). Compared exactly to the `method` tag. */
  method: string
  /**
   * Raw request body. Hashing uses the bytes directly (no intermediate copy for Buffer/Uint8Array).
   * When omitted, payload policy is skipped.
   */
  body?: Buffer | Uint8Array | string
  payloadPolicy?: Nip98PayloadPolicy
  maxSkewSeconds?: number
  maxAuthorizationHeaderLength?: number
  /** Overrideable for deterministic tests. Defaults to Math.floor(Date.now() / 1000). */
  nowSeconds?: number
}

export const hashNip98Payload = (body: Buffer | Uint8Array | string): string => {
  const hash = createHash('sha256')
  if (typeof body === 'string') {
    hash.update(body, 'utf8')
  } else {
    hash.update(body)
  }
  return hash.digest('hex')
}

const fail = (reason: string): Nip98AuthFailure => ({ ok: false, reason })

const bodyByteLength = (body: Buffer | Uint8Array | string): number =>
  typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength

type Nip98AuthTags = {
  url?: string
  method?: string
  payload?: string
}

const extractAuthTags = (tags: Event['tags']): Nip98AuthTags => {
  const result: Nip98AuthTags = {}

  for (const tag of tags) {
    if (tag.length < 2) {
      continue
    }

    switch (tag[0]) {
      case EventTags.Url:
        if (result.url === undefined) {
          result.url = tag[1]
        }
        break
      case EventTags.Method:
        if (result.method === undefined) {
          result.method = tag[1]
        }
        break
      case EventTags.Payload:
        if (result.payload === undefined) {
          result.payload = tag[1]
        }
        break
    }

    if (result.url !== undefined && result.method !== undefined && result.payload !== undefined) {
      break
    }
  }

  return result
}

const parseAuthorizationEventJson = (
  authorizationHeader: string | undefined | null,
  maxAuthorizationHeaderLength: number,
): Nip98AuthResult | string => {
  if (typeof authorizationHeader !== 'string' || authorizationHeader.length === 0) {
    return fail('missing authorization header')
  }

  if (authorizationHeader.length > maxAuthorizationHeaderLength) {
    return fail('invalid authorization header')
  }

  const trimmed = authorizationHeader.trim()
  const spaceIndex = trimmed.indexOf(' ')
  if (spaceIndex <= 0) {
    return fail('invalid authorization header')
  }

  const scheme = trimmed.slice(0, spaceIndex)
  const token = trimmed.slice(spaceIndex + 1).trim()
  if (!NOSTR_AUTH_SCHEME.test(scheme) || token.length === 0) {
    return fail('invalid authorization scheme')
  }

  if (!BASE64_TOKEN.test(token) || token.length % 4 !== 0) {
    return fail('invalid authorization encoding')
  }

  return Buffer.from(token, 'base64').toString('utf8')
}

const isHexEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length || !LOWER_HEX_64.test(left) || !LOWER_HEX_64.test(right)) {
    return false
  }

  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  } catch {
    return false
  }
}

const verifyPayloadBinding = (
  policy: Nip98PayloadPolicy,
  body: Buffer | Uint8Array | string | undefined,
  payloadTag: string | undefined,
): Nip98AuthFailure | undefined => {
  if (body === undefined || policy === 'ignore') {
    return undefined
  }

  const hasBody = bodyByteLength(body) > 0

  if (policy === 'require-when-body' && hasBody && payloadTag === undefined) {
    return fail('invalid: missing payload tag')
  }

  if (payloadTag === undefined) {
    return undefined
  }

  if (!isHexEqual(payloadTag.toLowerCase(), hashNip98Payload(body))) {
    return fail('invalid: payload tag does not match request body')
  }

  return undefined
}

/**
 * Cryptographically verifies a NIP-98 `Authorization: Nostr <base64-event>` header
 * against the HTTP request URL, method, and optional body payload hash.
 *
 * Check order: cheap structural/kind/skew rejects first, then id+signature
 * (authenticate the event), then u/method/payload (bind the authenticated event
 * to this request).
 */
export const verifyNip98Auth = async (input: VerifyNip98AuthInput): Promise<Nip98AuthResult> => {
  const maxAuthorizationHeaderLength =
    input.maxAuthorizationHeaderLength ?? DEFAULT_NIP98_MAX_AUTHORIZATION_HEADER_LENGTH

  const parsed = parseAuthorizationEventJson(input.authorizationHeader, maxAuthorizationHeaderLength)
  if (typeof parsed !== 'string') {
    return parsed
  }

  let raw: unknown
  try {
    raw = JSON.parse(parsed)
  } catch {
    return fail('invalid authorization event json')
  }

  const schemaResult = nip98EventSchema.safeParse(raw)
  if (!schemaResult.success) {
    return fail('invalid authorization event')
  }

  const event = schemaResult.data as unknown as Event

  if (event.kind !== EventKinds.HTTP_AUTH) {
    return fail('invalid: auth event must be kind 27235')
  }

  const maxSkewSeconds = input.maxSkewSeconds ?? DEFAULT_NIP98_MAX_SKEW_SECONDS
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(nowSeconds - event.created_at) > maxSkewSeconds) {
    return fail('invalid: created_at is too far from the current time')
  }

  // Authenticate before trusting tags for request binding.
  if (!(await isEventIdValid(event))) {
    return fail('invalid: event id does not match')
  }

  if (!(await isEventSignatureValid(event))) {
    return fail('invalid: event signature verification failed')
  }

  const tags = extractAuthTags(event.tags)

  if (tags.url === undefined) {
    return fail('invalid: missing u tag')
  }
  if (tags.url !== input.url) {
    return fail('invalid: u tag does not match request url')
  }

  if (tags.method === undefined) {
    return fail('invalid: missing method tag')
  }
  if (tags.method !== input.method) {
    return fail('invalid: method tag does not match request method')
  }

  const payloadFailure = verifyPayloadBinding(input.payloadPolicy ?? 'require-when-body', input.body, tags.payload)
  if (payloadFailure) {
    return payloadFailure
  }

  return {
    ok: true,
    pubkey: event.pubkey,
    event,
  }
}
