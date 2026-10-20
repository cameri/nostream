// Regenerates ../fixtures/schema.json and ../fixtures/repository-parity.json from the
// TypeScript implementation at the capture commit.
//
// Subject: cameri/nostream at 242a3001d77149e4d70151ec03060c4ef44a1547 — the capture commit
// this branch is cut from. The harness MUST run with that tree as its working directory,
// because the repositories and resources/default-settings.yaml are read from <cwd>.
//
// One-time setup, in a scratch directory (never in the working tree):
//   git archive 242a3001 | tar -x -C /tmp/nostream-capture
//   ln -s <primary checkout>/node_modules /tmp/nostream-capture/node_modules
//
// Run, from the capture tree, against a PostgreSQL 16 server with an empty `public` schema:
//   TZ=UTC DATABASE_URI=postgres://postgres:postgres@host:port/postgres \
//     node <this file> --out-dir <worktree>/crates/nostream-storage/tests/fixtures
//
// TZ=UTC is required: node-postgres parses a `timestamp without time zone` column in the
// process's local zone, so any other TZ would record shifted `confirmed_at`/`expires_at`
// values for the Rust side to disagree with.
//
// The generator applies the capture's 37 knex migrations itself, loads the shipped defaults
// and overrides the two settings gates, inserts the corpus, runs the script below through the
// TypeScript repositories, and writes both fixtures. The committed fixtures are the output;
// the routine harness never needs this tree or knex.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const cwd = process.cwd()
const settingsModule = path.join(cwd, 'src/utils/settings-config.ts')
const isCaptureTree =
  fs.existsSync(settingsModule) &&
  fs.existsSync(path.join(cwd, 'resources/default-settings.yaml')) &&
  !fs.existsSync(path.join(cwd, 'crates'))
if (!isCaptureTree) {
  console.error(
    `run this from the capture tree (cwd=${cwd}); src/utils/settings-config.ts and ` +
      `resources/default-settings.yaml must exist, and crates/ must not`,
  )
  process.exit(2)
}
if (process.env.TZ !== 'UTC') {
  console.error('run with TZ=UTC so timestamp columns are read as UTC')
  process.exit(2)
}
if (!process.env.DATABASE_URI) {
  console.error('DATABASE_URI must name an empty PostgreSQL 16 database')
  process.exit(2)
}

const outDir = (() => {
  const index = process.argv.indexOf('--out-dir')
  return index >= 0 ? process.argv[index + 1] : path.join(cwd, 'fixtures')
})()

const require = createRequire(path.join(cwd, 'package.json'))
require('ts-node/register/transpile-only')

const knex = require('knex')
const { EventRepository } = require(path.join(cwd, 'src/repositories/event-repository.ts'))
const { InvoiceRepository } = require(path.join(cwd, 'src/repositories/invoice-repository.ts'))
const { UserRepository } = require(path.join(cwd, 'src/repositories/user-repository.ts'))
const {
  Nip05VerificationRepository,
} = require(path.join(cwd, 'src/repositories/nip05-verification-repository.ts'))
const {
  InviteCodeRepository,
} = require(path.join(cwd, 'src/repositories/invite-code-repository.ts'))
const { DvmJobRepository } = require(path.join(cwd, 'src/repositories/dvm-job-repository.ts'))
const { ReportRepository } = require(path.join(cwd, 'src/repositories/report-repository.ts'))
const {
  NotificationDeliveryLogRepository,
} = require(path.join(cwd, 'src/repositories/notification-delivery-log-repository.ts'))
const {
  NotificationOutboxRepository,
} = require(path.join(cwd, 'src/repositories/notification-outbox-repository.ts'))
const { loadDefaults, setByPath } = require(settingsModule)
const {
  ContextMetadataKey,
  EventDeduplicationMetadataKey,
  EventExpirationTimeMetadataKey,
} = require(path.join(cwd, 'src/constants/base.ts'))

// ---------------------------------------------------------------------------------------
// Settings: the shipped defaults with the two query-shape gates switched on.
// ---------------------------------------------------------------------------------------

const SETTINGS_OVERRIDES = [
  ['nip50.enabled', true],
  ['nip50.language', 'simple'],
  ['nip50.maxQueryLength', 256],
  ['nip56.enabled', true],
  ['nip56.hideActionableReports', true],
]
const settings = SETTINGS_OVERRIDES.reduce(
  (document, [dotted, value]) => setByPath(document, dotted, value),
  loadDefaults(),
)
const getSettings = () => settings

// ---------------------------------------------------------------------------------------
// Corpus: the 463 shipped seed events plus deterministic synthetic edge cases.
// ---------------------------------------------------------------------------------------

const seedEvents = JSON.parse(fs.readFileSync(path.join(cwd, 'seeds/events.json'), 'utf8'))

const pad64 = (prefix) => prefix + '0'.repeat(64 - prefix.length)
const PK_A = pad64('a1')
const PK_B = pad64('a2')
const PK_C = pad64('b3')
const PK_D = pad64('c4')
const syntheticId = (index) => pad64(`c${index.toString(16).padStart(3, '0')}`)
const syntheticPubkey = (index) => pad64(`d${index.toString(16).padStart(3, '0')}`)
const SIG = 'ab'.repeat(64)

const makeEvent = (id, pubkey, created_at, kind, tags, content) => ({
  id,
  pubkey,
  created_at,
  kind,
  tags,
  content,
  sig: SIG,
})

