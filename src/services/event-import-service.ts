import fs from 'fs'
import readline from 'readline'

import {
  getEventExpiration,
  isDeleteEvent,
  isEphemeralEvent,
  isEventIdValid,
  isEventSignatureValid,
  isParameterizedReplaceableEvent,
  isReplaceableEvent,
} from '../utils/event'
import { attemptValidation } from '../utils/validation'

import { EventDeduplicationMetadataKey, EventExpirationTimeMetadataKey, EventTags } from '../constants/base'
import { Event } from '../@types/event'
import { eventSchema } from '../schemas/event-schema'
import { IEventRepository } from '../@types/repositories'

const enrichEventMetadata = (event: Event): Event => {
  let enriched: any = event

  const expiration = getEventExpiration(event)
  if (expiration) {
    enriched = { ...enriched, [EventExpirationTimeMetadataKey]: expiration }
  }

  if (isParameterizedReplaceableEvent(event)) {
    const [, ...deduplication] = event.tags.find(
      (tag) => tag.length >= 2 && tag[0] === EventTags.Deduplication,
    ) ?? [null, '']
    enriched = { ...enriched, [EventDeduplicationMetadataKey]: deduplication }
  }

  return enriched as Event
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

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

export const createEventBatchPersister =
  (eventRepository: IEventRepository) =>
    async (events: Event[]): Promise<number> => {
      if (!events.length) {
        return 0
      }

      let inserted = 0

      const regularEvents: Event[] = []
      const replaceableEvents: Event[] = []

      for (const event of events) {
        if (isEphemeralEvent(event)) {
          continue
        }

        if (isDeleteEvent(event)) {
          // flush pending batches before applying deletes
          inserted += await eventRepository.createMany(regularEvents.splice(0))
          inserted += await eventRepository.upsertMany(replaceableEvents.splice(0))

          const eventIdsToDelete = event.tags.reduce(
            (ids, tag) =>
              tag.length >= 2
              && tag[0] === EventTags.Event
              && /^[0-9a-f]{64}$/.test(tag[1])
                ? [...ids, tag[1]]
                : ids,
            [] as string[]
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
      inserted += await eventRepository.createMany(regularEvents)
      inserted += await eventRepository.upsertMany(replaceableEvents)

      return inserted
    }

export class EventImportService {
  public constructor(
    private readonly persistBatch: (events: Event[]) => Promise<number>,
  ) {}

  public async importFromJsonl(
    filePath: string,
    options: EventImportOptions = {},
  ): Promise<EventImportStats> {
    const batchSize = (
      typeof options.batchSize === 'number'
      && Number.isInteger(options.batchSize)
      && options.batchSize > 0
    ) ? options.batchSize : DEFAULT_BATCH_SIZE

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

    let lineNumber = 0

    const flushBatch = async () => {
      if (!batch.length) {
        return
      }

      const batchSize = batch.length
      const inserted = await this.persistBatch(batch)

      if (!Number.isInteger(inserted) || inserted < 0 || inserted > batchSize) {
        throw new Error(
          `Invalid insert count (${inserted}) for batch size ${batchSize}`,
        )
      }

      stats.inserted += inserted
      stats.skipped += batchSize - inserted
      batch.length = 0

      onProgress({ ...stats })
    }

    const stream = fs.createReadStream(filePath, {
      encoding: 'utf-8',
    })

    const lineReader = readline.createInterface({
      crlfDelay: Infinity,
      input: stream,
    })

    try {
      for await (const line of lineReader) {
        lineNumber += 1

        const trimmedLine = line.trim()
        if (!trimmedLine.length) {
          continue
        }

        stats.processed += 1

        let event: Event
        try {
          event = validateEventSchema(JSON.parse(trimmedLine)) as Event

          if (!await isEventIdValid(event)) {
            throw new Error('invalid: event id does not match')
          }

          if (!await isEventSignatureValid(event)) {
            throw new Error('invalid: event signature verification failed')
          }
        } catch (error) {
          stats.errors += 1
          onLineError({
            lineNumber,
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
    } finally {
      lineReader.close()
      stream.destroy()
    }
  }
}
