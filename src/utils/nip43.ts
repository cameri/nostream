import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'
import { getPublicKey, getRelayPrivateKey } from './event'
import { parseRelayPubkey } from './nip43-invites'
import { Settings } from '../@types/settings'
import { SubscriptionFilter } from '../@types/subscription'

const logger = createLogger('nip43')

export const isNip43JoinRequest = (event: Event): boolean =>
  event.kind === EventKinds.NIP43_JOIN_REQUEST

export const isNip43LeaveRequest = (event: Event): boolean =>
  event.kind === EventKinds.NIP43_LEAVE_REQUEST

export const isNip43InviteRequest = (event: Event): boolean => event.kind === EventKinds.NIP43_INVITE_REQUEST

export const getClaimTag = (event: Event): string | undefined => {
  const tag = event.tags.find((t) => t.length >= 2 && t[0] === EventTags.Claim)
  return tag?.[1]
}

// NIP-43 requires join/leave request created_at to be "now, plus or minus a few
// minutes". Same tolerance as the NIP-42 auth handler.
const MAX_TIMESTAMP_DELTA_SECONDS = 600

export const isNip43RequestTimestampValid = (event: Event): boolean =>
  Math.abs(Math.floor(Date.now() / 1000) - event.created_at) <= MAX_TIMESTAMP_DELTA_SECONDS

// NIP-43 requires invite/membership events to be signed by the pubkey advertised
// as `self` in the relay's NIP-11 document. The relay signs with a key derived
// from SECRET, while `info.self` is hand-edited, so the two can silently diverge
// and every invite the relay mints becomes unverifiable. These helpers derive the
// real signing pubkey and let callers detect the mismatch.

/**
 * The relay's own signing pubkey, derived the same way every other relay-signed
 * event derives it. Throws when SECRET is unset.
 */
export const getRelayNip43Pubkey = (settings: Settings): string =>
  getPublicKey(getRelayPrivateKey(settings.info?.relay_url))

/** getRelayNip43Pubkey, but undefined instead of a throw when SECRET is unset. */
export const tryGetRelayNip43Pubkey = (settings: Settings): string | undefined => {
  try {
    return getRelayNip43Pubkey(settings)
  } catch (error) {
    logger('unable to derive the relay signing pubkey: %o', error)
    return undefined
  }
}

/**
 * undefined = nothing to compare against (`info.self` unset or not derivable),
 * true/false = `info.self` is configured and (mis)matches the signing pubkey.
 * Throws when `info.self` is a malformed npub.
 */
export const isRelaySelfConsistent = (settings: Settings): boolean | undefined => {
  const configured = parseRelayPubkey(settings.info?.self)
  if (configured === undefined) {
    return undefined
  }

  const derived = tryGetRelayNip43Pubkey(settings)
  if (derived === undefined) {
    return undefined
  }

  return configured === derived
}

/**
 * The pubkey to advertise as `self` in NIP-11: the configured one when it parses,
 * otherwise the derived signing pubkey, which is correct by construction.
 */
export const resolveRelaySelfPubkey = (settings: Settings): string | undefined => {
  let configured: string | undefined

  try {
    configured = parseRelayPubkey(settings.info?.self)
  } catch (error) {
    logger('info.self is not a valid pubkey, falling back to the derived one: %o', error)
  }

  return configured ?? tryGetRelayNip43Pubkey(settings)
}

// NIP-43 kind 28935 is not an event clients publish: it is a REQ the relay
// answers by minting an invite code on the fly and returning a relay-signed
// ephemeral event. This detects those REQ filters.
export const isNip43InviteRequestFilter = (filter: SubscriptionFilter): boolean =>
  Array.isArray(filter.kinds) && filter.kinds.includes(EventKinds.NIP43_INVITE_REQUEST)
