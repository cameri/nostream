import { expect } from 'chai'
import { join } from 'path'

import {
  getConfigBaseDir,
  getDefaultSettingsFilePath,
  getSettingsAuditLogPath,
  getSettingsBackupDir,
  getSettingsFilePath,
} from '../../../src/utils/settings-paths'

describe('settings paths', () => {
  const originalConfigDir = process.env.NOSTR_CONFIG_DIR

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.NOSTR_CONFIG_DIR
    } else {
      process.env.NOSTR_CONFIG_DIR = originalConfigDir
    }
  })

  it('defaults config dir to .nostr under cwd', () => {
    delete process.env.NOSTR_CONFIG_DIR

    expect(getConfigBaseDir()).to.equal(join(process.cwd(), '.nostr'))
    expect(getSettingsFilePath()).to.equal(join(process.cwd(), '.nostr', 'settings.yaml'))
    expect(getSettingsBackupDir()).to.equal(join(process.cwd(), '.nostr', 'backups'))
    expect(getSettingsAuditLogPath()).to.equal(join(process.cwd(), '.nostr', 'settings-audit.jsonl'))
  })

  it('honors NOSTR_CONFIG_DIR', () => {
    process.env.NOSTR_CONFIG_DIR = '/srv/nostream/.nostr'

    expect(getConfigBaseDir()).to.equal('/srv/nostream/.nostr')
    expect(getSettingsFilePath()).to.equal(join('/srv/nostream/.nostr', 'settings.yaml'))
  })

  it('points default settings at bundled resources file', () => {
    expect(getDefaultSettingsFilePath()).to.equal(join(process.cwd(), 'resources', 'default-settings.yaml'))
  })
})
