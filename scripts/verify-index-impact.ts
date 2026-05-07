/**
 * End-to-end proof harness for the hot-path-indexes migration.
 *
 * Seeds ~N realistic event rows into a Postgres instance, drops the three
 * indexes added by migration 20260420_120000_add_hot_path_indexes.js, runs
 * EXPLAIN (ANALYZE, BUFFERS) for the hot-path queries, recreates the indexes,
 * runs the same EXPLAINs again, and prints a BEFORE/AFTER table.
 *
 * This script is intentionally self-contained so reviewers can reproduce the
 * numbers without trusting the main benchmark script. It expects the standard
 * DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME env vars (same as the relay).
 *
 * Usage:
 *   node -r ts-node/register scripts/verify-index-impact.ts [--events N] [--pubkeys N] [--runs N]
 *   pnpm run db:verify-index-impact
 */

import { randomBytes } from 'node:crypto'
import pg from 'pg'

const { Client } = pg

type ExplainPlanNode = {
  'Node Type'?: string
  'Index Name'?: string
  Plans?: ExplainPlanNode[]
}

type ExplainResult = {
  Plan: ExplainPlanNode
  'Execution Time': number
  'Planning Time': number
}

type BenchmarkCase = {
  name: string
  sql: string
  params: unknown[]
}

const args = process.argv.slice(2)
const getFlag = (name: string, def: number): number => {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) {
    return def
  }
  const value = Number(args[idx + 1])
  return Number.isFinite(value) ? value : def
}

const EVENTS = getFlag('events', 200_000)
const PUBKEYS = getFlag('pubkeys', 500)
const RUNS = getFlag('runs', 5)

const client = new Client({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'nostr_ts_relay',
  password: process.env.DB_PASSWORD ?? 'nostr_ts_relay',
  database: process.env.DB_NAME ?? 'nostr_ts_relay',
})

const kinds = [0, 1, 1, 1, 1, 1, 3, 4, 7, 7, 1059, 62]

function randPubkey(): Buffer {
  return randomBytes(32)
}

