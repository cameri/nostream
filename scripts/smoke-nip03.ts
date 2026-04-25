#!/usr/bin/env node
/**
 * End-to-end NIP-03 smoke test against a running nostream relay, using a
 * real OpenTimestamps proof that a real OTS client produced in the wild.
 *
 * Why not stamp our own? `ots stamp` writes a "pending" proof that has to
 * sit in a calendar server's queue for a few Bitcoin blocks (typically a
 * few hours) before `ots upgrade` can turn it into a confirmed Bitcoin
 * attestation. Running that end-to-end in CI or on a dev box is
 * impractical. Re-using an already-upgraded, already-published kind 1040
 * event is an equally honest "real client" test: we do not mint the
 * proof, and we prove its validity with the same binary a Nostr client
 * would use (`ots verify`, which queries an Esplora server for the
 * Bitcoin block header).
 *
 * Steps:
 *   1. Auto-discover a recent kind:1040 event by querying a rotating list
 *      of public relays until one returns a usable proof. (If you pass
 *      `--event-id <hex>` the script skips auto-discovery and fetches
 *      that specific event.)
 *   2. Optionally run `ots verify` on the decoded .ots content to confirm
 *      the Bitcoin attestation is valid.
 *   3. Republish the already-signed event verbatim to the local relay
 *      and assert OK=true.
 *   4. Re-query the local relay for the same event id and assert id, sig
 *      and content round-trip unchanged.
 *
 * Negative paths (mismatched digest, uppercase e tag, multiple k tags,
 * garbage content, unsupported version) can't be exercised here without
 * re-signing the event — which would make this no longer a "real client"
 * test. Those live in the unit tests:
 *   - test/unit/utils/nip03.spec.ts
 *   - test/unit/handlers/event-strategies/timestamp-event-strategy.spec.ts
 *
 * Usage:
 *   npx ts-node scripts/smoke-nip03.ts \
 *     [--local-relay ws://127.0.0.1:8008] \
 *     [--source-relay wss://nos.lol,wss://relay.damus.io,...] \
 *     [--event-id <hex>] \
 *     [--skip-ots-verify]
 *
 * Uses the `ws` package (same stack as `scripts/security-load-test.ts`).
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { type RawData } from 'ws'

type CliArgs = Record<string, string | boolean>

/** Minimal Nostr event shape for NIP-03 smoke (kind 1040). */
interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/**
 * Parsed JSON from Nostr relay messages.
 * Relay may send `EVENT`, `EOSE`, `OK`, `CLOSED`, `NOTICE`, etc.
 */
type RelayMessage =
  | ['EVENT', string, NostrEvent]
  | ['EOSE', string]
  | ['OK', string, boolean, string]
  | ['CLOSED', string, string?]

const DEFAULT_SOURCE_RELAYS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://nostr.wine',
  'wss://offchain.pub',
  'wss://nostr-pub.wellorder.net',
]

const args = parseArgs(process.argv.slice(2))
const LOCAL_RELAY = (typeof args['local-relay'] === 'string' && args['local-relay']) || 'ws://127.0.0.1:8008'
const SOURCE_RELAYS = (
  typeof args['source-relay'] === 'string' && args['source-relay']
    ? args['source-relay']
    : DEFAULT_SOURCE_RELAYS.join(',')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const PINNED_EVENT_ID = typeof args['event-id'] === 'string' ? args['event-id'] : undefined
const SKIP_OTS_VERIFY = Boolean(args['skip-ots-verify']) || process.env.SKIP_OTS_VERIFY === '1'

let passed = 0
let failed = 0

function ok(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, detail?: string): void {
  failed++
  console.log(`  FAIL  ${label}`)
  if (detail) {
    for (const line of String(detail).split('\n')) {
      console.log(`        ${line}`)
    }
  }
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1)
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[++i]
    } else {
      out[a.slice(2)] = true
    }
  }
  return out
}

async function openSocket(url: string, timeoutMs = 10000): Promise<WebSocket> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error(`timed out opening ${url}`))
    }, timeoutMs)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.once('error', (e: Error) => {
      clearTimeout(timer)
      reject(new Error(`socket error opening ${url}: ${e?.message ?? e}`))
    })
  })
  return ws
}

