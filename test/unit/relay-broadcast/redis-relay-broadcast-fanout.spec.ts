import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { WebSocketServerAdapterEvent } from '../../../src/constants/adapter'
import * as redis from 'redis'
import { RedisRelayBroadcastFanout } from '../../../src/relay-broadcast/redis-relay-broadcast-fanout'

chai.use(sinonChai)

const { expect } = chai

describe('RedisRelayBroadcastFanout', () => {
  let sandbox: Sinon.SinonSandbox
  let publisher: any
  let subscriber: any
  let xReadStub: Sinon.SinonStub

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    publisher = {
      connect: sandbox.stub().resolves(),
      disconnect: sandbox.stub().resolves(),
      on: sandbox.stub(),
      isOpen: true,
      xAdd: sandbox.stub().resolves('1-0'),
    }

    xReadStub = sandbox.stub()
    subscriber = {
      connect: sandbox.stub().resolves(),
      disconnect: sandbox.stub().resolves(),
      on: sandbox.stub(),
      isOpen: true,
      xRead: xReadStub,
    }

    sandbox.stub(redis, 'createClient').callsFake(() => {
      if (!publisher._used) {
        publisher._used = true
        return publisher
      }

      return subscriber
    })
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('publishes with stream trim options', async () => {
    const fanout = new RedisRelayBroadcastFanout('test:stream', 'instance-a')
    await fanout.start(() => undefined)

    await fanout.publish({
      eventName: WebSocketServerAdapterEvent.Broadcast,
      event: { id: 'aa'.repeat(32) } as any,
    })

    expect(publisher.xAdd).to.have.been.calledOnce
    const trimOptions = publisher.xAdd.firstCall.args[3]
    expect(trimOptions).to.deep.include({
      TRIM: {
        strategy: 'MAXLEN',
        strategyModifier: '~',
        threshold: 50_000,
      },
    })

    await fanout.stop()
  })

  it('skips self-origin and malformed stream entries', async () => {
    xReadStub.callsFake(async () => {
      if (xReadStub.callCount > 1) {
        return null
      }

      return [
        {
          name: 'test:stream',
          messages: [
            {
              id: '1-0',
              message: {
                payload: JSON.stringify({
                  originInstanceId: 'instance-a',
                  eventName: WebSocketServerAdapterEvent.Broadcast,
                  event: { id: 'bb'.repeat(32) },
                }),
              },
            },
            {
              id: '2-0',
              message: {
                payload: JSON.stringify({
                  originInstanceId: 'instance-b',
                  eventName: WebSocketServerAdapterEvent.Broadcast,
                  event: null,
                }),
              },
            },
            {
              id: '3-0',
              message: {
                payload: JSON.stringify({
                  originInstanceId: 'instance-b',
                  eventName: WebSocketServerAdapterEvent.Broadcast,
                  event: { id: 'cc'.repeat(32) },
                }),
              },
            },
          ],
        },
      ]
    })

    const fanout = new RedisRelayBroadcastFanout('test:stream', 'instance-a')
    const received: string[] = []

    await fanout.start((message) => {
      received.push(message.event.id)
    })

    for (let attempt = 0; attempt < 20 && received.length === 0; attempt++) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
    }

    expect(received).to.deep.equal(['cc'.repeat(32)])

    await fanout.stop()
  })
})
