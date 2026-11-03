import fs from 'fs'
import readline from 'readline'

const streamArrayModule = require('stream-json/streamers/stream-array.js') as {
  default: { withParserAsStream: () => NodeJS.ReadWriteStream }
}
const streamArray = streamArrayModule.default

import { Event } from '../@types/event'
import { IEventRepository, IUserRepository } from '../@types/repositories'

import { EventDeduplicationMetadataKey, EventExpirationTimeMetadataKey, EventKinds, EventTags } from '../constants/base'
import { eventSchema } from '../schemas/event-schema'
import {
  getEventExpiration,
  isDeleteEvent,
  isEphemeralEvent,
  isEventIdValid,
  isEventSignatureValid,
  isParameterizedReplaceableEvent,
  isReplaceableEvent,
  isRequestToVanishEvent,
} from '../utils/event'
import { attemptValidation } from '../utils/validation'

type EventWithImportMetadata = Event & {
  [EventDeduplicationMetadataKey]?: string[]
  [EventExpirationTimeMetadataKey]?: number
}

const enrichEventMetadata = (event: Event): Event => {
  let enriched: EventWithImportMetadata = event

  const expiration = getEventExpiration(event)
  if (expiration) {
    enriched = { ...enriched, [EventExpirationTimeMetadataKey]: expiration }
  }

  if (isParameterizedReplaceableEvent(event)) {
    const [, deduplication] = event.tags.find((tag) => tag.length >= 2 && tag[0] === EventTags.Deduplication) ?? [
      null,
      '',
    ]
    enriched = { ...enriched, [EventDeduplicationMetadataKey]: deduplication ? [deduplication] : [''] }
  }

  return enriched
}

const DEFAULT_BATCH_SIZE = 1000

export interface EventImportStats {
  errors: number
  inserted: number
  processed: number
  skipped: number
}

export interface EventImportLineError {
  lineNumber: number
  reason: string
}

export interface EventImportOptions {
  batchSize?: number
  onLineError?: (lineError: EventImportLineError) => void
  onProgress?: (stats: EventImportStats) => void
}