function sendJson(ws: WebSocket, msg: unknown[]): void {
  ws.send(JSON.stringify(msg))
}

function isHex64(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
}

function isPlausibleNip03(event: unknown): event is NostrEvent {
  if (!event || typeof event !== 'object') return false
  const e = event as Record<string, unknown>
  if (e.kind !== 1040) return false
  const tags = e.tags
  if (!Array.isArray(tags)) return false
  const eTag = tags.find((t) => Array.isArray(t) && t[0] === 'e')
  if (!eTag || !isHex64(eTag[1])) return false
  if (typeof e.content !== 'string' || e.content.length < 40) return false
  try {
    const buf = Buffer.from(e.content, 'base64')
    return buf.length > 40 && buf[0] === 0x00 && buf.slice(1, 15).toString('ascii') === 'OpenTimestamps'
  } catch {
    return false
  }
}

function parseRelayMessage(data: RawData): RelayMessage | undefined {
  try {
    const parsed = JSON.parse(String(data)) as unknown
    if (!Array.isArray(parsed)) return undefined
    return parsed as RelayMessage
  } catch {
    return undefined
  }
}

async function discoverRecentNip03(relayUrl: string, limit = 10): Promise<NostrEvent[]> {
  const ws = await openSocket(relayUrl, 8000)
  const subId = `disc-${randomUUID().slice(0, 8)}`
  const collected: NostrEvent[] = []
  let settled = false

  return new Promise((resolve) => {
    const done = (value: NostrEvent[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sendJson(ws, ['CLOSE', subId])
      } catch {
        /* ignore */
      }
      ws.close()
      resolve(value)
    }

    const timer = setTimeout(() => done(collected), 8000)

    ws.on('message', (data: RawData) => {
      const parsed = parseRelayMessage(data)
      if (!parsed) return
      if (parsed[0] === 'EVENT' && parsed[1] === subId) {
        if (isPlausibleNip03(parsed[2])) {
          collected.push(parsed[2])
        }
      } else if (parsed[0] === 'EOSE' && parsed[1] === subId) {
        done(collected)
      }
    })

    ws.on('error', () => done(collected))

    sendJson(ws, ['REQ', subId, { kinds: [1040], limit }])
  })
}

async function fetchEvent(relayUrl: string, eventId: string, timeoutMs = 15000): Promise<NostrEvent | undefined> {
  const ws = await openSocket(relayUrl, 10000)
  const subId = `fetch-${randomUUID().slice(0, 8)}`
  let settled = false

  return new Promise((resolve, reject) => {
    const done = <T>(fn: (v: T) => void, value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sendJson(ws, ['CLOSE', subId])
      } catch {
        /* ignore */
      }
      ws.close()
      fn(value)
    }

    const timer = setTimeout(() => {
      done(reject, new Error(`timed out fetching ${eventId} from ${relayUrl}`))
    }, timeoutMs)

    ws.on('message', (data: RawData) => {
      const parsed = parseRelayMessage(data)
      if (!parsed) return
      if (parsed[0] === 'EVENT' && parsed[1] === subId) {
        done(resolve, parsed[2])
      } else if (parsed[0] === 'EOSE' && parsed[1] === subId) {
        done(resolve, undefined)
      } else if (parsed[0] === 'CLOSED' && parsed[1] === subId) {
        done(reject, new Error(`relay closed subscription: ${parsed[2] ?? 'unknown reason'}`))
      }
    })

    sendJson(ws, ['REQ', subId, { ids: [eventId] }])
  })
}

async function publishEvent(
  relayUrl: string,
  event: NostrEvent,
  timeoutMs = 15000,
): Promise<{ accepted: boolean; reason: string }> {
  const ws = await openSocket(relayUrl, 10000)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`timed out waiting for OK on ${event.id} from ${relayUrl}`))
    }, timeoutMs)

    ws.on('message', (data: RawData) => {
      const parsed = parseRelayMessage(data)
      if (!parsed) return
      if (parsed[0] === 'OK' && parsed[1] === event.id) {
        clearTimeout(timer)
        ws.close()
        resolve({ accepted: Boolean(parsed[2]), reason: String(parsed[3] ?? '') })
      }
    })

    sendJson(ws, ['EVENT', event])
  })
}

