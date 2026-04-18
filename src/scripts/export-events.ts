import 'pg-query-stream'

import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'

import { getMasterDbClient } from '../database/client'

type EventRow = {
  event_id: Buffer
  event_pubkey: Buffer
  event_kind: number
  event_created_at: number
  event_content: string
  event_tags: unknown[] | null
  event_signature: Buffer
}

async function exportEvents(): Promise<void> {
  const filename = process.argv[2] || 'events.jsonl'
  const outputPath = path.resolve(filename)
  const db = getMasterDbClient()
  const abortController = new AbortController()
  let interruptedBySignal: NodeJS.Signals | undefined

  const onSignal = (signal: NodeJS.Signals) => {
    if (abortController.signal.aborted) {
      return
    }

    interruptedBySignal = signal
    process.exitCode = 130
    console.log(`${signal} received. Stopping export...`)
    abortController.abort()
  }

  process
    .on('SIGINT', onSignal)
    .on('SIGTERM', onSignal)

  try {
    const firstEvent = await db('events')
      .select('event_id')
      .whereNull('deleted_at')
      .first()

    if (abortController.signal.aborted) {
      return
    }

    if (!firstEvent) {
      console.log('No events to export.')
      return
    }

    console.log(`Exporting events to ${outputPath}`)

    const output = fs.createWriteStream(outputPath)
    let exported = 0

    const dbStream = db('events')
      .select(
        'event_id',
        'event_pubkey',
        'event_kind',
        'event_created_at',
        'event_content',
        'event_tags',
        'event_signature',
      )
      .whereNull('deleted_at')
      .orderBy('event_created_at', 'asc')
      .orderBy('event_id', 'asc')
      .stream()

    const toJsonLine = new Transform({
      objectMode: true,
      transform(row: EventRow, _encoding, callback) {
        const event = {
          id: row.event_id.toString('hex'),
          pubkey: row.event_pubkey.toString('hex'),
          created_at: row.event_created_at,
          kind: row.event_kind,
          tags: Array.isArray(row.event_tags) ? row.event_tags : [],
          content: row.event_content,
          sig: row.event_signature.toString('hex'),
        }

        exported++
        if (exported % 10000 === 0) {
          console.log(`Exported ${exported} events...`)
        }

        callback(null, JSON.stringify(event) + '\n')
      },
    })

    await pipeline(dbStream, toJsonLine, output, {
      signal: abortController.signal,
    })

    console.log(`Export complete: ${exported} events written to ${outputPath}`)
  } catch (error) {
    if (abortController.signal.aborted) {
      console.log(`Export interrupted by ${interruptedBySignal ?? 'signal'}.`)
      process.exitCode = 130
      return
    }

    throw error
  } finally {
    process
      .off('SIGINT', onSignal)
      .off('SIGTERM', onSignal)

    await db.destroy()
  }
}

exportEvents().catch((error) => {
  console.error('Export failed:', error.message)
  process.exit(1)
})
