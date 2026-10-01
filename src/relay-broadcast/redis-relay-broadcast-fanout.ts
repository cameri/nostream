import { createClient } from 'redis'
import { hostname } from 'os'

import { CacheClient } from '../@types/cache'
import { createLogger } from '../factories/logger-factory'
import { getCacheConfig } from '../cache/client'
import {
  getRelayBroadcastStreamKey,
  getRelayBroadcastStreamMaxLen,
  isRelayBroadcastMessage,
  RelayBroadcastMessage,
} from '../utils/relay-broadcast-message'

const logger = createLogger('relay-broadcast-fanout')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type StreamPayload = RelayBroadcastMessage & { originInstanceId: string }

const compareStreamIds = (left: string, right: string): number => {
  const [leftMs, leftSeq] = left.split('-').map((part) => Number(part))
  const [rightMs, rightSeq] = right.split('-').map((part) => Number(part))

  if (leftMs !== rightMs) {
    return leftMs - rightMs
  }

  return leftSeq - rightSeq
}

export class RedisRelayBroadcastFanout {
  private publisher: CacheClient | undefined
  private subscriber: CacheClient | undefined
  private running = false
  private readLoopPromise: Promise<void> | undefined
  private lastStreamId = '$'
  private trimGapWarned = false

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
    if (!this.publisher?.isReady) {
      logger.warn('publish skipped: publisher not ready')
      return
    }

    const payload: StreamPayload = {
      ...message,
      originInstanceId: this.instanceId,
    }

    await this.publisher.xAdd(
      this.streamKey,
      '*',
      {
        payload: JSON.stringify(payload),
      },
      {
        TRIM: {
          strategy: 'MAXLEN',
          strategyModifier: '~',
          threshold: getRelayBroadcastStreamMaxLen(),
        },
      },
    )
  }

  public async stop(): Promise<void> {
    this.running = false

    await Promise.all([
      this.subscriber?.isOpen ? this.subscriber.disconnect() : Promise.resolve(),
      this.publisher?.isOpen ? this.publisher.disconnect() : Promise.resolve(),
    ])

    if (this.readLoopPromise) {
      await this.readLoopPromise.catch(() => undefined)
      this.readLoopPromise = undefined
    }

    this.subscriber = undefined
    this.publisher = undefined
  }

  private async warnIfStreamTrimmedPastCursor(): Promise<void> {
    if (this.trimGapWarned || this.lastStreamId === '$' || !this.subscriber?.isReady) {
      return
    }

    try {
      const info = await this.subscriber.xInfoStream(this.streamKey)
      const firstEntryId = info.firstEntry?.id
      if (typeof firstEntryId !== 'string') {
        return
      }

      if (compareStreamIds(firstEntryId, this.lastStreamId) > 0) {
        this.trimGapWarned = true
        logger.warn(
          'relay broadcast stream may have evicted unread entries (cursor=%s, first-entry=%s)',
          this.lastStreamId,
          firstEntryId,
        )
      }
    } catch (error) {
      logger.warn('unable to inspect relay broadcast stream: %o', error)
    }
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

            const relayMessage: RelayBroadcastMessage = {
              eventName: parsed.eventName,
              event: parsed.event,
              source: parsed.source,
            }

            if (!isRelayBroadcastMessage(relayMessage)) {
              logger.warn('skipping invalid relay broadcast stream entry')
              continue
            }

            onMessage(relayMessage)
          }
        }

        await this.warnIfStreamTrimmedPastCursor()
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
