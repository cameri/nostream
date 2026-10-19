// Regenerates ../fixtures/ts-events.json — 1,000 events and 50 negative events measured
// through the capture's own TypeScript pipeline.
//
// Subject: cameri/nostream at 242a3001d77149e4d70151ec03060c4ef44a1547 — the capture
// commit this branch is cut from. The harness MUST run with that tree as its working
// directory, because it imports <cwd>/src/utils/event.ts through ts-node.
//
// One-time setup, in a scratch directory (never in the working tree):
//   git archive 242a3001 | tar -x -C /tmp/nostream-capture-006
//   cd /tmp/nostream-capture-006 && pnpm install --frozen-lockfile
//
// Run, from the capture tree, with this file's absolute path and an absolute output path —
// relative paths would resolve against the capture tree, not the worktree:
//   cd /tmp/nostream-capture-006
//   node /path/to/nostream/crates/nostream-core/tests/capture/gen-ts-events.mjs \
//     > /path/to/nostream/crates/nostream-core/tests/fixtures/ts-events.json
//
// The measurement is deterministic: the sample comes from a fixed PRNG seed, and every
// signature uses `aux = sha256("nostream-006:" + index)` rather than the capture's
// `signEvent`, whose noble default is a random aux. The id and every decision still come
// from the capture's own functions (`getEventHash`, `identifyEvent`, `isEventIdValid`,
// `isEventSignatureValid`, `isEventMatchingFilter`, `getEventProofOfWork`,
// `serializeEvent`), which is what makes a regeneration byte-identical to the committed
// file. The sample rules are enforced below: a violation exits non-zero rather than
// writing a fixture the Rust side would grade against a weaker table.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const SUBJECT = '242a3001d77149e4d70151ec03060c4ef44a1547'
const SEED = 'nostream-006'
const EVENT_COUNT = 1000
const NEGATIVE_COUNT = 50
const BASE_TIMESTAMP = 1700000000
const WINDOW = 1000000

// A capture tree is the TypeScript-only tree at `242a3001`: the Rust workspace does not
// exist there yet (`crates/` arrives at `ed31da2`), so its presence means this is the
// rewrite checkout, whose `src/` is a different tree and whose decisions would be graded
// as the capture's.
const cwd = process.cwd()
const eventModule = path.join(cwd, 'src/utils/event.ts')
const isCaptureTree =
  existsSync(eventModule) &&
  existsSync(path.join(cwd, 'package.json')) &&
  !existsSync(path.join(cwd, 'crates'))
if (!isCaptureTree) {
  console.error(
    `run this from a capture tree (cwd=${cwd}); src/utils/event.ts must exist and crates/ must not`,
  )
  process.exit(2)
}

const require = createRequire(path.join(cwd, 'package.json'))
require('ts-node/register/transpile-only')
const {
  getEventProofOfWork,
  identifyEvent,
  isEventIdValid,
  isEventMatchingFilter,
  isEventSignatureValid,
  serializeEvent,
} = require(eventModule)
const secp256k1 = require('@noble/secp256k1')

const sha256 = (...parts) => createHash('sha256').update(parts.join('')).digest()
const hex = (bytes) => Buffer.from(bytes).toString('hex')
const secretFor = (index) => `${'00'.repeat(31)}${index.toString(16).padStart(2, '0')}`
const publicFor = (index) => hex(secp256k1.getPublicKey(secretFor(index), true).subarray(1))

