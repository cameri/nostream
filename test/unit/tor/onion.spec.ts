import { addOnion, closeTorClient, createTorConfig, getTorClient, TorClient } from '../../../src/tor/client'

import { expect } from 'chai'
import fs from 'fs/promises'
import { hostname } from 'os'
import Sinon from 'sinon'

describe('onion', () => {
  TorClient.prototype.connect = async function () {
    const h = (this as any).host as string
    const p = (this as any).port as number
    const pw = (this as any).password as string
    if (h == hostname() && p == 9051 && pw === 'nostr_ts_relay') {
      return
    } else {
      throw new Error('Connection refused')
    }
  }
  TorClient.prototype.quit = async function () {
    return
  }
  TorClient.prototype.addOnion = async function (port: number, host?: string, privateKey?: string | null) {
    void privateKey
    if (host) {
      const validHost = /[a-zA-Z]+(:[0-9]+)?/.test(host)
      if (validHost) {
        return { ServiceID: 'pubKey', PrivateKey: 'privKey' }
      } else {
        return { ServiceID: undefined, PrivateKey: undefined }
      }
    } else {
      return { ServiceID: 'pubKey', PrivateKey: 'privKey' }
    }
  }
  let sandbox: Sinon.SinonSandbox
  const mock = function (sandbox: Sinon.SinonSandbox, readFail?: boolean, writeFail?: boolean) {
    sandbox.stub(fs, 'readFile').callsFake(async (path, options) => {
      void path
      void options
      if (readFail) {
        throw new Error()
      }
      return 'privKey'
    })
    sandbox.stub(fs, 'writeFile').callsFake(async (path, options) => {
      void path
      void options
      if (writeFail) {
        throw new Error()
      }
      return
    })
  }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
  })
  afterEach(() => {
    sandbox.restore()
  })

  it('config empty', () => {
    const config = createTorConfig()
    expect(config).to.include({ port: 9051 })
  })
  it('config set', () => {
    process.env.TOR_HOST = 'localhost'
    process.env.TOR_CONTROL_PORT = '9051'
    process.env.TOR_PASSWORD = 'test'
    const config = createTorConfig()
    // deepcode ignore NoHardcodedPasswords/test: password is part of the test
    expect(config).to.include({ host: 'localhost', port: 9051, password: 'test' })
  })
  it('tor connect fail', async () => {
    process.env.TOR_HOST = 'localhost'
    process.env.TOR_CONTROL_PORT = '9051'
    process.env.TOR_PASSWORD = 'nostr_ts_relay'

    let client: TorClient | undefined = undefined
    try {
      client = await getTorClient()
      await closeTorClient()
    } catch (_error) {
    }
    expect(client).be.undefined
  })
  it('tor connect success', async () => {
    process.env.TOR_HOST = hostname()
    process.env.TOR_CONTROL_PORT = '9051'
    process.env.TOR_PASSWORD = 'nostr_ts_relay'
    let client: TorClient | undefined = undefined
    try {
      client = await getTorClient()
      await closeTorClient()
    } catch (_error) {
    }
    expect(client).be.not.undefined
  })
  it('add onion connect fail', async () => {
    mock(sandbox)
    process.env.TOR_HOST = 'localhost'
    process.env.TOR_CONTROL_PORT = '9051'
    process.env.TOR_PASSWORD = 'nostr_ts_relay'

    let domain = undefined
    try {
      domain = await addOnion(80)
      await closeTorClient()
    } catch (_error) {
      void _error
    }
    expect(domain).be.undefined
  })
  it('add onion fail', async () => {
    mock(sandbox)
    process.env.TOR_HOST = hostname()
    process.env.TOR_CONTROL_PORT = '9051'
    process.env.TOR_PASSWORD = 'nostr_ts_relay'
    process.env.NOSTR_CONFIG_DIR = '/home/node'

    let domain = undefined
    try {
      domain = await addOnion(80, '}')
      await closeTorClient()
    } catch (_error) {
      void _error
    }
    expect(domain).be.undefined
  })
  it('add onion write fail', async () => {
    mock(sandbox, false, true)
    process.env.TOR_HOST = hostname()
    process.env.TOR_CONTROL_PORT = '9051'
    process.env.TOR_PASSWORD = 'nostr_ts_relay'

    let domain = undefined
    try {
      domain = await addOnion(80)
      await closeTorClient()
    } catch (_error) {
      void _error
    }
    console.log('domain: ' + domain)
    expect(domain).be.undefined
  })
  it('add onion success read fail', async () => {
    mock(sandbox, true)
    process.env.TOR_HOST = hostname()
    process.env.TOR_CONTROL_PORT = '9051'
    process.env.TOR_PASSWORD = 'nostr_ts_relay'

    let domain = undefined
    try {
      domain = await addOnion(80)
      await closeTorClient()
    } catch (_error) {
      void _error
    }
    console.log('domain: ' + domain)
    expect(domain).be.not.undefined
  })
  it('add onion success', async () => {
    mock(sandbox)
    process.env.TOR_HOST = hostname()
    process.env.TOR_CONTROL_PORT = '9051'
    process.env.TOR_PASSWORD = 'nostr_ts_relay'

    let domain = undefined
    try {
      domain = await addOnion(80)
      await closeTorClient()
    } catch (_error) {
      void _error
    }
    console.log('domain: ' + domain)
    expect(domain).be.not.undefined
  })
})
