import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { upsertEnvValue, writeEnvFile } from '../../../src/cli/utils/env-config'

describe('the permissions of the .env file written by the CLI', function () {
  // File modes mean nothing on Windows.
  before(function () {
    if (process.platform === 'win32') {
      this.skip()
    }
  })

  const originalCwd = process.cwd()
  let tempDir: string
  let originalUmask: number

  const envPath = () => path.join(tempDir, '.env')
  const modeOf = (file: string) => fs.statSync(file).mode & 0o777

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-env-'))
    process.chdir(tempDir)
    // The usual umask, under which a file created with the default mode is readable by every local account.
    originalUmask = process.umask(0o022)
  })

  afterEach(() => {
    process.umask(originalUmask)
    process.chdir(originalCwd)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('writeEnvFile', () => {
    it('creates a new file readable by its owner only', () => {
      writeEnvFile(envPath(), 'SECRET=abc\n')

      expect(modeOf(envPath())).to.equal(0o600)
      expect(fs.readFileSync(envPath(), 'utf-8')).to.equal('SECRET=abc\n')
    })

    it('restricts a file that exists already and replaces its content', () => {
      fs.writeFileSync(envPath(), 'OLD=1\n')
      fs.chmodSync(envPath(), 0o644)

      writeEnvFile(envPath(), 'SECRET=abc\n')

      expect(modeOf(envPath())).to.equal(0o600)
      expect(fs.readFileSync(envPath(), 'utf-8')).to.equal('SECRET=abc\n')
    })

    it('restricts an existing file before the new content is written into it', () => {
      fs.writeFileSync(envPath(), 'OLD=1\n')
      fs.chmodSync(envPath(), 0o644)

      // What another account could read at the moment the new content arrives.
      let modeWhenWritten: number | undefined
      const write = fs.writeFileSync
      ;(fs as any).writeFileSync = (...args: Parameters<typeof fs.writeFileSync>) => {
        modeWhenWritten = modeOf(envPath())
        return write(...args)
      }

      try {
        writeEnvFile(envPath(), 'SECRET=abc\n')
      } finally {
        ;(fs as any).writeFileSync = write
      }

      expect(modeWhenWritten).to.equal(0o600)
      expect(fs.readFileSync(envPath(), 'utf-8')).to.equal('SECRET=abc\n')
    })

    it('does not fail when the permissions cannot be changed', () => {
      const chmod = fs.chmodSync
      ;(fs as any).chmodSync = () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }

      try {
        expect(() => writeEnvFile(envPath(), 'SECRET=abc\n')).not.to.throw()
      } finally {
        ;(fs as any).chmodSync = chmod
      }

      expect(fs.readFileSync(envPath(), 'utf-8')).to.equal('SECRET=abc\n')
    })
  })

  describe('upsertEnvValue (nostream config env set)', () => {
    it('creates .env readable by its owner only when it did not exist', () => {
      upsertEnvValue('SECRET', 'abc')

      expect(modeOf(envPath())).to.equal(0o600)
      expect(fs.readFileSync(envPath(), 'utf-8')).to.equal('SECRET=abc\n')
    })

    it('restricts an existing .env and keeps its other values', () => {
      fs.writeFileSync(envPath(), 'FOO=bar\n')
      fs.chmodSync(envPath(), 0o644)

      upsertEnvValue('SECRET', 'abc')

      expect(modeOf(envPath())).to.equal(0o600)
      expect(fs.readFileSync(envPath(), 'utf-8')).to.equal('FOO=bar\n\nSECRET=abc\n')
    })
  })
})
