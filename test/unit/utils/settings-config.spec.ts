import { expect } from 'chai'

import {
  toCategoryLabel,
  getByPath,
  getTopLevelSettingCategories,
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
})
