import { expect } from 'chai'

import {
  applyAdminModerationAction,
  mergeAdminModerationLimitsPatch,
  readAdminModerationLimits,
} from '../../../src/utils/admin-moderation'
import * as settingsConfig from '../../../src/utils/settings-config'

describe('admin-moderation', () => {
  const baseLimits = {
    pubkey: { blacklist: [], whitelist: [] },
    kind: { blacklist: [], whitelist: [1] },
    rateLimitBypass: { pubkeys: [], ipAddresses: ['::1'] },
  }

  beforeEach(() => {
    const settings = settingsConfig.loadDefaults() as any
    settings.limits.event.pubkey.blacklist = []
    settings.limits.event.pubkey.whitelist = []
    settings.limits.event.kind.blacklist = []
    settings.limits.event.kind.whitelist = [1]
    settings.limits.event.whitelists = { pubkeys: [], ipAddresses: ['::1'] }
    settings.info = { relay_url: 'wss://relay.example', name: 'test' }
    settingsConfig.saveSettings(settings)
  })

  it('reads merged moderation limits', () => {
    const limits = readAdminModerationLimits()
    expect(limits.kind.whitelist).to.deep.equal([1])
    expect(limits.rateLimitBypass.ipAddresses).to.include('::1')
  })

  it('bans and unbans a pubkey', () => {
    const pubkey = 'a'.repeat(64)
    const banned = applyAdminModerationAction(baseLimits, 'ban-pubkey', { pubkey })
    expect(banned.pubkey.blacklist).to.include(pubkey)

    const unbanned = applyAdminModerationAction(banned, 'unban-pubkey', { pubkey })
    expect(unbanned.pubkey.blacklist).to.not.include(pubkey)
  })

  it('merges partial limit patches', () => {
    const merged = mergeAdminModerationLimitsPatch(baseLimits, {
      pubkey: { blacklist: ['b'.repeat(64)] },
    })
    expect(merged.pubkey.blacklist).to.have.length(1)
    expect(merged.kind.whitelist).to.deep.equal([1])
  })
})