const synthetic = [
  makeEvent(syntheticId(1), PK_A, 1700000100, 0, [], 'profile one'),
  makeEvent(syntheticId(2), PK_A, 1700000200, 0, [], 'profile two'),
  makeEvent(syntheticId(3), PK_A, 1700000200, 0, [], 'profile tie winner'),
  makeEvent(syntheticId(4), PK_A, 1700000300, 1, [['t', 'nostr']], 'bitcoin lightning network'),
  makeEvent(syntheticId(5), PK_B, 1700000400, 1, [['t', 'bitcoin'], ['g', 'u4pruydqqvj']], 'lightning strikes twice'),
  makeEvent(syntheticId(6), PK_B, 1700000500, 1, [], 'unrelated text'),
  makeEvent(syntheticId(7), PK_B, 1700000600, 7, [['e', 'c000000000000000000000000000000000000000000000000000000000000001']], 'reaction'),
  makeEvent(syntheticId(8), PK_C, 1700000700, 1, [['e', syntheticId(4)], ['p', PK_A]], 'reply to note'),
  makeEvent(syntheticId(9), PK_C, 1700000800, 30023, [['d', 'article-one']], 'long form article'),
  makeEvent(syntheticId(10), PK_C, 1700000801, 30023, [['d', 'article-one']], 'long form article v2'),
  makeEvent(syntheticId(11), PK_C, 1700000802, 30023, [], 'parameterized without d tag'),
  makeEvent(syntheticId(12), PK_D, 1700000900, 41, [], 'group chat'),
  makeEvent(syntheticId(13), PK_D, 1700000901, 41, [], 'group chat later'),
  makeEvent(syntheticId(14), PK_D, 1700001000, 1, [['g', 'u4pruydqqvj']], 'geohash note'),
  makeEvent(syntheticId(15), PK_D, 1700001100, 62, [], 'request to vanish'),
  makeEvent(syntheticId(16), PK_D, 1700001200, 1, [], 'expired note'),
  makeEvent(syntheticId(17), PK_A, 1700001300, 1, [['a', '30023:' + PK_C + ':article-one']], 'addressable reference'),
  makeEvent(syntheticId(18), syntheticPubkey(1), 1700001400, 1, [], 'deletable by kind'),
  makeEvent(syntheticId(19), syntheticPubkey(1), 1700001401, 2, [], 'relay recommendation'),
  makeEvent(syntheticId(20), syntheticPubkey(2), 1700001500, 1, [], 'target for a report'),
]

const eventExpiry = new Map([
  [syntheticId(16), 1600000000], // long expired
  [syntheticId(6), 2000000000], // far future
])

const corpus = [
  ...seedEvents.map((event) => ({ source: 'seeds/events.json', event })),
  ...synthetic.map((event) => ({
    source: 'synthetic',
    event,
    ...(eventExpiry.has(event.id) ? { expires_at: eventExpiry.get(event.id) } : {}),
    ...(event.id === syntheticId(7) ? { remote_address: '203.0.113.7' } : {}),
    ...(event.kind === 30023 && event.tags.length > 0
      ? { deduplication: [event.tags[0][1]] }
      : {}),
  })),
]

// ---------------------------------------------------------------------------------------
// Encoders shared with the Rust replay.
// ---------------------------------------------------------------------------------------

const hex = (value) => (value === null || value === undefined ? null : Buffer.from(value).toString('hex'))
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString())
const eventRow = (row) => [
  hex(row.event_id),
  row.event_created_at,
  row.expires_at ?? null,
  row.deleted_at !== null && row.deleted_at !== undefined,
  row.event_deduplication ?? null,
]
const invoiceView = (invoice) => {
  if (!invoice) return null
  return {
    id: invoice.id,
    pubkey: invoice.pubkey,
    bolt11: invoice.bolt11,
    amount_requested: Number(invoice.amountRequested),
    amount_paid:
      invoice.amountPaid === undefined || invoice.amountPaid === null
        ? null
        : Number(invoice.amountPaid),
    unit: invoice.unit,
    status: invoice.status,
    description: invoice.description,
    confirmed_at: iso(invoice.confirmedAt),
    expires_at: iso(invoice.expiresAt),
    verify_url: invoice.verifyURL ?? null,
  }
}
const userView = (user) =>
  user === undefined
    ? null
    : {
        pubkey: user.pubkey,
        is_admitted: user.isAdmitted,
        is_vanished: user.isVanished,
        balance: Number(user.balance),
      }
const nip05View = (row) =>
  row === undefined
    ? null
    : {
        pubkey: row.pubkey,
        nip05: row.nip05,
        domain: row.domain,
        is_verified: row.isVerified,
        last_verified_at: iso(row.lastVerifiedAt),
        last_checked_at: iso(row.lastCheckedAt),
        failure_count: row.failureCount,
      }
const inviteView = (row) => ({
  code: row.code,
  created_by: row.createdBy,
  claimed_by: row.claimedBy,
  expires_at: iso(row.expiresAt),
  remaining_uses: row.remainingUses,
})
const dvmView = (row) =>
  row === undefined
    ? null
    : {
        id: row.id,
        requester_pubkey: row.requesterPubkey,
        kind: row.kind,
        worker_index: row.workerIndex,
        status: row.status,
        result_event_id: row.resultEventId,
        error: row.error,
      }
const reportView = (row) => ({
  id: row.id,
  event_id: row.eventId,
  reporter_pubkey: row.reporterPubkey,
  reported_pubkey: row.reportedPubkey,
  reported_event_id: row.reportedEventId,
  report_type: row.reportType,
  weight: row.weight,
  actionable: row.actionable,
})
const deliveryView = (row) => ({
  outbox_id: row.outboxId,
  event_type: row.eventType,
  target_id: row.targetId,
  target_type: row.targetType,
  status: row.status,
  attempt_number: row.attemptNumber,
  error_snippet: row.errorSnippet,
})
const outboxView = (row) => ({
  event_type: row.eventType,
  payload: row.payload,
  status: row.status,
  attempt_count: row.attemptCount,
  last_error: row.lastError,
})

// Some lists are ordered by a timestamp the call generated; both sides sort them by a
// deterministic key before comparing, as the fixture's `projection` records.
const byKey = (key) => (left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0)
const byReportId = byKey((row) => row.id)
const byDvmId = byKey((row) => row.id)
const byInviteCode = byKey((row) => row.code)
const byDelivery = (left, right) =>
  byKey((row) => `${row.target_id}/${row.attempt_number}`)(left, right)
const byOutboxType = byKey((row) => row.event_type)

// ---------------------------------------------------------------------------------------
// Request decoding: JSON -> the TypeScript types, including the Symbol metadata.
// ---------------------------------------------------------------------------------------

const eventFromJson = (record) => {
  const event = { ...record.event }
  if (record.remote_address !== undefined) {
    event[ContextMetadataKey] = { remoteAddress: { address: record.remote_address } }
  }
  if (record.expires_at !== undefined) {
    event[EventExpirationTimeMetadataKey] = record.expires_at
  }
  if (record.deduplication !== undefined) {
    event[EventDeduplicationMetadataKey] = record.deduplication
  }
  return event
}

const date = (value) => (value === null ? null : new Date(value))

const fieldUpdateIn = (update) => {
  switch (update.kind) {
    case 'absent':
      return undefined
    case 'clear':
      return null
    default:
      return update.value
  }
}

// ---------------------------------------------------------------------------------------
// The script. Every op runs through the TypeScript repositories and records its result.
// ---------------------------------------------------------------------------------------

const repoTarget = syntheticId(20)
const reportEventId = syntheticId(19)

