import { Tag } from '../@types/base'
import { Event, UnidentifiedEvent } from '../@types/event'
import { PeeringPeer, Settings } from '../@types/settings'
import { EventKinds, EventTags } from '../constants/base'
import { getPublicKey, identifyEvent, signEvent } from './event'
import { parseRelayPubkey } from './nip43-invites'

export interface PeeringAuthEventOptions {
  relayUrl: string
  challenge: string
  privateKey: string
  createdAt?: number
}

/**
 * Normalizes a peer pubkey to lowercase hex. Returns undefined for anything
 * that is not a 32-byte hex pubkey or an npub, so malformed configured entries
 * are skipped rather than throwing during AUTH.
 */
export const parsePeeringPeerPubkey = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }

  try {
    return parseRelayPubkey(value)
  } catch {
    return undefined
  }
}

export const findConfiguredPeeringPeer = (
  settings: Pick<Settings, 'peering'> | undefined,
  pubkey: string,
): PeeringPeer | undefined => {
  const normalized = parsePeeringPeerPubkey(pubkey)
  if (!normalized) {
    return undefined
  }

  return settings?.peering?.peers?.find(
    (peer) => peer.enabled !== false && parsePeeringPeerPubkey(peer.pubkey) === normalized,
  )
}

/** True only when `pubkey` is an enabled entry in the configured peer list. */
export const isConfiguredPeeringPeer = (settings: Pick<Settings, 'peering'> | undefined, pubkey: string): boolean =>
  typeof findConfiguredPeeringPeer(settings, pubkey) !== 'undefined'

/**
 * Builds the NIP-42 AUTH event that proves this relay's own identity to a
 * source relay. Signed with the relay keypair, so the event's pubkey is the
 * derived key, not whatever `info.self` happens to say.
 */
export const buildPeeringAuthEvent = async ({
  relayUrl,
  challenge,
  privateKey,
  createdAt = Math.floor(Date.now() / 1000),
}: PeeringAuthEventOptions): Promise<Event> => {
  if (!relayUrl.trim()) {
    throw new Error('relayUrl is required to build a peering AUTH event')
  }

  if (!challenge.trim()) {
    throw new Error('challenge is required to build a peering AUTH event')
  }

  const unidentified: UnidentifiedEvent = {
    pubkey: getPublicKey(privateKey),
    created_at: createdAt,
    kind: EventKinds.AUTH,
    tags: [
      [EventTags.AuthRelay, relayUrl],
      [EventTags.Challenge, challenge],
    ] as Tag[],
    content: '',
  }

  return signEvent(privateKey)(await identifyEvent(unidentified))
}
