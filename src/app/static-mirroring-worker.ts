import { anyPass, map, path } from 'ramda'
import { RawData, WebSocket } from 'ws'
import cluster from 'cluster'
import { randomUUID } from 'crypto'

import { createRelayedEventMessage, createSubscriptionMessage } from '../utils/messages'
import { isEventIdValid, isEventMatchingFilter, isEventSignatureValid } from '../utils/event'
import { Mirror, Settings } from '../@types/settings'
import { createLogger } from '../factories/logger-factory'
import { IRunnable } from '../@types/base'
import { OutgoingEventMessage } from '../@types/messages'
import { RelayedEvent } from '../@types/event'
import { WebSocketServerAdapterEvent } from '../constants/adapter'

const debug = createLogger('static-mirror-worker')

export class StaticMirroringWorker implements IRunnable {
  private client: WebSocket | undefined
  private config: Mirror

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly settings: () => Settings,
  ) {
    this.process
      .on('message', this.onMessage.bind(this))
      .on('SIGINT', this.onExit.bind(this))
      .on('SIGHUP', this.onExit.bind(this))
      .on('SIGTERM', this.onExit.bind(this))
      .on('uncaughtException', this.onError.bind(this))
      .on('unhandledRejection', this.onError.bind(this))
  }

  public run(): void {
    const currentSettings = this.settings()

    console.log('mirroring', currentSettings.mirroring)

    this.config = path(['mirroring', 'static', process.env.MIRROR_INDEX], currentSettings) as Mirror

    let since = Math.floor(Date.now() / 1000) - 60*10

    const createMirror = (config: Mirror) => {
      const subscriptionId = `mirror-${randomUUID()}`

      debug('connecting to %s', config.address)

      return new WebSocket(config.address, { timeout: 5000 })
        .on('open', function () {
          debug('connected to %s', config.address)

          if (Array.isArray(config.filters) && config.filters?.length) {
            const filters = config.filters.map((filter) => ({ ...filter, since }))

            debug('subscribing with %s: %o', subscriptionId, filters)

            this.send(JSON.stringify(createSubscriptionMessage(subscriptionId, filters)))
          }
        })
        .on('message', async function (raw: RawData) {
          try {
            const message = JSON.parse(raw.toString('utf8')) as OutgoingEventMessage

            if (!Array.isArray(message)) {
              return
            }

            if (message[0] !== 'EVENT' || message[1] !== subscriptionId) {
              debug('%s >> local: %o', config.address, message)
              return
            }

            const event = message[2]

            if (!anyPass(map(isEventMatchingFilter, config.filters))(event)) {
              return
            }

            if (!await isEventIdValid(event) || !await isEventSignatureValid(event)) {
              return
            }

            since = Math.floor(Date.now() / 1000) - 30

            if (cluster.isWorker && typeof process.send === 'function') {
              debug('%s >> local: %s', config.address, event.id)
              process.send({
                eventName: WebSocketServerAdapterEvent.Broadcast,
                event,
                source: config.address,
              })
            }
          } catch (error) {
            debug('unable to process message: %o', error)
          }
        })
        .on('close', (code, reason) => {
          debug(`disconnected (${code}): ${reason.toString()}`)

          setTimeout(() => {
            this.client.removeAllListeners()
            this.client = createMirror(config)
          }, 5000)
        })
        .on('error', function (error) {
          debug('connection error: %o', error)
        })
    }

    this.client = createMirror(this.config)
  }

  private onMessage(message: { eventName: string, event: unknown, source: string }): void {
    if (
      message.eventName !== WebSocketServerAdapterEvent.Broadcast
      || message.source === this.config.address
      || !this.client
      || this.client.readyState !== WebSocket.OPEN
    ) {
      return
    }

    const event = message.event as RelayedEvent

    const eventToRelay = createRelayedEventMessage(event, this.config.secret)
    const outboundMessage = JSON.stringify(eventToRelay)
    debug('%s >> %s: %s', message.source ?? 'local', this.config.address, outboundMessage)
    this.client.send(outboundMessage)
  }

  private onError(error: Error) {
    debug('error: %o', error)
    throw error
  }

  private onExit() {
    debug('exiting')
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: () => void) {
    debug('closing')
    if (this.client) {
      this.client.terminate()
    }
    if (typeof callback === 'function') {
      callback()
    }
  }
}