const script = [
  // ---- events: writes -------------------------------------------------------------
  {
    op: 'events.create',
    request: { record: { event: makeEvent(syntheticId(21), PK_A, 1700001600, 1, [], 'created once') } },
  },
  {
    op: 'events.create',
    request: { record: { event: makeEvent(syntheticId(21), PK_A, 1700001600, 1, [], 'created once') } },
  },
  { op: 'events.create_many', request: { records: [] } },
  {
    op: 'events.upsert',
    request: { record: { event: makeEvent(syntheticId(22), PK_A, 1700001700, 0, [], 'profile upsert') } },
  },
  {
    op: 'events.upsert_many',
    request: {
      records: [
        { event: makeEvent(syntheticId(23), PK_B, 1700001800, 1, [], 'upsert many one') },
        {
          event: makeEvent(syntheticId(24), PK_B, 1700001801, 1, [], 'upsert many two'),
          expires_at: 2000000000,
          remote_address: '198.51.100.9',
        },
      ],
    },
    // upsert_many's merge list omits remote_address on both sides.
  },
  {
    op: 'events.upsert',
    request: { record: { event: makeEvent(syntheticId(25), PK_A, 1700001600, 0, [], 'profile older') } },
  },
  {
    op: 'events.upsert',
    request: { record: { event: makeEvent(syntheticId(26), PK_A, 1700001800, 0, [], 'profile newer') } },
  },
  {
    op: 'events.upsert',
    request: {
      record: {
        event: makeEvent(syntheticId(27), PK_C, 1700001900, 30023, [['d', 'article-two']], 'article two'),
        deduplication: ['article-two'],
      },
    },
  },
  {
    op: 'events.upsert',
    request: {
      record: {
        event: makeEvent(syntheticId(28), PK_C, 1700001900, 30023, [['d', 'article-two']], 'article two tie'),
        deduplication: ['article-two'],
      },
    },
  },
  {
    op: 'events.upsert_many',
    request: {
      records: [
        {
          event: makeEvent(syntheticId(29), PK_D, 1700002000, 30000, [['d', 'many']], 'many one'),
          deduplication: ['many'],
          remote_address: '198.51.100.1',
        },
        {
          event: makeEvent(syntheticId(30), PK_D, 1700002001, 30000, [['d', 'many-2']], 'many two'),
          deduplication: ['many-2'],
          remote_address: '198.51.100.2',
        },
      ],
    },
  },

  // ---- events: reads --------------------------------------------------------------
  {
    op: 'events.find_by_filters',
    request: { filters: [{ authors: [PK_A], kinds: [1] }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ authors: [PK_A.slice(0, 8)] }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ authors: [PK_A.slice(0, 7)] }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ ids: [syntheticId(4).slice(0, 9)] }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ ids: [syntheticId(5), syntheticId(6)] }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ authors: [], kinds: [1] }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ kinds: [1], since: 1700000400, until: 1700000600 }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ kinds: [1], limit: 3 }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ '#e': [syntheticId(4)] }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ '#g': ['u4pru*'] }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ '#e': [] }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ search: 'bitcoin lightning' }] },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ kinds: [1], limit: 2 }, { authors: [PK_C] }] },
  },
  { op: 'events.find_by_filters', request: { filters: [] } },
  {
    op: 'events.count_by_filters',
    request: { filters: [{ authors: [PK_A] }] },
  },
  {
    op: 'events.count_by_filters',
    request: { filters: [{ kinds: [1] }, { kinds: [7] }] },
  },
  {
    op: 'events.count_by_filters',
    request: { filters: [{ kinds: [1], limit: 2 }] },
  },
  {
    op: 'events.find_reconciliation_items',
    request: { filter: { authors: [PK_B] } },
  },
  {
    op: 'events.has_active_request_to_vanish',
    request: { pubkey: PK_D },
  },
  {
    op: 'events.has_active_request_to_vanish',
    request: { pubkey: PK_A },
  },

  // ---- events: soft deletes, then NIP-56 -------------------------------------------------
  {
    op: 'events.delete_by_pubkey_and_ids',
    request: { pubkey: syntheticPubkey(1), ids: [syntheticId(18)] },
  },
  {
    op: 'events.delete_by_pubkey_except_kinds',
    request: { pubkey: PK_B, kinds: [1] },
  },
  {
    op: 'report.create',
    request: {
      report: {
        event_id: reportEventId,
        reporter_pubkey: PK_A,
        reported_pubkey: syntheticPubkey(2),
        reported_event_id: repoTarget,
        report_type: 'spam',
        weight: 0.5,
        actionable: true,
      },
    },
  },
  {
    op: 'events.find_by_filters',
    request: { filters: [{ authors: [syntheticPubkey(2)] }] },
  },
  {
    op: 'events.count_by_filters',
    request: { filters: [{ authors: [syntheticPubkey(2)] }] },
  },

  // ---- events: retention (last, because it removes rows) ---------------------------
  // The whitelisted pass runs first, while its excluded rows still exist, so a broken
  // whitelist cannot hide behind an already-empty candidate set.
  {
    op: 'events.delete_expired_and_retained',
    request: {
      options: { max_days: 1, kind_whitelist: [[1, 1]], pubkey_whitelist: [PK_A] },
    },
  },
  {
    op: 'events.delete_expired_and_retained',
    request: { options: { max_days: 1 } },
  },
  {
    op: 'events.delete_expired_and_retained',
    request: { options: { max_days: 0 } },
  },

  // ---- users ----------------------------------------------------------------------
  {
    op: 'user.upsert',
    request: {
      patch: {
        pubkey: PK_A,
        is_admitted: true,
        is_vanished: false,
        tos_accepted_at: { kind: 'set', value: '2024-01-02T03:04:05Z' },
      },
    },
  },
  { op: 'user.find_by_pubkey', request: { pubkey: PK_A } },
  { op: 'user.find_by_pubkey', request: { pubkey: PK_B } },
  { op: 'user.get_balance_by_pubkey', request: { pubkey: PK_A } },
  { op: 'user.get_balance_by_pubkey', request: { pubkey: PK_D } },
  {
    op: 'user.is_vanished',
    request: { pubkey: PK_D },
  },
  { op: 'user.set_vanished', request: { pubkey: PK_A, vanished: true } },
  { op: 'user.is_vanished', request: { pubkey: PK_A } },
  {
    op: 'user.upsert',
    request: { patch: { pubkey: PK_B, is_admitted: false, is_vanished: true, tos_accepted_at: { kind: 'absent' } } },
  },
  {
    op: 'user.upsert',
    request: { patch: { pubkey: PK_B, is_admitted: true, is_vanished: false, tos_accepted_at: { kind: 'set', value: '2024-06-01T00:00:00Z' } } },
  },
  { op: 'user.tos_accepted_at', request: { pubkey: PK_B } },
  {
    op: 'user.upsert',
    request: { patch: { pubkey: PK_B, is_admitted: true, is_vanished: false, tos_accepted_at: { kind: 'clear' } } },
  },
  { op: 'user.tos_accepted_at', request: { pubkey: PK_B } },
  { op: 'user.revoke_admission', request: { pubkey: PK_B } },
  { op: 'user.find_by_pubkey', request: { pubkey: PK_C } },

  // ---- invoices -------------------------------------------------------------------
  {
    op: 'invoice.upsert',
    request: {
      invoice: {
        id: 'inv-1',
        pubkey: PK_A,
        bolt11: 'lnbc1invoiceone',
        amount_requested: 1000,
        amount_paid: null,
        unit: 'sats',
        status: 'pending',
        description: 'first invoice',
        confirmed_at: null,
        expires_at: '2024-03-01T00:00:00Z',
        created_at: '2024-02-29T00:00:00Z',
        verify_url: 'https://example.test/verify/1',
      },
    },
  },
  {
    op: 'invoice.upsert',
    request: {
      invoice: {
        id: 'inv-2',
        pubkey: PK_B,
        bolt11: 'lnbc1invoicetwo',
        amount_requested: 2000,
        amount_paid: null,
        unit: 'msats',
        status: 'pending',
        description: 'second invoice',
        confirmed_at: null,
        expires_at: null,
        created_at: '2024-02-28T00:00:00Z',
      },
    },
  },
  { op: 'invoice.find_by_id', request: { id: 'inv-1' } },
  { op: 'invoice.find_by_id', request: { id: 'missing' } },
  { op: 'invoice.find_pending_invoices', request: { offset: 0, limit: 10 } },
  { op: 'invoice.update_status', request: { id: 'inv-2', status: 'expired' } },
  { op: 'invoice.update_status', request: { id: 'missing', status: 'expired' } },
  {
    op: 'invoice.confirm_invoice',
    request: { invoice_id: 'inv-1', amount_received: 1000, confirmed_at: '2024-03-02T00:00:00Z' },
  },
  { op: 'user.get_balance_by_pubkey', request: { pubkey: PK_A } },
  { op: 'invoice.find_by_id', request: { id: 'inv-1' } },

  // ---- nip05 ----------------------------------------------------------------------
  {
    op: 'nip05.upsert',
    request: {
      verification: {
        pubkey: PK_A,
        nip05: '_@example.test',
        domain: 'example.test',
        is_verified: true,
        last_verified_at: '2024-04-01T00:00:00Z',
        last_checked_at: '2024-04-02T00:00:00Z',
        failure_count: 0,
      },
    },
  },
  {
    op: 'nip05.upsert',
    request: {
      verification: {
        pubkey: PK_B,
        nip05: 'bob@example.test',
        domain: 'example.test',
        is_verified: false,
        last_verified_at: null,
        last_checked_at: '2024-04-03T00:00:00Z',
        failure_count: 2,
      },
    },
  },
  { op: 'nip05.find_by_pubkey', request: { pubkey: PK_A } },
  { op: 'nip05.find_by_pubkey', request: { pubkey: PK_C } },
  {
    op: 'nip05.find_pending_verifications',
    request: { update_frequency_ms: 315360000000, max_failures: 5, limit: 10 },
  },
  { op: 'nip05.delete_by_pubkey', request: { pubkey: PK_B } },
  { op: 'nip05.find_by_pubkey', request: { pubkey: PK_B } },

  // ---- invite codes ---------------------------------------------------------------
  {
    op: 'invite.create',
    request: {
      code: 'invite-one',
      options: { expires_at: '2100-01-01T00:00:00Z', created_by: PK_A },
    },
  },
  {
    op: 'invite.create',
    request: { code: 'invite-two', options: { remaining_uses: { kind: 'clear' } } },
  },
  {
    op: 'invite.create',
    request: {
      code: 'invite-expired',
      options: { expires_at: '2020-01-01T00:00:00Z', remaining_uses: { kind: 'set', value: 3 } },
    },
  },
  { op: 'invite.find_by_code', request: { code: 'invite-one' } },
  { op: 'invite.claim_code', request: { code: 'invite-one', pubkey: PK_B } },
  { op: 'invite.claim_code', request: { code: 'invite-expired', pubkey: PK_B } },
  { op: 'invite.claim_code', request: { code: 'invite-two', pubkey: PK_C } },
  { op: 'invite.find_active_codes', request: { limit: 10 } },
  { op: 'invite.delete_expired_codes', request: {} },
  { op: 'invite.find_by_code', request: { code: 'invite-expired' } },

  // ---- dvm jobs -------------------------------------------------------------------
  {
    op: 'dvm.create',
    request: { id: syntheticId(30), requester: PK_A, kind: 5100 },
  },
  {
    op: 'dvm.create',
    request: { id: syntheticId(31), requester: PK_B, kind: 5200 },
  },
  { op: 'dvm.find_by_id', request: { id: syntheticId(30) } },
  { op: 'dvm.find_pending_jobs', request: { limit: 10 } },
  { op: 'dvm.assign_worker', request: { id: syntheticId(30), worker_index: 2 } },
  { op: 'dvm.assign_worker', request: { id: syntheticId(30), worker_index: 3 } },
  {
    op: 'dvm.update_status',
    request: {
      update: {
        id: syntheticId(30),
        status: 'picked_up',
        result_event_id: { kind: 'absent' },
        error: { kind: 'absent' },
      },
    },
  },
  {
    op: 'dvm.update_status',
    request: {
      update: {
        id: syntheticId(31),
        status: 'completed',
        result_event_id: { kind: 'set', value: syntheticId(32) },
        error: { kind: 'clear' },
      },
    },
  },
  { op: 'dvm.find_pending_jobs', request: { limit: 10, kinds: [5100] } },
  { op: 'dvm.find_by_id', request: { id: syntheticId(31) } },

  // ---- reports --------------------------------------------------------------------
  {
    op: 'report.create_many',
    request: {
      reports: [
        {
          event_id: reportEventId,
          reporter_pubkey: PK_B,
          reported_pubkey: null,
          reported_event_id: syntheticId(20),
          report_type: 'nudity',
          weight: 0.25,
          actionable: true,
        },
        {
          event_id: reportEventId,
          reporter_pubkey: PK_C,
          reported_pubkey: syntheticPubkey(2),
          reported_event_id: null,
          report_type: 'other',
          weight: 0.125,
          actionable: false,
        },
      ],
    },
  },
  { op: 'report.create_many', request: { reports: [] } },
  { op: 'report.find_by_event_id', request: { event_id: reportEventId } },
  { op: 'report.find_actionable', request: { limit: 10 } },
  { op: 'report.find_actionable_targets', request: {} },

  // ---- delivery log ---------------------------------------------------------------
  {
    op: 'delivery_log.append',
    request: {
      entry: {
        outbox_id: null,
        event_type: 'settings.changed',
        target_id: 'target-http',
        target_type: 'http',
        status: 'success',
        attempt_number: 1,
        error_snippet: null,
      },
    },
  },
  {
    op: 'delivery_log.append',
    request: {
      entry: {
        outbox_id: null,
        event_type: 'relay.restarted',
        target_id: 'target-discord',
        target_type: 'discord',
        status: 'failed',
        attempt_number: 2,
        error_snippet: 'connection refused',
      },
    },
  },
  { op: 'delivery_log.find_recent', request: { limit: 10, filters: {} } },
  {
    op: 'delivery_log.find_recent',
    request: { limit: 10, filters: { status: 'success' } },
  },
  {
    op: 'delivery_log.find_recent',
    request: { limit: 10, filters: { event_type: 'relay.restarted' } },
  },
  { op: 'delivery_log.delete_older_than', request: { cutoff: '1970-01-02T00:00:00Z' } },

  // ---- outbox ---------------------------------------------------------------------
  {
    op: 'outbox.enqueue',
    request: {
      event_type: 'admission.invoice.paid',
      payload: { invoiceId: 'inv-1', amount: 1000 },
    },
  },
  {
    op: 'outbox.enqueue',
    request: { event_type: 'settings.changed', payload: { changed: ['nip50.enabled'] } },
  },
  { op: 'outbox.mark_failed', request: { enqueue_event_type: 'admission.invoice.paid', error: 'boom', attempt_count: 2, max_attempts: 5, base_delay_ms: 0 } },
  { op: 'outbox.claim_batch', request: { limit: 10 } },
  { op: 'outbox.mark_delivered', request: { enqueue_event_type: 'admission.invoice.paid' } },
  { op: 'outbox.claim_batch', request: { limit: 10 } },
  { op: 'outbox.delete_terminal_older_than', request: { cutoff: '2100-01-01T00:00:00Z' } },
  { op: 'outbox.claim_batch', request: { limit: 10 } },
  {
    op: 'delivery_log.append',
    request: {
      entry: {
        outbox_id_from: 'settings.changed',
        event_type: 'settings.changed',
        target_id: 'target-slack',
        target_type: 'slack',
        status: 'success',
        attempt_number: 1,
        error_snippet: null,
      },
    },
  },
  {
    op: 'delivery_log.find_successful_target_ids',
    request: { outbox_id_from: 'settings.changed' },
  },

  // ---- serializable transaction groups --------------------------------------------
  {
    op: 'transaction',
    request: {
      ops: [
        { op: 'user.upsert', request: { patch: { pubkey: PK_B, is_admitted: true, is_vanished: false, tos_accepted_at: { kind: 'set', value: '2024-05-01T00:00:00Z' } } } },
        { op: 'user.admit_user', request: { pubkey: PK_D, admitted_at: '2024-05-02T00:00:00Z' } },
        { op: 'invoice.find_by_id', request: { id: 'inv-2' } },
        { op: 'outbox.enqueue', request: { event_type: 'admission.invoice.created', payload: { invoiceId: 'inv-2' } } },
      ],
    },
  },
  {
    op: 'transaction',
    request: {
      ops: [
        { op: 'invoice.upsert', request: { invoice: { id: 'inv-3', pubkey: PK_C, bolt11: 'lnbc1invoicethree', amount_requested: 500, amount_paid: null, unit: 'btc', status: 'pending', description: 'third', confirmed_at: null, expires_at: null, created_at: '2024-05-03T00:00:00Z' } } },
        { op: 'user.upsert', request: { patch: { pubkey: PK_C, is_admitted: true, is_vanished: false, tos_accepted_at: { kind: 'clear' } } } },
        { op: 'invoice.confirm_invoice', request: { invoice_id: 'inv-3', amount_received: 1000000000, confirmed_at: '2024-05-04T00:00:00Z' } },
      ],
    },
  },
  { op: 'invoice.find_by_id', request: { id: 'inv-3' } },
  { op: 'user.find_by_pubkey', request: { pubkey: PK_C } },
  // An enqueue inside a transaction that later fails must roll back with it: the
  // trailing claim sees only the enqueue from the successful transaction above.
  {
    op: 'transaction',
    request: {
      ops: [
        { op: 'outbox.enqueue', request: { event_type: 'transaction.rollback.probe', payload: { probe: true } } },
        // A negative count is a Set, not the unlimited sentinel, so the table's
        // CHECK refuses it: the statement fails and takes the enqueue with it.
        { op: 'invite.create', request: { code: 'invite-rollback', options: { remaining_uses: { kind: 'set', value: -5 } } } },
      ],
    },
  },
  { op: 'outbox.claim_batch', request: { limit: 10 } },
]

