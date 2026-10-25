import { isIP, SocketAddress } from 'node:net'
import { mergeDeepRight } from 'ramda'

import { Settings } from '../@types/settings'
import { isHexPubkey, parseRelayPubkey } from './nip43-invites'
import {
  loadDefaults,
  loadMergedSettings,
  loadUserSettings,
  saveSettings,
  validateSettings,
  withSettingsWriteLock,
} from './settings-config'

export interface AdminModerationLimits {
  pubkey: {
    blacklist: string[]
    whitelist: string[]
  }
  kind: {
    blacklist: NonNullable<NonNullable<Settings['limits']>['event']>['kind']['blacklist']
    whitelist: NonNullable<NonNullable<Settings['limits']>['event']>['kind']['whitelist']
  }
  rateLimitBypass: {
    pubkeys: string[]
    ipAddresses: string[]
  }
}

export type AdminModerationAction =
  | 'ban-pubkey'
  | 'unban-pubkey'
  | 'whitelist-pubkey'
  | 'unwhitelist-pubkey'
  | 'whitelist-ip'
  | 'unwhitelist-ip'

const normalizePubkeyList = (values: string[], label: string): string[] => {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const raw of values) {
    const pubkey = parseRelayPubkey(raw)
    if (!pubkey || !isHexPubkey(pubkey)) {
      throw new Error(`${label} must contain 64-character hex pubkeys or npubs`)
    }

    if (!seen.has(pubkey)) {
      seen.add(pubkey)
      normalized.push(pubkey)
    }
  }

  return normalized
}

export const normalizeModerationIpAddress = (raw: string): string => {
  const ip = raw.trim()
  if (!ip || isIP(ip) === 0) {
    throw new Error('ip must be a valid IPv4 or IPv6 address')
  }

  const family = isIP(ip)
  return new SocketAddress({
    address: ip,
    family: family === 6 ? 'ipv6' : 'ipv4',
  }).address
}

const normalizeIpList = (values: string[], label: string): string[] => {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const raw of values) {
    let ip: string
    try {
      ip = normalizeModerationIpAddress(raw)
    } catch {
      throw new Error(`${label} must contain valid IPv4 or IPv6 addresses`)
    }

    if (!seen.has(ip)) {
      seen.add(ip)
      normalized.push(ip)
    }
  }

  return normalized
}

export const readAdminModerationLimits = (): AdminModerationLimits => {
  const settings = loadMergedSettings()
  const eventLimits = settings.limits?.event

  return {
    pubkey: {
      blacklist: [...(eventLimits?.pubkey?.blacklist ?? [])],
      whitelist: [...(eventLimits?.pubkey?.whitelist ?? [])],
    },
    kind: {
      blacklist: [...(eventLimits?.kind?.blacklist ?? [])],
      whitelist: [...(eventLimits?.kind?.whitelist ?? [])],
    },
    rateLimitBypass: {
      pubkeys: [...(eventLimits?.whitelists?.pubkeys ?? [])],
      ipAddresses: [...(eventLimits?.whitelists?.ipAddresses ?? [])],
    },
  }
}

const applyLimitsToUserSettings = (userSettings: Settings, limits: AdminModerationLimits): Settings => {
  return {
    ...userSettings,
    limits: {
      ...userSettings.limits,
      event: {
        ...userSettings.limits?.event,
        pubkey: {
          ...userSettings.limits?.event?.pubkey,
          blacklist: limits.pubkey.blacklist,
          whitelist: limits.pubkey.whitelist,
        },
        kind: {
          ...userSettings.limits?.event?.kind,
          blacklist: limits.kind.blacklist,
          whitelist: limits.kind.whitelist,
        },
        whitelists: {
          ...userSettings.limits?.event?.whitelists,
          pubkeys: limits.rateLimitBypass.pubkeys,
          ipAddresses: limits.rateLimitBypass.ipAddresses,
        },
      },
    },
  }
}

export type AdminModerationLimitsUpdater = (current: AdminModerationLimits) => AdminModerationLimits

const persistAdminModerationLimitsUnlocked = (next: AdminModerationLimits): void => {
  const normalized: AdminModerationLimits = {
    pubkey: {
      blacklist: normalizePubkeyList(next.pubkey.blacklist, 'pubkey blacklist'),
      whitelist: normalizePubkeyList(next.pubkey.whitelist, 'pubkey whitelist'),
    },
    kind: {
      blacklist: [...next.kind.blacklist],
      whitelist: [...next.kind.whitelist],
    },
    rateLimitBypass: {
      pubkeys: normalizePubkeyList(next.rateLimitBypass.pubkeys, 'rate-limit bypass pubkeys'),
      ipAddresses: normalizeIpList(next.rateLimitBypass.ipAddresses, 'rate-limit bypass IP list'),
    },
  }

  const userSettings = loadUserSettings() as Settings
  const nextUserSettings = applyLimitsToUserSettings(userSettings, normalized)
  const mergedNext = mergeDeepRight(loadDefaults(), nextUserSettings) as Settings

  const issues = validateSettings(mergedNext)
  if (issues.length > 0) {
    throw new ValidationError('Validation failed', issues)
  }

  saveSettings(nextUserSettings)
}

