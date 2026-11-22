import { expect } from 'chai'

import {
  changedWriteProtectedSettingsPaths,
  collectWriteProtectedSettings,
  isSensitiveSettingsPath,
  isWriteProtectedSettingsPath,
  redactSettingsSecrets,
  redactSettingsValue,
} from '../../../src/utils/settings-redaction'

describe('settings-redaction', () => {
  it('redacts passwordHash and secret values in nested settings', () => {
    const input = {
      admin: {
        enabled: true,
        passwordHash: 'hashed-password-value',
      },
      mirroring: {
        static: [
          {
            address: 'wss://mirror.example',
            secret: 'mirror-secret-value',
          },
        ],
      },
      payments: {
        enabled: false,
      },
    }

    const redacted = redactSettingsSecrets(input)

    expect(redacted.admin.passwordHash).to.equal('***')
    expect(redacted.mirroring.static[0].secret).to.equal('***')
    expect(redacted.mirroring.static[0].address).to.equal('wss://mirror.example')
    expect(redacted.payments.enabled).to.equal(false)
  })

  it('leaves empty secret values unchanged', () => {
    const input = {
      mirroring: {
        static: [{ address: 'wss://mirror.example', secret: '' }],
      },
    }

    expect(redactSettingsSecrets(input).mirroring.static[0].secret).to.equal('')
  })

  it('identifies sensitive and write-protected paths', () => {
    expect(isSensitiveSettingsPath('admin.passwordHash')).to.equal(true)
    expect(isSensitiveSettingsPath('mirroring.static[0].secret')).to.equal(true)
    expect(isSensitiveSettingsPath('payments.enabled')).to.equal(false)
    expect(isWriteProtectedSettingsPath('admin.passwordHash')).to.equal(true)
    expect(isWriteProtectedSettingsPath('mirroring.static[0].secret')).to.equal(false)
  })

  it('redacts single values by path', () => {
    expect(redactSettingsValue('mirroring.static[0].secret', 'top-secret')).to.equal('***')
    expect(redactSettingsValue('payments.enabled', true)).to.equal(true)
    expect(redactSettingsValue('admin.notifications.targets[0].url', 'https://discord.com/api/webhooks/secret')).to.equal(
      '***',
    )
  })

  it('redacts notification webhook urls in nested settings', () => {
    const input = {
      admin: {
        notifications: {
          targets: [
            {
              id: 'slack-ops',
              type: 'slack',
              enabled: true,
              url: 'https://hooks.slack.com/services/T00/B00/xxxxx',
            },
          ],
        },
      },
    }

    expect(redactSettingsSecrets(input).admin.notifications.targets[0].url).to.equal('***')
  })

  describe('collectWriteProtectedSettings', () => {
    it('finds the protected values in a document, by path', () => {
      const settings = { admin: { enabled: true, passwordHash: 'abc' }, payments: {} }

      expect(collectWriteProtectedSettings(settings)).to.deep.equal({ 'admin.passwordHash': 'abc' })
    })

    it('finds a protected value nested in objects and arrays', () => {
      const settings = { other: [{ passwordHash: 'x' }, { name: 'y' }], deep: { er: { passwordHash: 'z' } } }

      expect(collectWriteProtectedSettings(settings)).to.deep.equal({
        'other[0].passwordHash': 'x',
        'deep.er.passwordHash': 'z',
      })
    })

    it('finds nothing in a document without one, or in something that is not a document', () => {
      expect(collectWriteProtectedSettings({ admin: { enabled: true } })).to.deep.equal({})
      expect(collectWriteProtectedSettings(undefined)).to.deep.equal({})
      expect(collectWriteProtectedSettings('admin.passwordHash')).to.deep.equal({})
    })
  })

  describe('changedWriteProtectedSettingsPaths', () => {
    it('is empty when no protected value changed, whatever else did', () => {
      const before = { admin: { passwordHash: 'abc', sessionTtlSeconds: 1 }, payments: { enabled: false } }
      const after = { admin: { passwordHash: 'abc', sessionTtlSeconds: 2 }, payments: { enabled: true } }

      expect(changedWriteProtectedSettingsPaths(before, after)).to.deep.equal([])
    })

    it('reports a protected value that was replaced', () => {
      expect(
        changedWriteProtectedSettingsPaths({ admin: { passwordHash: 'abc' } }, { admin: { passwordHash: 'new' } }),
      ).to.deep.equal(['admin.passwordHash'])
    })

    it('reports a protected value that was removed', () => {
      expect(changedWriteProtectedSettingsPaths({ admin: { passwordHash: 'abc' } }, { admin: {} })).to.deep.equal([
        'admin.passwordHash',
      ])
      expect(changedWriteProtectedSettingsPaths({ admin: { passwordHash: 'abc' } }, {})).to.deep.equal([
        'admin.passwordHash',
      ])
    })

    it('reports a protected value that was added', () => {
      expect(changedWriteProtectedSettingsPaths({ admin: {} }, { admin: { passwordHash: 'new' } })).to.deep.equal([
        'admin.passwordHash',
      ])
    })

    it('reports each changed protected path once, in order', () => {
      const before = { admin: { passwordHash: 'a' }, other: { passwordHash: 'b' } }
      const after = { admin: { passwordHash: 'x' }, other: { passwordHash: 'y' } }

      expect(changedWriteProtectedSettingsPaths(before, after)).to.deep.equal([
        'admin.passwordHash',
        'other.passwordHash',
      ])
    })
  })
})