const mulberry32 = (seed) => {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const seedValue = Number.parseInt(hex(sha256(SEED)).slice(0, 8), 16)
const random = mulberry32(seedValue)
const nextInt = (bound) => Math.floor(random() * bound)
const pick = (values) => values[nextInt(values.length)]

const SECRETS = Array.from({ length: 8 }, (_, index) => secretFor(index + 1))
const PUBKEYS = SECRETS.map((_, index) => publicFor(index + 1))
const KINDS = [0, 1, 3, 5, 7, 13, 14, 15, 62, 443, 444, 445, 1059, 1111, 10002, 20000, 30023, 31989]
const GEOHASHES = ['u4pruydqqvj', 'u4pruydm2s4', 'u4pruz0h1b2', '9q8yyk8ytpx']
const CONTENTS = [
  '',
  'bitcoin and lightning',
  'nostr relay engineering',
  'he said "hello"',
  'back\\slash',
  'control \u0001 and \u001f characters',
  'del \u007f and line separator \u2028 inside',
  'emoji 😀🚀',
  'Bitcoin is not Ethereum',
  'plain text note',
]

const events = []
const ids = []
let firstETag = null
let firstATag = null

for (let index = 0; index < EVENT_COUNT; index++) {
  const tags = []

  if (index > 1 && index % 2 === 0) {
    tags.push(['e', ids[(index * 37) % index]])
  }
  if (index % 3 === 0) {
    tags.push(['p', PUBKEYS[index % PUBKEYS.length]])
    tags.push(['g', GEOHASHES[index % GEOHASHES.length]])
  }
  if (index % 7 === 0) {
    tags.push(['d', ''])
  } else if (index % 11 === 0) {
    tags.push(['d', `dtag-${index % 4}`])
  }
  if (index % 4 === 0) {
    tags.push(['a', `30023:${PUBKEYS[index % PUBKEYS.length]}:post-${index % 4}`])
  }
  if (index % 6 === 0) {
    tags.push(['expiration', String(BASE_TIMESTAMP + 100000 + nextInt(200000))])
  }
  if (index % 5 === 0) {
    tags.push(['t', 'nostr'])
  } else if (index % 13 === 0) {
    tags.push(['t', pick(['bitcoin', 'test'])])
  }
  if (index % 9 === 0) {
    tags.push(['r', `https://example.com/${nextInt(10)}`])
  }
  if (index % 17 === 0) {
    tags.push(['-'])
  }

  const authorIndex = nextInt(SECRETS.length)
  const draft = {
    pubkey: PUBKEYS[authorIndex],
    created_at: BASE_TIMESTAMP + nextInt(WINDOW),
    kind: pick(KINDS),
    tags,
    content: pick(CONTENTS),
  }

  const identified = await identifyEvent(draft)
  const aux = sha256(`${SEED}:`, String(index))
  const signature = await secp256k1.schnorr.sign(identified.id, SECRETS[authorIndex], aux)

  const event = { ...identified, sig: hex(signature) }

  for (const tag of tags) {
    if (tag[0] === 'e' && firstETag === null) firstETag = tag[1]
    if (tag[0] === 'a' && firstATag === null) firstATag = tag[1]
  }

  events.push(event)
  ids.push(event.id)
}

const FILTERS = [
  { label: 'empty', filter: {} },
  { label: 'limit_only', filter: { limit: 50 } },
  { label: 'kind_text_note', filter: { kinds: [1] } },
  { label: 'kinds_text_reaction_giftwrap', filter: { kinds: [1, 7, 1059] } },
  { label: 'author_prefix', filter: { authors: [PUBKEYS[0].slice(0, 8)] } },
  { label: 'id_prefix', filter: { ids: [ids[0].slice(0, 4)] } },
  { label: 'since_midpoint', filter: { since: BASE_TIMESTAMP + WINDOW / 2 } },
  { label: 'until_midpoint', filter: { until: BASE_TIMESTAMP + WINDOW / 2 } },
  { label: 'e_tag', filter: { '#e': [firstETag] } },
  { label: 'p_tag', filter: { '#p': [PUBKEYS[1]] } },
  { label: 'd_tag_empty', filter: { '#d': [''] } },
  { label: 'a_tag', filter: { '#a': [firstATag] } },
  { label: 'g_prefix_wildcard', filter: { '#g': [`${GEOHASHES[0].slice(0, 6)}*`] } },
  { label: 'search', filter: { search: 'bitcoin' } },
  { label: 't_tag', filter: { '#t': ['nostr'] } },
  { label: 'multi_letter_key_ignored', filter: { '#expiration': [String(BASE_TIMESTAMP)] } },
]

const MATCH_ALL = new Set(['empty', 'limit_only', 'multi_letter_key_ignored'])

const describe = async (event) => ({
  event,
  serialized: JSON.stringify(serializeEvent(event)),
  id_ok: await isEventIdValid(event),
  sig_ok: await isEventSignatureValid(event),
  pow: getEventProofOfWork(event.id),
  matches: FILTERS.map(({ filter }) => isEventMatchingFilter(filter)(event)),
})

const entries = []
for (const event of events) {
  entries.push(await describe(event))
}

const unvalidated = entries.filter((entry) => !entry.id_ok || !entry.sig_ok)
if (unvalidated.length !== 0) {
  console.error(`${unvalidated.length} sampled events do not validate their id and signature`)
  process.exit(4)
}

const filters = FILTERS.map(({ label, filter }, position) => {
  const trueCount = entries.filter((entry) => entry.matches[position]).length

  if (MATCH_ALL.has(label)) {
    if (trueCount !== EVENT_COUNT) {
      console.error(`match-all filter ${label} matched ${trueCount} of ${EVENT_COUNT}`)
      process.exit(3)
    }
  } else if (trueCount === 0 || trueCount === EVENT_COUNT) {
    console.error(`filter ${label} matched ${trueCount} of ${EVENT_COUNT}; needs both decisions`)
    process.exit(3)
  }

  return { label, filter, true_count: trueCount }
})

const negatives = []

const mutateId = (event) => {
  const characters = event.id.split('')
  const last = characters.length - 1
  characters[last] = characters[last] === '0' ? '1' : '0'
  return { ...event, id: characters.join('') }
}

const mutateContent = (event) => ({ ...event, content: `${event.content} (mutated)` })

for (let offset = 0; offset < NEGATIVE_COUNT / 2; offset++) {
  negatives.push(await describe(mutateId(events[100 + offset])))
}
for (let offset = 0; offset < NEGATIVE_COUNT / 2; offset++) {
  negatives.push(await describe(mutateContent(events[200 + offset])))
}

const broken = negatives.filter((entry) => entry.id_ok || entry.sig_ok === undefined)
if (broken.length !== 0) {
  console.error(`${broken.length} negative events still validate their id`)
  process.exit(4)
}

const idMutated = negatives.slice(0, NEGATIVE_COUNT / 2)
const contentMutated = negatives.slice(NEGATIVE_COUNT / 2)
if (idMutated.some((entry) => entry.sig_ok) || contentMutated.some((entry) => !entry.sig_ok)) {
  console.error('the 25 id mutations must fail verification and the 25 content mutations must pass it')
  process.exit(5)
}

const fixture = {
  subject: SUBJECT,
  generated_by: 'crates/nostream-core/tests/capture/gen-ts-events.mjs',
  seed: SEED,
  event_count: entries.length,
  negative_count: negatives.length,
  filters,
  events: entries,
  negative_events: negatives,
}

process.stdout.write(JSON.stringify(fixture))
