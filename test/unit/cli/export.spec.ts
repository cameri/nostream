import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import sinon from 'sinon'

import * as dbClient from '../../../src/database/client'
import { runExportEvents } from '../../../src/scripts/export-events'

type EventRow = {
  event_id: Buffer
  event_pubkey: Buffer
  event_kind: number
  event_created_at: number
  event_content: string
  event_tags: unknown[] | null
  event_signature: Buffer
}

const createRow = (idHex: string, createdAt: number): EventRow => ({
  event_id: Buffer.from(idHex, 'hex'),
  event_pubkey: Buffer.from('11'.repeat(32), 'hex'),
  event_kind: 1,
  event_created_at: createdAt,
  event_content: `event-${createdAt}`,
  event_tags: [['p', 'abc']],
  event_signature: Buffer.from('22'.repeat(64), 'hex'),
})

const createMockDb = (rows: EventRow[]) => {
  const makeQuery = () => ({
    select() {
      return this
    },
    whereNull() {
      return this
    },
    orderBy() {
      return this
    },
    first: async () => (rows[0] ? { event_id: rows[0].event_id } : undefined),
    stream: () => Readable.from(rows),
  })

  const db = ((table: string) => {
    if (table !== 'events') {
      throw new Error(`Unexpected table: ${table}`)
    }

    return makeQuery()
  }) as unknown as ((table: string) => ReturnType<typeof makeQuery>) & { destroy: () => Promise<void> }

  db.destroy = async () => {}
  return db
}

describe('cli export formats', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('exports JSON array format when --format json is selected', async () => {
    const rows = [createRow('aa'.repeat(32), 100), createRow('bb'.repeat(32), 200)]
    sinon.stub(dbClient, 'getMasterDbClient').returns(createMockDb(rows) as any)

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-export-json-'))
    const outputPath = path.join(tempDir, 'events.json')

    const code = await runExportEvents([outputPath], { format: 'json' })
    expect(code).to.equal(0)

    const fileContent = fs.readFileSync(outputPath, 'utf-8')
    const parsed = JSON.parse(fileContent) as Array<{ id: string; kind: number }>
    expect(parsed).to.have.length(2)
    expect(parsed[0].id).to.equal('aa'.repeat(32))
    expect(parsed[1].id).to.equal('bb'.repeat(32))
    expect(parsed[0].kind).to.equal(1)
  })

  it('exports JSON Lines format by default', async () => {
    const rows = [createRow('cc'.repeat(32), 300)]
    sinon.stub(dbClient, 'getMasterDbClient').returns(createMockDb(rows) as any)

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-export-jsonl-'))
    const outputPath = path.join(tempDir, 'events.jsonl')

    const code = await runExportEvents([outputPath], { format: 'jsonl' })
    expect(code).to.equal(0)

    const lines = fs
      .readFileSync(outputPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)

    expect(lines).to.have.length(1)
    const first = JSON.parse(lines[0]) as { id: string }
    expect(first.id).to.equal('cc'.repeat(32))
  })

  it('rejects mismatched output extension for selected format', async () => {
    const rows = [createRow('dd'.repeat(32), 400)]
    sinon.stub(dbClient, 'getMasterDbClient').returns(createMockDb(rows) as any)

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-export-invalid-ext-'))
    const outputPath = path.join(tempDir, 'events.json')

    try {
      await runExportEvents([outputPath], { format: 'jsonl' })
      expect.fail('Expected runExportEvents to throw for mismatched extension')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).to.include('Output file extension must be .jsonl when using --format jsonl')
    }
  })
})
