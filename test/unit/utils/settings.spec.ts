import { expect } from 'chai'
import fs from 'fs'
import { join } from 'path'
import Sinon from 'sinon'

import { SettingsFileTypes, SettingsStatic } from '../../../src/utils/settings'

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
      expect(SettingsStatic.getSettingsFileBasePath()).to.be.a('string').and.to.match(/.nostr/)
    })

    it('returns path begins with user\'s home dir by default', () => {
      expect(SettingsStatic.getSettingsFileBasePath()).to.be.a('string').and.equal(`${join(process.cwd(), '.nostr')}`)
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
      expect(SettingsStatic.getDefaultSettingsFilePath()).to.be.a('string').and.to.match(/settings\.yaml$/)
    })

    it('returns path begins with user\'s home dir by default', () => {
      expect(SettingsStatic.getDefaultSettingsFilePath()).to.be.a('string').and.equal(`${join(process.cwd(), '/resources')}/default-settings.yaml`)
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

      expect(readFileSyncStub).to.have.been.calledOnceWithExactly(
        '/some/path/file.yaml',
        { encoding: 'utf-8' }
      )
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

      expect(readFileSyncStub).to.have.been.calledOnceWithExactly(
        '/some/path/file.json',
        { encoding: 'utf-8' }
      )
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

      expect(readFileSyncStub).to.have.been.calledOnceWithExactly(
        '/some/path/file.json',
        { encoding: 'utf-8' },
      )
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

      expect(readFileSyncStub).to.have.been.calledOnceWithExactly(
        '/some/path',
        { encoding: 'utf-8' }
      )
    })
  })

  describe('.createSettings', () => {
    let existsSyncStub: Sinon.SinonStub
    let mkdirSyncStub: Sinon.SinonStub
    let readdirSyncStub: Sinon.SinonStub
    let getSettingsFileBasePathStub: Sinon.SinonStub
    let getDefaultSettingsFilePathStub: Sinon.SinonStub
    let settingsFileTypeStub: Sinon.SinonStub
    let saveSettingsStub: Sinon.SinonStub
    let loadSettingsStub: Sinon.SinonStub

    let sandbox: Sinon.SinonSandbox

    beforeEach(() => {
      SettingsStatic._settings = undefined as any

      sandbox = Sinon.createSandbox()

      existsSyncStub = sandbox.stub(fs, 'existsSync')
      mkdirSyncStub = sandbox.stub(fs, 'mkdirSync')
      readdirSyncStub = sandbox.stub(fs, 'readdirSync')
      getSettingsFileBasePathStub = sandbox.stub(SettingsStatic, 'getSettingsFileBasePath')
      getDefaultSettingsFilePathStub = sandbox.stub(SettingsStatic, 'getDefaultSettingsFilePath')
      settingsFileTypeStub = sandbox.stub(SettingsStatic, 'settingsFileType')
      saveSettingsStub = sandbox.stub(SettingsStatic, 'saveSettings')
      loadSettingsStub = sandbox.stub(SettingsStatic, 'loadSettings')
    })

    afterEach(() => {
      sandbox.restore()
    })

    it('creates settings from defaults if settings file is missing', () => {
      getSettingsFileBasePathStub.returns('/some/path/settings.yaml')
      existsSyncStub.returns(false)
      mkdirSyncStub.returns(true)
      readdirSyncStub.returns(['file.yaml'])
      loadSettingsStub.returns({})

      expect(SettingsStatic.createSettings()).to.be.an('object')

      expect(existsSyncStub).to.have.been.calledOnceWithExactly('/some/path/settings.yaml')
      expect(getSettingsFileBasePathStub).to.have.been.calledOnce
      expect(saveSettingsStub).to.have.been.calledOnceWithExactly(
        '/some/path/settings.yaml',
        Sinon.match.object,
      )
      expect(loadSettingsStub).to.have.been.called
    })

    it('returns default settings if saving settings file throws', () => {
      const error = new Error('mistakes were made')
      getSettingsFileBasePathStub.returns('/some/path/settings.json')
      saveSettingsStub.throws(error)
      existsSyncStub.returns(false)
      readdirSyncStub.returns(['file.yaml'])
      loadSettingsStub.returns({})

      expect(SettingsStatic.createSettings()).to.be.an('object')

      expect(existsSyncStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
      expect(getSettingsFileBasePathStub).to.have.been.calledOnce
      expect(saveSettingsStub).to.have.been.calledOnceWithExactly(
        '/some/path/settings.json',
        Sinon.match.object,
      )
      expect(loadSettingsStub).to.have.been.called
    })

    it('loads settings from file if settings file exists', () => {
      loadSettingsStub.returns({ test: 'value' })
      getSettingsFileBasePathStub.returns('/some/path/settings.yaml')
      getDefaultSettingsFilePathStub.returns('/some/path/settings.yaml')
      existsSyncStub.returns(true)
      readdirSyncStub.returns(['settings.yaml'])
      settingsFileTypeStub.returns('yaml')


      expect(SettingsStatic.createSettings()).to.be.an('object')

      expect(existsSyncStub).to.have.been.calledWithExactly('/some/path/settings.yaml')
      expect(getSettingsFileBasePathStub).to.have.been.calledOnce
      expect(saveSettingsStub).not.to.have.been.called
      expect(loadSettingsStub).to.have.been.calledWithExactly('/some/path/settings.yaml', 'yaml')
    })

    it('returns cached settings if set', () => {
      const cachedSettings = Symbol()
      SettingsStatic._settings = cachedSettings as any

      expect(SettingsStatic.createSettings()).to.equal(cachedSettings)

      expect(getSettingsFileBasePathStub).not.to.have.been.calledOnce
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
      SettingsStatic.saveSettings('/some/path', {key: 'value'} as any)

      expect(writeFileSyncStub).to.have.been.calledOnceWithExactly(
        '/some/path/settings.yaml',
        Sinon.match.string,
        { encoding: 'utf-8' }
      )
    })
  })
})