function hasOtsBinary(): boolean {
  try {
    const probe = spawnSync('ots', ['--version'], { encoding: 'utf8' })
    return probe.status === 0
  } catch {
    return false
  }
}

interface OtsClientResult {
  info: { status: number | null; combined: string }
  otsPath: string
  verify?: { status: number | null; combined: string }
}

/**
 * Run the real `ots` client against the proof.
 *
 * We use `ots info` rather than `ots verify` because `ots verify` requires
 * a reachable Bitcoin node (or Esplora configuration) to look up the block
 * header, which most dev machines don't have. `ots info` parses the
 * proof, walks the commitment tree, and prints the Bitcoin block header
 * attestation it terminates in — which is exactly what NIP-03 requires
 * the proof to contain. If the client can't parse the file or the file
 * doesn't terminate in a Bitcoin attestation, `ots info` fails.
 *
 * If `--verify` is passed (or an `OTS_VERIFY=1` env), we additionally run
 * `ots verify -d <targetEventId> <file>` which performs the full check
 * against a Bitcoin node.
 */
function runOtsClient(
  base64Content: string,
  targetEventId: string,
  { alsoVerify = false }: { alsoVerify?: boolean } = {},
): OtsClientResult {
  const dir = mkdtempSync(join(tmpdir(), 'nip03-'))
  const otsPath = join(dir, 'proof.ots')
  writeFileSync(otsPath, Buffer.from(base64Content, 'base64'))
  const info = spawnSync('ots', ['info', otsPath], { encoding: 'utf8' })
  const result: OtsClientResult = {
    info: {
      status: info.status,
      combined: `${info.stdout ?? ''}\n${info.stderr ?? ''}`,
    },
    otsPath,
  }
  if (alsoVerify) {
    const verify = spawnSync('ots', ['verify', '-d', targetEventId, otsPath], { encoding: 'utf8' })
    result.verify = {
      status: verify.status,
      combined: `${verify.stdout ?? ''}\n${verify.stderr ?? ''}`,
    }
  }
  return result
}

