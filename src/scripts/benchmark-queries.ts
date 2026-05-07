/**
 * Read-only benchmark for the hot query paths on `events` / `invoices`.
 *
 * Runs `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` against canonical
 * query shapes used by the relay (REQ subscriptions, vanish checks, purge
 * scans, pending invoice polls) and reports the planner's choice and the
 * measured execution time so operators can validate index effectiveness
 * before and after applying the hot-path-indexes migration.
 *
 * Usage:
 *     pnpm run db:benchmark
 *     pnpm run db:benchmark --runs 5 --kind 1 --limit 500
 *
 * The script is read-only: it only issues EXPLAIN and SELECT statements.
 */

import { Knex } from 'knex'

import { EventKinds } from '../constants/base'
import { InvoiceStatus } from '../@types/invoice'
import { getMasterDbClient } from '../database/client'

type ExplainPlanNode = {
  'Node Type'?: string
  'Index Name'?: string
  'Relation Name'?: string
  'Actual Total Time'?: number
  'Actual Rows'?: number
  'Shared Hit Blocks'?: number
  'Shared Read Blocks'?: number
  'Plan Rows'?: number
  Plans?: ExplainPlanNode[]
}

type ExplainResult = {
  Plan: ExplainPlanNode
  'Execution Time': number
  'Planning Time': number
}

type BenchmarkCase = {
  name: string
  description: string
  skipIf?: (ctx: BenchContext) => string | undefined
  build: (ctx: BenchContext) => Knex.QueryBuilder | Knex.Raw
}

type BenchContext = {
  db: Knex
  samplePubkey?: Buffer
  eventCount: number
  invoiceCount: number
  kind: number
  limit: number
  horizonSeconds: number
}

type CliOptions = {
  runs: number
  kind: number
  limit: number
  horizonDays: number
}

function parseIntArg(raw: string | undefined, fallback: number, { min = Number.NEGATIVE_INFINITY } = {}): number {
  // Use Number.isFinite rather than falsy-coalescing so `0` is a valid input
  // (e.g. `--kind 0` selects SET_METADATA, which is a valid Nostr kind).
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(min, parsed)
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    runs: 3,
    kind: EventKinds.TEXT_NOTE,
    limit: 500,
    horizonDays: 7,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--runs':
        opts.runs = parseIntArg(next, opts.runs, { min: 1 })
        i++
        break
      case '--kind':
        opts.kind = parseIntArg(next, opts.kind, { min: 0 })
        i++
        break
      case '--limit':
        opts.limit = parseIntArg(next, opts.limit, { min: 1 })
        i++
        break
      case '--horizon-days':
        opts.horizonDays = parseIntArg(next, opts.horizonDays, { min: 1 })
        i++
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
    }
  }
  return opts
}

function printUsage(): void {
  console.log(
    [
      'Usage: pnpm run db:benchmark [options]',
      '',
      'Options:',
      '  --runs <n>           Execute each query N times (default 3).',
      '  --kind <kind>        Event kind for kind-based queries (default 1).',
      '  --limit <n>          LIMIT used in ordered queries (default 500).',
      '  --horizon-days <n>   Lookback window for time-range queries (default 7).',
      '  -h, --help           Show this message.',
    ].join('\n'),
  )
}

function walkPlan(node: ExplainPlanNode, visit: (n: ExplainPlanNode) => void): void {
  visit(node)
  if (node.Plans) {
    for (const child of node.Plans) {
      walkPlan(child, visit)
    }
  }
}

function summarizePlan(plan: ExplainPlanNode): { indexes: string[]; scans: string[] } {
  const indexes = new Set<string>()
  const scans = new Set<string>()
  walkPlan(plan, (node) => {
    if (node['Index Name']) {
      indexes.add(node['Index Name'])
    }
    if (node['Node Type']) {
      scans.add(node['Node Type'])
    }
  })
  return {
    indexes: Array.from(indexes),
    scans: Array.from(scans),
  }
}

