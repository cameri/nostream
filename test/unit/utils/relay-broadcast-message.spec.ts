import chai from 'chai'

import { WebSocketServerAdapterEvent } from '../../../src/constants/adapter'
import {
  getRelayBroadcastStreamMaxLen,
  isRelayBroadcastMessage,
} from '../../../src/utils/relay-broadcast-message'

const { expect } = chai

describe('relay-broadcast-message', () => {
  it('detects cluster broadcast messages', () => {
    expect(
      isRelayBroadcastMessage({
        eventName: WebSocketServerAdapterEvent.Broadcast,
        event: { id: '00'.repeat(32) },
      }),
    ).to.equal(true)

    expect(isRelayBroadcastMessage({ eventName: 'other' })).to.equal(false)
  })

  it('defaults stream maxlen when env is unset', () => {
    const previous = process.env.RELAY_BROADCAST_STREAM_MAXLEN
    delete process.env.RELAY_BROADCAST_STREAM_MAXLEN
    expect(getRelayBroadcastStreamMaxLen()).to.equal(50_000)
    if (previous !== undefined) {
      process.env.RELAY_BROADCAST_STREAM_MAXLEN = previous
    }
  })
})
