import { expect } from 'chai'

import {
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
  })
})
