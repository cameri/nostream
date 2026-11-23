import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import sinon from 'sinon'

import { runConfigEnvGet, runConfigEnvList } from '../../../src/cli/commands/config'
import { isSecretEnvKey } from '../../../src/cli/utils/env-config'

describe('secrets in the .env output of the CLI', () => {
  const originalCwd = process.cwd()
  const dbUri = 'postgresql://relay:hunter2-db-password@db.internal:5432/nostr'
  const redisUri = 'redis://default:hunter2-redis-password@cache.internal:6379'

  let tempDir: string
  let stdout: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-env-'))
    process.chdir(tempDir)
    const lines = [`DB_URI=${dbUri}`, `REDIS_URI=${redisUri}`, 'DB_HOST=db.internal', 'DB_PASSWORD=hunter2-password']
    fs.writeFileSync(path.join(tempDir, '.env'), `${lines.join('\n')}\n`)
    stdout = ''
    sinon.stub(process.stdout, 'write').callsFake(((chunk: string | Uint8Array) => {
      stdout += String(chunk)
      return true
    }) as typeof process.stdout.write)
  })

  afterEach(() => {
    sinon.restore()
    process.chdir(originalCwd)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('treats a connection URI as a secret, like a password', () => {
    expect(isSecretEnvKey('DB_URI')).to.equal(true)
    expect(isSecretEnvKey('REDIS_URI')).to.equal(true)
    expect(isSecretEnvKey('DB_PASSWORD')).to.equal(true)
    expect(isSecretEnvKey('DB_HOST')).to.equal(false)
  })

  it('does not list the password inside a connection URI by default', async () => {
    await runConfigEnvList()

    expect(stdout).to.not.include('hunter2')
    expect(stdout).to.include('DB_HOST=db.internal')
  })

  it('does not print the password inside a connection URI with get by default', async () => {
    await runConfigEnvGet('DB_URI')
    await runConfigEnvGet('REDIS_URI')

    expect(stdout).to.not.include('hunter2')
  })

  it('shows the whole URI when the operator asks for secrets', async () => {
    await runConfigEnvGet('DB_URI', { showSecrets: true })
    await runConfigEnvList({ showSecrets: true })

    expect(stdout).to.include(dbUri)
    expect(stdout).to.include(redisUri)
  })
})
