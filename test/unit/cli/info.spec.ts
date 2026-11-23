import { expect } from 'chai'
import fs from 'fs'
import path from 'path'
import sinon from 'sinon'

const infoCommand = require('../../../dist/src/cli/commands/info.js')
const settingsConfig = require('../../../dist/src/utils/settings-config.js')
const processUtils = require('../../../dist/src/cli/utils/process.js')

describe('runInfo', () => {
  const keysFile = path.join(process.cwd(), '.nostr', 'i2p', 'data', 'nostream.dat')

  let stdout = ''
  let stderr = ''
  let settings: sinon.SinonStub

  beforeEach(() => {
    settings = sinon.stub(settingsConfig, 'loadMergedSettings').returns({})
    sinon.stub(process.stdout, 'write').callsFake(((chunk: string | Uint8Array) => {
      stdout += String(chunk)
      return true
    }) as any)
    sinon.stub(process.stderr, 'write').callsFake(((chunk: string | Uint8Array) => {
      stderr += String(chunk)
      return true
    }) as any)
  })

  afterEach(() => {
    stdout = ''
    stderr = ''
    sinon.restore()
  })

  it('outputs valid JSON when docker is not installed (ENOENT)', async () => {
    sinon.stub(fs, 'existsSync').returns(false)
    sinon
      .stub(processUtils, 'runCommandWithOutput')
      .resolves({ ok: false, reason: 'not-found', stdout: '', stderr: '' })

    const code = await infoCommand.runInfo({ json: true })

    expect(code).to.equal(0)
    const parsed = JSON.parse(stdout)
    expect(parsed).to.have.nested.property('runtime.uptimeSeconds', null)
    expect(stderr).to.equal('')
  })

  it('prints detected I2P hostnames as JSON', async () => {
    sinon.stub(fs, 'existsSync').callsFake((target) => String(target).endsWith('nostream.dat'))
    sinon
      .stub(processUtils, 'runCommandWithOutput')
      .onFirstCall()
      .resolves({ ok: true, code: 1, stdout: '', stderr: '' })
      .onSecondCall()
      .resolves({
        ok: true,
        code: 0,
        stdout: 'alphaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.b32.i2p\n',
        stderr: 'betabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.b32.i2p\n',
      })

    const code = await infoCommand.runInfo({ i2pHostname: true, json: true })

    expect(code).to.equal(0)
    expect(JSON.parse(stdout)).to.deep.equal({
      i2pHostnames: [
        'alphaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.b32.i2p',
        'betabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.b32.i2p',
      ],
    })
    expect(stderr).to.equal('')
  })

  it('prints a JSON error when I2P keys are missing', async () => {
    sinon.stub(fs, 'existsSync').returns(false)
    sinon.stub(processUtils, 'runCommandWithOutput').resolves({ ok: true, code: 1, stdout: '', stderr: '' })

    const code = await infoCommand.runInfo({ i2pHostname: true, json: true })

    expect(code).to.equal(1)
    expect(JSON.parse(stderr)).to.deep.equal({
      error: {
        message: `I2P destination keys not found. Is the i2pd container running? Expected: ${keysFile}`,
        code: 1,
      },
    })
    expect(stdout).to.equal('')
  })

  it('prints JSON guidance when no I2P hostname can be extracted', async () => {
    sinon.stub(fs, 'existsSync').callsFake((target) => String(target).endsWith('nostream.dat'))
    sinon
      .stub(processUtils, 'runCommandWithOutput')
      .onFirstCall()
      .resolves({ ok: true, code: 1, stdout: '', stderr: '' })
      .onSecondCall()
      .resolves({ ok: true, code: 0, stdout: '', stderr: '' })

    const code = await infoCommand.runInfo({ i2pHostname: true, json: true })

    expect(code).to.equal(0)
    expect(JSON.parse(stdout)).to.deep.equal({
      i2pHostnames: [],
      keysFile,
      guidance: {
        webConsoleUrl: 'http://127.0.0.1:7070/?page=i2p_tunnels',
        consoleQueryCommand:
          "docker exec i2pd wget -qO- 'http://127.0.0.1:7070/?page=i2p_tunnels' | grep -oE '[a-z2-7]{52}\\\\.b32\\\\.i2p' | sort -u",
      },
    })
    expect(stderr).to.equal('')
  })

  it('keeps non-json I2P hostname output human-readable', async () => {
    sinon.stub(fs, 'existsSync').callsFake((target) => String(target).endsWith('nostream.dat'))
    sinon
      .stub(processUtils, 'runCommandWithOutput')
      .onFirstCall()
      .resolves({ ok: true, code: 1, stdout: '', stderr: '' })
      .onSecondCall()
      .resolves({ ok: true, code: 0, stdout: '', stderr: '' })

    const code = await infoCommand.runInfo({ i2pHostname: true })

    expect(code).to.equal(0)
    expect(stdout).to.include(`I2P destination keys exist at: ${keysFile}`)
    expect(stdout).to.include('To find your nostream .b32.i2p address, use one of these methods:')
    expect(stderr).to.equal('')
  })

  describe('relay metadata that someone else can set', () => {
    const hostileName = 'Nice relay\nPayments: disabled\r\u001b]52;c;ZXZpbA==\u0007\u009b31m'

    beforeEach(() => {
      settings.returns({
        info: { name: hostileName, relay_url: 'wss://relay.example/\u001b[2J' },
      })
      sinon.stub(fs, 'existsSync').returns(false)
      sinon
        .stub(processUtils, 'runCommandWithOutput')
        .resolves({ ok: false, reason: 'not-found', stdout: '', stderr: '' })
    })

    it('shows control characters in the relay name and url as visible escapes', async () => {
      const code = await infoCommand.runInfo({})

      expect(code).to.equal(0)
      expect(stdout).to.include(
        'Relay: Nice relay\\x0aPayments: disabled\\x0d\\x1b]52;c;ZXZpbA==\\x07\\x9b31m (wss://relay.example/\\x1b[2J)',
      )
    })

    it('cannot add lines or send escape sequences to the terminal', async () => {
      await infoCommand.runInfo({})

      expect(stdout).to.not.match(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
      expect(stdout.split('\n').filter((line) => line.startsWith('Payments:'))).to.have.length(1)
      expect(stdout.split('\n').filter((line) => line.startsWith('Relay:'))).to.have.length(1)
    })

    it('leaves ordinary names, including non-ASCII ones, as they are', async () => {
      settings.returns({ info: { name: 'Café relay 🚀', relay_url: 'wss://relay.example' } })

      await infoCommand.runInfo({})

      expect(stdout).to.include('Relay: Café relay 🚀 (wss://relay.example)')
    })

    it('keeps the JSON output exact', async () => {
      await infoCommand.runInfo({ json: true })

      expect(JSON.parse(stdout).relay.name).to.equal(hostileName)
    })
  })
})