export const updateAdminModerationLimits = (updater: AdminModerationLimitsUpdater): void => {
  withSettingsWriteLock(() => {
    const current = readAdminModerationLimits()
    persistAdminModerationLimitsUnlocked(updater(current))
  })
}

export const persistAdminModerationLimits = (next: AdminModerationLimits): void => {
  updateAdminModerationLimits(() => next)
}

export class ValidationError extends Error {
  public constructor(
    message: string,
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

export type AdminModerationLimitsPatch = {
  pubkey?: Partial<AdminModerationLimits['pubkey']>
  kind?: Partial<AdminModerationLimits['kind']>
  rateLimitBypass?: Partial<AdminModerationLimits['rateLimitBypass']>
}

export const mergeAdminModerationLimitsPatch = (
  current: AdminModerationLimits,
  patch: AdminModerationLimitsPatch,
): AdminModerationLimits => ({
  pubkey: {
    blacklist: patch.pubkey?.blacklist ?? current.pubkey.blacklist,
    whitelist: patch.pubkey?.whitelist ?? current.pubkey.whitelist,
  },
  kind: {
    blacklist: patch.kind?.blacklist ?? current.kind.blacklist,
    whitelist: patch.kind?.whitelist ?? current.kind.whitelist,
  },
  rateLimitBypass: {
    pubkeys: patch.rateLimitBypass?.pubkeys ?? current.rateLimitBypass.pubkeys,
    ipAddresses: patch.rateLimitBypass?.ipAddresses ?? current.rateLimitBypass.ipAddresses,
  },
})

const withoutValue = <T>(list: T[], value: T): T[] => list.filter((entry) => entry !== value)

export const applyAdminModerationAction = (
  current: AdminModerationLimits,
  action: AdminModerationAction,
  fields: { pubkey?: string; ip?: string },
): AdminModerationLimits => {
  switch (action) {
    case 'ban-pubkey': {
      const pubkey = parseRelayPubkey(fields.pubkey)
      if (!pubkey || !isHexPubkey(pubkey)) {
        throw new Error('pubkey is required and must be a 64-character hex pubkey or npub')
      }
      return {
        ...current,
        pubkey: {
          blacklist: [...new Set([...current.pubkey.blacklist.map((p) => p.toLowerCase()), pubkey])],
          whitelist: current.pubkey.whitelist,
        },
      }
    }
    case 'unban-pubkey': {
      const pubkey = parseRelayPubkey(fields.pubkey)
      if (!pubkey || !isHexPubkey(pubkey)) {
        throw new Error('pubkey is required and must be a 64-character hex pubkey or npub')
      }
      return {
        ...current,
        pubkey: {
          ...current.pubkey,
          blacklist: withoutValue(
            current.pubkey.blacklist.map((p) => p.toLowerCase()),
            pubkey,
          ),
        },
      }
    }
    case 'whitelist-pubkey': {
      const pubkey = parseRelayPubkey(fields.pubkey)
      if (!pubkey || !isHexPubkey(pubkey)) {
        throw new Error('pubkey is required and must be a 64-character hex pubkey or npub')
      }
      return {
        ...current,
        rateLimitBypass: {
          ...current.rateLimitBypass,
          pubkeys: [...new Set([...current.rateLimitBypass.pubkeys.map((p) => p.toLowerCase()), pubkey])],
        },
      }
    }
    case 'unwhitelist-pubkey': {
      const pubkey = parseRelayPubkey(fields.pubkey)
      if (!pubkey || !isHexPubkey(pubkey)) {
        throw new Error('pubkey is required and must be a 64-character hex pubkey or npub')
      }
      return {
        ...current,
        rateLimitBypass: {
          ...current.rateLimitBypass,
          pubkeys: withoutValue(
            current.rateLimitBypass.pubkeys.map((p) => p.toLowerCase()),
            pubkey,
          ),
        },
      }
    }
    case 'whitelist-ip': {
      const rawIp = fields.ip?.trim()
      if (!rawIp) {
        throw new Error('ip is required and must be a valid IPv4 or IPv6 address')
      }
      const ip = normalizeModerationIpAddress(rawIp)
      return {
        ...current,
        rateLimitBypass: {
          ...current.rateLimitBypass,
          ipAddresses: [...new Set([...current.rateLimitBypass.ipAddresses, ip])],
        },
      }
    }
    case 'unwhitelist-ip': {
      const rawIp = fields.ip?.trim()
      if (!rawIp) {
        throw new Error('ip is required and must be a valid IPv4 or IPv6 address')
      }
      const ip = normalizeModerationIpAddress(rawIp)
      return {
        ...current,
        rateLimitBypass: {
          ...current.rateLimitBypass,
          ipAddresses: withoutValue(current.rateLimitBypass.ipAddresses, ip),
        },
      }
    }
    default:
      throw new Error('Unsupported moderation action')
  }
}
