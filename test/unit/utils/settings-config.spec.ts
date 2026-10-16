import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  ensureSettingsExists,
  loadUserSettings,
  toCategoryLabel,
  getByPath,
  getTopLevelSettingCategories,
  loadDefaults,
  parseTypedValue,
  parseValue,
  setByPath,
  validatePathAgainstDefaults,
  validateSettings,
} from '../../../src/utils/settings-config'
import {
  getGuidedSettingCategory,
  getGuidedSettingField,
  guidedSettingCategories,
  requireNonEmptySettingValue,
  requireSafeNonNegativeIntegerSettingValue,
  requireSafePositiveIntegerSettingValue,
} from '../../../src/utils/settings-guided-schema'

describe('settings-config', () => {
  it('parses primitive values', () => {
    expect(parseValue('true')).to.equal(true)
    expect(parseValue('false')).to.equal(false)
    expect(parseValue('42')).to.equal(42)
    expect(parseValue('42n')).to.equal(42n)
    expect(parseValue('null')).to.equal(null)
    expect(parseValue('hello')).to.equal('hello')
  })

  it('parses typed json values', () => {
    expect(parseTypedValue('{"enabled":true}', 'json')).to.deep.equal({ enabled: true })
    expect(parseTypedValue('[1,2,3]', 'json')).to.deep.equal([1, 2, 3])
    expect(() => parseTypedValue('{', 'json')).to.throw('Invalid JSON value')
  })

  it('sets and gets dot-path values', () => {
    const input = {
      payments: {
        enabled: false,
      },
    }

    const updated = setByPath(input as any, 'payments.enabled', true)

    expect(getByPath(updated, 'payments.enabled')).to.equal(true)
    expect(getByPath(updated, 'payments')).to.deep.equal({ enabled: true })
    expect(getByPath(updated, 'payments.processor')).to.equal(undefined)
  })

  it('supports indexed path syntax', () => {
    const input = {
      limits: {
        event: {
          content: [
            {
              maxLength: 100,
            },
          ],
        },
      },
    }

    const updated = setByPath(input as any, 'limits.event.content[0].maxLength', 500)

    expect(getByPath(updated, 'limits.event.content[0].maxLength')).to.equal(500)
  })

  it('rejects malformed path syntax', () => {
    expect(() => setByPath({} as any, 'payments[]', true)).to.throw('Invalid path segment')
  })

  it('rejects reserved prototype-pollution path keys', () => {
    for (const path of ['__proto__.enabled', 'constructor.enabled', 'prototype.enabled']) {
      expect(() => setByPath({ payments: { enabled: false } } as any, path, true)).to.throw('Invalid path segment')
      expect(() => getByPath({ payments: { enabled: false } }, path)).to.throw('Invalid path segment')
    }
  })

  it('validates known paths against defaults', () => {
    expect(validatePathAgainstDefaults('payments.enabled')).to.deep.equal([])
    expect(validatePathAgainstDefaults('limits.event.content[0].maxLength')).to.deep.equal([])

    const issues = validatePathAgainstDefaults('payments.fakeField')
    expect(issues[0].message).to.include('does not exist')
  })

  it('validates basic required fields', () => {
    const issues = validateSettings({} as any)

    expect(issues.some((issue) => issue.path === 'info.relay_url')).to.equal(true)
    expect(issues.some((issue) => issue.path === 'network')).to.equal(true)
  })

  it('accepts a relay_url with a valid ws/wss/http/https absolute URL', () => {
    for (const relay_url of [
      'ws://nostream.example.com:8008',
      'wss://nostream.example.com',
      'http://localhost:8008',
      'http://nostream.example.com',
      'https://nostream.example.com',
      'https://nostream.example.com:8443',
      'ws://[::1]:8008',
      'wss://127.0.0.1',
    ]) {
      const issues = validateSettings({ info: { relay_url, name: 'test' } } as any)

      expect(
        issues.filter((issue) => issue.path === 'info.relay_url'),
        `expected ${relay_url} to pass`,
      ).to.be.empty
    }
  })

  it('rejects a relay_url that is not a valid absolute URL', () => {
    const issues = validateSettings({ info: { relay_url: 'nostream.example.com', name: 'test' } } as any)

    expect(
      issues.some(
        (issue) => issue.path === 'info.relay_url' && issue.message === 'relay_url must be a valid absolute URL',
      ),
    ).to.equal(true)
  })

  it('rejects a scheme-only relay_url with no host', () => {
    const issues = validateSettings({ info: { relay_url: 'localhost:8008', name: 'test' } } as any)

    expect(
      issues.some(
        (issue) => issue.path === 'info.relay_url' && issue.message === 'relay_url must include a valid host',
      ),
    ).to.equal(true)
  })

  it('rejects a relay_url whose protocol is not ws/wss/http/https', () => {
    for (const relay_url of [
      'ftp://nostream.example.com',
      'gopher://nostream.example.com:70',
      'whttp://nostream.example.com',
    ]) {
      const issues = validateSettings({ info: { relay_url, name: 'test' } } as any)

      expect(
        issues.some(
          (issue) =>
            issue.path === 'info.relay_url' &&
            issue.message === 'relay_url must use ws, wss, http, or https protocol',
        ),
        `expected ${relay_url} to be rejected for protocol`,
      ).to.equal(true)
    }
  })

  describe('rate limit period validation', () => {
    const baseSettings = () =>
      ({
        info: { relay_url: 'wss://test.relay', name: 'test' },
        network: {},
      }) as any

    const nonPositivePeriodCases: { issuePath: string; limits: Record<string, unknown> }[] = [
      {
        issuePath: 'limits.event.rateLimits[0].period',
        limits: { event: { rateLimits: [{ period: 0, rate: 1 }] } },
      },
      {
        issuePath: 'limits.message.rateLimits[0].period',
        limits: { message: { rateLimits: [{ period: 0, rate: 1 }] } },
      },
      {
        issuePath: 'limits.connection.rateLimits[0].period',
        limits: { connection: { rateLimits: [{ period: -1, rate: 1 }] } },
      },
      {
        issuePath: 'limits.invoice.rateLimits[0].period',
        limits: { invoice: { rateLimits: [{ period: 0, rate: 1 }] } },
      },
      {
        issuePath: 'limits.admissionCheck.rateLimits[0].period',
        limits: { admissionCheck: { rateLimits: [{ period: 0, rate: 1 }] } },
      },
      {
        issuePath: 'limits.invite.rateLimits[0].period',
        limits: { invite: { rateLimits: [{ period: 0, rate: 1 }] } },
      },
      {
        issuePath: 'limits.admin.rateLimits[0].period',
        limits: { admin: { rateLimits: [{ period: 0, rate: 1 }] } },
      },
      {
        issuePath: 'limits.admin.loginRateLimits[0].period',
        limits: { admin: { loginRateLimits: [{ period: -1, rate: 1 }] } },
      },
    ]

    for (const { issuePath, limits } of nonPositivePeriodCases) {
      it(`rejects a non-positive period on ${issuePath.replace('[0].period', '')}`, () => {
        const settings = baseSettings()
        settings.limits = limits

        const issues = validateSettings(settings)
        expect(issues.some((issue) => issue.path === issuePath)).to.equal(true)
      })
    }

    it('accepts a positive period on limits.event.rateLimits', () => {
      const settings = baseSettings()
      settings.limits = { event: { rateLimits: [{ period: 60_000, rate: 10 }] } }

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path.startsWith('limits.event.rateLimits'))).to.equal(false)
    })

    it('rejects a null entry in limits.event.rateLimits without throwing', () => {
      const settings = baseSettings()
      settings.limits = { event: { rateLimits: [null] } }

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path === 'limits.event.rateLimits[0]')).to.equal(true)
    })
  })

  describe('nip77 settings', () => {
    const baseSettings = (nip77: any) =>
      ({
        info: { relay_url: 'wss://test.relay', name: 'test' },
        network: {},
        nip77,
      }) as any

    const nip77Issues = (nip77: any) =>
      validateSettings(baseSettings(nip77)).filter((issue) => issue.path.startsWith('nip77'))

    it('accepts the shipped defaults', () => {
      expect(
        nip77Issues({
          enabled: true,
          maxEventsPerSession: 100000,
          maxSessionsPerConnection: 3,
          sessionIdleTimeoutMs: 60000,
        }),
      ).to.deep.equal([])
    })

    it('accepts an enabled section that leaves the limits to their defaults', () => {
      expect(nip77Issues({ enabled: true })).to.deep.equal([])
    })

    for (const key of ['maxEventsPerSession', 'maxSessionsPerConnection', 'sessionIdleTimeoutMs']) {
      for (const bad of [0, -1, 1.5, '10', Number.NaN]) {
        it(`rejects ${key} = ${String(bad)}`, () => {
          const issues = nip77Issues({ enabled: true, [key]: bad })

          expect(issues.map((issue) => issue.path)).to.deep.equal([`nip77.${key}`])
        })
      }
    }

    it('does not validate the limits while the feature is off', () => {
      expect(nip77Issues({ enabled: false, maxEventsPerSession: 0 })).to.deep.equal([])
    })
  })

  describe('subscription plan settings', () => {
    const settingsWith = (subscriptionPlans: any) =>
      ({
        info: { relay_url: 'wss://test.relay', name: 'test' },
        network: {},
        payments: { enabled: true, processor: 'lnbits', subscriptionPlans },
      }) as any

    const planIssues = (subscriptionPlans: any) =>
      validateSettings(settingsWith(subscriptionPlans)).filter((issue) =>
        issue.path.startsWith('payments.subscriptionPlans'),
      )

    const basic = { id: 'basic', amount: 1000000, intervalSeconds: 2592000, graceSeconds: 259200 }
    const premium = { id: 'premium', amount: 5000000, intervalSeconds: 2592000, graceSeconds: 0 }

    it('accepts no plans, an empty list and valid plans', () => {
      expect(planIssues(undefined)).to.deep.equal([])
      expect(planIssues([])).to.deep.equal([])
      expect(planIssues([basic, premium])).to.deep.equal([])
    })

    it('accepts per-plan limits', () => {
      const plan = { ...basic, limits: { rateLimits: [{ period: 60000, rate: 120 }], retentionMaxDays: 90 } }

      expect(planIssues([plan])).to.deep.equal([])
    })

    it('reports a value that is not a list once, through the settings schema', () => {
      expect(planIssues({ basic }).map((issue) => issue.path)).to.deep.equal(['payments.subscriptionPlans'])
    })

    it('rejects a plan that is not an object', () => {
      expect(planIssues(['basic']).map((issue) => issue.path)).to.deep.equal(['payments.subscriptionPlans[0]'])
    })

    it('rejects a missing, empty, reserved or repeated id', () => {
      expect(planIssues([{ ...basic, id: undefined }]).map((issue) => issue.path)).to.deep.equal([
        'payments.subscriptionPlans[0].id',
      ])
      expect(planIssues([{ ...basic, id: '  ' }]).map((issue) => issue.path)).to.deep.equal([
        'payments.subscriptionPlans[0].id',
      ])
      expect(planIssues([{ ...basic, id: 'grandfathered' }]).map((issue) => issue.message)).to.deep.equal([
        'id "grandfathered" is reserved',
      ])
      expect(planIssues([basic, { ...premium, id: 'basic' }]).map((issue) => issue.path)).to.deep.equal([
        'payments.subscriptionPlans[1].id',
      ])
    })

    for (const bad of [0, -1, 1.5, '1000', undefined]) {
      it(`rejects amount = ${String(bad)}`, () => {
        expect(planIssues([{ ...basic, amount: bad }]).map((issue) => issue.path)).to.deep.equal([
          'payments.subscriptionPlans[0].amount',
        ])
      })

      it(`rejects intervalSeconds = ${String(bad)}`, () => {
        expect(planIssues([{ ...basic, intervalSeconds: bad }]).map((issue) => issue.path)).to.deep.equal([
          'payments.subscriptionPlans[0].intervalSeconds',
        ])
      })
    }

    it('rejects two plans with the same amount, since the amount selects the plan', () => {
      const issues = planIssues([basic, { ...premium, amount: basic.amount }])

      expect(issues.map((issue) => issue.path)).to.deep.equal(['payments.subscriptionPlans[1].amount'])
    })

    it('accepts a bigint amount', () => {
      expect(planIssues([{ ...basic, amount: 1000000n }])).to.deep.equal([])
    })

    it('allows a zero grace period but not a negative or fractional one', () => {
      expect(planIssues([{ ...basic, graceSeconds: 0 }])).to.deep.equal([])
      for (const bad of [-1, 0.5, '60', undefined]) {
        expect(planIssues([{ ...basic, graceSeconds: bad }]).map((issue) => issue.path)).to.deep.equal([
          'payments.subscriptionPlans[0].graceSeconds',
        ])
      }
    })

    it('rejects invalid per-plan limits', () => {
      expect(planIssues([{ ...basic, limits: 'fast' }]).map((issue) => issue.path)).to.deep.equal([
        'payments.subscriptionPlans[0].limits',
      ])
      expect(
        planIssues([{ ...basic, limits: { rateLimits: [{ period: 0, rate: 1 }] } }]).map((issue) => issue.path),
      ).to.deep.equal(['payments.subscriptionPlans[0].limits.rateLimits[0].period'])
      expect(planIssues([{ ...basic, limits: { rateLimits: 'fast' } }]).map((issue) => issue.path)).to.deep.equal([
        'payments.subscriptionPlans[0].limits.rateLimits',
      ])
      expect(
        planIssues([{ ...basic, limits: { rateLimits: [{ period: 60000, rate: 'fast' }] } }]).map(
          (issue) => issue.path,
        ),
      ).to.deep.equal(['payments.subscriptionPlans[0].limits.rateLimits[0].rate'])
      expect(
        planIssues([{ ...basic, limits: { rateLimits: [{ period: '60000', rate: 5 }] } }]).map((issue) => issue.path),
      ).to.deep.equal(['payments.subscriptionPlans[0].limits.rateLimits[0].period'])
      expect(
        planIssues([{ ...basic, limits: { rateLimits: [{ period: 60000 }] } }]).map((issue) => issue.path),
      ).to.deep.equal(['payments.subscriptionPlans[0].limits.rateLimits[0].rate'])
      expect(planIssues([{ ...basic, limits: { rateLimits: ['x'] } }]).map((issue) => issue.path)).to.deep.equal([
        'payments.subscriptionPlans[0].limits.rateLimits[0]',
      ])
      expect(planIssues([{ ...basic, limits: { retentionMaxDays: 0 } }]).map((issue) => issue.path)).to.deep.equal([
        'payments.subscriptionPlans[0].limits.retentionMaxDays',
      ])
    })

    it('reports a problem in each plan', () => {
      const issues = planIssues([
        { ...basic, intervalSeconds: 0 },
        { ...premium, graceSeconds: -1 },
      ])

      expect(issues.map((issue) => issue.path)).to.deep.equal([
        'payments.subscriptionPlans[0].intervalSeconds',
        'payments.subscriptionPlans[1].graceSeconds',
      ])
    })
  })

  describe('adaptive pow settings', () => {
    const baseSettings = () =>
      ({
        info: { relay_url: 'wss://test.relay', name: 'test' },
        network: {},
        limits: {
          event: {
            pow: { enabled: true, floorBits: 8, ceilingBits: 24, targetEventsPerSecond: 10, periodMs: 60000 },
          },
        },
      }) as any

    it('accepts a valid pow config', () => {
      const issues = validateSettings(baseSettings())
      expect(issues.some((issue) => issue.path.startsWith('limits.event.pow'))).to.equal(false)
    })

    it('rejects floorBits greater than ceilingBits', () => {
      const settings = baseSettings()
      settings.limits.event.pow.floorBits = 20
      settings.limits.event.pow.ceilingBits = 10

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.floorBits')).to.equal(true)
    })

    it('rejects a negative floorBits', () => {
      const settings = baseSettings()
      settings.limits.event.pow.floorBits = -1

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.floorBits')).to.equal(true)
    })

    it('rejects a ceilingBits above 256', () => {
      const settings = baseSettings()
      settings.limits.event.pow.ceilingBits = 300

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.ceilingBits')).to.equal(true)
    })

    it('accepts a ceilingBits of exactly 256', () => {
      const settings = baseSettings()
      settings.limits.event.pow.ceilingBits = 256
      settings.limits.event.pow.floorBits = 0

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.ceilingBits')).to.equal(false)
    })

    it('rejects a non-positive periodMs', () => {
      const settings = baseSettings()
      settings.limits.event.pow.periodMs = 0

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.periodMs')).to.equal(true)
    })

    it('rejects a non-positive targetEventsPerSecond', () => {
      const settings = baseSettings()
      settings.limits.event.pow.targetEventsPerSecond = 0

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.targetEventsPerSecond')).to.equal(true)
    })

    it('skips validation entirely when pow is disabled', () => {
      const settings = baseSettings()
      settings.limits.event.pow.enabled = false
      settings.limits.event.pow.floorBits = -1
      settings.limits.event.pow.periodMs = -1

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path.startsWith('limits.event.pow'))).to.equal(false)
    })

    it('accepts valid wotThresholds', () => {
      const settings = baseSettings()
      settings.limits.event.pow.wotThresholds = [
        { maxDistance: 1, difficultyFactor: 0 },
        { maxDistance: 2, difficultyFactor: 0.5 },
      ]

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path.startsWith('limits.event.pow.wotThresholds'))).to.equal(false)
    })

    it('rejects a negative wotThresholds maxDistance', () => {
      const settings = baseSettings()
      settings.limits.event.pow.wotThresholds = [{ maxDistance: -1, difficultyFactor: 0.5 }]

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.wotThresholds[0].maxDistance')).to.equal(true)
    })

    it('rejects a wotThresholds difficultyFactor outside [0, 1]', () => {
      const settings = baseSettings()
      settings.limits.event.pow.wotThresholds = [
        { maxDistance: 1, difficultyFactor: -0.1 },
        { maxDistance: 2, difficultyFactor: 1.1 },
      ]

      const issues = validateSettings(settings)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.wotThresholds[0].difficultyFactor')).to.equal(true)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.wotThresholds[1].difficultyFactor')).to.equal(true)
    })

    it('rejects null or non-object entries in wotThresholds without throwing', () => {
      const settings = baseSettings()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(settings.limits.event.pow as any).wotThresholds = [null, undefined, 42]

      let issues: ReturnType<typeof validateSettings>
      expect(() => {
        issues = validateSettings(settings)
      }).not.to.throw()
      expect(issues.some((issue) => issue.path === 'limits.event.pow.wotThresholds[0]')).to.equal(true)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.wotThresholds[1]')).to.equal(true)
      expect(issues.some((issue) => issue.path === 'limits.event.pow.wotThresholds[2]')).to.equal(true)
    })
  })

  describe('event store settings', () => {
    const baseSettings = (): any => ({
      info: { relay_url: 'wss://test.relay', name: 'test' },
      network: {},
    })

    it('ships postgres as the default backend', () => {
      expect(loadDefaults().eventStore?.backend).to.equal('postgres')
    })

    it('accepts settings without an eventStore section', () => {
      const issues = validateSettings(baseSettings())

      expect(issues.some((issue) => issue.path.startsWith('eventStore'))).to.equal(false)
    })

    it('accepts the postgres backend', () => {
      const issues = validateSettings({ ...baseSettings(), eventStore: { backend: 'postgres' } })

      expect(issues.some((issue) => issue.path.startsWith('eventStore'))).to.equal(false)
    })

    it('rejects an unsupported backend', () => {
      const issues = validateSettings({ ...baseSettings(), eventStore: { backend: 'mongodb' } })

      expect(issues).to.deep.include({ path: 'eventStore.backend', message: 'backend must be one of: postgres' })
    })
  })

  it('formats setting category labels', () => {
    expect(toCategoryLabel('payments_processors')).to.equal('Payments Processors')
    expect(toCategoryLabel('rate_limiter')).to.equal('Rate Limiter')
  })

  it('lists top-level categories from defaults', () => {
    const categories = getTopLevelSettingCategories()

    expect(categories).to.include('payments')
    expect(categories).to.include('network')
    expect(categories).to.include('info')
  })
})

