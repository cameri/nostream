import fs from 'fs'
import readline from 'readline'

import {
  isDeleteEvent,
  isEphemeralEvent,
  isEventIdValid,
  isEventSignatureValid,
  isParameterizedReplaceableEvent,
  isReplaceableEvent,
} from '../utils/event'
import { attemptValidation } from '../utils/validation'

import { Event } from '../@types/event'
import { eventSchema } from '../schemas/event-schema'
import { EventTags } from '../constants/base'
import { IEventRepository } from '../@types/repositories'

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

      for (const event of events) {
        if (isEphemeralEvent(event)) {
          continue
        }

        if (isDeleteEvent(event)) {
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

          inserted += await eventRepository.create(event)
          continue
        }

        if (isReplaceableEvent(event) || isParameterizedReplaceableEvent(event)) {
          inserted += await eventRepository.upsert(event)
          continue
        }

        inserted += await eventRepository.create(event)
      }

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
      onProgress({ ...stats })

      return stats
    } finally {
      lineReader.close()
      stream.destroy()
    }
  }
}
