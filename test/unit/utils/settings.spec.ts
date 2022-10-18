import { expect } from 'chai'
import { homedir } from 'os'
import { join } from 'path'

import { getDefaultSettings, getSettingsFilePath } from '../../../src/utils/settings'

describe('Settings', () => {
  describe('getSettingsFilePath', () => {
    let originalEnv: NodeJS.ProcessEnv

    beforeEach(() => {
      originalEnv = process.env
      process.env = {}
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('returns string ending with settings.json by default', () => {
      expect(getSettingsFilePath()).to.be.a('string').and.to.match(/settings\.json$/)
    })

    it('returns string ending with given string', () => {
      expect(getSettingsFilePath('ending')).to.be.a('string').and.to.match(/ending$/)
    })

    it('returns path begins with user\'s home dir by default', () => {
      expect(getSettingsFilePath()).to.be.a('string').and.equal(`${join(homedir(), '.nostr')}/settings.json`)
    })

    it('returns path with NOSTR_CONFIG_DIR if set', () => {
      process.env.NOSTR_CONFIG_DIR = '/some/path'

      expect(getSettingsFilePath()).to.be.a('string').and.equal('/some/path/settings.json')
    })
  })

  describe('getDefaultSettings', () => {
    it('returns object with info', () => {
      expect(getDefaultSettings())
        .to.have.property('info')
        .and.to.deep.equal({
          relay_url: 'wss://nostr-ts-relay.your-domain.com',
          name: 'nostr-ts-relay.your-domain.com',
          description: 'A nostr relay written in Typescript.',
          pubkey: '',
          contact: 'operator@your-domain.com',
        })
    })


    it('returns object with default limits', () => {
      expect(getDefaultSettings())
        .to.have.property('limits')
        .and.to.deep.equal({
          event: {
            eventId: {
              minLeadingZeroBits: 0,
            },
            kind: {
              whitelist: [],
              blacklist: [],
            },
            pubkey: {
              minLeadingZeroBits: 0,
              whitelist: [],
              blacklist: [],
            },
            createdAt: {
              maxPositiveDelta: 900, // +15 min
              maxNegativeDelta: 0, // disabled
            },
          },
          client: {
            subscription: {
              maxSubscriptions: 10,
              maxFilters: 10,
            },
          },
        })
    })
  })

  // describe('loadSettings', () => {

  // })

  // describe('createSettings', () => {

  // })

  // describe('saveSettings', () => {

  // })
})