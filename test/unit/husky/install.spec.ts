import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

const projectRoot = process.cwd()
const installScriptPath = path.join(projectRoot, '.husky', 'install.mjs')

const runInstall = (cwd: string, env: NodeJS.ProcessEnv = {}) => {
  return spawnSync('node', [installScriptPath], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    encoding: 'utf-8',
    timeout: 10_000,
  })
}

describe('husky install script', () => {
  it('exits successfully when .git is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-husky-no-git-'))

    try {
      const result = runInstall(tmpDir)
      expect(result.status).to.equal(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('exits successfully when HUSKY is disabled', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-husky-disabled-'))

    try {
      const result = runInstall(tmpDir, { HUSKY: '0' })
      expect(result.status).to.equal(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('exits successfully when husky package is unavailable even if .git exists', function () {
    this.timeout(15_000)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-husky-missing-package-'))

    try {
      fs.mkdirSync(path.join(tmpDir, '.git'))
      const result = runInstall(tmpDir)
      expect(result.status).to.equal(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
