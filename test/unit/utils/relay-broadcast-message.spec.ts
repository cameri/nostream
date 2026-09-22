import chai from 'chai'

import { WebSocketServerAdapterEvent } from '../../../src/constants/adapter'
import { isRelayBroadcastMessage } from '../../../src/utils/relay-broadcast-message'

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
})