async function explain(db: Knex, query: Knex.QueryBuilder | Knex.Raw): Promise<ExplainResult> {
  // Keep placeholders in Knex's `?` form so `db.raw(sql, bindings)` substitutes
  // them correctly — `.toNative()` rewrites them to `$1, $2, …`, which makes
  // Knex's binding check fail ("Expected N bindings, saw 0").
  const { sql, bindings } = query.toSQL()

  const { rows } = await db.raw<{ rows: { 'QUERY PLAN': ExplainResult[] }[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${sql}`,
    bindings as readonly unknown[],
  )
  return rows[0]['QUERY PLAN'][0]
}

function formatDuration(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)} µs`
  }
  if (ms < 1000) {
    return `${ms.toFixed(2)} ms`
  }
  return `${(ms / 1000).toFixed(2)} s`
}

function buildCases(): BenchmarkCase[] {
  return [
    {
      name: 'REQ: authors + kinds ORDER BY created_at DESC',
      description:
        'NIP-01 REQ with a single pubkey filter + kind=TEXT_NOTE. Canonical per-author subscription; shape matches EventRepository.findByFilters and should hit events_active_pubkey_kind_created_at_idx.',
      skipIf: (ctx) => (ctx.samplePubkey ? undefined : 'no events rows found'),
      build: (ctx) =>
        ctx.db('events')
          .select('event_id', 'event_pubkey', 'event_kind', 'event_created_at')
          .where('event_pubkey', ctx.samplePubkey as Buffer)
          .whereIn('event_kind', [ctx.kind])
          .orderBy('event_created_at', 'desc')
          .orderBy('event_id', 'asc')
          .limit(ctx.limit),
    },
    {
      name: 'REQ: kind + created_at time range',
      description:
        'REQ with no authors but a time window and a kind. Matches findByFilters for the (kinds, since, until) case; exercises the (kind, created_at) access paths.',
      build: (ctx) => {
        const now = Math.floor(Date.now() / 1000)
        const since = now - ctx.horizonSeconds
        return ctx.db('events')
          .select('event_id')
          .where('event_kind', ctx.kind)
          .whereBetween('event_created_at', [since, now])
          .orderBy('event_created_at', 'desc')
          .orderBy('event_id', 'asc')
          .limit(ctx.limit)
      },
    },
    {
      name: 'hasActiveRequestToVanish (pubkey + kind=62 + not deleted)',
      description:
        'Exact query run on every inbound event via UserRepository.isVanished; latency here is a per-message tax. This is the only hot path that filters on deleted_at.',
      skipIf: (ctx) => (ctx.samplePubkey ? undefined : 'no events rows found'),
      build: (ctx) =>
        ctx.db('events')
          .select('event_id')
          .where('event_pubkey', ctx.samplePubkey as Buffer)
          .where('event_kind', EventKinds.REQUEST_TO_VANISH)
          .whereNull('deleted_at')
          .limit(1),
    },
    {
      name: 'Purge scan (soft-deleted rows)',
      description:
        'MaintenanceWorker retention sweep; hits events_deleted_at_partial_idx when present.',
      build: (ctx) =>
        ctx.db('events').select('event_id').whereNotNull('deleted_at').limit(ctx.limit),
    },
    {
      name: 'Purge scan (expired events)',
      description:
        'Retention sweep by expires_at; already served by the existing expires_at btree.',
      build: (ctx) => {
        const now = Math.floor(Date.now() / 1000)
        return ctx.db('events').select('event_id').where('expires_at', '<', now).limit(ctx.limit)
      },
    },
    {
      name: 'findPendingInvoices (status=pending ORDER BY created_at)',
      description:
        'Exact shape of InvoiceRepository.findPendingInvoices; hits invoices_pending_created_at_idx when present.',
      skipIf: (ctx) => (ctx.invoiceCount > 0 ? undefined : 'invoices table is empty'),
      build: (ctx) =>
        ctx
          .db('invoices')
          .select('id')
          .where('status', InvoiceStatus.PENDING)
          .orderBy('created_at', 'asc')
          .offset(0)
          .limit(ctx.limit),
    },
  ]
}

async function gatherContext(db: Knex, options: CliOptions): Promise<BenchContext> {
  const [{ count: eventCountText = '0' } = { count: '0' }] = await db('events').count('* as count')
  const [{ count: invoiceCountText = '0' } = { count: '0' }] = await db('invoices').count('* as count')
  // Pick any pubkey with rows — production REQ does not filter on deleted_at,
  // so the benchmark should not either.
  const sample = await db('events').select('event_pubkey').limit(1).first()

  return {
    db,
    samplePubkey: sample?.event_pubkey,
    eventCount: Number(eventCountText),
    invoiceCount: Number(invoiceCountText),
    kind: options.kind,
    limit: options.limit,
    horizonSeconds: options.horizonDays * 86400,
  }
}

function printHeader(ctx: BenchContext, options: CliOptions): void {
  console.log('Nostream query benchmark')
  console.log('------------------------')
  console.log(`events rows:          ${ctx.eventCount.toLocaleString()}`)
  console.log(`invoices rows:        ${ctx.invoiceCount.toLocaleString()}`)
  console.log(`sample pubkey:        ${ctx.samplePubkey ? ctx.samplePubkey.toString('hex').slice(0, 16) + '…' : '<none>'}`)
  console.log(`runs per query:       ${options.runs}`)
  console.log(`kind (REQ/time):      ${options.kind}`)
  console.log(`limit:                ${options.limit}`)
  console.log(`time horizon (days):  ${options.horizonDays}`)
  console.log('')
}

async function runCase(db: Knex, runs: number, testCase: BenchmarkCase, ctx: BenchContext): Promise<void> {
  const skip = testCase.skipIf?.(ctx)
  console.log(`• ${testCase.name}`)
  if (skip) {
    console.log(`  skipped: ${skip}`)
    console.log('')
    return
  }
  console.log(`  ${testCase.description}`)

  const timings: number[] = []
  let planningTime = 0
  let indexes: string[] = []
  let scans: string[] = []
  let rowsReturned = 0

  for (let i = 0; i < runs; i++) {
    const plan = await explain(db, testCase.build(ctx))
    timings.push(plan['Execution Time'])
    planningTime = plan['Planning Time']
    const summary = summarizePlan(plan.Plan)
    indexes = summary.indexes
    scans = summary.scans
    rowsReturned = plan.Plan['Actual Rows'] ?? 0
  }

  const min = Math.min(...timings)
  const max = Math.max(...timings)
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length

  console.log(
    [
      `  exec (min/avg/max): ${formatDuration(min)} / ${formatDuration(avg)} / ${formatDuration(max)}`,
      `  planning:           ${formatDuration(planningTime)}`,
      `  rows returned:      ${rowsReturned.toLocaleString()}`,
      `  node types:         ${scans.join(', ') || '<n/a>'}`,
      `  indexes used:       ${indexes.length ? indexes.join(', ') : '<none — sequential scan>'}`,
    ].join('\n'),
  )
  console.log('')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const db = getMasterDbClient()

  try {
    const ctx = await gatherContext(db, options)
    printHeader(ctx, options)
    for (const testCase of buildCases()) {
      await runCase(db, options.runs, testCase, ctx)
    }
  } finally {
    await db.destroy()
  }
}

main().catch((error) => {
  console.error('Benchmark failed:', error)
  process.exitCode = 1
})
