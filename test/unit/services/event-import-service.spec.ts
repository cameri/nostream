import { join } from 'path'

import fs from 'fs'
import os from 'os'

import {
  EventImportLineError,
  EventImportService,
  EventImportStats,
} from '../../../src/services/event-import-service'
import { Event } from '../../../src/@types/event'
import { expect } from 'chai'
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
    const filePath = createJsonlFile([
      JSON.stringify(event),
      JSON.stringify(event),
      JSON.stringify(event),
    ])

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
})
