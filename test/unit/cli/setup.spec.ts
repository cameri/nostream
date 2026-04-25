import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'

const setupCommand = await import('../../../dist/src/cli/commands/setup.js')

describe('runSetup', () => {
  const originalCwd = process.cwd()
  const originalSecret = process.env.SECRET

  let tempDir: string

  const writeDefaultSettings = () => {
    fs.mkdirSync(path.join(tempDir, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'resources', 'default-settings.yaml'), 'payments:\n  enabled: false\n', 'utf-8')
  }

  const readEnv = () => {
    return fs.readFileSync(path.join(tempDir, '.env'), 'utf-8')
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-setup-'))
    process.chdir(tempDir)
    writeDefaultSettings()
    delete process.env.SECRET
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (originalSecret === undefined) {
      delete process.env.SECRET
    } else {
      process.env.SECRET = originalSecret
    }

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('copies .env.example and replaces the placeholder secret', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.env.example'),
      'SECRET=change_me_to_something_long_and_random # Generate: openssl rand -hex 128\nFOO=bar\n',
      'utf-8',
    )
    process.env.SECRET = 'replacement-secret'

    const code = await setupCommand.runSetup({ yes: true })

    expect(code).to.equal(0)
    const envContents = readEnv()
    expect(envContents).to.include('SECRET=replacement-secret # Generate: openssl rand -hex 128')
    expect(envContents).to.include('FOO=bar')
    expect(envContents.match(/^SECRET=/gm)).to.have.length(1)
  })

  it('preserves an existing non-placeholder secret', async () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET=real-secret\nFOO=bar\n', 'utf-8')

    const code = await setupCommand.runSetup({ yes: true })

    expect(code).to.equal(0)
    expect(readEnv()).to.equal('SECRET=real-secret\nFOO=bar\n')
  })

  it('fills an empty secret from process.env.SECRET', async () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET=   # existing comment\nFOO=bar\n', 'utf-8')
    process.env.SECRET = 'env-secret'

    const code = await setupCommand.runSetup({ yes: true })

    expect(code).to.equal(0)
    const envContents = readEnv()
    expect(envContents).to.include('SECRET=env-secret # existing comment')
    expect(envContents.match(/^SECRET=/gm)).to.have.length(1)
  })

  it('generates a secure fallback secret in non-interactive mode', async () => {
    fs.writeFileSync(path.join(tempDir, '.env.example'), 'SECRET=change_me_to_something_long_and_random\n', 'utf-8')

    const code = await setupCommand.runSetup({ yes: true })

    expect(code).to.equal(0)
    const generatedSecret = readEnv().match(/^SECRET=([a-f0-9]+)$/m)?.[1]
    expect(generatedSecret).to.not.equal(undefined)
    expect(generatedSecret).to.not.equal('change_me_to_something_long_and_random')
    expect(generatedSecret).to.have.length(128)
  })
})
