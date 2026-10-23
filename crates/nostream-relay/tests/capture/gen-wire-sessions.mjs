// Regenerates ../fixtures/wire-sessions.json: the frame-session recording the Rust relay is
// replayed against (R31).
//
// Subject: cameri/nostream at 242a3001d77149e4d70151ec03060c4ef44a1547 — the capture commit
// this branch is cut from. The harness MUST run with that tree as its working directory,
// because it loads the capture's real adapters, handlers and shipped settings from <cwd>.
//
// One-time setup, in a scratch directory (never in the working tree):
//   git archive 242a3001 | tar -x -C /tmp/nostream-capture
//   ln -s <primary checkout>/node_modules /tmp/nostream-capture/node_modules
//
// Run, from the capture tree:
//   NODE_OPTIONS=--no-experimental-strip-types TS_NODE_TRANSPILE_ONLY=true \
//     node -r ts-node/register <this file> [--out-dir <worktree>/crates/nostream-relay/tests/fixtures]
//
// What it does. For each of the sixteen sessions R31 names, it:
//   1. installs the session's settings document over the capture's shipped defaults,
//   2. stands up the real WebSocketServerAdapter + WebSocketAdapter + five per-message
//      handlers on 127.0.0.1:0 over in-memory repository doubles,
//   3. connects one `ws` client and replays the session's script one step at a time,
//      recording every frame the relay sent, in order,
//   4. records the session's settings, its steps, and the interval or close the session needs.
//
// Determinism (R29). The clock is frozen at CLOCK_START_MS with `node:test`'s mocked `Date`, and
// `crypto.randomBytes` is replaced with SplitMix64 over SEED — the stream
// `nostream_core::random::SeededRandom` implements byte for byte. The one client frame that
// carries the NIP-42 challenge records it as `{{challenge}}`, and the server's AUTH frame masks
// it the same way, so the replay proves the relay verifies its own challenge. Because both
// sides draw the same challenge, the recorded AUTH event's id and signature stay valid in the
// replay; a divergence in the stream shows up as a failed AUTH, not a silent pass.
//
// Client events are signed here with a fixed key, `sha256("nostream-008-wire")`, so the recorded
// frames carry their ids and signatures and the replay only sends text.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mock } from 'node:test'

const CAPTURE = '242a3001d77149e4d70151ec03060c4ef44a1547'
const CLOCK_START_MS = 1700000000000
const SEED = 20261023
const RELAY_SECRET = createHash('sha256').update('nostream-008-relay').digest('hex')
const NODE_MODULES = '/workspace/projects/nostream/node_modules'

const cwd = process.cwd()
const isCaptureTree =
  fs.existsSync(path.join(cwd, 'src/adapters/web-socket-adapter.ts')) &&
  fs.existsSync(path.join(cwd, 'resources/default-settings.yaml')) &&
  !fs.existsSync(path.join(cwd, 'crates'))
if (!isCaptureTree) {
  console.error(`run this from the capture tree (cwd=${cwd}); src/adapters must exist and crates/ must not`)
  process.exit(2)
}

// ---- fixture randomness: SplitMix64, little-endian, eight bytes per draw ---------------
const MASK64 = (1n << 64n) - 1n
let rngState = BigInt(SEED)
const nextRandom = () => {
  rngState = (rngState + 0x9e3779b97f4a7c15n) & MASK64
  let z = rngState
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64
  return (z ^ (z >> 31n)) & MASK64
}
const seededBytes = (size) => {
  const out = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const draw = nextRandom()
    for (let index = 0; index < 8 && offset < size; index += 1) {
      out[offset] = Number((draw >> BigInt(index * 8)) & 0xffn)
      offset += 1
    }
  }
  return out
}

const cryptoModule = createRequire(import.meta.url)('node:crypto')
const originalRandomBytes = cryptoModule.randomBytes
cryptoModule.randomBytes = seededBytes

// ---- the frozen clock -----------------------------------------------------------------
mock.timers.enable({ apis: ['Date'], now: CLOCK_START_MS })
const advanceClock = (milliseconds) => mock.timers.tick(milliseconds)

// ---- the capture ----------------------------------------------------------------------
const requireTs = createRequire(path.join(cwd, 'index.ts'))
const { SettingsStatic } = requireTs('./src/utils/settings')
const { WebSocketAdapter } = requireTs('./src/adapters/web-socket-adapter')
const { WebSocketServerAdapter } = requireTs('./src/adapters/web-socket-server-adapter')
const { EventMessageHandler } = requireTs('./src/handlers/event-message-handler')
const { SubscribeMessageHandler } = requireTs('./src/handlers/subscribe-message-handler')
const { CountMessageHandler } = requireTs('./src/handlers/count-message-handler')
const { AuthMessageHandler } = requireTs('./src/handlers/auth-message-handler')
const { UnsubscribeMessageHandler } = requireTs('./src/handlers/unsubscribe-message-handler')
const { eventStrategyFactory } = requireTs('./src/factories/event-strategy-factory')
const { serializeEvent } = requireTs('./src/utils/event')
const { getLeadingZeroBits } = requireTs('./src/utils/proof-of-work')
const { startHiddenContentCache, resetHiddenContentCache } = requireTs('./src/utils/hidden-content-cache')