// ---------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------

const collect = async (stream) => {
  const rows = []
  for await (const row of stream) rows.push(row)
  return rows
}

const run = async (op, client, inTransaction = false) => {
  const repository = {
    master: client,
    event: new EventRepository(client, client, getSettings),
    user: new UserRepository(client, new EventRepository(client, client, getSettings)),
    invoice: new InvoiceRepository(client),
    nip05: new Nip05VerificationRepository(client),
    invite: new InviteCodeRepository(client),
    dvm: new DvmJobRepository(client),
    report: new ReportRepository(client),
    delivery: new NotificationDeliveryLogRepository(client),
    outbox: new NotificationOutboxRepository(client),
  }
  const request = op.request
  switch (op.op) {
    case 'events.create':
      return { compare: { count: await repository.event.create(eventFromJson(request.record)) } }
    case 'events.create_many':
      return {
        compare: { count: await repository.event.createMany(request.records.map(eventFromJson)) },
      }
    case 'events.upsert':
      return { compare: { count: await repository.event.upsert(eventFromJson(request.record)) } }
    case 'events.upsert_many':
      return {
        compare: { count: await repository.event.upsertMany(request.records.map(eventFromJson)) },
      }
    case 'events.find_by_filters': {
      if (request.filters.length === 0) {
        let failed = false
        try {
          await repository.event.findByFilters([])
        } catch {
          failed = true
        }
        return { compare: { error: failed } }
      }
      const rows = await collect(repository.event.findByFilters(request.filters).stream())
      return { compare: { rows: rows.map(eventRow) } }
    }
    case 'events.count_by_filters':
      return { compare: { count: await repository.event.countByFilters(request.filters) } }
    case 'events.find_reconciliation_items': {
      const rows = await collect(
        repository.event.findReconciliationItems(request.filter).stream(),
      )
      return { compare: { items: rows.map((row) => [row.event_created_at, hex(row.event_id)]) } }
    }
    case 'events.delete_by_pubkey_and_ids':
      return {
        compare: {
          count: await repository.event.deleteByPubkeyAndIds(request.pubkey, request.ids),
        },
      }
    case 'events.delete_by_pubkey_except_kinds':
      return {
        compare: {
          count: await repository.event.deleteByPubkeyExceptKinds(
            request.pubkey,
            request.kinds,
          ),
        },
      }
    case 'events.has_active_request_to_vanish':
      return {
        compare: { value: await repository.event.hasActiveRequestToVanish(request.pubkey) },
      }
    case 'events.delete_expired_and_retained': {
      const options = {}
      if (request.options?.max_days !== undefined) options.maxDays = request.options.max_days
      if (request.options?.kind_whitelist !== undefined) {
        options.kindWhitelist = request.options.kind_whitelist
      }
      if (request.options?.pubkey_whitelist !== undefined) {
        options.pubkeyWhitelist = request.options.pubkey_whitelist
      }
      const counts = await repository.event.deleteExpiredAndRetained(options)
      return { compare: { ...counts } }
    }
    case 'user.find_by_pubkey':
      return { compare: { user: userView(await repository.user.findByPubkey(request.pubkey)) } }
    case 'user.upsert': {
      const patch = {
        pubkey: request.patch.pubkey,
        isAdmitted: request.patch.is_admitted,
        isVanished: request.patch.is_vanished,
      }
      const tos = fieldUpdateIn(request.patch.tos_accepted_at)
      if (tos !== undefined) patch.tosAcceptedAt = tos === null ? null : date(tos)
      return { compare: { count: await repository.user.upsert(patch) } }
    }
    case 'user.get_balance_by_pubkey':
      return {
        compare: {
          balance: Number(await repository.user.getBalanceByPubkey(request.pubkey)),
        },
      }
    case 'user.is_vanished':
      return { compare: { value: await repository.user.isVanished(request.pubkey) } }
    case 'user.set_vanished':
      return {
        compare: { count: await repository.user.setVanished(request.pubkey, request.vanished) },
      }
    case 'user.admit_user':
      return {
        compare: {
          ok: await repository.user
            .admitUser(request.pubkey, date(request.admitted_at))
            .then(() => true),
        },
      }
    case 'user.tos_accepted_at': {
      const [row] = await client('users')
        .select('tos_accepted_at')
        .where('pubkey', Buffer.from(request.pubkey, 'hex'))
        .limit(1)
      return { compare: { value: iso(row?.tos_accepted_at) } }
    }
    case 'user.revoke_admission':
      return { compare: { count: await repository.user.revokeAdmission(request.pubkey) } }
    case 'invoice.find_by_id':
      return { compare: { invoice: invoiceView(await repository.invoice.findById(request.id)) } }
    case 'invoice.upsert': {
      const invoice = {
        id: request.invoice.id,
        pubkey: request.invoice.pubkey,
        bolt11: request.invoice.bolt11,
        amountRequested: BigInt(request.invoice.amount_requested),
        amountPaid:
          request.invoice.amount_paid === null
            ? undefined
            : BigInt(request.invoice.amount_paid),
        unit: request.invoice.unit,
        status: request.invoice.status,
        description: request.invoice.description,
        confirmedAt: request.invoice.confirmed_at === null ? null : date(request.invoice.confirmed_at),
        expiresAt: request.invoice.expires_at === null ? null : date(request.invoice.expires_at),
        createdAt: date(request.invoice.created_at),
        verifyURL: request.invoice.verify_url ?? undefined,
      }
      return { compare: { count: await repository.invoice.upsert(invoice) } }
    }
    case 'invoice.update_status':
      return {
        compare: {
          invoice: invoiceView(
            await repository.invoice.updateStatus({ id: request.id, status: request.status }),
          ),
        },
      }
    case 'invoice.confirm_invoice': {
      // The schema function asserts a serializable transaction; the capture's call sites
      // always supply one, so a standalone replay opens its own.
      const call = (trx) =>
        repository.invoice.confirmInvoice(
          request.invoice_id,
          BigInt(request.amount_received),
          date(request.confirmed_at),
          trx,
        )
      if (inTransaction) {
        await call(repository.master)
      } else {
        await db.transaction(call, { isolationLevel: 'serializable' })
      }
      return { compare: { ok: true } }
    }
    case 'invoice.find_pending_invoices':
      return {
        compare: {
          invoices: (await repository.invoice.findPendingInvoices(request.offset, request.limit))
            .map(invoiceView),
        },
      }
    case 'nip05.find_by_pubkey':
      return {
        compare: { verification: nip05View(await repository.nip05.findByPubkey(request.pubkey)) },
      }
    case 'nip05.upsert': {
      const verification = {
        pubkey: request.verification.pubkey,
        nip05: request.verification.nip05,
        domain: request.verification.domain,
        isVerified: request.verification.is_verified,
        lastVerifiedAt:
          request.verification.last_verified_at === null
            ? null
            : date(request.verification.last_verified_at),
        lastCheckedAt: date(request.verification.last_checked_at),
        failureCount: request.verification.failure_count,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
      return { compare: { count: await repository.nip05.upsert(verification) } }
    }
    case 'nip05.find_pending_verifications':
      return {
        compare: {
          verifications: (
            await repository.nip05.findPendingVerifications(
              request.update_frequency_ms,
              request.max_failures,
              request.limit,
            )
          ).map(nip05View),
        },
      }
    case 'nip05.delete_by_pubkey':
      return { compare: { count: await repository.nip05.deleteByPubkey(request.pubkey) } }
    case 'invite.create': {
      const options = {
        expiresAt: request.options.expires_at == null ? null : date(request.options.expires_at),
        remainingUses: fieldUpdateIn(request.options.remaining_uses ?? { kind: 'absent' }),
        createdBy: request.options.created_by ?? null,
      }
      return { compare: { invite: inviteView(await repository.invite.create(request.code, options)) } }
    }
    case 'invite.find_by_code': {
      const row = await repository.invite.findByCode(request.code)
      return { compare: { invite: row === undefined ? null : inviteView(row) } }
    }
    case 'invite.claim_code':
      return {
        compare: { value: await repository.invite.claimCode(request.code, request.pubkey) },
      }
    case 'invite.find_active_codes':
      return {
        compare: {
          invites: (await repository.invite.findActiveCodes(request.limit))
            .map(inviteView)
            .sort(byInviteCode),
        },
      }
    case 'invite.delete_expired_codes':
      return { compare: { count: await repository.invite.deleteExpiredCodes() } }
    case 'dvm.create':
      return {
        compare: {
          job: dvmView(await repository.dvm.create(request.id, request.requester, request.kind)),
        },
      }
    case 'dvm.find_by_id': {
      const row = await repository.dvm.findById(request.id)
      return { compare: { job: row === undefined ? null : dvmView(row) } }
    }
    case 'dvm.assign_worker':
      return {
        compare: {
          value: await repository.dvm.assignWorker(request.id, request.worker_index),
        },
      }
    case 'dvm.update_status': {
      const update = { id: request.update.id, status: request.update.status }
      const resultEventId = fieldUpdateIn(request.update.result_event_id)
      if (resultEventId !== undefined) update.resultEventId = resultEventId
      const error = fieldUpdateIn(request.update.error)
      if (error !== undefined) update.error = error
      const row = await repository.dvm.updateStatus(update)
      return { compare: { job: row === undefined ? null : dvmView(row) } }
    }
    case 'dvm.find_pending_jobs': {
      const rows = await repository.dvm.findPendingJobs(request.limit, request.kinds)
      return { compare: { jobs: rows.map(dvmView).sort(byDvmId) } }
    }
    case 'report.create': {
      const report = {
        eventId: request.report.event_id,
        reporterPubkey: request.report.reporter_pubkey,
        reportedPubkey: request.report.reported_pubkey,
        reportedEventId: request.report.reported_event_id,
        reportType: request.report.report_type,
        weight: request.report.weight,
        actionable: request.report.actionable,
      }
      return { compare: { report: reportView(await repository.report.create(report)) } }
    }
    case 'report.create_many': {
      const reports = request.reports.map((report) => ({
        eventId: report.event_id,
        reporterPubkey: report.reporter_pubkey,
        reportedPubkey: report.reported_pubkey,
        reportedEventId: report.reported_event_id,
        reportType: report.report_type,
        weight: report.weight,
        actionable: report.actionable,
      }))
      return {
        compare: {
          reports: (await repository.report.createMany(reports)).map(reportView).sort(byReportId),
        },
      }
    }
    case 'report.find_by_event_id':
      return {
        compare: {
          reports: (await repository.report.findByEventId(request.event_id))
            .map(reportView)
            .sort(byReportId),
        },
      }
    case 'report.find_actionable':
      return {
        compare: {
          reports: (await repository.report.findActionable(request.limit))
            .map(reportView)
            .sort(byReportId),
        },
      }
    case 'report.find_actionable_targets':
      return {
        compare: {
          targets: (await repository.report.findActionableTargets())
            .map((target) => ({
              reported_pubkey: target.reportedPubkey,
              reported_event_id: target.reportedEventId,
            }))
            .sort(byKey((target) => `${target.reported_pubkey}/${target.reported_event_id}`)),
        },
      }
    case 'delivery_log.append':
      return {
        compare: {
          ok: await repository.delivery
            .append({
              outboxId: request.entry.outbox_id_from
                ? resolveId({ enqueue_event_type: request.entry.outbox_id_from })
                : request.entry.outbox_id,
              eventType: request.entry.event_type,
              targetId: request.entry.target_id,
              targetType: request.entry.target_type,
              status: request.entry.status,
              attemptNumber: request.entry.attempt_number,
              errorSnippet: request.entry.error_snippet,
            })
            .then(() => true),
        },
      }
    case 'delivery_log.find_recent': {
      const filters = {}
      if (request.filters.status) filters.status = request.filters.status
      if (request.filters.event_type) filters.eventType = request.filters.event_type
      return {
        compare: {
          entries: (await repository.delivery.findRecent(request.limit, filters))
            .map(deliveryView)
            .sort(byDelivery),
        },
      }
    }
    case 'delivery_log.find_successful_target_ids': {
      const outboxId = request.outbox_id_from
        ? resolveId({ enqueue_event_type: request.outbox_id_from })
        : request.outbox_id
      return {
        compare: {
          target_ids: (await repository.delivery.findSuccessfulTargetIds(outboxId)).sort(),
        },
      }
    }
    case 'delivery_log.delete_older_than':
      return {
        compare: {
          count: await repository.delivery.deleteOlderThan(date(request.cutoff)),
        },
      }
    case 'outbox.enqueue':
      return {
        compare: { message: outboxView(await repository.outbox.enqueue(request.event_type, request.payload)) },
        ref: null, // filled below from the returned row
      }
    case 'outbox.claim_batch':
      return {
        compare: {
          messages: (await repository.outbox.claimBatch(request.limit)).map(outboxView).sort(byOutboxType),
        },
      }
    case 'outbox.mark_delivered':
      return {
        compare: {
          ok: await repository.outbox.markDelivered(resolveId(request)).then(() => true),
        },
      }
    case 'outbox.mark_failed':
      return {
        compare: {
          ok: await repository.outbox
            .markFailed(
              resolveId(request),
              request.error,
              request.attempt_count,
              request.max_attempts,
              request.base_delay_ms,
            )
            .then(() => true),
        },
      }
    case 'outbox.delete_terminal_older_than':
      return {
        compare: {
          count: await repository.outbox.deleteTerminalOlderThan(date(request.cutoff)),
        },
      }
    default:
      throw new Error(`unknown op ${op.op}`)
  }
}

// `enqueue_event_type` addresses the row an earlier enqueue created; both sides keep the id
// in a side channel, so the compared projection stays deterministic.
const refs = new Map()
const resolveId = (request) => {
  const value = refs.get(request.enqueue_event_type)
  if (!value) throw new Error(`no id ref for ${request.enqueue_event_type}`)
  return value
}

const runOp = async (op, client) => {
  const result = await run(op, client)
  if (op.op === 'outbox.enqueue') {
    const message = result.compare.message
    // The id is not part of the comparison; it is needed to address the row later.
    const row = await client('notification_outbox')
      .where({ event_type: message.event_type })
      .orderBy('created_at', 'desc')
      .first()
    result.ref = { id: row.id }
    refs.set(message.event_type, row.id)
  }
  return result
}

const runTransaction = async (op) => {
  const executed = []
  let failedAt = null
  try {
    await db.transaction(async (trx) => {
      for (const [index, nested] of op.request.ops.entries()) {
        try {
          executed.push(await run(nested, trx, true))
        } catch (error) {
          failedAt = index
          throw error
        }
      }
    }, { isolationLevel: 'serializable' })
  } catch (error) {
    if (failedAt === null) throw error
  }
  return failedAt === null
    ? { compare: { failed: false, results: executed.map((entry) => entry.compare) } }
    : { compare: { failed: true, at: failedAt } }
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

const db = knex({ client: 'pg', connection: process.env.DATABASE_URI })

const main = async () => {
  const [, applied] = await db.migrate.latest({ directory: path.join(cwd, 'migrations') })

  // The corpus goes in through createMany, exactly as the Rust side inserts it.
  const corpusRecords = corpus.map((entry) => {
    const record = { event: entry.event }
    if (entry.remote_address) record.remote_address = entry.remote_address
    if (entry.expires_at) record.expires_at = entry.expires_at
    if (entry.deduplication) record.deduplication = entry.deduplication
    return record
  })
  await new EventRepository(db, db, getSettings).createMany(corpusRecords.map(eventFromJson))

  for (const op of script) {
    op.result = op.op === 'transaction' ? await runTransaction(op) : await runOp(op, db)
  }

  const excluded = ['knex_migrations', 'knex_migrations_lock', '_sqlx_migrations']
  const notIn = excluded.map((name) => `'${name}'`).join(',')
  const queries = {
    columns: `
      SELECT table_name, column_name, ordinal_position::int AS position, data_type,
             udt_name, is_nullable, column_default,
             character_maximum_length::int AS max_length,
             numeric_precision::int AS numeric_precision,
             numeric_scale::int AS numeric_scale,
             datetime_precision::int AS datetime_precision
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name NOT IN (${notIn})
      ORDER BY table_name, ordinal_position`,
    indexes: `
      SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename NOT IN (${notIn})
      ORDER BY tablename, indexname`,
    constraints: `
      SELECT c.relname AS table_name, con.conname AS constraint_name,
             pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname NOT IN (${notIn})
      ORDER BY c.relname, con.conname`,
    functions: `
      SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS identity_arguments,
             pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`,
    triggers: `
      SELECT c.relname AS table_name, t.tgname AS trigger_name, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public'
      ORDER BY c.relname, t.tgname`,
    extensions: `
      SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname`,
    sequences: `
      SELECT sequence_name AS name, data_type, start_value::text, minimum_value::text,
             maximum_value::text, increment::text, cycle_option
      FROM information_schema.sequences
      WHERE sequence_schema = 'public'
        AND sequence_name NOT LIKE 'knex_migrations%'
      ORDER BY sequence_name`,
  }

  // Each entry is an array in the same field order the Rust test emits, so the fixture is a
  // representation the replay can compare structurally.
  const shapes = {
    columns: [
      'table_name', 'column_name', 'position', 'data_type', 'udt_name', 'is_nullable',
      'column_default', 'max_length', 'numeric_precision', 'numeric_scale', 'datetime_precision',
    ],
    indexes: ['table_name', 'index_name', 'definition'],
    constraints: ['table_name', 'constraint_name', 'definition'],
    functions: ['name', 'identity_arguments', 'definition'],
    triggers: ['table_name', 'trigger_name', 'definition'],
    extensions: ['name', 'version'],
    sequences: [
      'name', 'data_type', 'start_value', 'minimum_value', 'maximum_value', 'increment',
      'cycle_option',
    ],
  }
  const subject = {
    repo: 'cameri/nostream',
    capture_commit: '242a3001d77149e4d70151ec03060c4ef44a1547',
    generator: 'crates/nostream-storage/tests/capture/gen-storage-parity.mjs',
    generated_on: new Date().toISOString().slice(0, 10),
    server_image: 'postgres:16-alpine (PostgreSQL 16.15)',
    migration_command: 'knex migrate:latest',
    migration_count: applied.length,
  }
  const schema = { subject }
  for (const [key, sql] of Object.entries(queries)) {
    schema[key] = (await db.raw(sql)).rows.map((row) =>
      shapes[key].map((field) => (row[field] === undefined ? null : row[field])),
    )
  }

  const fixture = {
    subject: {
      repo: 'cameri/nostream',
      capture_commit: '242a3001d77149e4d70151ec03060c4ef44a1547',
      generator: 'crates/nostream-storage/tests/capture/gen-storage-parity.mjs',
      generated_on: new Date().toISOString().slice(0, 10),
      server_image: 'postgres:16-alpine (PostgreSQL 16.15)',
      timezone: 'UTC',
      migration_command: 'knex migrate:latest',
      migration_count: applied.length,
    },
    settings: {
      overrides: Object.fromEntries(SETTINGS_OVERRIDES),
      source: 'resources/default-settings.yaml',
    },
    corpus,
    script: script.map((op) => ({ op: op.op, request: op.request, result: op.result })),
    projection: {
      event_row: '[event_id, created_at, expires_at, deleted_at.is_some(), event_deduplication]',
      dropped_timestamps:
        'first_seen, updated_at, created_at of rows whose created_at the call generated, ' +
        'delivered_at, available_at, picked_up_at, completed_at',
      sorted_lists:
        'reports (by id), dvm jobs (by id), invite codes (by code), delivery log ' +
        '(by target_id/attempt_number), outbox messages (by event_type)',
      transaction:
        'a group result is {failed, at} or {failed, results}; the failing op is ' +
        'confirm_invoice with an amount that overflows int8',
    },
  }

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'schema.json'), JSON.stringify(schema, null, 2) + '\n')
  fs.writeFileSync(
    path.join(outDir, 'repository-parity.json'),
    JSON.stringify(fixture, null, 2) + '\n',
  )
  console.log(
    `wrote schema.json and repository-parity.json (${script.length} ops, ` +
      `${corpus.length} corpus events, ${applied.length} migrations)`,
  )
  await db.destroy()
}

main().catch(async (error) => {
  console.error(error)
  await db.destroy()
  process.exit(1)
})
