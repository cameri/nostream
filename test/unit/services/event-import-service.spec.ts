import { expect } from 'chai'

import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { Tag } from '../../../src/@types/base'
import { Event } from '../../../src/@types/event'
import { EventDeduplicationMetadataKey, EventKinds, EventTags } from '../../../src/constants/base'
import {
  createEventBatchPersister,
  EventImportLineError,
  EventImportService,
  EventImportStats,
} from '../../../src/services/event-import-service'
import { getPublicKey, identifyEvent, signEvent } from '../../../src/utils/event'
import { getEvents } from '../data/events'

describe('EventImportService', () => {
  const tmpDirs: string[] = []

  const createJsonlFile = (lines: string[]): string => {
    const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'nostream-import-'))
    tmpDirs.push(tmpDir)

    const filePath = join(tmpDir, 'events.jsonl')

    fs.writeFileSync(filePath, lines.join('\n'), {
      encoding: 'utf-8',
    })

    return filePath
  }

  const createJsonArrayFile = (value: unknown): string => {
    const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'nostream-import-array-'))
    tmpDirs.push(tmpDir)

    const filePath = join(tmpDir, 'events.json')
    fs.writeFileSync(filePath, JSON.stringify(value), {
      encoding: 'utf-8',
    })

    return filePath
  }

  afterEach(() => {
    for (const tmpDir of tmpDirs.splice(0)) {
      fs.rmSync(tmpDir, {
        force: true,
        recursive: true,
      })
    }
  })

  it('imports valid events in batches and tracks skipped duplicates', async () => {
    const [event] = getEvents()
    const filePath = createJsonlFile([JSON.stringify(event), JSON.stringify(event), JSON.stringify(event)])

    const batchCalls: Event[][] = []
    const persistBatch = async (events: Event[]): Promise<number> => {
      batchCalls.push([...events])

      if (batchCalls.length === 1) {
        return 2
      }

      return 0
    }

    const progressUpdates: EventImportStats[] = []

    const importer = new EventImportService(persistBatch)

    const stats = await importer.importFromJsonl(filePath, {
      batchSize: 2,
      onProgress: (progress) => {
        progressUpdates.push(progress)
      },
    })

    expect(stats).to.deep.equal({
      errors: 0,
      inserted: 2,
      processed: 3,
      skipped: 1,
    })

    expect(batchCalls.length).to.equal(2)

    const [firstBatch, secondBatch] = batchCalls

    expect(firstBatch.map(({ id }) => id)).to.deep.equal([event.id, event.id])
    expect(secondBatch.map(({ id }) => id)).to.deep.equal([event.id])

    expect(progressUpdates.length).to.equal(2)

    const finalProgress = progressUpdates[progressUpdates.length - 1]

    expect(finalProgress).to.deep.equal(stats)
  })

  it('imports valid events from a readable stream', async () => {
    const [event] = getEvents()

    const persistBatch = async (events: Event[]): Promise<number> => {
      return events.length
    }

    const importer = new EventImportService(persistBatch)
    const input = Readable.from([`${JSON.stringify(event)}\n`])

    const stats = await importer.importFromReadable(input)

    expect(stats).to.deep.equal({
      errors: 0,
      inserted: 1,
      processed: 1,
      skipped: 0,
    })
  })

  it('imports valid events from JSON array in batches and tracks skipped duplicates', async () => {
    const [event] = getEvents()
    const filePath = createJsonArrayFile([event, event, event])

    const batchCalls: Event[][] = []
    const persistBatch = async (events: Event[]): Promise<number> => {
      batchCalls.push([...events])

      if (batchCalls.length === 1) {
        return 2
      }

      return 0
    }

    const progressUpdates: EventImportStats[] = []

    const importer = new EventImportService(persistBatch)

    const stats = await importer.importFromJsonArray(filePath, {
      batchSize: 2,
      onProgress: (progress) => {
        progressUpdates.push(progress)
      },
    })

    expect(stats).to.deep.equal({
      errors: 0,
      inserted: 2,
      processed: 3,
      skipped: 1,
    })

    expect(batchCalls.length).to.equal(2)
    expect(progressUpdates.length).to.equal(2)
    expect(progressUpdates[progressUpdates.length - 1]).to.deep.equal(stats)
  })

  it('counts malformed and invalid events as errors and keeps importing', async () => {
    const [event] = getEvents()

    const invalidIdEvent: Event = {
      ...event,
      content: `${event.content} changed`,
    }

    const invalidSignatureEvent: Event = {
      ...event,
      sig: 'f'.repeat(128),
    }

    const filePath = createJsonlFile([
      JSON.stringify(event),
      '{not-json}',
      JSON.stringify(invalidIdEvent),
      JSON.stringify(invalidSignatureEvent),
    ])

    const batchCalls: Event[][] = []
    const persistBatch = async (events: Event[]): Promise<number> => {
      batchCalls.push([...events])

      return 1
    }

    const lineErrors: EventImportLineError[] = []

    const importer = new EventImportService(persistBatch)

    const stats = await importer.importFromJsonl(filePath, {
      batchSize: 10,
      onLineError: (lineError) => {
        lineErrors.push(lineError)
      },
    })

    expect(stats).to.deep.equal({
      errors: 3,
      inserted: 1,
      processed: 4,
      skipped: 0,
    })

    expect(batchCalls.length).to.equal(1)
    expect(batchCalls[0].length).to.equal(1)
    expect(lineErrors.length).to.equal(3)
  })

  it('counts malformed and invalid events in JSON array as errors and keeps importing', async () => {
    const [event] = getEvents()

    const invalidIdEvent: Event = {
      ...event,
      content: `${event.content} changed`,
    }

    const invalidSignatureEvent: Event = {
      ...event,
      sig: 'f'.repeat(128),
    }

    const filePath = createJsonArrayFile([event, 'not-an-event', invalidIdEvent, invalidSignatureEvent])

    const batchCalls: Event[][] = []
    const persistBatch = async (events: Event[]): Promise<number> => {
      batchCalls.push([...events])
      return 1
    }

    const lineErrors: EventImportLineError[] = []

    const importer = new EventImportService(persistBatch)

    const stats = await importer.importFromJsonArray(filePath, {
      batchSize: 10,
      onLineError: (lineError) => {
        lineErrors.push(lineError)
      },
    })

    expect(stats).to.deep.equal({
      errors: 3,
      inserted: 1,
      processed: 4,
      skipped: 0,
    })
    expect(batchCalls.length).to.equal(1)
    expect(batchCalls[0].length).to.equal(1)
    expect(lineErrors.length).to.equal(3)
    expect(lineErrors.map((item) => item.lineNumber)).to.deep.equal([2, 3, 4])
  })

  it('rejects when persistence returns an invalid insert count', async () => {
    const [event] = getEvents()
    const filePath = createJsonlFile([JSON.stringify(event)])

    const persistBatch = async (): Promise<number> => 2

    const importer = new EventImportService(persistBatch)

    try {
      await importer.importFromJsonl(filePath)
      expect.fail('Expected import to reject when persistence returns invalid insert count')
    } catch (error) {
      expect((error as Error).message).to.include('Invalid insert count')
    }
  })

  it('rejects JSON array import when persistence returns an invalid insert count', async () => {
    const [event] = getEvents()
    const filePath = createJsonArrayFile([event])

    const persistBatch = async (): Promise<number> => 2

    const importer = new EventImportService(persistBatch)

    try {
      await importer.importFromJsonArray(filePath)
      expect.fail('Expected import to reject when persistence returns invalid insert count')
    } catch (error) {
      expect((error as Error).message).to.include('Invalid insert count')
    }
  })

  it('propagates persistence failures as import failures', async () => {
    const [event] = getEvents()
    const filePath = createJsonlFile([JSON.stringify(event)])

    const persistBatch = async (): Promise<number> => {
      throw new Error('database unavailable')
    }

    const lineErrors: EventImportLineError[] = []

    const importer = new EventImportService(persistBatch)

    try {
      await importer.importFromJsonl(filePath, {
        onLineError: (lineError) => {
          lineErrors.push(lineError)
        },
      })
      expect.fail('Expected import to reject when persistence fails')
    } catch (error) {
      expect((error as Error).message).to.equal('database unavailable')
      expect(lineErrors.length).to.equal(0)
    }
  })

  it('propagates persistence failures as JSON array import failures', async () => {
    const [event] = getEvents()
    const filePath = createJsonArrayFile([event])

    const persistBatch = async (): Promise<number> => {
      throw new Error('database unavailable')
    }

    const lineErrors: EventImportLineError[] = []

    const importer = new EventImportService(persistBatch)

    try {
      await importer.importFromJsonArray(filePath, {
        onLineError: (lineError) => {
          lineErrors.push(lineError)
        },
      })
      expect.fail('Expected import to reject when persistence fails')
    } catch (error) {
      expect((error as Error).message).to.equal('database unavailable')
      expect(lineErrors.length).to.equal(0)
    }
  })

  it('fails fast for malformed top-level JSON in JSON array mode', async () => {
    const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'nostream-import-array-malformed-'))
    tmpDirs.push(tmpDir)
    const filePath = join(tmpDir, 'events.json')
    fs.writeFileSync(filePath, '{"broken":', 'utf-8')

    const importer = new EventImportService(async () => 0)

    try {
      await importer.importFromJsonArray(filePath)
      expect.fail('Expected malformed top-level JSON to fail')
    } catch (error) {
      expect((error as Error).message).to.include('Invalid JSON array input:')
    }
  })

  it('fails fast for non-array top-level JSON in JSON array mode', async () => {
    const filePath = createJsonArrayFile({ foo: 'bar' })

    const importer = new EventImportService(async () => 0)

    try {
      await importer.importFromJsonArray(filePath)
      expect.fail('Expected non-array top-level JSON to fail')
    } catch (error) {
      expect((error as Error).message).to.include('Invalid JSON array input:')
    }
  })

  it('normalizes parameterized replaceable deduplication to first d tag value', async () => {
    const parameterizedEvent: Event = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: EventKinds.PARAMETERIZED_REPLACEABLE_FIRST,
      tags: [[EventTags.Deduplication, 'one', 'two']],
      content: 'hello',
      sig: 'c'.repeat(128),
    }

    let upsertedEvents: Event[] = []

    const eventRepository = {
      create: async () => 0,
      createMany: async () => 0,
      upsert: async () => 0,
      upsertMany: async (events: Event[]) => {
        upsertedEvents = events
        return events.length
      },
      deleteByPubkeyAndIds: async () => 0,
    } as any

    const persistBatch = createEventBatchPersister(eventRepository)
    const inserted = await persistBatch([parameterizedEvent])

    expect(inserted).to.equal(1)
    expect(upsertedEvents).to.have.length(1)
    expect((upsertedEvents[0] as any)[EventDeduplicationMetadataKey]).to.deep.equal(['one'])
  })

  it('skips vanished authors and applies kind-62 vanish rules when a user repository is configured', async () => {
    const visible: Event = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: 1,
      tags: [],
      content: 'visible',
      sig: 'c'.repeat(128),
    }
    const vanished: Event = {
      ...visible,
      id: 'd'.repeat(64),
      pubkey: 'e'.repeat(64),
    }
    const vanish: Event = {
      ...visible,
      id: 'f'.repeat(64),
      pubkey: '1'.repeat(64),
      kind: EventKinds.REQUEST_TO_VANISH,
      content: 'vanish',
    }

    const created: Event[] = []
    const deletedExcept: string[][] = []
    const vanishedPubkeys: string[] = []

    const eventRepository = {
      create: async (event: Event) => {
        created.push(event)
        return 1
      },
      createMany: async (events: Event[]) => {
        created.push(...events)
        return events.length
      },
      upsert: async () => 0,
      upsertMany: async () => 0,
      deleteByPubkeyAndIds: async () => 0,
      deleteByPubkeyExceptKinds: async (pubkey: string, kinds: number[]) => {
        deletedExcept.push([pubkey, ...kinds.map(String)])
        return 1
      },
    } as any

    const userRepository = {
      isVanished: async (pubkey: string) => pubkey === vanished.pubkey,
      setVanished: async (pubkey: string) => {
        vanishedPubkeys.push(pubkey)
        return 1
      },
    }

    const persistBatch = createEventBatchPersister(eventRepository, { userRepository })
    const inserted = await persistBatch([visible, vanished, vanish])

    expect(inserted).to.equal(2)
    expect(created.map((event) => event.id)).to.deep.equal([visible.id, vanish.id])
    expect(deletedExcept).to.deep.equal([[vanish.pubkey, String(EventKinds.REQUEST_TO_VANISH)]])
    expect(vanishedPubkeys).to.deep.equal([vanish.pubkey])
  })

  it('checks vanish state once per author within a batch', async () => {
    const first: Event = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: 1,
      tags: [],
      content: 'one',
      sig: 'c'.repeat(128),
    }
    const second: Event = { ...first, id: 'd'.repeat(64), content: 'two' }

    let checks = 0
    const eventRepository = {
      create: async () => 1,
      createMany: async (events: Event[]) => events.length,
      upsert: async () => 0,
      upsertMany: async (events: Event[]) => events.length,
      deleteByPubkeyAndIds: async () => 0,
    } as any

    const persistBatch = createEventBatchPersister(eventRepository, {
      userRepository: {
        isVanished: async () => {
          checks += 1
          return false
        },
        setVanished: async () => 1,
      },
    })

    const inserted = await persistBatch([first, second])

    expect(inserted).to.equal(2)
    expect(checks).to.equal(1)
  })

  it('does not apply a kind-62 request aimed at another relay', async () => {
    const vanish: Event = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: EventKinds.REQUEST_TO_VANISH,
      tags: [[EventTags.Relay, 'wss://other.example.com']],
      content: 'vanish',
      sig: 'c'.repeat(128),
    }
    const eventRepository = {
      create: async () => 1,
      createMany: async (events: Event[]) => events.length,
      upsert: async () => 0,
      upsertMany: async () => 0,
      deleteByPubkeyAndIds: async () => 0,
      deleteByPubkeyExceptKinds: async () => {
        throw new Error('must not delete for another relay')
      },
    } as any
    let vanished = 0
    const persistBatch = createEventBatchPersister(eventRepository, {
      relayUrl: 'wss://relay.example.com',
      userRepository: {
        isVanished: async () => false,
        setVanished: async () => {
          vanished += 1
          return 1
        },
      },
    })

    const inserted = await persistBatch([vanish])

    expect(inserted).to.equal(1)
    expect(vanished).to.equal(0)
  })

  it('keeps import behavior for kind-62 events when no user repository is supplied', async () => {
    const vanish: Event = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: EventKinds.REQUEST_TO_VANISH,
      tags: [[EventTags.Relay, 'wss://other.example.com']],
      content: 'vanish',
      sig: 'c'.repeat(128),
    }
    const eventRepository = {
      create: async () => 1,
      createMany: async (events: Event[]) => events.length,
      upsert: async () => 0,
      upsertMany: async () => 0,
      deleteByPubkeyAndIds: async () => 0,
      deleteByPubkeyExceptKinds: async () => {
        throw new Error('import must not apply vanish deletions')
      },
    } as any

    const persistBatch = createEventBatchPersister(eventRepository)
    const inserted = await persistBatch([vanish])

    expect(inserted).to.equal(1)
  })

  it('drops ephemeral events without counting them as inserted', async () => {
    const ephemeral: Event = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: EventKinds.EPHEMERAL_FIRST,
      tags: [],
      content: 'ephemeral',
      sig: 'c'.repeat(128),
    }

    let createdManyCalls = 0
    const eventRepository = {
      create: async () => 1,
      createMany: async (events: Event[]) => {
        if (!events.length) {
          return 0
        }
        createdManyCalls += 1
        return events.length
      },
      upsert: async () => 0,
      upsertMany: async (events: Event[]) => events.length,
      deleteByPubkeyAndIds: async () => 0,
    } as any

    const persistBatch = createEventBatchPersister(eventRepository)
    const inserted = await persistBatch([ephemeral])

    expect(inserted).to.equal(0)
    expect(createdManyCalls).to.equal(0)
  })

  describe('deletion requests', () => {
    const limit = 65_533
    const privateKey = 'a'.repeat(64)
    const pubkey = getPublicKey(privateKey)
    const toEventId = (index: number) => index.toString(16).padStart(64, '0')
    const toETags = (ids: string[]): Tag[] => ids.map((id): Tag => [EventTags.Event, id])

    const signEventWithTags = async (kind: number, tags: Tag[]): Promise<Event> =>
      signEvent(privateKey)(await identifyEvent({ pubkey, created_at: 1700000000, kind, tags, content: '' }))

    const createRecordingRepository = () => {
      const inserted: Event[] = []
      const deletions: string[][] = []
      const eventRepository = {
        create: async (event: Event) => {
          inserted.push(event)
          return 1
        },
        createMany: async (events: Event[]) => {
          inserted.push(...events)
          return events.length
        },
        upsertMany: async (events: Event[]) => events.length,
        deleteByPubkeyAndIds: async (_pubkey: string, ids: string[]) => {
          deletions.push(ids)
          return ids.length
        },
      } as any

      return { deletions, eventRepository, inserted }
    }

    it('asks for each id once, in the order it first appears, and ignores tags that are not e tags', async () => {
      const [a, b, c] = ['a', 'b', 'c'].map((char) => char.repeat(64))
      const deletion: Event = {
        id: 'd'.repeat(64),
        pubkey: 'e'.repeat(64),
        created_at: 1,
        kind: EventKinds.DELETE,
        tags: [
          [EventTags.Event, b],
          [EventTags.Pubkey, 'f'.repeat(64)],
          [EventTags.Event, a],
          [EventTags.Event] as any,
          [EventTags.Event, 'not-an-id'],
          [EventTags.Event, 'a'.repeat(63)],
          [EventTags.Event, 'a'.repeat(65)],
          [EventTags.Event, b],
          [EventTags.Event, 'C'.repeat(64)],
          [EventTags.Event, c, 'wss://relay.example'],
          [EventTags.Event, a],
        ],
        content: '',
        sig: '0'.repeat(128),
      }
      const { deletions, eventRepository } = createRecordingRepository()

      await createEventBatchPersister(eventRepository)([deletion])

      expect(deletions).to.deep.equal([[b, a, c]])
    })

    it('imports a request naming 65,533 distinct ids, counting a repeated id once and no other tag', async () => {
      const ids = Array.from({ length: limit }, (_, index) => toEventId(index))
      const deletion = await signEventWithTags(EventKinds.DELETE, [
        ...toETags([...ids, ids[0]]),
        [EventTags.Pubkey, getEvents()[1].pubkey],
        [EventTags.Address, `30023:${pubkey}:post`],
      ])
      const { deletions, eventRepository, inserted } = createRecordingRepository()
      const lineErrors: EventImportLineError[] = []

      const stats = await new EventImportService(createEventBatchPersister(eventRepository)).importFromJsonl(
        createJsonlFile([JSON.stringify(deletion)]),
        { onLineError: (lineError) => lineErrors.push(lineError) },
      )

      expect(lineErrors).to.deep.equal([])
      expect(stats).to.deep.equal({ errors: 0, inserted: 1, processed: 1, skipped: 0 })
      expect(deletions).to.deep.equal([ids])
      expect(inserted.map(({ id }) => id)).to.deep.equal([deletion.id])
    })

    it('refuses a request naming 65,534 distinct ids as a line error and keeps importing', async () => {
      const deletion = await signEventWithTags(
        EventKinds.DELETE,
        toETags(Array.from({ length: limit + 1 }, (_, index) => toEventId(index))),
      )
      const note = getEvents()[1]
      const { deletions, eventRepository, inserted } = createRecordingRepository()
      const lineErrors: EventImportLineError[] = []

      const stats = await new EventImportService(createEventBatchPersister(eventRepository)).importFromJsonl(
        createJsonlFile([JSON.stringify(deletion), JSON.stringify(note)]),
        { onLineError: (lineError) => lineErrors.push(lineError) },
      )

      expect(lineErrors).to.deep.equal([
        { lineNumber: 1, reason: 'invalid: a deletion request may name at most 65533 events' },
      ])
      expect(stats).to.deep.equal({ errors: 1, inserted: 1, processed: 2, skipped: 0 })
      expect(deletions).to.deep.equal([])
      expect(inserted.map(({ id }) => id)).to.deep.equal([note.id])
    })

    it('does not limit the e tags of an event that is not a deletion request', async () => {
      const note = await signEventWithTags(
        EventKinds.TEXT_NOTE,
        toETags(Array.from({ length: limit + 1 }, (_, index) => toEventId(index))),
      )
      const { eventRepository, inserted } = createRecordingRepository()

      const stats = await new EventImportService(createEventBatchPersister(eventRepository)).importFromJsonl(
        createJsonlFile([JSON.stringify(note)]),
      )

      expect(stats).to.deep.equal({ errors: 0, inserted: 1, processed: 1, skipped: 0 })
      expect(inserted.map(({ id }) => id)).to.deep.equal([note.id])
    })
  })
})
