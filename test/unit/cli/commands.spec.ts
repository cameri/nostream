import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import sinon from 'sinon'
import { parseEnv } from 'util'

import { runConfigEnvSet } from '../../../src/cli/commands/config'
import { isSupportedEnvKey, validateEnvPair, validateEnvValues } from '../../../src/cli/utils/env-config'
import * as output from '../../../src/cli/utils/output'

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

  it('leaves a saved SECRET with a trailing comment valid, as .env.example has', () => {
    expect(validateEnvPair('SECRET', 'change_me # Generate: openssl rand -hex 128')).to.equal(undefined)
    expect(validateEnvValues({ SECRET: 'change_me # Generate: openssl rand -hex 128' })).to.deep.equal([])
  })

  describe('runConfigEnvSet for SECRET', () => {
    const originalCwd = process.cwd()
    let tempDir: string

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-env-set-'))
      process.chdir(tempDir)
    })

    afterEach(() => {
      sinon.restore()
      process.chdir(originalCwd)
      fs.rmSync(tempDir, { recursive: true, force: true })
    })

    const readSaved = () => parseEnv(fs.readFileSync(path.join(tempDir, '.env'), 'utf-8')).SECRET

    for (const [value, reason] of [
      ['pre$TOKEN', '"$"'],
      ['${TOKEN}', '"$"'],
      ['abc#def', '"#"'],
      ['abc\ndef', 'newlines'],
      ['"abc', 'unmatched quote'],
      ['"abc"tail"', 'the quote it is wrapped in'],
      ["'it's'", 'the quote it is wrapped in'],
    ]) {
      it(`refuses ${JSON.stringify(value)} and writes nothing`, async () => {
        const error = sinon.stub(output, 'logError')

        expect(await runConfigEnvSet('SECRET', value)).to.equal(1)

        expect(error.firstCall.args[0]).to.include(reason)
        expect(fs.existsSync(path.join(tempDir, '.env'))).to.equal(false)
      })
    }

    for (const value of ['a=b', "it's-fine", 'with spaces', '"quoted value"', "'quoted'", 'ends-with-==']) {
      it(`saves ${JSON.stringify(value)} so that Node reads it back as given`, async () => {
        sinon.stub(output, 'logInfo')

        expect(await runConfigEnvSet('SECRET', value)).to.equal(0)

        expect(readSaved()).to.equal(value.replace(/^(["'])(.*)\1$/, '$2'))
      })
    }
  })
})
