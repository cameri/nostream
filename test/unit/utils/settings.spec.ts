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

    it('returns string ending with .nostr/ by default', () => {
      expect(SettingsStatic.getSettingsFileBasePath()).to.be.a('string').and.to.match(/s\.nostr$/)
    })

    it('returns path begins with user\'s home dir by default', () => {
      expect(SettingsStatic.getSettingsFileBasePath()).to.be.a('string').and.equal(`${join(homedir(), '.nostr')}/`)
    })

    it('returns path with NOSTR_CONFIG_DIR if set', () => {
      process.env.NOSTR_CONFIG_DIR = '/some/path'

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
      expect(SettingsStatic.getDefaultSettingsFilePath()).to.be.a('string').and.equal(`${join(homedir(), '.nostr')}/settings.yaml`)
    })

    it('returns path with NOSTR_CONFIG_DIR if set', () => {
      process.env.NOSTR_CONFIG_DIR = '/some/path'

      expect(SettingsStatic.getDefaultSettingsFilePath()).to.be.a('string').and.equal('/some/path/settings.yaml')
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

      expect(SettingsStatic.loadSettings('/some/path', 'yaml')).to.equal('content')

      expect(readFileSyncStub).to.have.been.calledOnceWithExactly(
        '/some/path',
        { encoding: 'utf-8' }
      )
    })
  })

  describe('.createSettings', () => {
    let existsSyncStub: Sinon.SinonStub
    let getSettingsFilePathStub: Sinon.SinonStub
    let saveSettingsStub: Sinon.SinonStub
    let loadSettingsStub: Sinon.SinonStub

    let sandbox: Sinon.SinonSandbox

    beforeEach(() => {
      SettingsStatic._settings = undefined

      sandbox = Sinon.createSandbox()

      existsSyncStub = sandbox.stub(fs, 'existsSync')
      getSettingsFilePathStub = sandbox.stub(SettingsStatic, 'getSettingsFileBasePath')
      saveSettingsStub = sandbox.stub(SettingsStatic, 'saveSettings')
      loadSettingsStub = sandbox.stub(SettingsStatic, 'loadSettings')
    })

    afterEach(() => {
      sandbox.restore()
    })

    it('creates settings from default if settings file is missing', () => {
      getSettingsFilePathStub.returns('/some/path/settings.json')
      existsSyncStub.returns(false)

      expect(SettingsStatic.createSettings()).to.be.an('object')

      expect(existsSyncStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
      expect(getSettingsFilePathStub).to.have.been.calledOnce
      expect(saveSettingsStub).to.have.been.calledOnceWithExactly(
        '/some/path/settings.json',
        Sinon.match.object,
      )
      expect(loadSettingsStub).not.to.have.been.called
    })

    it('returns default settings if saving settings file throws', () => {
      const error = new Error('mistakes were made')
      getSettingsFilePathStub.returns('/some/path/settings.json')
      saveSettingsStub.throws(error)
      existsSyncStub.returns(false)

      expect(SettingsStatic.createSettings()).to.be.an('object')

      expect(existsSyncStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
      expect(getSettingsFilePathStub).to.have.been.calledOnce
      expect(saveSettingsStub).to.have.been.calledOnceWithExactly(
        '/some/path/settings.json',
        Sinon.match.object,
      )
      expect(loadSettingsStub).not.to.have.been.called
    })

    it('loads settings from file if settings file is exists', () => {
      loadSettingsStub.returns({})
      getSettingsFilePathStub.returns('/some/path/settings.json')
      existsSyncStub.returns(true)

      expect(SettingsStatic.createSettings()).to.be.an('object')

      expect(existsSyncStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
      expect(getSettingsFilePathStub).to.have.been.calledOnce
      expect(saveSettingsStub).not.to.have.been.called
      expect(loadSettingsStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
    })

    it('returns defaults if loading settings file throws', () => {
      const error = new Error('mistakes were made')
      loadSettingsStub.throws(error)
      getSettingsFilePathStub.returns('/some/path/settings.json')
      existsSyncStub.returns(true)

      expect(SettingsStatic.createSettings()).to.be.an('object')

      expect(existsSyncStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
      expect(getSettingsFilePathStub).to.have.been.calledOnce
      expect(saveSettingsStub).not.to.have.been.called
      expect(loadSettingsStub).to.have.been.calledOnceWithExactly('/some/path/settings.json')
    })

    it('returns cached settings if set', () => {
      const cachedSettings = Symbol()
      SettingsStatic._settings = cachedSettings as any

      expect(SettingsStatic.createSettings()).to.equal(cachedSettings)

      expect(getSettingsFilePathStub).not.to.have.been.calledOnce
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