async function findEventAndSource(): Promise<{ event: NostrEvent; source: string }> {
  if (PINNED_EVENT_ID) {
    if (!isHex64(PINNED_EVENT_ID)) {
      throw new Error(`--event-id must be 32-byte lowercase hex, got ${PINNED_EVENT_ID}`)
    }
    for (const relay of SOURCE_RELAYS) {
      console.log(`  trying ${relay} for id=${PINNED_EVENT_ID.slice(0, 12)}…`)
      try {
        const ev = await fetchEvent(relay, PINNED_EVENT_ID, 12000)
        if (ev && ev.kind === 1040 && isPlausibleNip03(ev)) {
          return { event: ev, source: relay }
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        console.log(`    ${relay}: ${err.message}`)
      }
    }
    throw new Error(`pinned event ${PINNED_EVENT_ID} not found on any source relay`)
  }

  for (const relay of SOURCE_RELAYS) {
    console.log(`  trying ${relay} for any recent kind 1040…`)
    try {
      const candidates = await discoverRecentNip03(relay)
      if (candidates.length > 0) {
        candidates.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
        return { event: candidates[0], source: relay }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      console.log(`    ${relay}: ${err.message}`)
    }
  }
  throw new Error(
    `no kind 1040 events found on any of: ${SOURCE_RELAYS.join(', ')}. ` +
      `Pass --event-id <hex> to pin a specific one.`,
  )
}

async function main(): Promise<void> {
  console.log('NIP-03 end-to-end smoke test')
  console.log(`  local relay:   ${LOCAL_RELAY}`)
  console.log(`  source relays: ${SOURCE_RELAYS.join(', ')}`)
  if (PINNED_EVENT_ID) console.log(`  pinned id:     ${PINNED_EVENT_ID}`)
  console.log('')

  console.log('1) Discovering a real NIP-03 event from public relays')
  let event: NostrEvent
  let source: string
  try {
    const found = await findEventAndSource()
    event = found.event
    source = found.source
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    fail('discovered a real NIP-03 event', err.message)
    finish()
    return
  }
  const eTag = event.tags.find((t) => t[0] === 'e')
  if (!eTag || !isHex64(eTag[1])) {
    fail('discovered a real NIP-03 event', 'missing valid e tag')
    finish()
    return
  }
  ok(
    `discovered ${event.id.slice(0, 12)}… on ${source} ` +
      `(pubkey=${event.pubkey.slice(0, 8)}…, attests e=${eTag[1].slice(0, 12)}…, content=${event.content.length} chars)`,
  )

  console.log('')
  console.log('2) Parsing OTS content with the real `ots` client')
  const targetEventId = eTag[1]
  if (SKIP_OTS_VERIFY) {
    console.log('  SKIP  --skip-ots-verify set')
  } else if (!hasOtsBinary()) {
    console.log('  SKIP  `ots` binary not found on PATH.')
    console.log('        Install it to exercise this step:')
    console.log('          pipx install opentimestamps-client')
    console.log('        (or pip install opentimestamps-client)')
    console.log('        On Windows with Python 3.13 the native install may hit')
    console.log('        an OpenSSL compatibility issue; use `docker run --rm -v')
    console.log('        <dir>:/work python:3.11-slim sh -c "pip install -q')
    console.log('        opentimestamps-client && ots info /work/proof.ots"` instead.')
  } else {
    const alsoVerify = Boolean(args['verify']) || process.env.OTS_VERIFY === '1'
    const res = runOtsClient(event.content, targetEventId, { alsoVerify })
    const infoMatch = res.info.combined.match(/BitcoinBlockHeaderAttestation\((\d+)\)/i)
    if (res.info.status === 0 && infoMatch) {
      ok(`ots info parsed proof — BitcoinBlockHeaderAttestation(${infoMatch[1]}) (file: ${res.otsPath})`)
    } else {
      fail('ots info parsed proof', `status=${res.info.status}\n${res.info.combined.trim()}`)
    }
    if (alsoVerify && res.verify) {
      if (res.verify.status === 0 && /bitcoin\s+block/i.test(res.verify.combined)) {
        const vm = res.verify.combined.match(/bitcoin\s+block\s+\[?(\d+)\]?/i)
        ok(`ots verify confirmed proof against Bitcoin node (block ${vm ? vm[1] : 'unknown'})`)
      } else {
        fail(
          'ots verify confirmed proof against Bitcoin node',
          `status=${res.verify.status}\n${res.verify.combined.trim()}\n` +
            '(this step needs a reachable Bitcoin node; without one, `ots info` above is sufficient ' +
            'to prove the real OTS client parses the file and sees a Bitcoin attestation.)',
        )
      }
    }
  }

  console.log('')
  console.log('3) Publishing the real event to the local relay')
  try {
    const res = await publishEvent(LOCAL_RELAY, event)
    if (res.accepted) {
      ok(`local relay accepted real NIP-03 event (reason="${res.reason}")`)
    } else {
      fail('local relay accepted real NIP-03 event', `OK false, reason="${res.reason}"`)
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    fail('local relay accepted real NIP-03 event', err.message)
  }

  console.log('')
  console.log('4) Round-tripping the event through the local relay')
  try {
    const roundTripped = await fetchEvent(LOCAL_RELAY, event.id)
    if (!roundTripped) {
      fail('local relay returned the stored event on REQ', 'no event came back')
    } else if (roundTripped.content !== event.content) {
      fail('local relay returned the stored event on REQ', 'content differs after round-trip')
    } else if (roundTripped.id !== event.id || roundTripped.sig !== event.sig) {
      fail('local relay returned the stored event on REQ', 'id/sig differs after round-trip')
    } else {
      ok('local relay returned the same event (id, sig, content) on REQ')
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    fail('local relay returned the stored event on REQ', err.message)
  }

  finish()
}

function finish(): void {
  console.log('')
  console.log(`summary: ${passed} passed, ${failed} failed`)
  if (failed === 0) {
    console.log('')
    console.log('Real-client negative paths (digest mismatch, uppercase hex, multiple k tags,')
    console.log('garbage content, unsupported OTS version) are covered in:')
    console.log('  - test/unit/utils/nip03.spec.ts')
    console.log('  - test/unit/handlers/event-strategies/timestamp-event-strategy.spec.ts')
  }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(2)
})
