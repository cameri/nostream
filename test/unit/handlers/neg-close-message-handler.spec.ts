import { expect } from 'chai'
import EventEmitter from 'events'

import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { MessageType } from '../../../src/@types/messages'
import { NegCloseMessageHandler } from '../../../src/handlers/neg-close-message-handler'
import { Negentropy, NegentropyStorageVector } from '../../../src/utils/negentropy'
import { NegentropySessions } from '../../../src/utils/negentropy-sessions'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'

describe('NegCloseMessageHandler', () => {
  let sessions: NegentropySessions
  let webSocket: IWebSocketAdapter
  let handler: NegCloseMessageHandler
  let emitted: unknown[][]

  const openSession = (id: string) => {
    const storage = new NegentropyStorageVector()
    storage.seal()
    sessions.activate(id, sessions.reserve(id, 3) as symbol, { negentropy: new Negentropy(storage), filter: {} }, 60000)
  }

  beforeEach(() => {
    sessions = new NegentropySessions(() => undefined)
    webSocket = new EventEmitter() as any
    webSocket.getNegentropySessions = () => sessions
    emitted = []
    webSocket.on(WebSocketAdapterEvent.Message, (...args) => emitted.push(args))
    handler = new NegCloseMessageHandler(webSocket)
  })

  afterEach(() => {
    sessions.closeAll()
    webSocket.removeAllListeners()
  })

  it('closes the session without replying', async () => {
    openSession('sync1')

    await handler.handleMessage([MessageType.NEG_CLOSE, 'sync1'] as any)

    expect(sessions.getSessionIds()).to.deep.equal([])
    expect(emitted).to.deep.equal([])
  })

  it('only closes the named session', async () => {
    openSession('a')
    openSession('b')

    await handler.handleMessage([MessageType.NEG_CLOSE, 'a'] as any)

    expect(sessions.getSessionIds()).to.deep.equal(['b'])
  })

  it('ignores an unknown id', async () => {
    await handler.handleMessage([MessageType.NEG_CLOSE, 'nope'] as any)

    expect(emitted).to.deep.equal([])
  })
})
