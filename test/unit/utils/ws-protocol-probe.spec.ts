import { expect } from 'chai'

import { parseWireMessage, wireMessagePayload } from '../../../src/utils/relay-probe/ws-protocol-probe'

describe('ws-protocol-probe wire parsing', () => {
  it('parses JSON array messages from Buffer payloads', () => {
    const payload = Buffer.from(JSON.stringify(['COUNT', 'nip66-probe-read', { count: 1 }]), 'utf8')

    expect(wireMessagePayload(payload)).to.be.a('string')
    expect(parseWireMessage(payload)).to.deep.equal(['COUNT', 'nip66-probe-read', { count: 1 }])
  })

  it('parses fragmented Buffer array payloads', () => {
    const json = JSON.stringify(['OK', 'event-id', true, ''])
    const partA = Buffer.from(json.slice(0, 8), 'utf8')
    const partB = Buffer.from(json.slice(8), 'utf8')

    expect(parseWireMessage([partA, partB])).to.deep.equal(['OK', 'event-id', true, ''])
  })
})