async function seed(): Promise<void> {
  const { rows } = await client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM events')
  const count = rows[0]?.count ?? 0
  if (count >= EVENTS) {
    console.log(`seed: skipping (events=${count} >= target=${EVENTS})`)
    return
  }

  console.log(`seed: inserting ${EVENTS - count} events across ${PUBKEYS} pubkeys…`)

  const pubkeys = Array.from({ length: PUBKEYS }, randPubkey)
  const now = Math.floor(Date.now() / 1000)
  const BATCH = 2000
  const toInsert = EVENTS - count

  await client.query('BEGIN')
  await client.query('ALTER TABLE events DISABLE TRIGGER insert_event_tags')
  try {
    for (let i = 0; i < toInsert; i += BATCH) {
      const values: string[] = []
      const params: unknown[] = []
      const size = Math.min(BATCH, toInsert - i)
      for (let j = 0; j < size; j++) {
        const idx = params.length
        const pk = pubkeys[(i + j) % PUBKEYS]
        const kind = kinds[(i + j) % kinds.length]
        const created = now - Math.floor(Math.random() * 60 * 86400)
        const deleted = Math.random() < 0.02 ? new Date(created * 1000) : null
        params.push(
          randomBytes(32),
          pk,
          created,
          kind,
          '[]',
          '',
          randomBytes(64),
          null,
          null,
          deleted,
        )
        values.push(
          `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}::jsonb, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10})`,
        )
      }
      await client.query(
        `INSERT INTO events (event_id, event_pubkey, event_created_at, event_kind, event_tags, event_content, event_signature, event_deduplication, expires_at, deleted_at)
         VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
        params,
      )
      if ((i / BATCH) % 10 === 0) {
        process.stdout.write(`  inserted ${i + size}/${toInsert}\r`)
      }
    }
  } finally {
    await client.query('ALTER TABLE events ENABLE TRIGGER insert_event_tags')
    await client.query('COMMIT')
  }

  console.log('\nseed: ANALYZE events')
  await client.query('ANALYZE events')

  const { rows: invRows } = await client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM invoices')
  const pend = invRows[0]?.count ?? 0
  if (pend === 0) {
    console.log('seed: inserting 1000 pending invoices…')
    const inv: string[] = []
    const invParams: unknown[] = []
    for (let i = 0; i < 1000; i++) {
      const idx = invParams.length
      invParams.push(randomBytes(32), `lnbc${i}`, 1000, 'sats', 'pending', 'bench')
      inv.push(`(uuid_generate_v4(), $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6})`)
    }
    await client.query(
      `INSERT INTO invoices (id, pubkey, bolt11, amount_requested, unit, status, description)
       VALUES ${inv.join(',')}`,
      invParams,
    )
    await client.query('ANALYZE invoices')
  }
}

async function dropHotPathIndexes(): Promise<void> {
  console.log('before: dropping hot-path indexes')
  await client.query('DROP INDEX IF EXISTS events_active_pubkey_kind_created_at_idx')
  await client.query('DROP INDEX IF EXISTS events_deleted_at_partial_idx')
  await client.query('DROP INDEX IF EXISTS invoices_pending_created_at_idx')
}

async function createHotPathIndexes(): Promise<void> {
  console.log('after: creating hot-path indexes')
  // Shape must match migrations/20260420_120000_add_hot_path_indexes.js
  // exactly, otherwise the before/after numbers are meaningless.
  await client.query(`CREATE INDEX IF NOT EXISTS events_active_pubkey_kind_created_at_idx
    ON events (event_pubkey, event_kind, event_created_at DESC, event_id)`)
  await client.query(`CREATE INDEX IF NOT EXISTS events_deleted_at_partial_idx
    ON events (deleted_at) WHERE deleted_at IS NOT NULL`)
  await client.query(`CREATE INDEX IF NOT EXISTS invoices_pending_created_at_idx
    ON invoices (created_at) WHERE status = 'pending'`)
  await client.query('ANALYZE events')
  await client.query('ANALYZE invoices')
}

async function pickSamplePubkey(): Promise<Buffer | undefined> {
  // Production REQ does not filter on deleted_at, so pick the densest pubkey
  // regardless of soft-delete state — mirrors what EventRepository.findByFilters
  // will actually scan.
  const { rows } = await client.query<{ event_pubkey: Buffer }>(
    'SELECT event_pubkey FROM events GROUP BY event_pubkey ORDER BY COUNT(*) DESC LIMIT 1',
  )
  return rows[0]?.event_pubkey
}

function cases(samplePubkey: Buffer): BenchmarkCase[] {
  const now = Math.floor(Date.now() / 1000)
  const sevenDaysAgo = now - 7 * 86400
  return [
    {
      // Shape matches EventRepository.findByFilters exactly.
      name: 'REQ authors+kind ORDER BY created_at DESC LIMIT 500',
      sql: `SELECT event_id FROM events
            WHERE event_pubkey = $1 AND event_kind = ANY($2::int[])
            ORDER BY event_created_at DESC, event_id ASC LIMIT 500`,
      params: [samplePubkey, [1]],
    },
    {
      // This is the only hot path that filters on deleted_at in production.
      name: 'hasActiveRequestToVanish (pubkey + kind=62)',
      sql: `SELECT event_id FROM events
            WHERE event_pubkey = $1 AND event_kind = 62 AND deleted_at IS NULL LIMIT 1`,
      params: [samplePubkey],
    },
    {
      name: 'Purge scan: soft-deleted rows',
      sql: `SELECT event_id FROM events WHERE deleted_at IS NOT NULL LIMIT 500`,
      params: [],
    },
    {
      // Shape matches InvoiceRepository.findPendingInvoices exactly.
      name: 'findPendingInvoices ORDER BY created_at',
      sql: `SELECT id FROM invoices WHERE status = 'pending' ORDER BY created_at ASC OFFSET 0 LIMIT 500`,
      params: [],
    },
    {
      name: 'REQ kind + time range ORDER BY created_at DESC LIMIT 500',
      sql: `SELECT event_id FROM events
            WHERE event_kind = 1 AND event_created_at BETWEEN $1 AND $2
            ORDER BY event_created_at DESC, event_id ASC LIMIT 500`,
      params: [sevenDaysAgo, now],
    },
  ]
}

async function explain(sql: string, params: unknown[]): Promise<ExplainResult> {
  const { rows } = await client.query<{ 'QUERY PLAN': ExplainResult[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    params,
  )
  const plan = rows[0]?.['QUERY PLAN']?.[0]
  if (!plan) {
    throw new Error('EXPLAIN returned no plan')
  }
  return plan
}

function walk(node: ExplainPlanNode, visit: (n: ExplainPlanNode) => void): void {
  visit(node)
  if (node.Plans) {
    for (const c of node.Plans) {
      walk(c, visit)
    }
  }
}

function summarize(plan: ExplainResult): {
  indexes: string[]
  nodeTypes: string[]
  execMs: number
  planMs: number
} {
  const indexes = new Set<string>()
  const nodeTypes = new Set<string>()
  walk(plan.Plan, (n) => {
    if (n['Index Name']) {
      indexes.add(n['Index Name'])
    }
    if (n['Node Type']) {
      nodeTypes.add(n['Node Type'])
    }
  })
  return {
    indexes: [...indexes],
    nodeTypes: [...nodeTypes],
    execMs: plan['Execution Time'],
    planMs: plan['Planning Time'],
  }
}

type MeasureResult = {
  indexes: string[]
  nodeTypes: string[]
  min: number
  median: number
  max: number
}

async function measure(testCase: BenchmarkCase): Promise<MeasureResult> {
  const runs: ExplainResult[] = []
  for (let i = 0; i < RUNS; i++) {
    runs.push(await explain(testCase.sql, testCase.params))
  }
  const summaries = runs.map(summarize)
  const exec = summaries.map((s) => s.execMs).sort((a, b) => a - b)
  const median = exec[Math.floor(exec.length / 2)]
  const min = exec[0]
  const max = exec[exec.length - 1]
  return {
    indexes: summaries[0]?.indexes ?? [],
    nodeTypes: summaries[0]?.nodeTypes ?? [],
    min,
    median,
    max,
  }
}

async function main(): Promise<void> {
  await client.connect()
  try {
    await seed()
    const samplePubkey = await pickSamplePubkey()
    if (!samplePubkey) {
      console.error('no pubkey found — seeding failed')
      process.exit(1)
    }

    await dropHotPathIndexes()
    const before: Array<{ name: string } & MeasureResult> = []
    for (const tc of cases(samplePubkey)) {
      before.push({ name: tc.name, ...(await measure(tc)) })
    }

    await createHotPathIndexes()
    const after: Array<{ name: string } & MeasureResult> = []
    for (const tc of cases(samplePubkey)) {
      after.push({ name: tc.name, ...(await measure(tc)) })
    }

    console.log('\n=== RESULTS (median of %d runs, milliseconds) ===\n', RUNS)
    for (let i = 0; i < before.length; i++) {
      const b = before[i]
      const a = after[i]
      const speedup = (b.median / a.median).toFixed(2)
      console.log(`• ${b.name}`)
      console.log(
        `    BEFORE: ${b.median.toFixed(2)} ms  | nodes=${b.nodeTypes.join(',')} | idx=[${b.indexes.join(', ') || 'none'}]`,
      )
      console.log(
        `    AFTER:  ${a.median.toFixed(2)} ms  | nodes=${a.nodeTypes.join(',')} | idx=[${a.indexes.join(', ') || 'none'}]`,
      )
      console.log(`    SPEEDUP: ${speedup}x\n`)
    }
  } finally {
    await client.end()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
