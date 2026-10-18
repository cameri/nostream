// Regenerates the `cases` array of ../fixtures/ts-issues.json from the TypeScript validator.
//
// Subject: cameri/nostream at 242a3001d77149e4d70151ec03060c4ef44a1547 — the capture commit
// this branch is cut from. The harness MUST run with that tree as its working directory,
// because loadDefaults() reads <cwd>/resources/default-settings.yaml.
//
// One-time setup, in a scratch directory (never in the working tree):
//   git archive 242a3001 | tar -x -C /tmp/nostream-capture
//   cd /tmp/nostream-capture && pnpm install --frozen-lockfile
//
// Run, from the capture tree, with this file's absolute path:
//   cd /tmp/nostream-capture
//   node <this file> > /tmp/ts-issues.cases.json
//
// Merge the printed array into `cases` and leave `subject`/`deferred` untouched: those are
// metadata about this job, not measurements. The cases below are the probe statements the job
// grades; none may be removed or renamed without regenerating and stating why.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'

const cwd = process.cwd()
const settingsModule = path.join(cwd, 'src/utils/settings-config.ts')
if (!existsSync(settingsModule) || !existsSync(path.join(cwd, 'resources/default-settings.yaml'))) {
  console.error(`run this from the capture tree (cwd=${cwd}); src/utils/settings-config.ts or resources/default-settings.yaml is missing`)
  process.exit(2)
}

// Resolve ts-node from the capture tree, not from this script's own directory: the setup
// above installs the dependencies in `cwd`, and a rewrite checkout with no `node_modules` of
// its own has nothing beside this file to resolve.
const require = createRequire(path.join(cwd, 'package.json'))
require('ts-node/register/transpile-only')
const { loadDefaults, setByPath, validateSettings } = require(settingsModule)

const deleteByPath = (document, dotted) => {
  const segments = dotted.split('.')
  const last = segments.pop()
  const parentPath = segments
    .join('.')
    .replace(/\[(\d+)\]/g, '.$1')
  const parent = parentPath ? parentPath.split('.').reduce((node, key) => node?.[key], document) : document
  if (parent && typeof parent === 'object') {
    delete parent[last]
  }
  return document
}

const CASES = [
  { name: 'defaults', mutations: [] },
  { name: 'backend_lmdb', mutations: [{ op: 'set', path: 'eventStore.backend', value: 'lmdb' }] },
  {
    name: 'pow_floor_gt_ceiling',
    mutations: [
      { op: 'set', path: 'limits.event.pow.enabled', value: true },
      { op: 'set', path: 'limits.event.pow.floorBits', value: 16 },
      { op: 'set', path: 'limits.event.pow.ceilingBits', value: 8 },
    ],
  },
  {
    name: 'pow_period_zero',
    mutations: [
      { op: 'set', path: 'limits.event.pow.enabled', value: true },
      { op: 'set', path: 'limits.event.pow.periodMs', value: 0 },
    ],
  },
  {
    name: 'pow_target_zero',
    mutations: [
      { op: 'set', path: 'limits.event.pow.enabled', value: true },
      { op: 'set', path: 'limits.event.pow.targetEventsPerSecond', value: 0 },
    ],
  },
  {
    name: 'conn_rate_limit_period_zero',
    mutations: [{ op: 'set', path: 'limits.connection.rateLimits[0].period', value: 0 }],
  },
  {
    name: 'telegram_missing_creds',
    mutations: [{ op: 'set', path: 'admin.notifications.targets', value: [{ id: 't1', type: 'telegram', enabled: true }] }],
  },
  {
    name: 'duplicate_target_id',
    mutations: [
      {
        op: 'set',
        path: 'admin.notifications.targets',
        value: [
          { id: 'dup', type: 'http', enabled: true, url: 'https://a.example' },
          { id: 'dup', type: 'http', enabled: true, url: 'https://b.example' },
        ],
      },
    ],
  },
  {
    name: 'target_bad_url',
    mutations: [{ op: 'set', path: 'admin.notifications.targets', value: [{ id: 'w1', type: 'http', url: 'ftp://bad.example' }] }],
  },
  {
    name: 'target_url_bad_port',
    mutations: [{ op: 'set', path: 'admin.notifications.targets', value: [{ id: 'w1', type: 'http', url: 'https://hooks.example:99999/hook' }] }],
  },
  {
    name: 'target_url_bad_host',
    mutations: [{ op: 'set', path: 'admin.notifications.targets', value: [{ id: 'w1', type: 'discord', url: 'https://bad host/hook' }] }],
  },
  { name: 'unknown_top_level', mutations: [{ op: 'set', path: 'bogusSection', value: {} }] },
  { name: 'unknown_nested_key', mutations: [{ op: 'set', path: 'info.unknownKey', value: 1 }] },
  { name: 'wrong_type_workers_count', mutations: [{ op: 'set', path: 'workers.count', value: 'four' }] },
  { name: 'missing_name', mutations: [{ op: 'delete', path: 'info.name' }] },
  { name: 'missing_relay_url', mutations: [{ op: 'delete', path: 'info.relay_url' }] },
  { name: 'bad_strategy', mutations: [{ op: 'set', path: 'limits.rateLimiter.strategy', value: 'random' }] },
  { name: 'nip77_present', mutations: [{ op: 'set', path: 'nip77', value: { enabled: true } }] },
  { name: 'relay_url_ftp', mutations: [{ op: 'set', path: 'info.relay_url', value: 'ftp://relay.example.com' }] },
]

const EXEMPT = {
  backend_lmdb: {
    paths: ['eventStore.backend'],
    reason:
      "D7: the rewrite's target backend is LMDB, so the Rust validator accepts lmdb and rejects only values outside {postgres, lmdb}. Path-scoped, not case-scoped.",
  },
}

const output = CASES.map((entry) => {
  let settings = structuredClone(loadDefaults())
  for (const mutation of entry.mutations) {
    settings =
      mutation.op === 'set'
        ? setByPath(settings, mutation.path, structuredClone(mutation.value))
        : deleteByPath(settings, mutation.path)
  }

  const issues = validateSettings(settings).map(({ path: issuePath, message }) => ({ path: issuePath, message }))
  const exemption = EXEMPT[entry.name]
  return {
    name: entry.name,
    mutations: entry.mutations,
    ts_issues: issues,
    rust_exempt_paths: exemption ? exemption.paths : [],
    ...(exemption ? { exempt_reason: exemption.reason } : {}),
  }
})

console.log(JSON.stringify(output, null, 2))
