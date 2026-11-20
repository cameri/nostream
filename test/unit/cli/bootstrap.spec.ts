import { expect } from 'chai'
import fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ensureConfigBootstrap } from '../../../src/cli/utils/bootstrap'
import { getDefaultSettingsFilePath } from '../../../src/cli/utils/paths'

describe('ensureConfigBootstrap', () => {
  let root: string
  let configDir: string
  let previousConfigDir: string | undefined

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'nostream-bootstrap-'))
    configDir = join(root, '.nostr')
    previousConfigDir = process.env.NOSTR_CONFIG_DIR
    process.env.NOSTR_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.NOSTR_CONFIG_DIR
    } else {
      process.env.NOSTR_CONFIG_DIR = previousConfigDir
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates the config directory and copies the defaults when there are no settings', () => {
    ensureConfigBootstrap()

    expect(fs.readFileSync(join(configDir, 'settings.yaml'), 'utf-8')).to.equal(
      fs.readFileSync(getDefaultSettingsFilePath(), 'utf-8'),
    )
  })

  it('leaves an existing settings.yaml alone', () => {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(join(configDir, 'settings.yaml'), 'info:\n  name: mine\n')

    ensureConfigBootstrap()

    expect(fs.readFileSync(join(configDir, 'settings.yaml'), 'utf-8')).to.equal('info:\n  name: mine\n')
  })

  it('does not write the defaults next to a settings.json, which they would shadow', () => {
    fs.mkdirSync(configDir, { recursive: true })
    const legacy = JSON.stringify({ nip43: { enabled: true } })
    fs.writeFileSync(join(configDir, 'settings.json'), legacy)

    ensureConfigBootstrap()

    expect(fs.existsSync(join(configDir, 'settings.yaml'))).to.equal(false)
    expect(fs.readFileSync(join(configDir, 'settings.json'), 'utf-8')).to.equal(legacy)
  })

  it('keeps the settings.json overrides in effect after bootstrapping', () => {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ nip43: { enabled: true } }))

    ensureConfigBootstrap()

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadMergedSettings } = require('../../../src/utils/settings-config')
    expect(loadMergedSettings().nip43?.enabled).to.equal(true)
  })

  it('leaves settings.yaml alone when a settings.json is there too', () => {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(join(configDir, 'settings.yaml'), 'info:\n  name: mine\n')
    fs.writeFileSync(join(configDir, 'settings.json'), '{}')

    ensureConfigBootstrap()

    expect(fs.readFileSync(join(configDir, 'settings.yaml'), 'utf-8')).to.equal('info:\n  name: mine\n')
  })
})