type EventImportCandidate = {
  candidate?: unknown
  parseError?: unknown
  recordNumber: number
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

const isDestroyableStream = (
  stream: NodeJS.ReadableStream,
): stream is NodeJS.ReadableStream & { destroy: (error?: Error) => void } => {
  const candidate = stream as { destroy?: unknown }

  return typeof candidate.destroy === 'function'
}

export interface EventBatchPersisterOptions {
  /**
   * When present, events from vanished authors are skipped and a kind-62
   * request applies the same deletion and vanish-state rules as the live
   * event path. Import leaves this out and keeps its historical behavior.
   */
  userRepository?: Pick<IUserRepository, 'isVanished' | 'setVanished'>
  /** This relay's URL, used to honor kind-62 `r` tag targeting. */
  relayUrl?: string
}

export const createEventBatchPersister =
  (eventRepository: IEventRepository, options: EventBatchPersisterOptions = {}) =>
  async (events: Event[]): Promise<number> => {
    if (!events.length) {
      return 0
    }

    let inserted = 0

    const regularEvents: Event[] = []
    const replaceableEvents: Event[] = []
    // A batch often carries many events from the same author. Ask once per
    // author instead of once per event.
    const vanishedByAuthor = new Map<string, Promise<boolean>>()
    const isVanished = (pubkey: string): Promise<boolean> => {
      if (!options.userRepository) {
        return Promise.resolve(false)
      }

      let result = vanishedByAuthor.get(pubkey)
      if (!result) {
        result = options.userRepository.isVanished(pubkey)
        vanishedByAuthor.set(pubkey, result)
      }

      return result
    }

    const flush = async () => {
      inserted += await eventRepository.createMany(regularEvents.splice(0))
      inserted += await eventRepository.upsertMany(replaceableEvents.splice(0))
    }

    for (const event of events) {
      if (isRequestToVanishEvent(event, options.relayUrl)) {
        // Flush pending writes before deleting, so the vanish applies after
        // everything accepted ahead of it in this batch.
        await flush()
        await eventRepository.deleteByPubkeyExceptKinds(event.pubkey, [EventKinds.REQUEST_TO_VANISH])
        inserted += await eventRepository.create(enrichEventMetadata(event))
        await options.userRepository?.setVanished(event.pubkey, true)
        vanishedByAuthor.set(event.pubkey, Promise.resolve(true))
        continue
      }

      if (await isVanished(event.pubkey)) {
        continue
      }

      if (isEphemeralEvent(event)) {
        continue
      }

      if (isDeleteEvent(event)) {
        // flush pending batches before applying deletes
        await flush()

        const eventIdsToDelete = event.tags.reduce(
          (ids, tag) =>
            tag.length >= 2 && tag[0] === EventTags.Event && /^[0-9a-f]{64}$/.test(tag[1]) ? [...ids, tag[1]] : ids,
          [] as string[],
        )

        if (eventIdsToDelete.length) {
          await eventRepository.deleteByPubkeyAndIds(event.pubkey, eventIdsToDelete)
        }

        inserted += await eventRepository.create(enrichEventMetadata(event))
        continue
      }

      const enrichedEvent = enrichEventMetadata(event)

      if (isReplaceableEvent(event) || isParameterizedReplaceableEvent(event)) {
        replaceableEvents.push(enrichedEvent)
        continue
      }

      regularEvents.push(enrichedEvent)
    }

    // flush remaining
    await flush()

    return inserted
  }

export class EventImportService {
  public constructor(private readonly persistBatch: (events: Event[]) => Promise<number>) {}

  public async importFromReadable(
    input: NodeJS.ReadableStream,
    options: EventImportOptions = {},
  ): Promise<EventImportStats> {
    return this.importFromCandidates(this.readJsonlCandidatesFromStream(input), options)
  }

  public async importFromJsonl(filePath: string, options: EventImportOptions = {}): Promise<EventImportStats> {
    const stream = fs.createReadStream(filePath, {
      encoding: 'utf-8',
    })

    return this.importFromReadable(stream, options)
  }

  public async importFromJsonArray(filePath: string, options: EventImportOptions = {}): Promise<EventImportStats> {
    return this.importFromCandidates(this.readJsonArrayCandidates(filePath), options)
  }

  private async *readJsonlCandidatesFromStream(input: NodeJS.ReadableStream): AsyncGenerator<EventImportCandidate> {
    const lineReader = readline.createInterface({
      crlfDelay: Infinity,
      input,
    })

    let lineNumber = 0

    try {
      for await (const line of lineReader) {
        lineNumber += 1

        const trimmedLine = line.trim()
        if (!trimmedLine.length) {
          continue
        }

        try {
          yield {
            recordNumber: lineNumber,
            candidate: JSON.parse(trimmedLine),
          }
        } catch (error) {
          yield {
            recordNumber: lineNumber,
            parseError: error,
          }
        }
      }
    } finally {
      lineReader.close()
      if (isDestroyableStream(input)) {
        input.destroy()
      }
    }
  }

  private async *readJsonArrayCandidates(filePath: string): AsyncGenerator<EventImportCandidate> {
    const source = fs.createReadStream(filePath, {
      encoding: 'utf-8',
    })
    const arrayStream = streamArray.withParserAsStream()
    const pipeline = source.pipe(arrayStream)

    try {
      for await (const chunk of pipeline as AsyncIterable<{ key: number; value: unknown }>) {
        yield {
          recordNumber: chunk.key + 1,
          candidate: chunk.value,
        }
      }
    } catch (error) {
      throw new Error(`Invalid JSON array input: ${getErrorMessage(error)}`)
    } finally {
      source.destroy()
    }
  }

  private async importFromCandidates(
    candidates: AsyncIterable<EventImportCandidate>,
    options: EventImportOptions = {},
  ): Promise<EventImportStats> {
    const batchSize =
      typeof options.batchSize === 'number' && Number.isInteger(options.batchSize) && options.batchSize > 0
        ? options.batchSize
        : DEFAULT_BATCH_SIZE

    const onLineError = options.onLineError ?? (() => undefined)
    const onProgress = options.onProgress ?? (() => undefined)

    const validateEventSchema = attemptValidation(eventSchema)

    const batch: Event[] = []
    const stats: EventImportStats = {
      errors: 0,
      inserted: 0,
      processed: 0,
      skipped: 0,
    }

    const flushBatch = async () => {
      if (!batch.length) {
        return
      }

      const currentBatchSize = batch.length
      const inserted = await this.persistBatch(batch)

      if (!Number.isInteger(inserted) || inserted < 0 || inserted > currentBatchSize) {
        throw new Error(`Invalid insert count (${inserted}) for batch size ${currentBatchSize}`)
      }

      stats.inserted += inserted
      stats.skipped += currentBatchSize - inserted
      batch.length = 0

      onProgress({ ...stats })
    }

    for await (const { recordNumber, candidate, parseError } of candidates) {
      if (parseError) {
        stats.processed += 1
        stats.errors += 1
        onLineError({
          lineNumber: recordNumber,
          reason: getErrorMessage(parseError),
        })
        continue
      }

      stats.processed += 1

      let event: Event
      try {
        event = validateEventSchema(candidate) as Event

        if (!(await isEventIdValid(event))) {
          throw new Error('invalid: event id does not match')
        }

        if (!(await isEventSignatureValid(event))) {
          throw new Error('invalid: event signature verification failed')
        }
      } catch (error) {
        stats.errors += 1
        onLineError({
          lineNumber: recordNumber,
          reason: getErrorMessage(error),
        })

        continue
      }

      batch.push(event)

      if (batch.length >= batchSize) {
        await flushBatch()
      }
    }

    await flushBatch()

    return stats
  }
}
