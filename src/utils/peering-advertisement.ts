import axios from 'axios'
import { z } from 'zod'
import { AdvertisedPeeringScope, PeeringAdvertisement } from '../@types/peering'
import { EventKindsRange, PeeringTerm } from '../@types/settings'
import { MAX_PEERING_KIND } from './peering-scope'
import { isNip11FetchTargetSafe, safeNip11Lookup } from './relay-probe/nip11-probe'
import { parseProbeTarget } from './relay-probe/target'

const MAX_NIP11_RESPONSE_BYTES = 256 * 1024
const DEFAULT_NIP11_TIMEOUT_MS = 10_000

const peeringKindSchema = z.union([
  z.number().int().min(0).max(MAX_PEERING_KIND),
  z.tuple([z.number().int().min(0).max(MAX_PEERING_KIND), z.number().int().min(0).max(MAX_PEERING_KIND)]),
])

const advertisedScopeSchema = z
  .object({
    kinds: z.array(peeringKindSchema).min(1),
    since: z.number().int().min(0).optional(),
    until: z.number().int().min(0).optional(),
    window_seconds: z.number().int().positive().optional(),
    // Older or hand-written documents sometimes use camelCase; accept both.
    windowSeconds: z.number().int().positive().optional(),
  })
  .passthrough()
  .superRefine((scope, ctx) => {
    const windowSeconds = scope.window_seconds ?? scope.windowSeconds
    if (windowSeconds !== undefined && (scope.since !== undefined || scope.until !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'window_seconds cannot be combined with since or until',
      })
    }

    if (scope.since !== undefined && scope.until !== undefined && scope.since > scope.until) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'since must be less than or equal to until',
      })
    }

    for (const kind of scope.kinds) {
      if (Array.isArray(kind) && kind[0] > kind[1]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'kind range start must be less than or equal to its end',
        })
      }
    }
  })

const peeringTermSchema = z.object({
  amount: z.number().finite().nonnegative(),
  unit: z.string().min(1),
  period: z.number().int().positive(),
})

const peeringDocumentSchema = z
  .object({
    enabled: z.boolean().optional(),
    scopes: z.array(advertisedScopeSchema).optional(),
    terms: z.array(peeringTermSchema).optional(),
  })
  .passthrough()

const nip11Schema = z
  .object({
    self: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional(),
    supported_nips: z.array(z.number().int().positive()).optional(),
    peering: peeringDocumentSchema.optional(),
  })
  .passthrough()

export type Nip11PeeringDocument = z.infer<typeof nip11Schema>

export const parsePeeringAdvertisement = (document: unknown): PeeringAdvertisement => {
  const parsed = nip11Schema.safeParse(document)
  if (!parsed.success) {
    const reason = parsed.error.issues.map((issue) => issue.message).join('; ')

    throw new Error(`invalid NIP-11 document: ${reason}`)
  }

  const peering = parsed.data.peering
  const enabled = peering?.enabled === true

  if (!enabled) {
    return {
      enabled: false,
      scopes: [],
      terms: [],
      self: parsed.data.self?.toLowerCase(),
      supportedNips: parsed.data.supported_nips ?? [],
    }
  }

  const scopes = peering?.scopes ?? []
  if (scopes.length === 0) {
    throw new Error('peer advertises peering but offers no scopes')
  }

  return {
    enabled,
    scopes: scopes.map(
      (scope): AdvertisedPeeringScope => ({
        kinds: scope.kinds as (number | EventKindsRange)[],
        ...(scope.since !== undefined ? { since: scope.since } : {}),
        ...(scope.until !== undefined ? { until: scope.until } : {}),
        ...(scope.window_seconds !== undefined || scope.windowSeconds !== undefined
          ? { windowSeconds: scope.window_seconds ?? scope.windowSeconds }
          : {}),
      }),
    ),
    terms: (peering?.terms ?? []).map(
      (term): PeeringTerm => ({
        amount: term.amount,
        unit: term.unit,
        period: term.period,
      }),
    ),
    self: parsed.data.self?.toLowerCase(),
    supportedNips: parsed.data.supported_nips ?? [],
  }
}

export const nip11UrlForRelay = (relayUrl: string): string => parseProbeTarget(relayUrl).nip11Url

export interface FetchPeeringAdvertisementOptions {
  timeoutMs?: number
}

/**
 * Reads a peer's NIP-11 document and returns the peering terms it advertises.
 * Phases that act on those terms (sync here, settlement later) share this one
 * reader instead of each re-implementing discovery.
 */
export const fetchPeeringAdvertisement = async (
  relayUrl: string,
  options: FetchPeeringAdvertisementOptions = {},
): Promise<PeeringAdvertisement> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NIP11_TIMEOUT_MS
  const url = nip11UrlForRelay(relayUrl)

  if (!isNip11FetchTargetSafe(url)) {
    throw new Error(`unable to read peering advertisement from ${relayUrl}: refused unsafe NIP-11 fetch target`)
  }

  try {
    const response = await axios.get(url, {
      timeout: timeoutMs,
      headers: { Accept: 'application/nostr+json' },
      responseType: 'json',
      validateStatus: (status) => status === 200,
      maxRedirects: 1,
      maxContentLength: MAX_NIP11_RESPONSE_BYTES,
      maxBodyLength: MAX_NIP11_RESPONSE_BYTES,
      // Direct egress so safeNip11Lookup actually sees the peer host. A proxy
      // would resolve the destination itself and bypass the private-address check.
      proxy: false,
      lookup: safeNip11Lookup,
      beforeRedirect: (redirect: { href?: string; protocol?: string; hostname?: string }) => {
        const href = redirect.href ?? `${redirect.protocol ?? ''}//${redirect.hostname ?? ''}`
        if (!isNip11FetchTargetSafe(href)) {
          throw new Error(`refused redirect to unsafe NIP-11 target: ${href}`)
        }
      },
    })

    return parsePeeringAdvertisement(response.data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`unable to read peering advertisement from ${relayUrl}: ${message}`)
  }
}
