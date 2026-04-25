const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const sinon = require('sinon')

const infoCommand = require('../../../dist/src/cli/commands/info.js')
const configUtils = require('../../../dist/src/cli/utils/config.js')
const processUtils = require('../../../dist/src/cli/utils/process.js')

describe('runInfo', () => {
  const keysFile = path.join(process.cwd(), '.nostr', 'i2p', 'data', 'nostream.dat')

  let stdout = ''
  let stderr = ''

  beforeEach(() => {
    sinon.stub(configUtils, 'loadMergedSettings').returns({})
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

  it('prints detected I2P hostnames as JSON', async () => {
    sinon.stub(fs, 'existsSync').callsFake((target) => String(target).endsWith('nostream.dat'))
    sinon
      .stub(processUtils, 'runCommandWithOutput')
      .onFirstCall()
      .resolves({ code: 1, stdout: '', stderr: '' })
      .onSecondCall()
      .resolves({
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
    sinon.stub(processUtils, 'runCommandWithOutput').resolves({ code: 1, stdout: '', stderr: '' })

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
      .resolves({ code: 1, stdout: '', stderr: '' })
      .onSecondCall()
      .resolves({ code: 0, stdout: '', stderr: '' })

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
      .resolves({ code: 1, stdout: '', stderr: '' })
      .onSecondCall()
      .resolves({ code: 0, stdout: '', stderr: '' })

    const code = await infoCommand.runInfo({ i2pHostname: true })

    expect(code).to.equal(0)
    expect(stdout).to.include(`I2P destination keys exist at: ${keysFile}`)
    expect(stdout).to.include('To find your nostream .b32.i2p address, use one of these methods:')
    expect(stderr).to.equal('')
  })
})
