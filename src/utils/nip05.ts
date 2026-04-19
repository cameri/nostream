import axios, { AxiosError } from 'axios'
import { z } from 'zod'

import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { EventKinds } from '../constants/base'
import { pubkeySchema } from '../schemas/base-schema'

const logger = createLogger('nip05')

const VERIFICATION_TIMEOUT_MS = 10000
// NIP-05 responses are trivially small; cap hard to protect relay memory/bandwidth.
const MAX_RESPONSE_BYTES = 64 * 1024
// Allow at most a single redirect. Zero would break some operators that front
// their well-known under a redirect; unlimited would enable SSRF pivoting.
const MAX_REDIRECTS = 1
const DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/

// Public defaults used by callers when settings omit these fields. Exported so the
// runtime defaults stay in one place and are easy to unit test.
export const DEFAULT_NIP05_VERIFY_EXPIRATION_MS = 604800000
export const DEFAULT_NIP05_VERIFY_UPDATE_FREQUENCY_MS = 86400000
export const DEFAULT_NIP05_MAX_CONSECUTIVE_FAILURES = 20

/**
 * Result of a NIP-05 verification attempt.
 *
 * `verified` / `mismatch` / `invalid` are *definitive* outcomes: the remote host
 * responded with a well-formed document and we could decide the pubkey question.
 * Callers should update `isVerified` / `lastVerifiedAt` based on these.
 *
 * `error` is *transient* (network failure, timeout, malformed JSON, oversized
 * response, redirect to a disallowed target, etc.). Callers should keep any
 * prior successful verification intact and only bump `failureCount` / `lastCheckedAt`.
 */
export type Nip05VerificationOutcome =
  | { status: 'verified' }
  | { status: 'mismatch' }
  | { status: 'invalid'; reason: string }
  | { status: 'error'; reason: string }

interface Nip05ParsedIdentifier {
  localPart: string
  domain: string
}

// https://github.com/nostr-protocol/nips/blob/master/05.md
// `names` is a map of local-part -> 64-char lowercase hex pubkey.
// `relays` is optional and unused server-side; passthrough() keeps unknown keys.
const nip05ResponseSchema = z
  .object({
    names: z.record(z.string(), pubkeySchema),
  })
  .passthrough()

export function parseNip05Identifier(nip05: string): Nip05ParsedIdentifier | undefined {
  if (!nip05 || typeof nip05 !== 'string') {
    return undefined
  }

  const atIndex = nip05.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === nip05.length - 1) {
    return undefined
  }

  const localPart = nip05.substring(0, atIndex)
  const domain = nip05.substring(atIndex + 1)

  if (!localPart || !domain || !DOMAIN_REGEX.test(domain)) {
    return undefined
  }

  return {
    localPart: localPart.toLowerCase(),
    domain: domain.toLowerCase(),
  }
}

export function extractNip05FromEvent(event: Event): string | undefined {
  if (event.kind !== EventKinds.SET_METADATA) {
    return undefined
  }

  try {
    const metadata = JSON.parse(event.content)
    if (metadata && typeof metadata.nip05 === 'string' && metadata.nip05.length > 0) {
      return metadata.nip05
    }
  } catch {
    logger('failed to parse metadata content for event %s', event.id)
  }

  return undefined
}

/**
 * Reject redirect targets that would turn this endpoint into an SSRF primitive:
 * non-https schemes, loopback, link-local, and RFC1918 private ranges.
 * Domain-based checks (e.g. `localhost`) are included for belt-and-suspenders.
 */
function isRedirectTargetSafe(targetUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return false
  }

  if (parsed.protocol !== 'https:') {
    return false
  }

  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.localhost')) {
    return false
  }

  // IPv4 literal check. Covers loopback (127/8), private ranges (10/8, 172.16/12,
  // 192.168/16), link-local (169.254/16), and multicast/reserved (>=224).
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = ipv4.slice(1, 3).map(Number)
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return false
    }
  }

  // IPv6 literal: reject any bracketed v6 address; NIP-05 hosts are domain names.
  if (host.startsWith('[') && host.endsWith(']')) {
    return false
  }

  return true
}

export async function verifyNip05Identifier(nip05: string, pubkey: string): Promise<Nip05VerificationOutcome> {
  const parsed = parseNip05Identifier(nip05)
  if (!parsed) {
    return { status: 'invalid', reason: 'unparseable NIP-05 identifier' }
  }

  const { localPart, domain } = parsed
  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(localPart)}`

  try {
    logger('verifying %s for pubkey %s via %s', nip05, pubkey, url)

    const response = await axios.get(url, {
      timeout: VERIFICATION_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
      responseType: 'json',
      validateStatus: (status) => status === 200,
      maxRedirects: MAX_REDIRECTS,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      // `beforeRedirect` is forwarded to follow-redirects by axios. Any throw
      // here aborts the request with that error, which we catch below.
      beforeRedirect: (options: { href?: string; protocol?: string; hostname?: string }) => {
        const href = options.href ?? `${options.protocol ?? ''}//${options.hostname ?? ''}`
        if (!isRedirectTargetSafe(href)) {
          throw new Error(`refused redirect to unsafe target: ${href}`)
        }
      },
    })

    const parseResult = nip05ResponseSchema.safeParse(response.data)

    if (!parseResult.success) {
      const zodError = parseResult as z.SafeParseError<z.infer<typeof nip05ResponseSchema>>
      const reason = zodError.error.issues.map((i) => i.message).join('; ')
      logger('malformed response from %s: %s', url, reason)
      return { status: 'invalid', reason: `malformed response: ${reason}` }
    }

    const registeredPubkey = parseResult.data.names[localPart]
    if (typeof registeredPubkey !== 'string') {
      logger('name %s not found in response from %s', localPart, domain)
      return { status: 'mismatch' }
    }

    if (registeredPubkey.toLowerCase() !== pubkey.toLowerCase()) {
      logger('pubkey mismatch for %s (got %s)', nip05, registeredPubkey)
      return { status: 'mismatch' }
    }

    logger('verification succeeded for %s', nip05)
    return { status: 'verified' }
  } catch (error: unknown) {
    const axiosError = error as AxiosError
    const message = axiosError?.message ?? (error instanceof Error ? error.message : String(error))
    logger('verification request failed for %s: %s', nip05, message)
    return { status: 'error', reason: message }
  }
}

export function isDomainAllowed(domain: string, whitelist?: string[], blacklist?: string[]): boolean {
  const lowerDomain = domain.toLowerCase()

  if (Array.isArray(blacklist) && blacklist.length > 0) {
    if (blacklist.some((d) => lowerDomain === d.toLowerCase())) {
      return false
    }
  }

  if (Array.isArray(whitelist) && whitelist.length > 0) {
    if (!whitelist.some((d) => lowerDomain === d.toLowerCase())) {
      return false
    }
  }

  return true
}
