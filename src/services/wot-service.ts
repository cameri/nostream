import { RawData, WebSocket } from 'ws'
import { randomUUID } from 'crypto'

import { isEventIdValid, isEventSignatureValid } from '../utils/event'
import { createLogger } from '../factories/logger-factory'
import { IEventRepository } from '../@types/repositories'
import { IWotService } from '../@types/services'
import { WoTSettings } from '../@types/settings'

const logger = createLogger('wot-service')

export const PHASE1_TIMEOUT_MS = 5_000
export const PHASE2_BATCH_SIZE = 500
export const PHASE2_CONCURRENCY = 5
export const PHASE2_BATCH_TIMEOUT_MS = 30_000

const KIND_FOLLOW_LIST = 3

/**
 * Open a WebSocket to `relayUrl`, send a REQ for `filter`, and yield each
 * EVENT payload as it arrives. Closes on EOSE or timeout.
 */
async function* fetchEvents(
  relayUrl: string,
  filter: Record<string, unknown>,
  timeoutMs: number,
): AsyncGenerator<any> {
  const subId = `wot-${randomUUID().slice(0, 8)}`

  const queue: any[] = []
  let done = false
  let notify: (() => void) | null = null

  const wake = () => {
    const fn = notify
    notify = null
    fn?.()
  }

  const finish = () => {
    if (done) {
      return
    }
    done = true
    clearTimeout(timer)
    try { ws.close() } catch { /* ignore */ }
    wake()
  }

  const timer = setTimeout(finish, timeoutMs)

  let ws: WebSocket
  try {
    ws = new WebSocket(relayUrl, { timeout: timeoutMs })
  } catch (err) {
    logger.warn('wot-service: could not create WebSocket to %s: %o', relayUrl, err)
    clearTimeout(timer)
    return
  }

  ws.on('open', () => {
    ws.send(JSON.stringify(['REQ', subId, filter]))
  })

  ws.on('message', (raw: RawData) => {
    try {
      const msg = JSON.parse(raw.toString('utf8'))
      if (!Array.isArray(msg)) {
        return
      }

      if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
        queue.push(msg[2])
        wake()
      } else if (msg[0] === 'EOSE' && msg[1] === subId) {
        finish()
      }
    } catch { /* malformed message — ignore */ }
  })

  ws.on('error', (err) => {
    logger.warn('wot-service: WebSocket error for %s: %o', relayUrl, err)
    finish()
  })

  ws.on('close', finish)

  while (true) {
    while (queue.length > 0) {
      yield queue.shift()
    }
    if (done) {
      break
    }
    await new Promise<void>((resolve) => { notify = resolve })
  }
}

/**
 * Run up to `concurrency` async tasks from `items` at a time.
 */
async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (item !== undefined) {
        await task(item)
      }
    }
  })
  await Promise.all(workers)
}

export type RelayFetcher = (
  relayUrl: string,
  filter: Record<string, unknown>,
  timeoutMs: number,
) => AsyncGenerator<any>

export class WotService implements IWotService {
  private booted = false
  private building = false

  public constructor(
    private readonly eventRepository: IEventRepository,
    private readonly fetcher: RelayFetcher = fetchEvents,
  ) {}

  public async buildGraph(settings: WoTSettings): Promise<string[]> {
    if (this.building) {
      logger('build already in progress — skipping')
      return []
    }

    this.building = true
    logger.info('starting WoT graph build, seed=%s relays=%o', settings.seedPubkey, settings.seedRelays)

    try {
      // ── Phase 1: fetch and store seed's kind-3 follow list ──────────────────
      for (const relayUrl of settings.seedRelays) {
        for await (const event of this.fetcher(
          relayUrl,
          { authors: [settings.seedPubkey], kinds: [KIND_FOLLOW_LIST] },
          PHASE1_TIMEOUT_MS,
        )) {
          if (!(await isEventIdValid(event)) || !(await isEventSignatureValid(event))) {
            continue
          }
          await this.eventRepository.upsert(event)
        }
      }

      logger.info('phase 1 complete: seed kind-3 events stored')

      // ── Phase 1B: read 1-hop pubkeys from DB ────────────────────────────────
      const oneHopRows = await (this.eventRepository as any).masterDbClient('event_tags')
        .select('tag_value')
        .whereIn(
          'event_id',
          (this.eventRepository as any).masterDbClient('events')
            .select('event_id')
            .where('event_pubkey', Buffer.from(settings.seedPubkey, 'hex'))
            .where('event_kind', KIND_FOLLOW_LIST),
        )
        .where('tag_name', 'p')

      const oneHopPubkeys: string[] = oneHopRows.map((r: any) => r.tag_value as string)

      logger.info('phase 1B complete: %d 1-hop pubkeys', oneHopPubkeys.length)

      if (oneHopPubkeys.length === 0) {
        this.booted = true
        return [settings.seedPubkey]
      }

      // ── Phase 2: fetch and store 1-hop kind-3 events (batched) ──────────────
      const batches: string[][] = []
      for (let i = 0; i < oneHopPubkeys.length; i += PHASE2_BATCH_SIZE) {
        batches.push(oneHopPubkeys.slice(i, i + PHASE2_BATCH_SIZE))
      }

      await runConcurrent(batches, PHASE2_CONCURRENCY, async (batch) => {
        for (const relayUrl of settings.seedRelays) {
          try {
            for await (const event of this.fetcher(
              relayUrl,
              { authors: batch, kinds: [KIND_FOLLOW_LIST] },
              PHASE2_BATCH_TIMEOUT_MS,
            )) {
              if (!(await isEventIdValid(event)) || !(await isEventSignatureValid(event))) {
                continue
              }
              await this.eventRepository.upsert(event)
            }
          } catch (err) {
            logger.warn('wot-service: phase 2 batch failed for %s: %o', relayUrl, err)
          }
        }
      })

      logger.info('phase 2 complete: 1-hop kind-3 events stored')

      // ── Phase 3: SQL trust query ─────────────────────────────────────────────
      const trustedRows = await (this.eventRepository as any).masterDbClient('event_tags')
        .select('tag_value')
        .whereIn(
          'event_id',
          (this.eventRepository as any).masterDbClient('events')
            .select('event_id')
            .whereIn('event_pubkey', oneHopPubkeys.map((pk) => Buffer.from(pk, 'hex')))
            .where('event_kind', KIND_FOLLOW_LIST),
        )
        .where('tag_name', 'p')
        .groupBy('tag_value')
        .havingRaw('COUNT(*) >= ?', [settings.minimumFollowers])

      const trustedSet = new Set<string>(trustedRows.map((r: any) => r.tag_value as string))
      trustedSet.add(settings.seedPubkey)
      const trustedPubkeys = Array.from(trustedSet)

      this.booted = true
      logger.info('WoT graph build complete: %d trusted pubkeys', trustedPubkeys.length)

      return trustedPubkeys
    } catch (err) {
      logger.error('wot-service: graph build failed: %o', err)
      throw err
    } finally {
      this.building = false
    }
  }

  public isReady(): boolean {
    return this.booted
  }
}