const nodeRequire = createRequire(import.meta.url)
const WebSocket = nodeRequire(`${NODE_MODULES}/ws`)
const { WebSocketServer } = nodeRequire(`${NODE_MODULES}/ws`)
const secp = nodeRequire(`${NODE_MODULES}/@noble/secp256k1`)

secp.utils.sha256Sync = (...messages) => {
  const hash = createHash('sha256')
  for (const message of messages) hash.update(message)
  return hash.digest()
}

// The shipped document, snapshotted before any session installs its own: `createSettings`
// caches, so a later read would return the session that ran last.
const PRISTINE = JSON.parse(JSON.stringify(SettingsStatic.createSettings()))
const shippedSettings = () => JSON.parse(JSON.stringify(PRISTINE))

// ---- in-memory collaborators (A7: doubles, never a database) --------------------------
const notFound = async () => undefined
const zero = async () => 0
const empty = async () => []

const eventRow = (event) => ({
  id: `row-${event.id.slice(0, 8)}`,
  event_id: Buffer.from(event.id, 'hex'),
  event_kind: event.kind,
  event_pubkey: Buffer.from(event.pubkey, 'hex'),
  event_created_at: event.created_at,
  event_content: event.content,
  event_tags: event.tags,
  event_signature: Buffer.from(event.sig, 'hex'),
  first_seen: new Date(CLOCK_START_MS),
  deleted_at: null,
  expires_at: null,
  remote_address: null,
})

// The capture emits a stored event in this order; the doubles' rows follow it so the replay can
// compare read-back frames byte-for-byte.
const rowToEvent = (row) => ({
  id: row.event_id.toString('hex'),
  pubkey: row.event_pubkey.toString('hex'),
  created_at: row.event_created_at,
  kind: row.event_kind,
  tags: row.event_tags,
  content: row.event_content,
})

const matches = (filter, event) => {
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.since !== undefined && event.created_at < filter.since) return false
  if (filter.until !== undefined && event.created_at > filter.until) return false
  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue
    const name = key.slice(1)
    const wanted = filter[key]
    const present = (event.tags || []).filter((tag) => tag[0] === name).map((tag) => tag[1])
    if (!wanted.some((value) => present.includes(value))) return false
  }
  return true
}

const makeDoubles = () => {
  const rows = new Map()
  const asRow = (value) => (typeof value.id === 'string' && !value.event_id ? eventRow(value) : value)

  const state = {
    rows,
    minted: [],
    vanished: new Set(),
    verified: new Map(),
    actionable: [],
    blocked: new Set(),
    balance: 0,
  }

  const eventRepository = {
    create: async (value) => {
      const row = asRow(value)
      const id = row.event_id.toString('hex')
      if (rows.has(id)) return 0
      rows.set(id, row)
      return 1
    },
    createMany: async (list) => list.length,
    upsert: async (value) => {
      const row = asRow(value)
      rows.set(row.event_id.toString('hex'), row)
      return 1
    },
    upsertMany: async (list) => list.length,
    deleteByPubkeyAndIds: async () => 0,
    deleteByPubkeyExceptKinds: async () => 0,
    countByFilters: async (filters) => {
      let total = 0
      for (const row of [...rows.values()]) {
        if (filters.some((filter) => matches(filter, rowToEvent(row)))) total += 1
      }
      return total
    },
    findByFilters: (filters) => ({
      stream: () =>
        Readable.from(
          [...rows.values()]
            .filter((row) => filters.some((filter) => matches(filter, rowToEvent(row))))
            .map((row) => ({ ...row })),
        ),
    }),
  }

  // `findByPubkey` has no row for a pubkey the session does not name, and `isAdmitted` has no
  // opinion for it: the capture's admission check then allows the event (payments are off in
  // every session but the rejections one).
  const userRepository = {
    findByPubkey: async (pubkey) =>
      state.blocked.has(pubkey)
        ? { pubkey, balance: state.balance, admitted: false }
        : undefined,
    upsert: zero,
    admitUser: zero,
    revokeAdmission: zero,
    isVanished: async (pubkey) => state.vanished.has(pubkey),
    setVanished: zero,
    getBalanceByPubkey: async () => state.balance,
    isAdmitted: async (pubkey) => (state.blocked.has(pubkey) ? false : undefined),
  }
  const nip05Repository = {
    findByPubkey: async (pubkey) => state.verified.get(pubkey),
    deleteByPubkey: zero,
    upsert: zero,
  }
  const inviteCodeRepository = {
    claimCode: async () => true,
    find: notFound,
    create: async (code, options) => {
      state.minted.push({ code, options })
      return { code, ...options }
    },
    findByCode: notFound,
    findActiveCodes: empty,
    deleteExpiredCodes: zero,
  }
  const dvmJobRepository = {
    create: async (job) => job,
    updateStatus: notFound,
    findById: notFound,
    assignWorker: async () => false,
    findPendingJobs: empty,
  }
  const reportRepository = {
    create: async () => ({}),
    createMany: empty,
    findByEventId: empty,
    findActionable: empty,
    findActionableTargets: async () => state.actionable,
  }

  return {
    state,
    eventRepository,
    userRepository,
    nip05Repository,
    inviteCodeRepository,
    dvmJobRepository,
    reportRepository,
  }
}

