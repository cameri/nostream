import { expect } from 'chai'
import { IncomingMessage } from 'http'
import Sinon from 'sinon'
import WebSocket from 'ws'

import { IEventRepository, IUserRepository } from '../../../src/@types/repositories'
import { IWebSocketServerAdapter } from '../../../src/@types/adapters'
import { SettingsStatic } from '../../../src/utils/settings'
import { WebSocketAdapter } from '../../../src/adapters/web-socket-adapter'
import { webSocketAdapterFactory } from '../../../src/factories/websocket-adapter-factory'

describe('webSocketAdapterFactory', () => {
  let onStub: Sinon.SinonStub
  let createSettingsStub: Sinon.SinonStub

  beforeEach(() => {
    onStub = Sinon.stub()
    createSettingsStub = Sinon.stub(SettingsStatic, 'createSettings')
  })

  afterEach(() => {
    createSettingsStub.restore()
    onStub.reset()
  })

  it('returns a WebSocketAdapter', () => {
    createSettingsStub.returns({
      network: {
        remoteIpHeader: 'remoteIpHeader',
      },
    })
    const eventRepository: IEventRepository = {} as any
    const userRepository: IUserRepository = {} as any

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
      webSocketAdapterFactory(eventRepository, userRepository)([client, request, webSocketServerAdapter])
    ).to.be.an.instanceOf(WebSocketAdapter)
  })
})
