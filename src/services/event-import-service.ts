import fs from 'fs'
import readline from 'readline'

import { Knex } from 'knex'

import { DatabaseClient, EventId } from '../@types/base'
import {
  getEventExpiration,
  isDeleteEvent,
  isEphemeralEvent,
  isEventIdValid,
  isEventSignatureValid,
  isParameterizedReplaceableEvent,
  isReplaceableEvent,
} from '../utils/event'
import { toBuffer, toJSON } from '../utils/transform'
import { attemptValidation } from '../utils/validation'

import { Event } from '../@types/event'
import { eventSchema } from '../schemas/event-schema'
import { EventTags } from '../constants/base'

const DEFAULT_BATCH_SIZE = 1000

const REPLACEABLE_EVENT_CONFLICT_TARGET =
  '(event_pubkey, event_kind, event_deduplication) '
  + 'WHERE (event_kind = 0 OR event_kind = 3 OR event_kind = 41 '
  + 'OR (event_kind >= 10000 AND event_kind < 20000)) '
  + 'OR (event_kind >= 30000 AND event_kind < 40000)'

interface ImportEventRow {
  deleted_at: null
  event_content: string
  event_created_at: number
  event_deduplication: string | null
  event_id: Buffer
  event_kind: number
  event_pubkey: Buffer
  event_signature: Buffer
  event_tags: string
  expires_at: number | null
}

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

const getAffectedRowCount = (result: unknown): number => {
  if (Array.isArray(result)) {
    return result.length
  }

  if (
    typeof result === 'object'
    && result !== null
    && 'rowCount' in result
    && typeof (result as { rowCount: unknown }).rowCount === 'number'
  ) {
    return Number((result as { rowCount: number }).rowCount)
  }

  return 0
}

const isEventIdUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const dbError = error as {
    code?: string
    constraint?: string
    message?: string
  }

  return dbError.code === '23505'
    && (
      dbError.constraint === 'events_event_id_unique'
      || dbError.message?.includes('events_event_id_unique') === true
    )
}

const isValidDeleteTag = (tag: string[]): boolean => {
  return tag.length >= 2
    && tag[0] === EventTags.Event
    && /^[0-9a-f]{64}$/.test(tag[1])
}

const getDeleteTargetEventIds = (event: Event): EventId[] => {
  return event.tags.reduce((eventIds, tag) => {
    if (isValidDeleteTag(tag)) {
      eventIds.push(tag[1])
    }

    return eventIds
  }, [] as EventId[])
}

const isEventReplaceableForStorage = (event: Event): boolean => {
  return isReplaceableEvent(event) || isParameterizedReplaceableEvent(event)
}

const getReplaceableEventDeduplication = (event: Event): string => {
  if (isParameterizedReplaceableEvent(event)) {
    const [, ...deduplication] = event.tags.find(
      (tag) => tag.length >= 2 && tag[0] === EventTags.Deduplication,
    ) ?? [null, '']

    return toJSON(deduplication)
  }

  return toJSON([event.pubkey, event.kind])
}

const getReplaceableEventKey = (event: Event): string => {
  return `${event.pubkey}:${event.kind}:${getReplaceableEventDeduplication(event)}`
}

const toImportEventRow = (event: Event): ImportEventRow => {
  const expiresAt = getEventExpiration(event)

  return {
    deleted_at: null,
    event_content: event.content,
    event_created_at: event.created_at,
    event_deduplication: (
      isReplaceableEvent(event) || isParameterizedReplaceableEvent(event)
        ? getReplaceableEventDeduplication(event)
        : null
    ),
    event_id: toBuffer(event.id),
    event_kind: event.kind,
    event_pubkey: toBuffer(event.pubkey),
    event_signature: toBuffer(event.sig),
    event_tags: toJSON(event.tags),
    expires_at: typeof expiresAt === 'number' ? expiresAt : null,
  }
}