// The capture reaches Redis through module-level limiters. Here they are substituted, and the
// session says which of the two trips; the recorded settings are what the Rust side derives the
// same verdict from (`rate: 0` with the window's period).
let tripping = { message: false, event: false }
const adapterLimiter = { hit: async (key) => tripping.message && String(key).includes(':message:') }
const eventLimiter = { hit: async (key) => tripping.event && String(key).includes(':events:') }
// The capture's ICacheAdapter, over a Map: the admission check reads and writes it, so a
// missing method would throw inside the EVENT handler and lose the OK frame.
const store = new Map()
const cache = {
  getKey: async (key) => (store.has(key) ? store.get(key) : null),
  hasKey: async (key) => store.has(key),
  setKey: async (key, value) => {
    store.set(key, value)
    return true
  },
  setKeyIfNotExists: async (key, value) => {
    if (store.has(key)) return false
    store.set(key, value)
    return true
  },
  addToSortedSet: async () => 0,
  removeRangeByScoreFromSortedSet: async () => 0,
  getRangeFromSortedSet: async () => [],
  setKeyExpiry: async () => undefined,
  deleteKey: async (key) => {
    store.delete(key)
    return 1
  },
  getHKey: async () => null,
  setHKey: async () => true,
  addToSet: async () => 0,
  getSetMembers: async () => [],
  eval: async () => 0,
  get: async () => null,
  set: async () => undefined,
  del: async () => 0,
  exists: async () => false,
  zadd: async () => 0,
  zremrangebyscore: async () => 0,
  zrange: empty,
  hgetall: async () => ({}),
  hset: async () => 0,
  expire: async () => 0,
  incr: async () => 1,
  publish: async () => 0,
  subscribe: async () => undefined,
}
const wotGraphService = {
  isTrusted: async () => false,
  getScore: async () => 0,
  suggest: async () => 0,
  update: async () => undefined,
  score: async () => 0,
}

// ---- the client keys ------------------------------------------------------------------
const CLIENT_SECRET = createHash('sha256').update('nostream-008-wire').digest('hex')
const OTHER_SECRET = createHash('sha256').update('nostream-008-other').digest('hex')
const pubkeyOf = (secret) => Buffer.from(secp.getPublicKey(secret, true)).toString('hex').substring(2)
const CLIENT_PUBKEY = pubkeyOf(CLIENT_SECRET)
const OTHER_PUBKEY = pubkeyOf(OTHER_SECRET)
const RELAY_PUBKEY = pubkeyOf(RELAY_SECRET)

// A key whose pubkey already carries one leading zero bit, so the pubkey PoW gate passes once
// the session turns it on and an event can reach the gates behind it.
const MINED_SECRET = (() => {
  for (let counter = 0; ; counter += 1) {
    const candidate = createHash('sha256').update(`nostream-008-mined-${counter}`).digest('hex')
    const pubkey = pubkeyOf(candidate)
    if (getLeadingZeroBits(Buffer.from(pubkey, 'hex')) >= 1) return candidate
  }
})()
const MINED_PUBKEY = pubkeyOf(MINED_SECRET)

const NOW_SECS = Math.floor(CLOCK_START_MS / 1000)

const sign = (event, secret = CLIENT_SECRET) => {
  const id = createHash('sha256').update(Buffer.from(JSON.stringify(serializeEvent(event)))).digest()
  event.id = id.toString('hex')
  // A fixed aux rand keeps signing out of the fixture's random stream: only the challenge
  // and the invite code draw from it.
  event.sig = Buffer.from(secp.schnorr.signSync(id, secret, '00'.repeat(32))).toString('hex')
  return event
}

const pubkeyOfSecret = (secret) =>
  secret === CLIENT_SECRET ? CLIENT_PUBKEY : secret === OTHER_SECRET ? OTHER_PUBKEY : MINED_PUBKEY

const makeEvent = (over = {}, secret = CLIENT_SECRET) =>
  sign(
    {
      pubkey: pubkeyOfSecret(secret),
      kind: 1,
      created_at: NOW_SECS,
      content: 'wire-session',
      tags: [],
      ...over,
    },
    secret,
  )

/// An event whose id carries `bits` leading zero bits, by varying its content.
const grind = (event, bits = 4, secret = MINED_SECRET) => {
  for (let nonce = 0; nonce < 10000; nonce += 1) {
    const candidate = makeEvent({ ...event, content: `ground-${nonce}` }, secret)
    if (getLeadingZeroBits(Buffer.from(candidate.id, 'hex')) >= bits) return candidate
  }
  throw new Error('grind gave up')
}

