import { expect } from 'chai'
import fs from 'fs'
import { join } from 'path'
import Sinon from 'sinon'
import { mergeDeepRight } from 'ramda'
import { Settings } from '../../../src/@types/settings'

import { SettingsFileTypes, SettingsStatic } from '../../../src/utils/settings'
import * as settingsConfig from '../../../src/utils/settings-config'

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

    it('returns string ending with .nostr/ by default', () => {
      expect(SettingsStatic.getSettingsFileBasePath())
        .to.be.a('string')
        .and.to.match(/.nostr/)
    })

    it("returns path begins with user's home dir by default", () => {
      expect(SettingsStatic.getSettingsFileBasePath())
        .to.be.a('string')
        .and.equal(`${join(process.cwd(), '.nostr')}`)
    })

    it('returns path with NOSTR_CONFIG_DIR if set', () => {
      process.env.NOSTR_CONFIG_DIR = '/some/path/'

      expect(SettingsStatic.getSettingsFileBasePath()).to.be.a('string').and.equal('/some/path/')
    })
  })

  describe('.getDefaultSettingsFilePath', () => {
    let originalEnv: NodeJS.ProcessEnv

    beforeEach(() => {
      originalEnv = process.env
      process.env = {}
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('returns string ending with settings.json by default', () => {
      expect(SettingsStatic.getDefaultSettingsFilePath())
        .to.be.a('string')
        .and.to.match(/settings\.yaml$/)
    })

    it("returns path begins with user's home dir by default", () => {
      expect(SettingsStatic.getDefaultSettingsFilePath())
        .to.be.a('string')
        .and.equal(join(process.cwd(), 'resources', 'default-settings.yaml'))
    })
  })

  describe('.loadAndParseYamlFile', () => {
    let readFileSyncStub: Sinon.SinonStub

    beforeEach(() => {
      readFileSyncStub = Sinon.stub(fs, 'readFileSync')
    })

    afterEach(() => {
      readFileSyncStub.restore()
    })

    it('loads and parses yaml file from given path', () => {
      readFileSyncStub.returns('"content"')

      expect(SettingsStatic.loadAndParseYamlFile('/some/path/file.yaml')).to.equal('content')

      expect(readFileSyncStub).to.have.been.calledOnceWithExactly('/some/path/file.yaml', { encoding: 'utf-8' })
    })
  })

  describe('.loadAndParseJsonFile', () => {
    let readFileSyncStub: Sinon.SinonStub

    beforeEach(() => {
      readFileSyncStub = Sinon.stub(fs, 'readFileSync')
    })

    afterEach(() => {
      readFileSyncStub.restore()
    })

    it('loads and parses json file from given path', () => {
      readFileSyncStub.returns('"content"')

      expect(SettingsStatic.loadAndParseJsonFile('/some/path/file.json')).to.equal('content')

      expect(readFileSyncStub).to.have.been.calledOnceWithExactly('/some/path/file.json', { encoding: 'utf-8' })
    })
  })

  describe('.settingsFileType', () => {
    let readFileSyncStub: Sinon.SinonStub

    beforeEach(() => {
      readFileSyncStub = Sinon.stub(fs, 'readFileSync')
    })

    afterEach(() => {
      readFileSyncStub.restore()
    })

    it('gets file type by looking for settings file in config dir', () => {
      readFileSyncStub.returns('{\n"key": "value"\n}')

      expect(SettingsStatic.loadAndParseJsonFile('/some/path/file.json')).to.have.property('key', 'value')

      expect(readFileSyncStub).to.have.been.calledOnceWithExactly('/some/path/file.json', { encoding: 'utf-8' })
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

      expect(SettingsStatic.loadSettings('/some/path', SettingsFileTypes.yaml)).to.equal('content')

      expect(readFileSyncStub).to.have.been.calledOnceWithExactly('/some/path', { encoding: 'utf-8' })
    })
  })

  describe('.createSettings', () => {
    let existsSyncStub: Sinon.SinonStub
    let mkdirSyncStub: Sinon.SinonStub
    let loadMergedSettingsStub: Sinon.SinonStub
    let loadDefaultsStub: Sinon.SinonStub

    let sandbox: Sinon.SinonSandbox

    beforeEach(() => {
      SettingsStatic._settings = undefined as any

      sandbox = Sinon.createSandbox()

      existsSyncStub = sandbox.stub(fs, 'existsSync')
      mkdirSyncStub = sandbox.stub(fs, 'mkdirSync')
      loadMergedSettingsStub = sandbox.stub(settingsConfig, 'loadMergedSettings')
      loadDefaultsStub = sandbox.stub(settingsConfig, 'loadDefaults')
    })

    afterEach(() => {
      sandbox.restore()
    })

    it('loads merged settings from defaults and optional overrides', () => {
      existsSyncStub.returns(false)
      mkdirSyncStub.returns(true)
      loadMergedSettingsStub.returns({ info: { name: 'relay' } })

      expect(SettingsStatic.createSettings()).to.deep.equal({ info: { name: 'relay' } })
      expect(loadMergedSettingsStub).to.have.been.calledOnce
      expect(loadDefaultsStub).not.to.have.been.called
    })

    it('returns image defaults if loading merged settings throws', () => {
      existsSyncStub.returns(false)
      mkdirSyncStub.returns(true)
      loadMergedSettingsStub.throws(new Error('mistakes were made'))
      loadDefaultsStub.returns({ info: { name: 'default-relay' } })

      expect(SettingsStatic.createSettings()).to.deep.equal({ info: { name: 'default-relay' } })

      expect(loadMergedSettingsStub).to.have.been.calledOnce
      expect(loadDefaultsStub).to.have.been.calledOnce
    })

    it('returns cached settings if set', () => {
      const cachedSettings = Symbol()
      SettingsStatic._settings = cachedSettings as any

      expect(SettingsStatic.createSettings()).to.equal(cachedSettings)

      expect(existsSyncStub).not.to.have.been.called
      expect(loadMergedSettingsStub).not.to.have.been.called
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
      SettingsStatic.saveSettings('/some/path', { key: 'value' } as any)

      expect(writeFileSyncStub).to.have.been.calledOnceWithExactly(
        join('/some/path', 'settings.yaml'),
        Sinon.match.string,
        { encoding: 'utf-8' },
      )
    })
  })

  describe('NIP-43 settings defaults', () => {
    it('default-settings.yaml contains a nip43 block with mint defaults', () => {
      const defaults = SettingsStatic.loadAndParseYamlFile(SettingsStatic.getDefaultSettingsFilePath())

      expect(defaults).to.have.nested.property('nip43.enabled', false)
      expect(defaults).to.have.nested.property('nip43.inviteCodeExpirySeconds', 600)
      expect(defaults).to.have.nested.property('nip43.defaultMaxUses', 1)
    })

    it('user config nip43 block overrides defaults', () => {
      const defaults = SettingsStatic.loadAndParseYamlFile(SettingsStatic.getDefaultSettingsFilePath())
      const userConfig = {
        nip43: {
          enabled: true,
          inviteCodeExpirySeconds: 86400,
          defaultMaxUses: 5,
        },
      }
      const merged = mergeDeepRight(defaults, userConfig) as Settings

      expect(merged.nip43?.enabled).to.equal(true)
      expect(merged.nip43?.inviteCodeExpirySeconds).to.equal(86400)
      expect(merged.nip43?.defaultMaxUses).to.equal(5)
    })
  })

  describe('NIP-66 settings defaults', () => {
    it('default-settings.yaml contains a nip66 block with safe defaults', () => {
      const defaults = SettingsStatic.loadAndParseYamlFile(SettingsStatic.getDefaultSettingsFilePath())

      expect(defaults).to.have.nested.property('nip66.enabled', false)
      expect(defaults).to.have.nested.property('nip66.probeIntervalSeconds', 3600)
      expect(defaults).to.have.nested.property('nip66.timeouts.dnsMs', 10_000)
      expect(defaults).to.have.nested.property('nip66.timeouts.tlsMs', 10_000)
      expect(defaults).to.have.nested.property('nip66.timeouts.wsRttMs', 10_000)
      expect(defaults).to.have.nested.property('nip66.timeouts.nip11Ms', 10_000)
      expect(defaults).to.have.nested.property('nip66.targets').that.deep.equals([])
      expect(defaults).to.have.nested.property('nip66.dnsCacheTtlSeconds', 300)
    })

    it('user config nip66 block overrides defaults', () => {
      const defaults = SettingsStatic.loadAndParseYamlFile(SettingsStatic.getDefaultSettingsFilePath())
      const userConfig = {
        nip66: {
          enabled: true,
          probeIntervalSeconds: 900,
          targets: ['wss://relay.example.com'],
        },
      }
      const merged = mergeDeepRight(defaults, userConfig) as Settings

      expect(merged.nip66?.enabled).to.equal(true)
      expect(merged.nip66?.probeIntervalSeconds).to.equal(900)
      expect(merged.nip66?.targets).to.deep.equal(['wss://relay.example.com'])
      expect(merged.nip66?.timeouts?.dnsMs).to.equal(10_000)
      expect(merged.nip66?.dnsCacheTtlSeconds).to.equal(300)
    })
  })

  describe('WoT settings defaults', () => {
    it('default-settings.yaml contains a wot block with enabled: false', () => {
      const defaults = SettingsStatic.loadAndParseYamlFile(
        SettingsStatic.getDefaultSettingsFilePath()
      )
      expect(defaults).to.have.nested.property('wot.enabled', false)
      expect(defaults).to.have.nested.property('wot.seedPubkey', '')
      expect(defaults).to.have.nested.property('wot.minimumFollowers', 1)
      expect(defaults).to.have.nested.property('wot.refreshIntervalHours', 24)
    })

    it('user config wot block overrides defaults', () => {
      const defaults = SettingsStatic.loadAndParseYamlFile(
        SettingsStatic.getDefaultSettingsFilePath()
      )
      const userConfig = { wot: { enabled: true, seedPubkey: 'abc123', minimumFollowers: 3 } }
      const merged = mergeDeepRight(defaults, userConfig) as Settings
      expect(merged.wot?.enabled).to.equal(true)
      expect(merged.wot?.seedPubkey).to.equal('abc123')
      expect(merged.wot?.minimumFollowers).to.equal(3)
      // non-overridden fields stay as defaults
      expect(merged.wot?.refreshIntervalHours).to.equal(24)
    })
  })
})
