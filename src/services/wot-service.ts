import { RawData, WebSocket } from 'ws'
import { randomUUID } from 'crypto'

import { createLogger } from '../factories/logger-factory'
import { IWotService } from '../@types/services'
import { WoTSettings } from '../@types/settings'

const logger = createLogger('wot-service')

const PHASE1_TIMEOUT_MS = 5_000
const PHASE2_BATCH_SIZE = 500
const PHASE2_CONCURRENCY = 5
const PHASE2_BATCH_TIMEOUT_MS = 30_000

// Kind 3 — contact / follow list
const KIND_FOLLOW_LIST = 3

/**
 * Open a WebSocket to `relayUrl`, send a REQ for `filter`, collect all EVENT
 * payloads, close on EOSE or timeout, resolve with collected events.
 */
function fetchEvents(
  relayUrl: string,
  filter: Record<string, unknown>,
  timeoutMs: number,
): Promise<any[]> {
  return new Promise((resolve) => {
    const subId = `wot-${randomUUID().slice(0, 8)}`
    const events: any[] = []
    let settled = false

    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      resolve(events)
    }

    const timer = setTimeout(finish, timeoutMs)

    let ws: WebSocket
    try {
      ws = new WebSocket(relayUrl, { timeout: timeoutMs })
    } catch (err) {
      logger.warn('wot-service: could not create WebSocket to %s: %o', relayUrl, err)
      clearTimeout(timer)
      resolve(events)
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
          events.push(msg[2])
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
  })
}

/**
 * Fetch from multiple relays in parallel, deduplicate events by id.
 * Exported so it can be injected / replaced in tests.
 */
export async function fetchFromRelays(
  relayUrls: string[],
  filter: Record<string, unknown>,
  timeoutMs: number,
): Promise<any[]> {
  const results = await Promise.all(
    relayUrls.map((url) => fetchEvents(url, filter, timeoutMs))
  )

  const seen = new Set<string>()
  const deduped: any[] = []

  for (const batch of results) {
    for (const event of batch) {
      if (typeof event.id === 'string' && !seen.has(event.id)) {
        seen.add(event.id)
        deduped.push(event)
      }
    }
  }

  return deduped
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

// static service

export type RelayFetcher = (
  relayUrls: string[],
  filter: Record<string, unknown>,
  timeoutMs: number,
) => Promise<any[]>

export class WotService implements IWotService {
  private trustMap: Map<string, boolean> = new Map()
  private booted = false
  private building = false

  /**
   * @param fetcher - relay fetch function. Defaults to the real WebSocket
   *   implementation. Pass a stub in tests.
   */
  public constructor(private readonly fetcher: RelayFetcher = fetchFromRelays) {}

  public async buildGraph(settings: WoTSettings): Promise<void> {
    if (this.building) {
      logger('build already in progress — skipping')
      return
    }

    this.building = true
    logger.info('starting WoT graph build, seed=%s relays=%o', settings.seedPubkey, settings.seedRelays)

    try {
      // local accumulators — never touch live state during the build
      const followerCount = new Map<string, number>()
      const oneHopSet = new Set<string>()

      // ── Phase 1: fetch owner's follow list (1-hop) ──────────────────────────
      const phase1Events = await this.fetcher(
        settings.seedRelays,
        { authors: [settings.seedPubkey], kinds: [KIND_FOLLOW_LIST] },
        PHASE1_TIMEOUT_MS,
      )

      for (const event of phase1Events) {
        if (!Array.isArray(event.tags)) {
          continue
        }
        for (const tag of event.tags) {
          if (Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string' && tag[1].length === 64) {
            const pubkey = tag[1]
            oneHopSet.add(pubkey)
            followerCount.set(pubkey, (followerCount.get(pubkey) ?? 0) + 1)
          }
        }
      }

      logger.info('phase 1 complete: %d 1-hop pubkeys', oneHopSet.size)

      // ── Phase 2: fetch 2-hop follow lists (batched + concurrent) ───────────
      const oneHopList = Array.from(oneHopSet)
      const batches: string[][] = []

      for (let i = 0; i < oneHopList.length; i += PHASE2_BATCH_SIZE) {
        batches.push(oneHopList.slice(i, i + PHASE2_BATCH_SIZE))
      }

      await runConcurrent(batches, PHASE2_CONCURRENCY, async (batch) => {
        try {
          const events = await this.fetcher(
            settings.seedRelays,
            { authors: batch, kinds: [KIND_FOLLOW_LIST] },
            PHASE2_BATCH_TIMEOUT_MS,
          )

          for (const event of events) {
            if (!Array.isArray(event.tags)) {
              continue
            }
            for (const tag of event.tags) {
              if (Array.isArray(tag) && tag[0] === 'p' && typeof tag[1] === 'string' && tag[1].length === 64) {
                const pubkey = tag[1]
                followerCount.set(pubkey, (followerCount.get(pubkey) ?? 0) + 1)
              }
            }
          }
        } catch (err) {
          logger.warn('wot-service: phase 2 batch failed: %o', err)
        }
      })

      logger.info('phase 2 complete: %d unique pubkeys in follower map', followerCount.size)

      // ── Phase 3: build new trust map and swap atomically ───────────────────
      const newTrustMap = new Map<string, boolean>()

      // owner is always trusted
      newTrustMap.set(settings.seedPubkey, true)

      for (const [pubkey, count] of followerCount) {
        if (count >= settings.minimumFollowers) {
          newTrustMap.set(pubkey, true)
        }
      }

      // atomic swap
      this.trustMap = newTrustMap
      this.booted = true

      logger.info('WoT graph build complete: %d trusted pubkeys', newTrustMap.size)
    } catch (err) {
      logger.error('wot-service: graph build failed: %o', err)
      throw err
    } finally {
      this.building = false
    }
  }

  public isTrusted(pubkey: string): boolean {
    return this.trustMap.get(pubkey) === true
  }

  public isReady(): boolean {
    return this.booted
  }

  public reset(): void {
    this.trustMap = new Map()
    this.booted = false
    this.building = false
  }
}
