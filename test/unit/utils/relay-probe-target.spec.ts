import { expect } from 'chai'

import {
  detectNetworkType,
  isNip11FetchTargetSafe,
  parseProbeTarget,
  shouldSkipDnsProbe,
} from '../../../src/utils/relay-probe/index'

describe('relay-probe target parsing', () => {
  it('parses wss relay URLs into HTTP and WebSocket probe targets', () => {
    const target = parseProbeTarget('wss://relay.example.com/nostream')

    expect(target.hostname).to.equal('relay.example.com')
    expect(target.networkType).to.equal('clearnet')
    expect(target.httpOrigin).to.equal('https://relay.example.com')
    expect(target.nip11Url).to.equal('https://relay.example.com/nostream/')
    expect(target.wsUrl).to.equal('wss://relay.example.com/nostream')
  })

  it('detects tor and i2p destinations', () => {
    expect(detectNetworkType('abc123.onion')).to.equal('tor')
    expect(detectNetworkType('relay.i2p')).to.equal('i2p')
    expect(shouldSkipDnsProbe('tor')).to.equal(true)
  })

  it('rejects non-websocket relay URLs', () => {
    expect(() => parseProbeTarget('https://relay.example.com')).to.throw('ws:// or wss://')
  })
})

describe('relay-probe safety helpers', () => {
  it('rejects unsafe NIP-11 fetch targets', () => {
    expect(isNip11FetchTargetSafe('https://relay.example.com/')).to.equal(true)
    expect(isNip11FetchTargetSafe('http://127.0.0.1/')).to.equal(false)
    expect(isNip11FetchTargetSafe('ftp://relay.example.com/')).to.equal(false)
  })
})