const applyDeleteEvents = async (
  transaction: Knex.Transaction,
  deleteEvent: Event,
): Promise<void> => {
  const eventIds = getDeleteTargetEventIds(deleteEvent)
  if (!eventIds.length) {
    return
  }

  await transaction('events')
    .where('event_pubkey', toBuffer(deleteEvent.pubkey))
    .whereIn('event_id', eventIds.map(toBuffer))
    .whereNull('deleted_at')
    .update({
      deleted_at: transaction.raw('now()'),
    })
}

const insertRegularEvents = async (
  transaction: Knex.Transaction,
  events: Event[],
): Promise<number> => {
  if (!events.length) {
    return 0
  }

  const rows = events.map(toImportEventRow)

  const result = await transaction('events')
    .insert(rows)
    .onConflict()
    .ignore()
    .returning('event_id')

  return getAffectedRowCount(result)
}

const filterOutExistingEventIds = async (
  transaction: Knex.Transaction,
  events: Event[],
): Promise<Event[]> => {
  if (!events.length) {
    return []
  }

  const existingRows = await transaction('events')
    .select('event_id')
    .whereIn('event_id', events.map((event) => toBuffer(event.id))) as Array<{ event_id: Buffer }>

  const existingEventIds = new Set(existingRows.map((row) => row.event_id.toString('hex')))

  return events.filter((event) => !existingEventIds.has(event.id))
}

const upsertReplaceableEvents = async (
  transaction: Knex.Transaction,
  events: Event[],
): Promise<number> => {
  if (!events.length) {
    return 0
  }

  let pendingEvents = events

  while (pendingEvents.length) {
    const deduplicatedByEventId = new Map<string, Event>()
    for (const event of pendingEvents) {
      deduplicatedByEventId.set(event.id, event)
    }

    pendingEvents = Array.from(deduplicatedByEventId.values())

    const rows = pendingEvents.map(toImportEventRow)

    try {
      const result = await transaction('events')
        .insert(rows)
        .onConflict(transaction.raw(REPLACEABLE_EVENT_CONFLICT_TARGET))
        .merge([
          'deleted_at',
          'event_content',
          'event_created_at',
          'event_id',
          'event_signature',
          'event_tags',
          'expires_at',
        ])
        .whereRaw('"events"."event_created_at" < "excluded"."event_created_at"')
        .returning('event_id')

      return getAffectedRowCount(result)
    } catch (error) {
      if (!isEventIdUniqueViolation(error)) {
        throw error
      }

      const filteredEvents = await filterOutExistingEventIds(transaction, pendingEvents)

      if (filteredEvents.length === pendingEvents.length) {
        throw error
      }

      pendingEvents = filteredEvents
    }
  }

  return 0
}

export const createEventBatchPersister =
  (dbClient: DatabaseClient) =>
    async (events: Event[]): Promise<number> => {
      if (!events.length) {
        return 0
      }

      return dbClient.transaction(async (transaction) => {
        let inserted = 0

        let nonDeleteSegment: Event[] = []

        const flushNonDeleteSegment = async () => {
          if (!nonDeleteSegment.length) {
            return
          }

          const regularEvents: Event[] = []
          const replaceableEventsByKey = new Map<string, Event>()

          for (const event of nonDeleteSegment) {
            if (isEventReplaceableForStorage(event)) {
              const deduplicationKey = getReplaceableEventKey(event)
              const existingEvent = replaceableEventsByKey.get(deduplicationKey)

              if (!existingEvent || existingEvent.created_at < event.created_at) {
                replaceableEventsByKey.set(deduplicationKey, event)
              }

              continue
            }

            regularEvents.push(event)
          }

          inserted += await insertRegularEvents(transaction, regularEvents)

          const upsertEvents = await filterOutExistingEventIds(
            transaction,
            Array.from(replaceableEventsByKey.values()),
          )

          inserted += await upsertReplaceableEvents(transaction, upsertEvents)

          nonDeleteSegment = []
        }

        for (const event of events) {
          if (isEphemeralEvent(event)) {
            continue
          }

          if (isDeleteEvent(event)) {
            await flushNonDeleteSegment()

            await applyDeleteEvents(transaction, event)

            inserted += await insertRegularEvents(transaction, [event])

            continue
          }

          nonDeleteSegment.push(event)
        }

        await flushNonDeleteSegment()

        return inserted
      })
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