const AUTH_RE = /"AUTH","([A-Za-z0-9_-]+)"/g
const maskChallenge = (frame) => frame.replace(AUTH_RE, '"AUTH","{{challenge}}"')

// ---- one session ----------------------------------------------------------------------
const sessions = []

const settingsFor = (overrides) => {
  const document = shippedSettings()

  const merge = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        target[key] = merge(target[key] && typeof target[key] === 'object' ? target[key] : {}, value)
      } else {
        target[key] = value
      }
    }
    return target
  }

  return merge(document, overrides)
}

// The capture caches its settings in a static, and its watcher can replace that object. Each
// session installs its own document as a whole, so nothing leaks between sessions.
const installSettings = (document) => {
  SettingsStatic._settings = JSON.parse(JSON.stringify(document))
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

const startServer = async (definition) => {
  const document = definition.settings
  installSettings(document)

  const doubles = makeDoubles()
  const { eventRepository, userRepository, nip05Repository, inviteCodeRepository } = doubles
  const { dvmJobRepository, reportRepository } = doubles
  const settings = () => SettingsStatic.createSettings()

  const createMessageHandler = ([message, adapter]) => {
    switch (message[0]) {
      case 'EVENT':
        return new EventMessageHandler(
          adapter,
          eventStrategyFactory(
            eventRepository,
            userRepository,
            inviteCodeRepository,
            dvmJobRepository,
            reportRepository,
            cache,
            settings,
          ),
          eventRepository,
          userRepository,
          settings,
          nip05Repository,
          cache,
          () => eventLimiter,
          wotGraphService,
        )
      case 'REQ':
        return new SubscribeMessageHandler(adapter, eventRepository, settings, inviteCodeRepository, () => eventLimiter)
      case 'CLOSE':
        return new UnsubscribeMessageHandler(adapter)
      case 'COUNT':
        return new CountMessageHandler(adapter, eventRepository, settings)
      case 'AUTH':
        return new AuthMessageHandler(adapter, settings)
      default:
        throw new Error(`Unknown message type: ${String(message[0]).substring(0, 64)}`)
    }
  }

  const createWebSocketAdapter = ([client, request, serverAdapter]) =>
    new WebSocketAdapter(client, request, serverAdapter, createMessageHandler, () => adapterLimiter, settings)

  const restoreInterval = globalThis.setInterval
  if (definition.livenessIntervalMs) {
    globalThis.setInterval = (fn, delay, ...rest) =>
      restoreInterval(fn, delay >= 30000 ? definition.livenessIntervalMs : delay, ...rest)
  }

  const server = http.createServer()
  const wss = new WebSocketServer({
    server,
    maxPayload: settings().network?.maxPayloadSize ?? 131072,
    perMessageDeflate: false,
  })
  const serverAdapter = new WebSocketServerAdapter(server, wss, createWebSocketAdapter, settings)

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  resetHiddenContentCache()
  if (settings().nip56?.hideActionableReports) {
    await startHiddenContentCache(reportRepository, settings)
  }

  globalThis.setInterval = restoreInterval

  return {
    doubles,
    port: server.address().port,
    serverAdapter,
    close: () =>
      new Promise((resolve) => {
        serverAdapter.close(() => server.close(() => resolve()))
      }),
  }
}

const runSession = async (definition) => {
  const secret = process.env.SECRET
  if (definition.withoutSecret) {
    delete process.env.SECRET
    delete process.env.RELAY_PRIVATE_KEY
  }

  const server = await startServer({ ...definition, settings: definition.settings })
  const { state } = server.doubles

  for (const target of definition.actionable ?? []) state.actionable.push(target)
  for (const pubkey of definition.vanished ?? []) state.vanished.add(pubkey)
  for (const [pubkey, verification] of Object.entries(definition.verified ?? {})) {
    state.verified.set(pubkey, verification)
  }
  for (const pubkey of definition.blocked ?? []) state.blocked.add(pubkey)

  const options = { perMessageDeflate: Boolean(definition.offerCompression) }
  if (definition.autoPong === false) options.autoPong = false
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, options)

  let responseHeaders = {}
  socket.on('upgrade', (response) => {
    responseHeaders = response.headers
  })

  // The listener goes on before the handshake completes: the relay's AUTH frame races `open`.
  const frames = []
  socket.on('message', (data) => frames.push(data.toString()))

  let closed = null
  socket.on('close', (code, reason) => {
    closed = { code, reason: reason.toString() }
  })

  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  // `Date` is mocked, so every wait counts attempts rather than reading the clock.
  const take = async (count, attempts = 300) => {
    const out = []
    while (out.length < count && frames.length) {
      out.push(frames.shift())
    }
    for (let attempt = 0; attempt < attempts && out.length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      while (out.length < count && frames.length) out.push(frames.shift())
    }
    return out
  }

  const steps = []
  const first = await take(1)
  steps.push({ connect: true, expect: first.map(maskChallenge) })
  const challenge = JSON.parse(first[0])[1]

  const send = async (payload, options = {}) => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    socket.send(text)

    const step = { send: { text: text.split(challenge).join('{{challenge}}') } }
    if (options.allow) step.allow = options.allow
    if (options.compare === false) {
      step.compare = false
      step.compare_why = options.why
    }
    if (options.advanceMs) step.advance_ms = options.advanceMs
    if (options.expect) step.expect = (await take(options.expect, options.attempts)).map(maskChallenge)
    if (options.none) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      step.expect = frames.splice(0).map(maskChallenge)
    }
    steps.push(step)
    return step.expect ?? []
  }

  const context = {
    socket,
    send,
    steps,
    challenge,
    state,
    settings: () => SettingsStatic.createSettings(),
    advanceClock,
    waitForClose: async (attempts = 600) => {
      for (let attempt = 0; attempt < attempts && !closed; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return closed
    },
    platform: { server, frames, take },
  }

  await definition.script(context)

  if (definition.drain) {
    const before = frames.length
    await new Promise((resolve) => server.serverAdapter.close(() => resolve()))
    // The adapter's close drains: the CLOSED frames and the 1001 close arrive before the
    // callback, but give the socket a moment to hand them over.
    await new Promise((resolve) => setTimeout(resolve, 300))
    steps.push({ drain: true, expect: frames.splice(0).map(maskChallenge) })
    if (frames.length !== before) throw new Error('drain frames were consumed twice')
  }

  const session = {
    id: definition.id,
    challenge,
    clock: { start_ms: CLOCK_START_MS },
    seed: SEED,
    settings: JSON.parse(JSON.stringify(definition.settings)),
    steps,
  }

  if (definition.livenessIntervalMs) session.liveness_interval_ms = definition.livenessIntervalMs
  if (definition.finalClose) {
    const info = await context.waitForClose()
    session.final_close = info ?? { code: 'open' }
  }
  if (definition.offerCompression) {
    session.handshake = {
      extensions: 'permessage-deflate; client_max_window_bits',
      response_extensions: responseHeaders['sec-websocket-extensions'] ?? null,
    }
  }
  if (!definition.withoutSecret) session.relay_secret = RELAY_SECRET
  if (state.actionable.length) session.actionable = state.actionable

  // The two values the relay minted from its own randomness: the challenge this socket was
  // given, and (for a mint) the invite code. The replay hands the relay exactly these bytes.
  session.random = {
    challenge: Buffer.from(challenge, 'base64url').toString('hex'),
    invite_code: state.minted.length ? state.minted[0].code : null,
  }

  sessions.push(session)

  try {
    socket.terminate()
  } catch {}
  await server.close()
  if (secret !== undefined) {
    process.env.SECRET = secret
    process.env.RELAY_PRIVATE_KEY = secret
  }
  tripping = { message: false, event: false }
  console.error(`recorded ${definition.id}: ${steps.length} steps`)
}

