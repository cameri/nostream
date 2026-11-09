import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import sinon from 'sinon'
import { parseEnv } from 'util'

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

  it('rejects an inherited placeholder secret from process.env.SECRET and generates a fresh secret', async () => {
    fs.writeFileSync(path.join(tempDir, '.env.example'), 'SECRET=change_me_to_something_long_and_random\n', 'utf-8')
    process.env.SECRET = 'change_me_to_something_long_and_random'

    const code = await setupCommand.runSetup({ yes: true })

    expect(code).to.equal(0)
    const generatedSecret = readEnv().match(/^SECRET=([a-f0-9]+)$/m)?.[1]
    expect(generatedSecret).to.not.equal(undefined)
    expect(generatedSecret).to.not.equal('change_me_to_something_long_and_random')
    expect(generatedSecret).to.have.length(128)
    expect(process.env.SECRET).to.equal(generatedSecret)
  })

  it('validates secret input in interactive mode and rejects empty or placeholder values', async () => {
    process.stdin.isTTY = true
    fs.writeFileSync(path.join(tempDir, '.env.example'), 'SECRET=change_me_to_something_long_and_random\n', 'utf-8')

    let validateFn: ((input: string) => string | undefined) | undefined
    sinon.stub(setupCommand.setupPrompts, 'text').callsFake((opts: any) => {
      validateFn = opts.validate
      return Promise.resolve('my-strong-interactive-secret')
    })
    sinon.stub(setupCommand.setupPrompts, 'confirm').resolves(false as any)

    const code = await setupCommand.runSetup({ yes: false })

    expect(code).to.equal(0)
    expect(validateFn).to.be.a('function')
    expect(validateFn!('')).to.equal('SECRET is required')
    expect(validateFn!('   ')).to.equal('SECRET is required')
    expect(validateFn!('change_me_to_something_long_and_random')).to.equal('SECRET cannot be the default placeholder')
    expect(validateFn!('  change_me_to_something_long_and_random  ')).to.equal(
      'SECRET cannot be the default placeholder',
    )
    expect(validateFn!('my-strong-interactive-secret')).to.equal(undefined)
    expect(validateFn!('secret#comment')).to.equal('SECRET cannot contain "#"')
    expect(validateFn!('secret\nnewline')).to.equal('SECRET cannot contain newlines')

    expect(readEnv()).to.include('SECRET=my-strong-interactive-secret')
    expect(process.env.SECRET).to.equal('my-strong-interactive-secret')
  })

  describe('a secret that cannot be saved to .env and read back unchanged', () => {
    const placeholderEnv = 'SECRET=change_me_to_something_long_and_random\nFOO=bar\n'

    beforeEach(() => {
      fs.writeFileSync(path.join(tempDir, '.env'), placeholderEnv, 'utf-8')
    })

    const unsafe: Array<[string, string, string]> = [
      ['contains "#"', 'my-secret#suffix', 'SECRET cannot contain "#"'],
      ['contains a newline', 'first\nsecond', 'SECRET cannot contain newlines'],
      ['starts with an unmatched double quote', '"unterminated', 'SECRET cannot start with an unmatched quote'],
      ['starts with an unmatched single quote', "'unterminated", 'SECRET cannot start with an unmatched quote'],
    ]

    for (const [label, secret, reason] of unsafe) {
      it(`rejects an inherited SECRET that ${label}, and leaves .env alone`, async () => {
        process.env.SECRET = secret

        let error: Error | undefined
        try {
          await setupCommand.runSetup({ yes: true })
        } catch (caught) {
          error = caught as Error
        }

        expect(error?.message).to.contain(reason)
        expect(error?.message).to.contain('unset it')
        expect(readEnv()).to.equal(placeholderEnv)
      })
    }

    it('rejects a secret the prompt hands back with a "#", even though the prompt validator should have refused it', async () => {
      process.stdin.isTTY = true
      sinon.stub(setupCommand.setupPrompts, 'text').resolves('typed#secret')
      sinon.stub(setupCommand.setupPrompts, 'confirm').resolves(false as any)

      let error: Error | undefined
      try {
        await setupCommand.runSetup({ yes: false })
      } catch (caught) {
        error = caught as Error
      }

      expect(error?.message).to.equal('SECRET cannot contain "#"')
      expect(readEnv()).to.equal(placeholderEnv)
    })

    it('saves a quoted secret typed at the prompt without its quotes, so every start has the same value', async () => {
      process.stdin.isTTY = true
      sinon.stub(setupCommand.setupPrompts, 'text').resolves('"quoted-secret"')
      sinon.stub(setupCommand.setupPrompts, 'confirm').resolves(false as any)

      const code = await setupCommand.runSetup({ yes: false })

      expect(code).to.equal(0)
      expect(process.env.SECRET).to.equal('quoted-secret')
      expect(readEnv()).to.include('SECRET=quoted-secret\n')
      expect(parseEnv(readEnv()).SECRET).to.equal('quoted-secret')

      delete process.env.SECRET
      expect(await setupCommand.runSetup({ yes: true })).to.equal(0)
      expect(process.env.SECRET).to.equal('quoted-secret')
    })

    it('saves a single-quoted secret typed at the prompt without its quotes too', async () => {
      process.stdin.isTTY = true
      sinon.stub(setupCommand.setupPrompts, 'text').resolves("'quoted-secret'")
      sinon.stub(setupCommand.setupPrompts, 'confirm').resolves(false as any)

      await setupCommand.runSetup({ yes: false })

      expect(process.env.SECRET).to.equal('quoted-secret')
      expect(parseEnv(readEnv()).SECRET).to.equal('quoted-secret')
    })

    it('refuses the same values in the interactive prompt', async () => {
      process.stdin.isTTY = true
      let validateFn: ((input: string) => string | undefined) | undefined
      sinon.stub(setupCommand.setupPrompts, 'text').callsFake((opts: any) => {
        validateFn = opts.validate
        return Promise.resolve('my-strong-interactive-secret')
      })
      sinon.stub(setupCommand.setupPrompts, 'confirm').resolves(false as any)

      await setupCommand.runSetup({ yes: false })

      expect(validateFn!('"unterminated')).to.equal('SECRET cannot start with an unmatched quote')
      expect(validateFn!("'unterminated")).to.equal('SECRET cannot start with an unmatched quote')
      expect(validateFn!('"quoted-secret"')).to.equal(undefined)
    })
  })

  describe('a secret that is accepted', () => {
    const safe = [
      'plain-hex-0123456789abcdef',
      'a=b',
      'pa$$word!',
      "it's-fine",
      'with space inside',
      'trailing-equals==',
      '"quoted-secret"',
    ]

    for (const secret of safe) {
      it(`reads back from .env as the same value: ${secret}`, async () => {
        fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET=change_me_to_something_long_and_random\n', 'utf-8')
        process.env.SECRET = secret

        const code = await setupCommand.runSetup({ yes: true })

        // what the CLI hands the relay, and what a later start reads from .env with Node's own loader
        const expected = secret.replace(/^"(.*)"$/, '$1')
        expect(code).to.equal(0)
        expect(process.env.SECRET).to.equal(expected)
        expect(parseEnv(readEnv()).SECRET).to.equal(expected)

        // and what a later run of setup reads back through its own parser, with nothing inherited
        delete process.env.SECRET
        expect(await setupCommand.runSetup({ yes: true })).to.equal(0)
        expect(process.env.SECRET).to.equal(expected)
      })
    }
  })

  it('replaces placeholder with generated secret if interactive input somehow resolves to placeholder', async () => {
    process.stdin.isTTY = true
    fs.writeFileSync(path.join(tempDir, '.env.example'), 'SECRET=change_me_to_something_long_and_random\n', 'utf-8')

    sinon.stub(setupCommand.setupPrompts, 'text').resolves('change_me_to_something_long_and_random')
    sinon.stub(setupCommand.setupPrompts, 'confirm').resolves(false as any)

    const code = await setupCommand.runSetup({ yes: false })

    expect(code).to.equal(0)
    const generatedSecret = readEnv().match(/^SECRET=([a-f0-9]+)$/m)?.[1]
    expect(generatedSecret).to.not.equal(undefined)
    expect(generatedSecret).to.not.equal('change_me_to_something_long_and_random')
    expect(generatedSecret).to.have.length(128)
    expect(process.env.SECRET).to.equal(generatedSecret)
  })

  it('replaces a quoted placeholder secret in .env', async () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET="change_me_to_something_long_and_random"\nFOO=bar\n', 'utf-8')

    const code = await setupCommand.runSetup({ yes: true })

    expect(code).to.equal(0)
    const generatedSecret = readEnv().match(/^SECRET=([a-f0-9]+)$/m)?.[1]
    expect(generatedSecret).to.not.equal(undefined)
    expect(generatedSecret).to.not.equal('change_me_to_something_long_and_random')
    expect(generatedSecret).to.have.length(128)
    expect(process.env.SECRET).to.equal(generatedSecret)
  })

  it('syncs process.env.SECRET from an existing valid .env secret when process.env.SECRET held a placeholder', async () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET="persisted-real-secret"\n', 'utf-8')
    process.env.SECRET = 'change_me_to_something_long_and_random'

    const code = await setupCommand.runSetup({ yes: true })

    expect(code).to.equal(0)
    expect(process.env.SECRET).to.equal('persisted-real-secret')
  })

  it('preserves full quoted secret containing # from .env and does not truncate at #', async () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET="abc#def" # trailing comment\n', 'utf-8')

    const code = await setupCommand.runSetup({ yes: true })

    expect(code).to.equal(0)
    expect(process.env.SECRET).to.equal('abc#def')
    expect(readEnv()).to.equal('SECRET="abc#def" # trailing comment\n')
  })

  it('preserves explicitly supplied valid process.env.SECRET when .env contains a different valid secret', async () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET="file-secret"\n', 'utf-8')
    process.env.SECRET = 'operator-supplied-secret'

    const code = await setupCommand.runSetup({ yes: true })

    expect(code).to.equal(0)
    expect(process.env.SECRET).to.equal('operator-supplied-secret')
    expect(readEnv()).to.equal('SECRET="file-secret"\n')
  })

  it('correctly handles escaped quotes inside double-quoted secrets', async () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET="sec\\"ret#with#hashes" # comment\n', 'utf-8')

    const code = await setupCommand.runSetup({ yes: true })

    expect(code).to.equal(0)
    expect(process.env.SECRET).to.equal('sec"ret#with#hashes')
    expect(readEnv()).to.equal('SECRET="sec\\"ret#with#hashes" # comment\n')
  })
})
