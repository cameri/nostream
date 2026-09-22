import { createClient } from 'redis'
import { hostname } from 'os'

import { CacheClient } from '../@types/cache'
import { createLogger } from '../factories/logger-factory'
import { getCacheConfig } from '../cache/client'
import { WebSocketServerAdapterEvent } from '../constants/adapter'
import { getRelayBroadcastStreamKey, RelayBroadcastMessage } from '../utils/relay-broadcast-message'

const logger = createLogger('relay-broadcast-fanout')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type StreamPayload = RelayBroadcastMessage & { originInstanceId: string }

export class RedisRelayBroadcastFanout {
  private publisher: CacheClient | undefined
  private subscriber: CacheClient | undefined
  private running = false
  private readLoopPromise: Promise<void> | undefined
  private lastStreamId = '$'

  public constructor(
    private readonly streamKey = getRelayBroadcastStreamKey(),
    private readonly instanceId = process.env.RELAY_INSTANCE_ID?.trim() || `${hostname()}:${process.pid}`,
  ) {}

  public async start(onMessage: (message: RelayBroadcastMessage) => void): Promise<void> {
    if (this.running) {
      return
    }

    this.running = true
    const config = getCacheConfig()

    this.publisher = createClient(config)
    this.subscriber = createClient(config)

    this.publisher.on('error', (error) => logger.error('publisher error: %o', error))
    this.subscriber.on('error', (error) => logger.error('subscriber error: %o', error))

    await this.publisher.connect()
    await this.subscriber.connect()

    logger('connected (stream=%s, instance=%s)', this.streamKey, this.instanceId)

    this.readLoopPromise = this.readLoop(onMessage)
  }

  public async publish(message: RelayBroadcastMessage): Promise<void> {
    if (!this.publisher?.isOpen) {
      logger.warn('publish skipped: publisher not connected')
      return
    }

    const payload: StreamPayload = {
      ...message,
      originInstanceId: this.instanceId,
    }

    await this.publisher.xAdd(this.streamKey, '*', {
      payload: JSON.stringify(payload),
    })
  }

  public async stop(): Promise<void> {
    this.running = false

    if (this.readLoopPromise) {
      await this.readLoopPromise.catch(() => undefined)
      this.readLoopPromise = undefined
    }

    await Promise.all([
      this.subscriber?.isOpen ? this.subscriber.disconnect() : Promise.resolve(),
      this.publisher?.isOpen ? this.publisher.disconnect() : Promise.resolve(),
    ])

    this.subscriber = undefined
    this.publisher = undefined
  }

  private async readLoop(onMessage: (message: RelayBroadcastMessage) => void): Promise<void> {
    while (this.running && this.subscriber?.isOpen) {
      try {
        const response = await this.subscriber.xRead(
          {
            key: this.streamKey,
            id: this.lastStreamId,
          },
          {
            BLOCK: 5000,
            COUNT: 32,
          },
        )

        if (!response) {
          continue
        }

        for (const stream of response) {
          for (const entry of stream.messages) {
            this.lastStreamId = entry.id
            const rawPayload = entry.message.payload

            if (typeof rawPayload !== 'string') {
              continue
            }

            let parsed: StreamPayload
            try {
              parsed = JSON.parse(rawPayload) as StreamPayload
            } catch (error) {
              logger.warn('invalid stream payload: %o', error)
              continue
            }

            if (parsed.originInstanceId === this.instanceId) {
              continue
            }

            if (parsed.eventName !== WebSocketServerAdapterEvent.Broadcast) {
              continue
            }

            onMessage({
              eventName: parsed.eventName,
              event: parsed.event,
              source: parsed.source,
            })
          }
        }
      } catch (error) {
        if (!this.running) {
          return
        }

        logger.error('stream read failed: %o', error)
        await sleep(1000)
      }
    }
  }
}
