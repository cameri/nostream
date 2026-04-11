import axios from 'axios'

import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { EventKinds } from '../constants/base'

const debug = createLogger('nip05')

const VERIFICATION_TIMEOUT_MS = 10000
const DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/

interface Nip05ParsedIdentifier {
  localPart: string
  domain: string
}

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
    debug('failed to parse metadata content for event %s', event.id)
  }

  return undefined
}

export async function verifyNip05Identifier(
  nip05: string,
  pubkey: string,
): Promise<boolean> {
  const parsed = parseNip05Identifier(nip05)
  if (!parsed) {
    return false
  }

  const { localPart, domain } = parsed
  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(localPart)}`

  try {
    debug('verifying %s for pubkey %s via %s', nip05, pubkey, url)

    const response = await axios.get(url, {
      timeout: VERIFICATION_TIMEOUT_MS,
      headers: { 'Accept': 'application/json' },
      validateStatus: (status) => status === 200,
    })

    const { data } = response

    if (!data || typeof data !== 'object' || !data.names || typeof data.names !== 'object') {
      debug('malformed response from %s', url)
      return false
    }

    const registeredPubkey = data.names[localPart]
    if (typeof registeredPubkey !== 'string') {
      debug('name %s not found in response from %s', localPart, domain)
      return false
    }

    const verified = registeredPubkey.toLowerCase() === pubkey.toLowerCase()
    debug('verification result for %s: %s', nip05, verified ? 'verified' : 'pubkey mismatch')

    return verified
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    debug('verification request failed for %s: %s', nip05, message)
    return false
  }
}

export function isDomainAllowed(
  domain: string,
  whitelist?: string[],
  blacklist?: string[],
): boolean {
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
