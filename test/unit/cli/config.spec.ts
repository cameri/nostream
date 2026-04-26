import { expect } from 'chai'

import {
  getByPath,
  parseTypedValue,
  parseValue,
  setByPath,
  validatePathAgainstDefaults,
  validateSettings,
} from '../../../src/cli/utils/config'

describe('cli config utils', () => {
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
})