// ---- the sixteen sessions -------------------------------------------------------------
const baseLimits = () => shippedSettings().limits
const noConnectionLimit = (limits) => {
  const next = JSON.parse(JSON.stringify(limits))
  next.connection = { ...next.connection, ipWhitelist: LOOPBACK }
  return next
}

// The document that lets the rejections session reach every gate it names, in the pipeline's
// order: the timestamp window and content cap are tight, PoW is on, and admission/NIP-05 only
// bite for the last two steps because earlier steps fail sooner.
const rejectionLimits = () => {
  const limits = JSON.parse(JSON.stringify(baseLimits()))
  limits.connection = { ...limits.connection, ipWhitelist: LOOPBACK }
  limits.event.createdAt = { maxPositiveDelta: 60, maxNegativeDelta: 60 }
  limits.event.content = [{ description: 'small', maxLength: 16 }]
  limits.event.eventId = { minLeadingZeroBits: 4 }
  limits.event.pubkey = { ...limits.event.pubkey, minLeadingZeroBits: 1, blacklist: [] }
  limits.event.kind = { whitelist: [], blacklist: [7] }
  limits.event.rateLimits = []
  return limits
}

const runAll = async () => {
  // 10. No SECRET: an EVENT cannot reach a strategy. This session runs first, because the
  // capture memoises the relay key on first use and later sessions need it.
  await runSession({
    id: 'no-secret',
    settings: settingsFor({ limits: noConnectionLimit(baseLimits()) }),
    withoutSecret: true,
    script: async ({ send }) => {
      await send(['EVENT', makeEvent({ content: 'no secret' })], { expect: 1, attempts: 600 })
    },
  })

  // 1. Every frame of recon.md's quoted transcript, in order, ending with the payload close.
  await runSession({
    id: 'measured-session',
    settings: settingsFor({ limits: noConnectionLimit(baseLimits()) }),
    script: async ({ send, socket, settings, challenge, steps }) => {
      const good = makeEvent()
      await send('{not json', {
        expect: 1,
        allow: [{ why: 'T1', detail: 'the JSON syntax message is V8-specific; the prefix is not' }],
      })
      await send(['BOGUS', 'x'], { expect: 1 })
      await send(['REQ', 's-empty'], { expect: 1 })
      await send(['REQ', 's1', { kinds: [1] }], { expect: 1 })
      await send(['COUNT', 'c1', { kinds: [1] }], { expect: 1 })
      await send(['REQ', 's1', { kinds: [1] }], { expect: 1 })
      await send(['CLOSE', 's1'], { none: true })
      await send(['EVENT', good], { expect: 1 })
      await send(['EVENT', good], { expect: 1 })
      await send(['EVENT', { ...good, content: 'tampered' }], { expect: 1 })
      const wrongKind = makeEvent({ kind: 22242, tags: [['relay', settings().info.relay_url], ['challenge', 'nope']] })
      await send(['AUTH', wrongKind], { expect: 1 })
      const goodAuth = makeEvent({
        kind: 22242,
        tags: [['relay', settings().info.relay_url], ['challenge', challenge]],
      })
      await send(['AUTH', goodAuth], { expect: 1 })
      // A read-back EVENT frame carries the capture's own field order for stored rows
      // (`id, kind, pubkey, created_at, content, tags, sig`), which differs from the order its
      // broadcast path emits; recorded, not byte-compared.
      await send(['REQ', 's2', { kinds: [1] }], {
        expect: 2,
        compare: false,
        why: 'a REQ result carries the capture’s stored-row field order; recorded, not compared — job 008',
      })
      // The oversized frame: recorded as its size, not its 600 KB of text.
      socket.send(JSON.stringify(['EVENT', makeEvent({ content: 'x'.repeat(600 * 1024) })]))
      steps.push({ oversized: 600 * 1024 + 200 })
    },
    finalClose: true,
  })

  // 2. The message limiter: REQ/COUNT are CLOSED with the window's period, EVENT is a NOTICE.
  await runSession({
    id: 'rate-limit-message',
    settings: settingsFor({
      limits: {
        ...noConnectionLimit(baseLimits()),
        message: { rateLimits: [{ period: 60000, rate: 0 }], ipWhitelist: [] },
      },
    }),
    script: async ({ send }) => {
      tripping = { message: true, event: false }
      await send(['REQ', 's1', { kinds: [1] }], { expect: 1 })
      await send(['COUNT', 'c1', { kinds: [1] }], { expect: 1 })
      await send(['EVENT', makeEvent()], { expect: 1 })
      await send(['REQ', 's2', { kinds: [1] }], { expect: 1 })
      await send(['CLOSE', 's1'], { none: true })
    },
  })

  // 3. The event limiter: the OK carries the window's period as the backoff.
  await runSession({
    id: 'rate-limit-event',
    settings: settingsFor({
      limits: {
        ...noConnectionLimit(baseLimits()),
        event: { ...noConnectionLimit(baseLimits()).event, rateLimits: [{ period: 60000, rate: 0 }] },
      },
    }),
    script: async ({ send }) => {
      tripping = { message: false, event: true }
      await send(['EVENT', makeEvent({ content: 'limited' })], { expect: 1 })
      await send(['EVENT', makeEvent({ content: 'again' })], { expect: 1 })
    },
  })

  // 4. Both whitelists: loopback bypasses the message limiter, the pubkey bypasses the event one.
  await runSession({
    id: 'whitelists',
    settings: settingsFor({
      limits: {
        ...noConnectionLimit(baseLimits()),
        message: { rateLimits: [{ period: 60000, rate: 0 }], ipWhitelist: LOOPBACK },
        event: {
          ...noConnectionLimit(baseLimits()).event,
          rateLimits: [{ period: 60000, rate: 0 }],
          whitelists: { pubkeys: [CLIENT_PUBKEY], ipAddresses: [] },
        },
      },
    }),
    script: async ({ send }) => {
      tripping = { message: true, event: true }
      await send(['REQ', 'w1', { kinds: [1] }], { expect: 1 })
      await send(['EVENT', makeEvent({ content: 'whitelisted' })], { expect: 1 })
      await send(['EVENT', makeEvent({ content: 'not whitelisted' }, OTHER_SECRET)], { expect: 1 })
    },
  })

  // 5. A restricted-only REQ from an unauthenticated client, then the same REQ after AUTH.
  await runSession({
    id: 'req-auth-required',
    settings: settingsFor({
      limits: noConnectionLimit(baseLimits()),
      nip42: { ...shippedSettings().nip42, restrictedReads: { enabled: true, kinds: [4] } },
    }),
    script: async ({ send, settings, challenge }) => {
      await send(['REQ', 'r1', { kinds: [4] }], { expect: 1 })
      const auth = makeEvent({
        kind: 22242,
        tags: [['relay', settings().info.relay_url], ['challenge', challenge]],
      })
      await send(['AUTH', auth], { expect: 1 })
      await send(['REQ', 'r2', { kinds: [4] }], { expect: 1 })
    },
  })

  // 6. CLOSE emits nothing; a later REQ still serves.
  await runSession({
    id: 'req-close-abort',
    settings: settingsFor({ limits: noConnectionLimit(baseLimits()) }),
    script: async ({ send }) => {
      await send(['REQ', 'c1', { kinds: [1] }], { expect: 1 })
      await send(['CLOSE', 'c1'], { none: true })
      await send(['REQ', 'c2', { kinds: [1] }], { expect: 1 })
    },
  })

  // 7. NIP-43: an authenticated REQ for kind 28935 mints one claim event before EOSE.
  await runSession({
    id: 'invite-mint',
    relaySecret: true,
    settings: settingsFor({
      limits: noConnectionLimit(baseLimits()),
      info: { ...shippedSettings().info, pubkey: RELAY_PUBKEY, self: RELAY_PUBKEY },
      nip43: {
        ...shippedSettings().nip43,
        enabled: true,
        allowInviteRequests: true,
        inviteRequestWhitelist: [],
      },
    }),
    script: async ({ send, settings, challenge }) => {
      const auth = makeEvent({
        kind: 22242,
        tags: [['relay', settings().info.relay_url], ['challenge', challenge]],
      })
      await send(['AUTH', auth], { expect: 1 })
      // The capture's invite-code builder emits its own key order
      // (`pubkey, kind, created_at, content, tags, id, sig`) while every other EVENT frame uses
      // the read-back order, so this frame is recorded but not byte-compared.
      await send(['REQ', 'invite', { kinds: [28935] }], {
        expect: 2,
        compare: false,
        why: 'the capture builds the claim event with its own field order; recorded, not compared — job 008',
      })
    },
  })

  // 8. Two overlapping subscriptions both receive a live event.
  await runSession({
    id: 'live-dispatch',
    settings: settingsFor({ limits: noConnectionLimit(baseLimits()) }),
    script: async ({ send }) => {
      await send(['REQ', 'a', {}], { expect: 1 })
      await send(['REQ', 'b', { kinds: [1] }], { expect: 1 })
      await send(['EVENT', makeEvent({ content: 'live' })], { expect: 3 })
    },
  })

  // 9. An actionable report hides its target from the live broadcast.
  await runSession({
    id: 'hidden-report',
    settings: settingsFor({
      limits: noConnectionLimit(baseLimits()),
      nip56: { ...shippedSettings().nip56, enabled: true, hideActionableReports: true },
    }),
    actionable: [],
    script: async ({ send, state }) => {
      const hidden = makeEvent({ content: 'hidden' })
      state.actionable.push({ reportedPubkey: null, reportedEventId: hidden.id })
      // The cache was seeded at boot; mark the target by refreshing through the same path the
      // harness uses: the boot seed ran before the target existed, so the tick is driven here.
      const { startHiddenContentCache } = requireTs('./src/utils/hidden-content-cache')
      await startHiddenContentCache(
        { findActionableTargets: async () => state.actionable },
        () => SettingsStatic.createSettings(),
      )
      await send(['REQ', 'h1', {}], { expect: 1 })
      await send(['EVENT', hidden], { expect: 1 })
      await send(['EVENT', makeEvent({ content: 'visible' })], { expect: 3 })
    },
  })

  // 11. The drain: one CLOSED per subscription, then close 1001.
  await runSession({
    id: 'drain',
    settings: settingsFor({ limits: noConnectionLimit(baseLimits()) }),
    script: async ({ send }) => {
      await send(['REQ', 'd1', { kinds: [1] }], { expect: 1 })
      await send(['REQ', 'd2', { kinds: [4] }], { expect: 1 })
    },
    drain: true,
  })

  // 12. A client that never pongs is closed with no close frame.
  await runSession({
    id: 'liveness',
    livenessIntervalMs: 20,
    autoPong: false,
    settings: settingsFor({ limits: noConnectionLimit(baseLimits()) }),
    script: async ({ platform }) => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      platform.frames.splice(0)
    },
    finalClose: true,
  })

  // 13. A permessage-deflate offer is declined and the session stays uncompressed.
  await runSession({
    id: 'compression-offer',
    offerCompression: true,
    settings: settingsFor({ limits: noConnectionLimit(baseLimits()) }),
    script: async ({ send }) => {
      await send(['REQ', 'z1', { kinds: [1] }], { expect: 1 })
    },
  })

  // 14. COUNT with NIP-45 disabled.
  await runSession({
    id: 'count-disabled',
    settings: settingsFor({
      limits: noConnectionLimit(baseLimits()),
      nip45: { ...shippedSettings().nip45, enabled: false },
    }),
    script: async ({ send }) => {
      await send(['COUNT', 'c1', { kinds: [1] }], { expect: 1 })
    },
  })

  // 15. An authenticated session expires after sessionExpirySeconds.
  await runSession({
    id: 'nip42-expiry',
    settings: settingsFor({
      limits: noConnectionLimit(baseLimits()),
      nip42: {
        ...shippedSettings().nip42,
        sessionExpirySeconds: 1,
        restrictedReads: { enabled: true, kinds: [4] },
      },
    }),
    script: async ({ send, settings, challenge, advanceClock }) => {
      const auth = makeEvent({
        kind: 22242,
        tags: [['relay', settings().info.relay_url], ['challenge', challenge]],
      })
      await send(['AUTH', auth], { expect: 1 })
      await send(['REQ', 'e1', { kinds: [4] }], { expect: 1 })
      advanceClock(1000)
      await send(['REQ', 'e2', { kinds: [4] }], { expect: 1, advanceMs: 1000 })
    },
  })

  // 16. One step per EVENT reason string, in the pipeline's order.
  await runSession({
    id: 'event-rejections',
    vanished: [OTHER_PUBKEY],
    verified: {},
    blocked: [MINED_PUBKEY],
    settings: settingsFor({
      limits: rejectionLimits(),
      nip43: { ...shippedSettings().nip43, enabled: true, allowInviteRequests: false },
    }),
    script: async ({ send }) => {
      const good = makeEvent({ kind: 1, content: 'ok', tags: [] })
      // 1. id / 2. signature: tamper after signing.
      await send(['EVENT', { ...good, content: 'id-mismatch' }], { expect: 1 })
      const signed = makeEvent({ content: 'sig' })
      await send(['EVENT', { ...signed, sig: '0'.repeat(128) }], { expect: 1 })
      // 3. NIP-17 inner kinds.
      await send(['EVENT', makeEvent({ kind: 13, content: 'seal', tags: [] })], { expect: 1 })
      await send(['EVENT', makeEvent({ kind: 444, content: 'rumor', tags: [] })], { expect: 1 })
      // 4. an AUTH event over EVENT.
      await send(['EVENT', makeEvent({ kind: 22242, tags: [] })], { expect: 1 })
      // 5. the request-to-vanish relay tag.
      await send(['EVENT', makeEvent({ kind: 62, tags: [['relay', 'wss://relay.example.com']] })], { expect: 1 })
      // 6. expired.
      await send(['EVENT', makeEvent({ tags: [['expiration', String(NOW_SECS - 1)]] })], { expect: 1 })
      // 7. content over the cap.
      await send(['EVENT', makeEvent({ content: 'x'.repeat(64) })], { expect: 1 })
      // 8. created_at too far ahead, then too far behind.
      await send(['EVENT', makeEvent({ created_at: NOW_SECS + 3600 })], { expect: 1 })
      await send(['EVENT', makeEvent({ created_at: NOW_SECS - 3600 })], { expect: 1 })
      // 9. PoW on the event id, that is: an unground id.
      await send(['EVENT', makeEvent({ content: 'not-ground' })], { expect: 1 })
      // 10. PoW on the pubkey: a ground id from a key with no leading zero bit.
      await send(['EVENT', grind({ kind: 1 })], { expect: 1 })
      // 11. The kind blacklist, once both PoW gates pass.
      await send(['EVENT', grind({ kind: 7, tags: [['e', '0'.repeat(64)]] })], { expect: 1 })
      // 12. A protected event from somebody other than its author.
      await send(['EVENT', grind({ kind: 1, tags: [['-']] })], { expect: 1 })
      // 13. NIP-43 membership: a grounded event from a pubkey that is not admitted.
      await send(['EVENT', grind({ kind: 1, tags: [['p', CLIENT_PUBKEY]] })], { expect: 1 })

    },
  })
}

