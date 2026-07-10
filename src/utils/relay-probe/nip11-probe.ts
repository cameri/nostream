import axios, { AxiosError } from 'axios'
import { z } from 'zod'

import { pubkeySchema } from '../../schemas/base-schema'
import { Nip11Result } from './types'

const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_REDIRECTS = 1

const nip11DocumentSchema = z
  .object({
    name: z.string().optional(),
    pubkey: pubkeySchema.optional(),
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

  if (host.startsWith('[') && host.endsWith(']')) {
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

      return {
        statusCode: response.status,
        name: parsed.data.name,
        pubkey: parsed.data.pubkey,
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
