// Regenerates ../fixtures/ts-cases.json: the census of unit cases this job must carry.
//
// Subject: cameri/nostream at 242a3001d77149e4d70151ec03060c4ef44a1547 — the capture commit
// this branch is cut from. The harness MUST run with that tree as its working directory: it
// loads the spec files from <cwd>/test and the modules they import from <cwd>/src.
//
// One-time setup, in a scratch directory (never in the working tree):
//   git archive 242a3001 | tar -x -C /tmp/nostream-capture
//   ln -s <primary checkout>/node_modules /tmp/nostream-capture/node_modules
//
// Run, from the capture tree:
//   NODE_OPTIONS=--no-experimental-strip-types TS_NODE_TRANSPILE_ONLY=true \
//     node <this file> [--out-dir <worktree>/crates/nostream-relay/tests/fixtures]
//
// The generator runs mocha with its JSON reporter over the 36 in-scope spec files, checks each
// file's case count against the table below (the spec's Context table, measured at the capture),
// and writes one row per file with every case's full title. `ts-case-map.json` maps those titles
// to the Rust tests that carry them; `tests/ts_case_parity.rs` holds the two files against each
// other.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const CAPTURE = '242a3001d77149e4d70151ec03060c4ef44a1547'

// The spec's Context table: the 36 in-scope files and their measured case counts.
const FILES = [
  ['test/unit/handlers/event-message-handler.spec.ts', 200],
  ['test/unit/handlers/subscribe-message-handler.spec.ts', 58],
  ['test/unit/handlers/count-message-handler.spec.ts', 10],
  ['test/unit/handlers/auth-message-handler.spec.ts', 12],
  ['test/unit/handlers/unsubscribe-message-handler.spec.ts', 1],
  ['test/unit/handlers/event-strategies/contact-list-event-strategy.spec.ts', 7],
  ['test/unit/handlers/event-strategies/default-event-strategy.spec.ts', 4],
  ['test/unit/handlers/event-strategies/delete-event-strategy.spec.ts', 6],
  ['test/unit/handlers/event-strategies/dvm-job-request-event-strategy.spec.ts', 6],
  ['test/unit/handlers/event-strategies/ephemeral-event-strategy.spec.ts', 1],
  ['test/unit/handlers/event-strategies/gift-wrap-event-strategy.spec.ts', 9],
  ['test/unit/handlers/event-strategies/group-event-strategy.spec.ts', 12],
  ['test/unit/handlers/event-strategies/invite-request-event-strategy.spec.ts', 2],
  ['test/unit/handlers/event-strategies/join-request-event-strategy.spec.ts', 8],
  ['test/unit/handlers/event-strategies/leave-request-event-strategy.spec.ts', 8],
  ['test/unit/handlers/event-strategies/parameterized-replaceable-event-strategy.spec.ts', 6],
  ['test/unit/handlers/event-strategies/replaceable-event-strategy.spec.ts', 4],
  ['test/unit/handlers/event-strategies/report-event-strategy.spec.ts', 16],
  ['test/unit/handlers/event-strategies/timestamp-event-strategy.spec.ts', 13],
  ['test/unit/handlers/event-strategies/vanish-event-strategy.spec.ts', 3],
  ['test/unit/adapters/web-socket-adapter.spec.ts', 60],
  ['test/unit/adapters/web-socket-server-adapter.spec.ts', 17],
  ['test/unit/utils/nip42.spec.ts', 27],
  ['test/unit/utils/nip42-session.spec.ts', 9],
  ['test/unit/utils/messages.spec.ts', 14],
  ['test/unit/utils/filter.spec.ts', 9],
  ['test/unit/utils/ewma-rate-limiter.spec.ts', 6],
  ['test/unit/utils/sliding-window-rate-limiter.spec.ts', 3],
  ['test/unit/factories/event-strategy-factory.spec.ts', 25],
  ['test/unit/factories/message-handler-factory.spec.ts', 6],
  ['test/unit/factories/websocket-adapter-factory.spec.ts', 1],
  ['test/unit/schemas/event-schema.spec.ts', 57],
  ['test/unit/schemas/message-schema.spec.ts', 17],
  ['test/unit/utils/hidden-content-cache.spec.ts', 12],
  ['test/unit/utils/shutdown-state.spec.ts', 5],
  ['test/unit/utils/validation.spec.ts', 4],
]

const cwd = process.cwd()
const isCaptureTree =
  fs.existsSync(path.join(cwd, 'src/utils/messages.ts')) &&
  fs.existsSync(path.join(cwd, 'test/unit/handlers/event-message-handler.spec.ts')) &&
  !fs.existsSync(path.join(cwd, 'crates'))
if (!isCaptureTree) {
  console.error(
    `run this from the capture tree (cwd=${cwd}); src/utils/messages.ts must exist and crates/ must not`,
  )
  process.exit(2)
}

const outDirFlag = process.argv.indexOf('--out-dir')
const outDir =
  outDirFlag === -1
    ? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../fixtures')
    : path.resolve(process.argv[outDirFlag + 1])

const report = path.join(fs.mkdtempSync('/tmp/census-'), 'report.json')

execFileSync(
  './node_modules/.bin/mocha',
  [
    '--no-config',
    '--reporter',
    'json',
    '--reporter-option',
    `output=${report}`,
    '-r',
    'ts-node/register',
    ...FILES.map(([file]) => file),
  ],
  { stdio: ['ignore', 'ignore', 'inherit'], env: process.env },
)

const runner = JSON.parse(fs.readFileSync(report, 'utf8'))

const byFile = new Map(FILES.map(([file]) => [file, []]))
for (const test of runner.tests) {
  const file = test.file.replace(/^.*?\/test\//, 'test/')
  if (!byFile.has(file)) {
    console.error(`a case ran from a file outside the census: ${file}`)
    process.exit(1)
  }
  byFile.get(file).push(test.fullTitle)
}

const files = []
let total = 0
for (const [file, expected] of FILES) {
  const titles = byFile.get(file)

  if (titles.length !== expected) {
    console.error(`${file}: ${titles.length} cases, the Context table says ${expected}`)
    process.exit(1)
  }

  files.push({ file, cases: titles.length, titles })
  total += titles.length
}

const fixture = {
  capture: CAPTURE,
  generated_by: 'crates/nostream-relay/tests/capture/gen-ts-cases.mjs',
  total,
  files,
}

const target = path.join(outDir, 'ts-cases.json')
fs.writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`)

console.log(`${total} cases from ${files.length} files -> ${target}`)
