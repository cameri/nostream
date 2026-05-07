import { expect } from 'chai'

import { isEventIdValid, isEventSignatureValid } from '../../../src/utils/event'

const seedScript = require('../../../seeds/0000-events')
const sourceEvents = require('../../../seeds/events.json')

type EventRow = {
  event_id: Buffer
  event_pubkey: Buffer
  event_kind: number
  event_created_at: number
  event_content: string
  event_tags: string
  event_signature: Buffer
}

const runSeed = async (requestedCount?: number): Promise<EventRow[]> => {
  if (typeof requestedCount === 'number') {
    process.env.NOSTREAM_SEED_COUNT = String(requestedCount)
  } else {
    delete process.env.NOSTREAM_SEED_COUNT
  }

  let rows: EventRow[] = []

  const knex = ((table: string) => {
    if (table !== 'events') {
      throw new Error(`Unexpected table: ${table}`)
    }

    return {
      del: async () => undefined,
    }
  }) as any

  knex.batchInsert = async (_table: string, insertedRows: EventRow[]) => {
    rows = insertedRows
  }

  await seedScript.seed(knex)

  return rows
}

describe('seeds/0000-events', () => {
  const originalSeedCount = process.env.NOSTREAM_SEED_COUNT

  afterEach(() => {
    if (originalSeedCount === undefined) {
      delete process.env.NOSTREAM_SEED_COUNT
      return
    }

    process.env.NOSTREAM_SEED_COUNT = originalSeedCount
  })

  it('keeps default seed behavior when NOSTREAM_SEED_COUNT is not set', async () => {
    const rows = await runSeed()

    expect(rows.length).to.equal(sourceEvents.length)
    expect(rows[0].event_id.toString('hex')).to.equal(sourceEvents[0].id)
    expect(rows[0].event_pubkey.toString('hex')).to.equal(sourceEvents[0].pubkey)
    expect(rows[0].event_signature.toString('hex')).to.equal(sourceEvents[0].sig)
  })

  it('generates deterministic valid events when NOSTREAM_SEED_COUNT is set', async () => {
    const firstRunRows = await runSeed(5)
    const secondRunRows = await runSeed(5)

    expect(firstRunRows.length).to.equal(5)
    expect(secondRunRows.length).to.equal(5)
    expect(firstRunRows.map((row) => row.event_id.toString('hex'))).to.deep.equal(
      secondRunRows.map((row) => row.event_id.toString('hex')),
    )

    for (const row of firstRunRows) {
      const event = {
        id: row.event_id.toString('hex'),
        pubkey: row.event_pubkey.toString('hex'),
        created_at: row.event_created_at,
        kind: row.event_kind,
        tags: JSON.parse(row.event_tags),
        content: row.event_content,
        sig: row.event_signature.toString('hex'),
      }

      expect(await isEventIdValid(event)).to.equal(true)
      expect(await isEventSignatureValid(event)).to.equal(true)
    }
  })
})
