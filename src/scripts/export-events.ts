import 'pg-query-stream'
import dotenv from 'dotenv'
dotenv.config()

import fs from 'fs'
import knex from 'knex'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'

const getDbConfig = () => ({
  client: 'pg',
  connection: process.env.DB_URI || {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'nostream',
  },
})

async function exportEvents(): Promise<void> {
  const filename = process.argv[2] || 'events.jsonl'
  const outputPath = path.resolve(filename)
  const db = knex(getDbConfig())

  try {
    const [{ count }] = await db('events')
      .whereNull('deleted_at')
      .count('* as count')
    const total = Number(count)

    if (total === 0) {
      console.log('No events to export.')
      return
    }

    console.log(`Exporting ${total} events to ${outputPath}`)

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
      .stream()

    const toJsonLine = new Transform({
      objectMode: true,
      transform(row: any, _encoding, callback) {
        const event = {
          id: row.event_id.toString('hex'),
          pubkey: row.event_pubkey.toString('hex'),
          created_at: row.event_created_at,
          kind: row.event_kind,
          tags: row.event_tags || [],
          content: row.event_content,
          sig: row.event_signature.toString('hex'),
        }

        exported++
        if (exported % 10000 === 0) {
          console.log(`Exported ${exported}/${total} events...`)
        }

        callback(null, JSON.stringify(event) + '\n')
      },
    })

    await pipeline(dbStream, toJsonLine, output)

    console.log(`Export complete: ${exported} events written to ${outputPath}`)
  } finally {
    await db.destroy()
  }
}

exportEvents().catch((error) => {
  console.error('Export failed:', error.message)
  process.exit(1)
})