// The stream restarts here: module loading draws nothing this fixture wants to replay, and the
// replay's own generator starts at the seed, so the first session's challenge is the same on
// both sides.
rngState = BigInt(SEED)

// The capture's settings loader reads the environment as it loads, so the relay key is
// installed here, after every module is in memory and before the first session.
process.env.SECRET = RELAY_SECRET
process.env.RELAY_PRIVATE_KEY = RELAY_SECRET
console.error(`secret ${process.env.SECRET ? 'set' : 'unset'}`)

await runAll()

// ---- output ---------------------------------------------------------------------------
const outDirFlag = process.argv.indexOf('--out-dir')
const outDir =
  outDirFlag === -1
    ? path.resolve(path.dirname(new URL(import.meta.url).pathname), '../fixtures')
    : path.resolve(process.argv[outDirFlag + 1])

const fixture = {
  capture: CAPTURE,
  generated_by: 'crates/nostream-relay/tests/capture/gen-wire-sessions.mjs',
  clock: { start_ms: CLOCK_START_MS },
  seed: SEED,
  client_secret: CLIENT_SECRET,
  relay_secret: RELAY_SECRET,
  sessions,
}

const target = path.join(outDir, 'wire-sessions.json')
fs.writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`${sessions.length} sessions -> ${target}`)

cryptoModule.randomBytes = originalRandomBytes
process.exit(0)
