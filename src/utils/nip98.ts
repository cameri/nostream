import { Event } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'
import { eventSchema } from '../schemas/event-schema'
import { isEventIdValid, isEventSignatureValid } from './event'
import { validateSchema } from './validation'

export const DEFAULT_NIP98_TIMESTAMP_TOLERANCE_SECONDS = 60

const NOSTR_SCHEME_REGEX = /^nostr\s+(.+)$/i
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/

export interface Nip98RequestContext {
  url: string
  method: string
  bodySha256Hex?: string
}

export interface Nip98VerifyOptions {
  timestampToleranceSeconds?: number
  now?: number
}

export type Nip98Result =
  | { ok: true; event: Event }
  | { ok: false; reason: string }

const failure = (reason: string): Nip98Result => ({ ok: false, reason })

const findTagValue = (event: Event, name: string): string | undefined => {
  const tag = event.tags.find((entry) => entry.length >= 2 && entry[0] === name)

  return tag?.[1]
}

export const parseNip98AuthorizationHeader = (header: string | undefined): Nip98Result => {
  if (typeof header !== 'string') {
    return failure('missing authorization header')
  }

  const match = NOSTR_SCHEME_REGEX.exec(header.trim())
  if (!match) {
    return failure('authorization scheme is not Nostr')
  }

  const token = match[1].trim()
  if (!BASE64_REGEX.test(token) || token.length % 4 !== 0) {
    return failure('token is not valid base64')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
  } catch {
    return failure('token does not contain valid JSON')
  }

  const validation = validateSchema(eventSchema)(parsed)
  if (validation.error) {
    return failure('token does not contain a valid event')
  }

  return { ok: true, event: validation.value as Event }
}

export const isNip98UrlMatch = (tagUrl: string, requestUrl: string): boolean => {
  try {
    const expected = new URL(requestUrl)
    const actual = new URL(tagUrl)

    return actual.origin === expected.origin
      && actual.pathname === expected.pathname
      && actual.search === expected.search
  } catch {
    return false
  }
}

export const verifyNip98Event = async (
  event: Event,
  context: Nip98RequestContext,
  options: Nip98VerifyOptions = {},
): Promise<Nip98Result> => {
  if (event.kind !== EventKinds.HTTP_AUTH) {
    return failure('invalid event kind')
  }

  if (!(await isEventIdValid(event))) {
    return failure('invalid event id')
  }

  if (!(await isEventSignatureValid(event))) {
    return failure('invalid event signature')
  }

  const tolerance = options.timestampToleranceSeconds ?? DEFAULT_NIP98_TIMESTAMP_TOLERANCE_SECONDS
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - event.created_at) > tolerance) {
    return failure('event timestamp is out of tolerance')
  }

  const url = findTagValue(event, EventTags.Url)
  if (typeof url !== 'string' || !isNip98UrlMatch(url, context.url)) {
    return failure('u tag does not match request URL')
  }

  const method = findTagValue(event, EventTags.Method)
  if (typeof method !== 'string' || method.toUpperCase() !== context.method.toUpperCase()) {
    return failure('method tag does not match request method')
  }

  const payload = findTagValue(event, EventTags.Payload)
  if (typeof payload === 'string') {
    if (typeof context.bodySha256Hex !== 'string'
      || payload.toLowerCase() !== context.bodySha256Hex.toLowerCase()) {
      return failure('payload tag does not match request body hash')
    }
  }

  return { ok: true, event }
}

export const verifyNip98AuthorizationHeader = async (
  header: string | undefined,
  context: Nip98RequestContext,
  options: Nip98VerifyOptions = {},
): Promise<Nip98Result> => {
  const parsed = parseNip98AuthorizationHeader(header)
  if (!parsed.ok) {
    return parsed
  }

  return verifyNip98Event(parsed.event, context, options)
}
