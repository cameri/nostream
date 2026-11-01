import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  applyAdminModerationAction,
  mergeAdminModerationLimitsPatch,
  persistAdminModerationLimits,
  readAdminModerationLimits,
} from '../../../src/utils/admin-moderation'
import * as settingsConfig from '../../../src/utils/settings-config'

describe('admin-moderation', () => {
  const baseLimits = {
    pubkey: { blacklist: [], whitelist: [] },
    kind: { blacklist: [], whitelist: [1] },
    rateLimitBypass: { pubkeys: [], ipAddresses: ['::1'] },
  }

  let previousConfigDir: string | undefined
  let tempConfigDir: string

  before(() => {
    previousConfigDir = process.env.NOSTR_CONFIG_DIR
    tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-admin-moderation-'))
    process.env.NOSTR_CONFIG_DIR = tempConfigDir
  })

  after(() => {
    if (previousConfigDir === undefined) {
      delete process.env.NOSTR_CONFIG_DIR
    } else {
      process.env.NOSTR_CONFIG_DIR = previousConfigDir
    }
    fs.rmSync(tempConfigDir, { recursive: true, force: true })
  })

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

  it('does not remove a banned pubkey from the event pubkey whitelist', () => {
    const pubkey = 'a'.repeat(64)
    const withWhitelist = {
      ...baseLimits,
      pubkey: { blacklist: [], whitelist: [pubkey] },
    }
    const banned = applyAdminModerationAction(withWhitelist, 'ban-pubkey', { pubkey })
    expect(banned.pubkey.whitelist).to.deep.equal([pubkey])
    expect(banned.pubkey.blacklist).to.include(pubkey)
  })

  it('merges partial limit patches', () => {
    const merged = mergeAdminModerationLimitsPatch(baseLimits, {
      pubkey: { blacklist: ['b'.repeat(64)] },
    })
    expect(merged.pubkey.blacklist).to.have.length(1)
    expect(merged.kind.whitelist).to.deep.equal([1])
  })

  it('whitelists and removes rate-limit bypass pubkeys', () => {
    const pubkey = 'd'.repeat(64)
    const withPubkey = applyAdminModerationAction(baseLimits, 'whitelist-pubkey', { pubkey })
    expect(withPubkey.rateLimitBypass.pubkeys).to.include(pubkey)

    const withoutPubkey = applyAdminModerationAction(withPubkey, 'unwhitelist-pubkey', { pubkey })
    expect(withoutPubkey.rateLimitBypass.pubkeys).to.not.include(pubkey)
  })

  it('rejects invalid pubkeys and IPs for moderation actions', () => {
    expect(() => applyAdminModerationAction(baseLimits, 'ban-pubkey', { pubkey: 'short' })).to.throw(
      /64-character hex pubkey/,
    )
    expect(() => applyAdminModerationAction(baseLimits, 'whitelist-ip', { ip: 'not-an-ip' })).to.throw(/valid IPv4/)
  })

  it('whitelists and removes rate-limit bypass for IPs', () => {
    const withIp = applyAdminModerationAction(baseLimits, 'whitelist-ip', { ip: '203.0.113.10' })
    expect(withIp.rateLimitBypass.ipAddresses).to.include('203.0.113.10')

    const withoutIp = applyAdminModerationAction(withIp, 'unwhitelist-ip', { ip: '203.0.113.10' })
    expect(withoutIp.rateLimitBypass.ipAddresses).to.not.include('203.0.113.10')
  })

  it('persists normalized moderation limits to settings', async () => {
    const pubkey = 'c'.repeat(64)
    await persistAdminModerationLimits({
      ...baseLimits,
      pubkey: { blacklist: [pubkey], whitelist: [] },
    })

    const limits = readAdminModerationLimits()
    expect(limits.pubkey.blacklist).to.include(pubkey)
  })

  it('persists when user settings only override part of info', async () => {
    settingsConfig.saveSettings({ info: { relay_url: 'wss://relay.example' } } as any)
    const pubkey = 'f'.repeat(64)

    await persistAdminModerationLimits({
      ...baseLimits,
      pubkey: { blacklist: [pubkey], whitelist: [] },
    })

    expect(readAdminModerationLimits().pubkey.blacklist).to.include(pubkey)
  })
})
