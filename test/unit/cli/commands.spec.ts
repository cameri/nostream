import { expect } from 'chai'

import { isSupportedEnvKey, validateEnvPair } from '../../../src/cli/utils/env-config'

describe('cli env config helpers', () => {
  it('accepts supported env keys', () => {
    expect(isSupportedEnvKey('RELAY_PORT')).to.equal(true)
    expect(isSupportedEnvKey('RR0_DB_HOST')).to.equal(true)
    expect(isSupportedEnvKey('UNKNOWN_KEY')).to.equal(false)
  })

  it('validates numeric and boolean env values', () => {
    expect(validateEnvPair('RELAY_PORT', '8008')).to.equal(undefined)
    expect(validateEnvPair('RELAY_PORT', 'bad')).to.include('must be an integer')
    expect(validateEnvPair('READ_REPLICA_ENABLED', 'true')).to.equal(undefined)
    expect(validateEnvPair('READ_REPLICA_ENABLED', 'yes')).to.include('must be true or false')
  })

  it('refuses a SECRET that would read back differently from .env', () => {
    expect(validateEnvPair('SECRET', 'pre$TOKEN')).to.include('"$"')
    expect(validateEnvPair('SECRET', '${TOKEN}')).to.include('"$"')
    expect(validateEnvPair('SECRET', 'abc#def')).to.include('"#"')
    expect(validateEnvPair('SECRET', 'abc\ndef')).to.include('newlines')
    expect(validateEnvPair('SECRET', '"abc')).to.include('unmatched quote')
    expect(validateEnvPair('SECRET', "a=b it's fine")).to.equal(undefined)
  })
})