describe('settings-guided-schema', () => {
  it('exports guided categories for admin and CLI use', () => {
    expect(guidedSettingCategories.length).to.be.greaterThan(0)
    expect(getGuidedSettingCategory('payments')?.settings.some((entry) => entry.path === 'payments.enabled')).to.equal(true)
    expect(getGuidedSettingField('limits', 'limits.rateLimiter.strategy')?.options).to.deep.equal(['ewma', 'sliding_window'])
  })

  it('validates guided numeric fields', () => {
    expect(requireSafeNonNegativeIntegerSettingValue('bad')).to.equal('Value must be a non-negative integer')
    expect(requireSafeNonNegativeIntegerSettingValue('2048')).to.equal(undefined)
    expect(requireNonEmptySettingValue(' ')).to.equal('Value is required')
  })

  it('validates guided positive integer fields', () => {
    expect(requireSafePositiveIntegerSettingValue('bad')).to.equal('Value must be a positive integer')
    expect(requireSafePositiveIntegerSettingValue('-1')).to.equal('Value must be a positive integer')
    expect(requireSafePositiveIntegerSettingValue('0')).to.equal('Value must be a positive integer')
    expect(requireSafePositiveIntegerSettingValue('9007199254740993')).to.equal('Value must be a safe integer')
    expect(requireSafePositiveIntegerSettingValue(' 60000 ')).to.equal(undefined)
  })

  it('exposes the nip77 settings with positive integer validation', () => {
    const category = 'nip-features'

    expect(getGuidedSettingField(category, 'nip77.enabled')?.type).to.equal('boolean')
    for (const key of ['maxEventsPerSession', 'maxSessionsPerConnection', 'sessionIdleTimeoutMs']) {
      const field = getGuidedSettingField(category, `nip77.${key}`)
      expect(field?.type, key).to.equal('number')
      expect(field?.validate?.('0'), key).to.equal('Value must be a positive integer')
      expect(field?.validate?.('3'), key).to.equal(undefined)
    }
  })

  it('does not create settings.yaml when ensuring config dir exists', () => {
    const originalConfigDir = process.env.NOSTR_CONFIG_DIR
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-settings-config-'))

    try {
      process.env.NOSTR_CONFIG_DIR = tmpDir
      ensureSettingsExists()
      expect(loadUserSettings()).to.deep.equal({})
      expect(fs.existsSync(path.join(tmpDir, 'settings.yaml'))).to.equal(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      if (originalConfigDir === undefined) {
        delete process.env.NOSTR_CONFIG_DIR
      } else {
        process.env.NOSTR_CONFIG_DIR = originalConfigDir
      }
    }
  })

  it('falls back to deprecated settings.json when settings.yaml is absent', () => {
    const originalConfigDir = process.env.NOSTR_CONFIG_DIR
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-settings-legacy-'))

    try {
      process.env.NOSTR_CONFIG_DIR = tmpDir
      fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ info: { name: 'legacy' } }))

      expect(loadUserSettings()).to.deep.equal({ info: { name: 'legacy' } })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      if (originalConfigDir === undefined) {
        delete process.env.NOSTR_CONFIG_DIR
      } else {
        process.env.NOSTR_CONFIG_DIR = originalConfigDir
      }
    }
  })

  it('prefers settings.yaml over deprecated settings.json', () => {
    const originalConfigDir = process.env.NOSTR_CONFIG_DIR
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-settings-precedence-'))

    try {
      process.env.NOSTR_CONFIG_DIR = tmpDir
      fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ info: { name: 'legacy' } }))
      fs.writeFileSync(path.join(tmpDir, 'settings.yaml'), 'info:\n  name: current\n')

      expect(loadUserSettings()).to.deep.equal({ info: { name: 'current' } })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      if (originalConfigDir === undefined) {
        delete process.env.NOSTR_CONFIG_DIR
      } else {
        process.env.NOSTR_CONFIG_DIR = originalConfigDir
      }
    }
  })
})
