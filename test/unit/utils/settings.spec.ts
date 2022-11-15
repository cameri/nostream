import { expect } from 'chai'
import fs from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import Sinon from 'sinon'

import { SettingsStatic } from '../../../src/utils/settings'

describe('SettingsStatic', () => {
  describe('.getSettingsFilePath', () => {
    let originalEnv: NodeJS.ProcessEnv

    beforeEach(() => {
      originalEnv = process.env
      process.env = {}
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('returns string ending with settings.json by default', () => {
      expect(SettingsStatic.getSettingsFilePath()).to.be.a('string').and.to.match(/settings\.json$/)
    })

    it('returns string ending with given string', () => {
      expect(SettingsStatic.getSettingsFilePath('ending')).to.be.a('string').and.to.match(/ending$/)
    })

    it('returns path begins with user\'s home dir by default', () => {
      expect(SettingsStatic.getSettingsFilePath()).to.be.a('string').and.equal(`${join(homedir(), '.nostr')}/settings.json`)
    })

    it('returns path with NOSTR_CONFIG_DIR if set', () => {
      process.env.NOSTR_CONFIG_DIR = '/some/path'

      expect(SettingsStatic.getSettingsFilePath()).to.be.a('string').and.equal('/some/path/settings.json')
    })
  })

  describe('.getDefaultSettings', () => {
    it('returns object with info', () => {
      expect(SettingsStatic.getDefaultSettings())
        .to.have.property('info')
        .and.to.deep.equal({
          relay_url: 'wss://nostr-ts-relay.your-domain.com',
          name: 'nostr-ts-relay.your-domain.com',
          description: 'A nostr relay written in Typescript.',
          pubkey: 'replace-with-your-pubkey',
          contact: 'operator@your-domain.com',
        })
    })

    it('returns object with default limits', () => {
      expect(SettingsStatic.getDefaultSettings())
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
            'rateLimits': [
              {
                'kinds': [[0, 5], 7, [40, 49], [10000, 19999], [30000, 39999]],
                'period': 60000,
                'rate': 60,
              },
              {
                'kinds': [[20000, 29999]],
                'period': 60000,
                'rate': 600,
              },
              {
                'period': 3600000,
                'rate': 3600,
              },
              {
                'period': 86400000,
                'rate': 86400,
              },
            ],
          },
          client: {
            subscription: {
              maxSubscriptions: 10,
              maxFilters: 10,
            },
          },
          message: {
            'rateLimits': [
              {
                'period': 60000,
                'rate': 600,
              },
              {
                'period': 3600000,
                'rate': 3600,
              },
              {
                'period': 86400000,
                'rate': 86400,
              },
            ],
            ipWhitelist: [
              '::1',
              '::ffff:10.10.10.1',
            ],
          },
        })
    })
  })

  describe('.loadSettings', () => {
    let readFileSyncStub: Sinon.SinonStub

    beforeEach(() => {
      readFileSyncStub = Sinon.stub(fs, 'readFileSync')
    })

    afterEach(() => {
      readFileSyncStub.restore()
    })

    it('loads settings from given path', () => {
      readFileSyncStub.returns('"content"')

      expect(SettingsStatic.loadSettings('/some/path')).to.equal('content')

      expect(readFileSyncStub).to.have.been.calledOnceWithExactly(
        '/some/path',
        { encoding: 'utf-8' }
      )
    })
  })

  describe('.createSettings', () => {
    let existsSyncStub: Sinon.SinonStub
    let getSettingsFilePathStub: Sinon.SinonStub
    let getDefaultSettingsStub: Sinon.SinonStub
    let saveSettingsStub: Sinon.SinonStub
    let loadSettingsStub: Sinon.SinonStub

    let sandbox: Sinon.SinonSandbox

    beforeEach(() => {
      SettingsStatic._settings = undefined

      sandbox = Sinon.createSandbox()

      existsSyncStub = sandbox.stub(fs, 'existsSync')
      getSettingsFilePathStub = sandbox.stub(SettingsStatic, 'getSettingsFilePath')
      getDefaultSettingsStub = sandbox.stub(SettingsStatic, 'getDefaultSettings')
      saveSettingsStub = sandbox.stub(SettingsStatic, 'saveSettings')
      loadSettingsStub = sandbox.stub(SettingsStatic, 'loadSettings')
    })

    afterEach(() => {
      sandbox.restore()
    })

    it('creates settings from default if settings file is missing', () => {
      getDefaultSettingsStub.returns({})
      getSettingsFilePathStub.returns('/some/path/settings.json')
      existsSyncStub.returns(false)

      expect(SettingsStatic.createSettings()).to.deep.equal({})

      expect(existsSyncStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
      expect(getSettingsFilePathStub).to.have.been.calledOnce
      expect(getDefaultSettingsStub).to.have.been.calledOnce
      expect(saveSettingsStub).to.have.been.calledOnceWithExactly(
        '/some/path/settings.json',
        {},
      )
      expect(loadSettingsStub).not.to.have.been.called
    })

    it('returns default settings if saving settings file throws', () => {
      const error = new Error('mistakes were made')
      const defaults = Symbol()
      getSettingsFilePathStub.returns('/some/path/settings.json')
      getDefaultSettingsStub.returns(defaults)
      saveSettingsStub.throws(error)
      existsSyncStub.returns(false)

      expect(SettingsStatic.createSettings()).to.equal(defaults)

      expect(existsSyncStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
      expect(getSettingsFilePathStub).to.have.been.calledOnce
      expect(getDefaultSettingsStub).to.have.been.calledOnce
      expect(saveSettingsStub).to.have.been.calledOnceWithExactly(
        '/some/path/settings.json',
        defaults,
      )
      expect(loadSettingsStub).not.to.have.been.called
    })

    it('loads settings from file if settings file is exists', () => {
      getDefaultSettingsStub.returns({})
      loadSettingsStub.returns({})
      getSettingsFilePathStub.returns('/some/path/settings.json')
      existsSyncStub.returns(true)

      expect(SettingsStatic.createSettings()).to.deep.equal({})

      expect(existsSyncStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
      expect(getSettingsFilePathStub).to.have.been.calledOnce
      expect(getDefaultSettingsStub).to.have.been.calledOnce
      expect(saveSettingsStub).not.to.have.been.called
      expect(loadSettingsStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
    })

    it('returns defaults if loading settings file throws', () => {
      const defaults = Symbol()
      const error = new Error('mistakes were made')
      getDefaultSettingsStub.returns(defaults)
      loadSettingsStub.throws(error)
      getSettingsFilePathStub.returns('/some/path/settings.json')
      existsSyncStub.returns(true)

      expect(SettingsStatic.createSettings()).to.equal(defaults)

      expect(existsSyncStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
      expect(getSettingsFilePathStub).to.have.been.calledOnce
      expect(getDefaultSettingsStub).to.have.been.calledOnce
      expect(saveSettingsStub).not.to.have.been.called
      expect(loadSettingsStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
    })

    it('returns cached settings if set', () => {
      const cachedSettings = Symbol()
      SettingsStatic._settings = cachedSettings as any

      expect(SettingsStatic.createSettings()).to.equal(cachedSettings)

      expect(getSettingsFilePathStub).not.to.have.been.calledOnce
      expect(getDefaultSettingsStub).not.to.have.been.calledOnce
      expect(existsSyncStub).not.to.have.been.called
      expect(saveSettingsStub).not.to.have.been.called
      expect(loadSettingsStub).not.to.have.been.called
    })
  })

  describe('.saveSettings', () => {
    let writeFileSyncStub: Sinon.SinonStub

    beforeEach(() => {
      writeFileSyncStub = Sinon.stub(fs, 'writeFileSync')
    })

    afterEach(() => {
      writeFileSyncStub.restore()
    })

    it('saves settings to given path', () => {
      SettingsStatic.saveSettings('/some/path/settings.json', {key: 'value'} as any)

      expect(writeFileSyncStub).to.have.been.calledOnceWithExactly(
        '/some/path/settings.json',
        '{\n  "key": "value"\n}',
        { encoding: 'utf-8' }
      )
    })
  })
})
