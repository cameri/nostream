import { expect } from 'chai'
import { IncomingMessage } from 'http'
import Sinon from 'sinon'
import WebSocket from 'ws'

import { IEventRepository } from '../../../src/@types/repositories'
import { IWebSocketServerAdapter } from '../../../src/@types/adapters'
import { WebSocketAdapter } from '../../../src/adapters/web-socket-adapter'
import { webSocketAdapterFactory } from '../../../src/factories/websocket-adapter-factory'

describe('webSocketAdapterFactory', () => {
  let onStub: Sinon.SinonStub

  beforeEach(() => {
    onStub = Sinon.stub()
  })

  afterEach(() => {
    onStub.reset()
  })

  it('returns a WebSocketAdapter', () => {
    const eventRepository: IEventRepository = {} as any

    const client: WebSocket = {
      on: onStub,
    } as any
    onStub.returns(client)
    const request: IncomingMessage = {
      headers: {
        'sec-websocket-key': Buffer.from('key', 'utf8').toString('base64'),
      },
      socket: {
        remoteAddress: '::1',
      },
    } as any
    const webSocketServerAdapter: IWebSocketServerAdapter = {} as any

    expect(
      webSocketAdapterFactory(eventRepository)([client, request, webSocketServerAdapter])
    ).to.be.an.instanceOf(WebSocketAdapter)
  })
})
