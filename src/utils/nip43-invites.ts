import { randomBytes } from 'crypto'
import { andThen, pipe } from 'ramda'

import { CreateInviteCodeOptions, InviteCode } from '../@types/invite-code'
import { Event, UnidentifiedEvent } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'
import { Tag } from '../@types/base'
import { identifyEvent, signEvent } from './event'
import { IInviteCodeRepository } from '../@types/repositories'
import { Nip43Settings } from '../@types/settings'
import { fromBech32 } from './transform'

export const DEFAULT_INVITE_MAX_USES = 1
export const DEFAULT_INVITE_CODE_EXPIRY_SECONDS = 600

const HEX_PUBKEY = /^[0-9a-f]{64}$/i

export const generateInviteCode = (): string => randomBytes(16).toString('hex')

export interface IssueInviteCodeOverrides {
  remainingUses?: number
  expiresAt?: Date | null
  createdBy?: string | null
}

export const isHexPubkey = (value: string | undefined | null): boolean =>
  typeof value === 'string' && HEX_PUBKEY.test(value)

export const parseRelayPubkey = (value: string | undefined | null): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }

  if (HEX_PUBKEY.test(value)) {
    return value.toLowerCase()
  }

  if (value.toLowerCase().startsWith('npub1')) {
    const hex = fromBech32(value)
    if (!HEX_PUBKEY.test(hex)) {
      throw new Error('info.self npub did not decode to a 32-byte pubkey')
    }
    return hex
  }

  return undefined
}

export const resolveInviteCodeLimits = (
  settings: Nip43Settings | undefined,
  overrides: IssueInviteCodeOverrides = {},
): Required<Pick<CreateInviteCodeOptions, 'remainingUses' | 'expiresAt'>> => {
  const remainingUses = overrides.remainingUses ?? settings?.defaultMaxUses ?? DEFAULT_INVITE_MAX_USES

  if (!Number.isSafeInteger(remainingUses) || remainingUses < 1) {
    throw new Error('remainingUses must be a positive integer')
  }

  if (overrides.expiresAt !== undefined) {
    return { remainingUses, expiresAt: overrides.expiresAt }
  }

  const expirySeconds = settings?.inviteCodeExpirySeconds ?? DEFAULT_INVITE_CODE_EXPIRY_SECONDS
  const expiresAt =
    typeof expirySeconds === 'number' && Number.isFinite(expirySeconds) && expirySeconds > 0
      ? new Date(Date.now() + expirySeconds * 1000)
      : null

  return { remainingUses, expiresAt }
}

export const issueInviteCode = async (
  repository: IInviteCodeRepository,
  settings: Nip43Settings | undefined,
  overrides: IssueInviteCodeOverrides = {},
): Promise<InviteCode> => {
  const { remainingUses, expiresAt } = resolveInviteCodeLimits(settings, overrides)

  let createdBy: string | null = null
  if (overrides.createdBy) {
    if (!isHexPubkey(overrides.createdBy)) {
      throw new Error('createdBy must be a 64-character hex pubkey')
    }
    createdBy = overrides.createdBy.toLowerCase()
  }

  return repository.create(generateInviteCode(), {
    remainingUses,
    expiresAt,
    createdBy,
  })
}

/**
 * Builds the relay-signed kind 28935 event that answers a NIP-43 invite request.
 *
 * The `claim` tag is a bearer secret: the caller MUST send this event only to the
 * socket that asked for it, and MUST NOT persist or broadcast it. 28935 is in the
 * ephemeral range, so there is nothing to store either way.
 */
export const buildInviteCodeEvent = async (
  relayPrivkey: string,
  relayPubkey: string,
  invite: Pick<InviteCode, 'code' | 'expiresAt'>,
  createdAt: number = Math.floor(Date.now() / 1000),
): Promise<Event> => {
  const tags: Tag[] = [
    [EventTags.Claim, invite.code],
    // NIP-70: this event is for the requesting client only. The tag carries no
    // value, which Tag (which requires an index 1) cannot express.
    [EventTags.Protected] as unknown as Tag,
  ]

  // NIP-40: mirrors nip43.inviteCodeExpirySeconds so clients can show a countdown.
  if (invite.expiresAt instanceof Date) {
    tags.push([EventTags.Expiration, String(Math.floor(invite.expiresAt.getTime() / 1000))])
  }

  const unidentifiedEvent: UnidentifiedEvent = {
    pubkey: relayPubkey,
    kind: EventKinds.NIP43_INVITE_REQUEST,
    created_at: createdAt,
    content: '',
    tags,
  }

  return pipe(identifyEvent, andThen(signEvent(relayPrivkey)))(unidentifiedEvent)
}
