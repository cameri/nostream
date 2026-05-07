import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import sinon from 'sinon'

const setupCommand: typeof import('../../../dist/src/cli/commands/setup.js') = require('../../../dist/src/cli/commands/setup.js')

describe('runSetup', () => {
  const originalCwd = process.cwd()
  const originalSecret = process.env.SECRET
  const originalStdinIsTTY = process.stdin.isTTY

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
    sinon.restore()
    process.chdir(originalCwd)
    process.stdin.isTTY = originalStdinIsTTY
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

  it('returns 1 when setup is cancelled while entering the secret and does not continue', async () => {
    const cancelToken = Symbol('cancel')

    process.stdin.isTTY = true
    fs.writeFileSync(path.join(tempDir, '.env.example'), 'SECRET=change_me_to_something_long_and_random\n', 'utf-8')

    const textStub = sinon.stub(setupCommand.setupPrompts, 'text').resolves(cancelToken as any)
    const isCancelStub = sinon.stub(setupCommand.setupPrompts, 'isCancel').callsFake((value) => value === cancelToken)
    const cancelStub = sinon.stub(setupCommand.setupPrompts, 'cancel')
    const confirmStub = sinon.stub(setupCommand.setupPrompts, 'confirm')
    const outroStub = sinon.stub(setupCommand.setupPrompts, 'outro')

    const code = await setupCommand.runSetup({ yes: false })

    expect(code).to.equal(1)
    expect(textStub.calledOnce).to.equal(true)
    expect(isCancelStub.calledOnceWithExactly(cancelToken)).to.equal(true)
    expect(cancelStub.calledOnceWithExactly('Setup cancelled')).to.equal(true)
    expect(confirmStub.notCalled).to.equal(true)
    expect(outroStub.notCalled).to.equal(true)
    expect(readEnv()).to.equal('SECRET=change_me_to_something_long_and_random\n')
  })
})
