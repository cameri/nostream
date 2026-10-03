import axios, { AxiosError } from 'axios'
import { z } from 'zod'

import { pubkeySchema } from '../../schemas/base-schema'
import { Nip11Result } from './types'

const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_REDIRECTS = 1

const nip11LimitationSchema = z
  .object({
    auth_required: z.boolean().optional(),
    restricted_writes: z.boolean().optional(),
    payment_required: z.boolean().optional(),
    min_pow_difficulty: z.number().optional(),
  })
  .passthrough()

const nip11DocumentSchema = z
  .object({
    name: z.string().optional(),
    pubkey: pubkeySchema.optional(),
    supported_nips: z.array(z.number().int().positive()).optional(),
    limitation: nip11LimitationSchema.optional(),
    fees: z
      .object({
        publication: z
          .array(
            z.object({
              kinds: z.array(z.number().int()).optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    accepted_kinds: z.array(z.number().int()).optional(),
  })
  .passthrough()

export interface Nip11Fetcher {
  fetch(url: string, timeoutMs: number): Promise<Nip11Result>
}

/**
 * Reject redirect targets that would turn relay probing into an SSRF primitive.
 * Mirrors the NIP-05 verification guard in src/utils/nip05.ts.
 */
export const isNip11FetchTargetSafe = (targetUrl: string): boolean => {
  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return false
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false
  }

  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.localhost')) {
    return false
  }

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

  // IPv6 literal: URL.hostname is unbracketed (e.g. "::1"); NIP-11 fetch targets should not be IP literals.
  if (host.includes(':')) {
    return false
  }

  return true
}

export const createNodeNip11Fetcher = (): Nip11Fetcher => ({
  fetch: async (url, timeoutMs) => {
    if (!isNip11FetchTargetSafe(url)) {
      throw new Error(`refused unsafe NIP-11 fetch target: ${url}`)
    }

    try {
      const response = await axios.get(url, {
        timeout: timeoutMs,
        headers: { Accept: 'application/nostr+json' },
        responseType: 'json',
        validateStatus: (status) => status === 200,
        maxRedirects: MAX_REDIRECTS,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        beforeRedirect: (options: { href?: string; protocol?: string; hostname?: string }) => {
          const href = options.href ?? `${options.protocol ?? ''}//${options.hostname ?? ''}`
          if (!isNip11FetchTargetSafe(href)) {
            throw new Error(`refused redirect to unsafe target: ${href}`)
          }
        },
      })

      const parsed = nip11DocumentSchema.safeParse(response.data)
      if (!parsed.success) {
        const reason = parsed.error.issues.map((issue) => issue.message).join('; ')
        throw new Error(`invalid NIP-11 document: ${reason}`)
      }

      const limitation = parsed.data.limitation
      const acceptedKinds = new Set<number>(parsed.data.accepted_kinds ?? [])

      for (const publicationFee of parsed.data.fees?.publication ?? []) {
        for (const kind of publicationFee.kinds ?? []) {
          acceptedKinds.add(kind)
        }
      }

      return {
        statusCode: response.status,
        name: parsed.data.name,
        pubkey: parsed.data.pubkey,
        supportedNips: parsed.data.supported_nips,
        limitation: limitation
          ? {
              authRequired: limitation.auth_required,
              restrictedWrites: limitation.restricted_writes,
              paymentRequired: limitation.payment_required,
              minPowDifficulty: limitation.min_pow_difficulty,
            }
          : undefined,
        acceptedKinds: acceptedKinds.size > 0 ? [...acceptedKinds].sort((a, b) => a - b) : undefined,
        rawDocument: JSON.stringify(parsed.data),
      }
    } catch (error: unknown) {
      const axiosError = error as AxiosError
      if (axiosError.response?.status) {
        throw new Error(`NIP-11 request failed with status ${axiosError.response.status}`)
      }

      const message = axiosError?.message ?? (error instanceof Error ? error.message : String(error))
      throw new Error(message)
    }
  },
})

export const probeNip11 = async (fetcher: Nip11Fetcher, url: string, timeoutMs: number): Promise<Nip11Result> => {
  return fetcher.fetch(url, timeoutMs)
}
