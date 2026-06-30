import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import * as eventUtils from '../../../src/utils/event'
import { WoTSettings } from '../../../src/@types/settings'
import {
  WotService,
  RelayFetcher,
  PHASE1_TIMEOUT_MS,
  PHASE2_BATCH_SIZE,
  PHASE2_CONCURRENCY,
  PHASE2_BATCH_TIMEOUT_MS,
} from '../../../src/services/wot-service'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

// ── fixtures ──────────────────────────────────────────────────────────────────

const SEED_PUBKEY  = 'a'.repeat(64)
const HOP1_PUBKEY  = 'b'.repeat(64)
const HOP2_PUBKEY  = 'c'.repeat(64)
const OTHER_PUBKEY = 'd'.repeat(64)

const RELAY_A = 'wss://relay-a.example.com'
const RELAY_B = 'wss://relay-b.example.com'

const baseSettings: WoTSettings = {
  enabled: true,
  seedPubkey: SEED_PUBKEY,
  minimumFollowers: 1,
  refreshIntervalHours: 24,
  seedRelays: [RELAY_A],
}

function makeEvent(id: string, pubkey: string, follows: string[]): object {
  return {
    id,
    pubkey,
    kind: 3,
    tags: follows.map((pk) => ['p', pk]),
    content: '',
    created_at: 1_700_000_000,
    sig: 'f'.repeat(128),
  }
}

async function* toStream(events: any[]): AsyncGenerator<any> {
  for (const e of events) { yield e }
}

function hangingStream(): { gen: AsyncGenerator<any>; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  async function* gen(): AsyncGenerator<any> { await gate }
  return { gen: gen(), release }
}

// ── repository stub ───────────────────────────────────────────────────────────
//
// WotService accesses masterDbClient directly for Phase 1B and Phase 3 queries.
// Each phase makes two calls to clientFn (outer query + inner subselect), so:
//   calls 1-2  → oneHopChain   (Phase 1B)
//   calls 3-4  → trustedChain  (Phase 3)
//
function makeRepoStub(
  sandbox: Sinon.SinonSandbox,
  opts: { oneHopRows?: any[]; trustedRows?: any[] } = {},
) {
  const { oneHopRows = [], trustedRows = [] } = opts
  const upsert = sandbox.stub().resolves(1)

  const makeChain = (rows: any[]) => {
    const chain: any = {}
    ;['select', 'whereIn', 'where', 'groupBy', 'havingRaw'].forEach((m) => {
      chain[m] = () => chain
    })
    chain.then = (ok: any, fail: any) => Promise.resolve(rows).then(ok, fail)
    return chain
  }

  const oneHopChain = makeChain(oneHopRows)
  const trustedChain = makeChain(trustedRows)

  const clientStub = sandbox.stub()
  clientStub.onCall(0).returns(oneHopChain)  // Phase 1B outer
  clientStub.onCall(1).returns(oneHopChain)  // Phase 1B subselect
  clientStub.onCall(2).returns(trustedChain) // Phase 3 outer
  clientStub.onCall(3).returns(trustedChain) // Phase 3 subselect

  // knex exposes `.raw()` — add it as a plain property on the stub function
  const clientFn = Object.assign(clientStub, { raw: () => ({}) })

  return { upsert, masterDbClient: clientFn }
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('WotService', () => {
  let sandbox: Sinon.SinonSandbox
  let fetcher: Sinon.SinonStub
  let repo: ReturnType<typeof makeRepoStub>
  let service: WotService

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    // Default: all events pass validation
    sandbox.stub(eventUtils, 'isEventIdValid').resolves(true)
    sandbox.stub(eventUtils, 'isEventSignatureValid').resolves(true)

    // Default fetcher: empty stream
    fetcher = sandbox.stub<Parameters<RelayFetcher>, ReturnType<RelayFetcher>>()
      .callsFake(() => toStream([]))

    repo = makeRepoStub(sandbox)
    service = new WotService(repo as any, fetcher)
  })

  afterEach(() => {
    sandbox.restore()
  })

  // ── initial state ──────────────────────────────────────────────────────────

  describe('before any build', () => {
    it('isReady() returns false', () => {
      expect(service.isReady()).to.equal(false)
    })
  })

  // ── fetch parameters ───────────────────────────────────────────────────────

  describe('buildGraph() — fetch parameters', () => {
    it('phase 1: calls fetcher with the seed relay URL', async () => {
      await service.buildGraph(baseSettings)

      expect(fetcher.firstCall.args[0]).to.equal(RELAY_A)
    })

    it('phase 1: calls fetcher with correct kind-3 filter for the seed', async () => {
      await service.buildGraph(baseSettings)

      const filter = fetcher.firstCall.args[1]
      expect(filter).to.deep.include({ kinds: [3], authors: [SEED_PUBKEY] })
    })

    it('phase 1: calls fetcher with PHASE1_TIMEOUT_MS', async () => {
      await service.buildGraph(baseSettings)

      expect(fetcher.firstCall.args[2]).to.equal(PHASE1_TIMEOUT_MS)
    })

    it('phase 1: fans out to every configured seed relay', async () => {
      const settings = { ...baseSettings, seedRelays: [RELAY_A, RELAY_B] }
      await service.buildGraph(settings)

      const calledUrls = Array.from({ length: fetcher.callCount }, (_, i) => fetcher.getCall(i).args[0])
      expect(calledUrls).to.include(RELAY_A)
      expect(calledUrls).to.include(RELAY_B)
    })

    it('phase 2: calls fetcher with PHASE2_BATCH_TIMEOUT_MS for batch fetches', async () => {
      repo = makeRepoStub(sandbox, { oneHopRows: [{ tag_value: HOP1_PUBKEY }] })
      service = new WotService(repo as any, fetcher)

      await service.buildGraph(baseSettings)

      // phase 1 call uses PHASE1_TIMEOUT_MS; phase 2 calls use PHASE2_BATCH_TIMEOUT_MS
      const phase2Call = fetcher.getCalls().find((c) => c.args[2] === PHASE2_BATCH_TIMEOUT_MS)
      expect(phase2Call).to.not.be.undefined
    })
  })

  // ── validation and storage ─────────────────────────────────────────────────

  describe('buildGraph() — validation and storage', () => {
    it('upserts events that pass both validation checks', async () => {
      fetcher.onFirstCall().callsFake(() => toStream([
        makeEvent('evt1', SEED_PUBKEY, [HOP1_PUBKEY]),
      ]))

      await service.buildGraph(baseSettings)

      expect(repo.upsert.callCount).to.equal(1)
    })

    it('skips events where isEventIdValid returns false', async () => {
      ;(eventUtils.isEventIdValid as Sinon.SinonStub).resolves(false)
      fetcher.onFirstCall().callsFake(() => toStream([
        makeEvent('evt1', SEED_PUBKEY, [HOP1_PUBKEY]),
      ]))

      await service.buildGraph(baseSettings)

      expect(repo.upsert.callCount).to.equal(0)
    })

    it('skips events where isEventSignatureValid returns false', async () => {
      ;(eventUtils.isEventSignatureValid as Sinon.SinonStub).resolves(false)
      fetcher.onFirstCall().callsFake(() => toStream([
        makeEvent('evt1', SEED_PUBKEY, [HOP1_PUBKEY]),
      ]))

      await service.buildGraph(baseSettings)

      expect(repo.upsert.callCount).to.equal(0)
    })

    it('upserts valid events and skips invalid ones in the same stream', async () => {
      const isIdValid = eventUtils.isEventIdValid as Sinon.SinonStub
      // first event: valid, second event: invalid id
      isIdValid.onFirstCall().resolves(true)
      isIdValid.onSecondCall().resolves(false)

      fetcher.onFirstCall().callsFake(() => toStream([
        makeEvent('evt1', SEED_PUBKEY, [HOP1_PUBKEY]),
        makeEvent('evt2', SEED_PUBKEY, [HOP2_PUBKEY]),
      ]))

      await service.buildGraph(baseSettings)

      expect(repo.upsert.callCount).to.equal(1)
    })
  })

  // ── batching ───────────────────────────────────────────────────────────────

  describe('buildGraph() — batching', () => {
    it('splits 1-hop pubkeys into batches of PHASE2_BATCH_SIZE', async () => {
      // produce PHASE2_BATCH_SIZE + 1 one-hop pubkeys so we expect 2 batches
      const manyPubkeys = Array.from({ length: PHASE2_BATCH_SIZE + 1 }, (_, i) =>
        i.toString(16).padStart(64, '0'),
      )
      repo = makeRepoStub(sandbox, { oneHopRows: manyPubkeys.map((pk) => ({ tag_value: pk })) })
      service = new WotService(repo as any, fetcher)

      await service.buildGraph(baseSettings)

      // phase 1: 1 call, phase 2: 2 batches × 1 relay = 2 calls → total 3
      expect(fetcher.callCount).to.equal(3)
    })

    it('each phase 2 batch carries at most PHASE2_BATCH_SIZE authors', async () => {
      const manyPubkeys = Array.from({ length: PHASE2_BATCH_SIZE + 1 }, (_, i) =>
        i.toString(16).padStart(64, '0'),
      )
      repo = makeRepoStub(sandbox, { oneHopRows: manyPubkeys.map((pk) => ({ tag_value: pk })) })
      service = new WotService(repo as any, fetcher)

      await service.buildGraph(baseSettings)

      const phase2Calls = fetcher.getCalls().filter((c) => c.args[2] === PHASE2_BATCH_TIMEOUT_MS)
      for (const call of phase2Calls) {
        expect(call.args[1].authors.length).to.be.at.most(PHASE2_BATCH_SIZE)
      }
    })

    it('does not exceed PHASE2_CONCURRENCY simultaneous fetches', async () => {
      // Enough batches to exceed the concurrency limit
      const batchCount = PHASE2_CONCURRENCY + 2
      const pubkeys = Array.from({ length: PHASE2_BATCH_SIZE * batchCount }, (_, i) =>
        i.toString(16).padStart(64, '0'),
      )
      repo = makeRepoStub(sandbox, { oneHopRows: pubkeys.map((pk) => ({ tag_value: pk })) })
      service = new WotService(repo as any, fetcher)

      // Promise barrier — all workers park here until we release them.
      // When waitingCount peaks, that IS the max concurrency — no timing needed.
      let waitingCount = 0
      let peakWaiting = 0
      let releaseAll!: () => void
      const barrier = new Promise<void>((resolve) => { releaseAll = resolve })

      fetcher.callsFake((url: string, filter: any, timeout: number) => {
        if (timeout !== PHASE2_BATCH_TIMEOUT_MS) {
          return toStream([])
        }
        return (async function* () {
          waitingCount++
          peakWaiting = Math.max(peakWaiting, waitingCount)
          await barrier   // park until releaseAll() is called
          waitingCount--
        })()
      })

      // Start buildGraph but don't await — workers are now queued up at the barrier
      const buildPromise = service.buildGraph(baseSettings)

      // Yield to the event loop until PHASE2_CONCURRENCY workers have parked
      // (runConcurrent starts exactly min(concurrency, batches) workers upfront)
      await new Promise<void>((resolve) => {
        const poll = () => {
          if (waitingCount >= Math.min(PHASE2_CONCURRENCY, batchCount)) {
            resolve()
          } else {
            setImmediate(poll)
          }
        }
        poll()
      })

      // At this point all initially-scheduled workers are parked — record peak
      const observedPeak = peakWaiting

      // Release the barrier so buildGraph can complete
      releaseAll()
      await buildPromise

      expect(observedPeak).to.be.at.most(PHASE2_CONCURRENCY)
      expect(observedPeak).to.equal(Math.min(PHASE2_CONCURRENCY, batchCount))
    })
  })

  // ── phase 2 error handling ─────────────────────────────────────────────────

  describe('buildGraph() — phase 2 error handling', () => {
    it('continues build if one relay throws during a batch', async () => {
      const settings = { ...baseSettings, seedRelays: [RELAY_A, RELAY_B] }
      repo = makeRepoStub(sandbox, { oneHopRows: [{ tag_value: HOP1_PUBKEY }] })
      service = new WotService(repo as any, fetcher)

      // RELAY_B phase 2 batch throws mid-iteration
      fetcher.callsFake((url: string, filter: any, timeout: number) => {
        if (url === RELAY_B && timeout === PHASE2_BATCH_TIMEOUT_MS) {
          return (async function* () {
            yield makeEvent('evt-err', HOP1_PUBKEY, [])  // yield first so we enter the for-await
            throw new Error('relay down')
          })()
        }
        return toStream([])
      })

      await expect(service.buildGraph(settings)).to.eventually.be.fulfilled
      expect(service.isReady()).to.equal(true)
    })

    it('completes build even if all relays fail for a batch', async () => {
      repo = makeRepoStub(sandbox, { oneHopRows: [{ tag_value: HOP1_PUBKEY }] })
      service = new WotService(repo as any, fetcher)

      fetcher.callsFake((url: string, filter: any, timeout: number) => {
        if (timeout === PHASE2_BATCH_TIMEOUT_MS) {
          return (async function* () {
            yield makeEvent('evt-err', HOP1_PUBKEY, [])
            throw new Error('all relays down')
          })()
        }
        return toStream([])
      })

      await expect(service.buildGraph(baseSettings)).to.eventually.be.fulfilled
      expect(service.isReady()).to.equal(true)
    })
  })

  // ── early return path ──────────────────────────────────────────────────────

  describe('buildGraph() — early return path', () => {
    it('returns [seedPubkey] when seed has no 1-hop follows', async () => {
      // oneHopRows defaults to [] in makeRepoStub
      const result = await service.buildGraph(baseSettings)
      expect(result).to.deep.equal([SEED_PUBKEY])
    })

    it('sets isReady() true even on early return', async () => {
      await service.buildGraph(baseSettings)
      expect(service.isReady()).to.equal(true)
    })

    it('does not call fetcher for phase 2 when seed has no follows', async () => {
      await service.buildGraph(baseSettings)

      const phase2Calls = fetcher.getCalls().filter((c) => c.args[2] === PHASE2_BATCH_TIMEOUT_MS)
      expect(phase2Calls).to.have.length(0)
    })
  })

  // ── SQL trust contract ─────────────────────────────────────────────────────

  describe('buildGraph() — SQL trust contract', () => {
    it('always includes seedPubkey in result', async () => {
      repo = makeRepoStub(sandbox, {
        oneHopRows: [{ tag_value: HOP1_PUBKEY }],
        trustedRows: [],
      })
      service = new WotService(repo as any, fetcher)

      const result = await service.buildGraph(baseSettings)
      expect(result).to.include(SEED_PUBKEY)
    })

    it('includes pubkeys returned by the SQL trust query', async () => {
      repo = makeRepoStub(sandbox, {
        oneHopRows: [{ tag_value: HOP1_PUBKEY }],
        trustedRows: [{ tag_value: HOP2_PUBKEY }],
      })
      service = new WotService(repo as any, fetcher)

      const result = await service.buildGraph(baseSettings)
      expect(result).to.include(HOP2_PUBKEY)
    })

    it('does not include pubkeys absent from the SQL trust query result', async () => {
      repo = makeRepoStub(sandbox, {
        oneHopRows: [{ tag_value: HOP1_PUBKEY }],
        trustedRows: [{ tag_value: HOP2_PUBKEY }],
      })
      service = new WotService(repo as any, fetcher)

      const result = await service.buildGraph(baseSettings)
      expect(result).to.not.include(OTHER_PUBKEY)
    })

    it('deduplicates seedPubkey if it also appears in SQL results', async () => {
      repo = makeRepoStub(sandbox, {
        oneHopRows: [{ tag_value: HOP1_PUBKEY }],
        // seed appears in trusted rows (e.g. someone follows them back)
        trustedRows: [{ tag_value: SEED_PUBKEY }, { tag_value: HOP2_PUBKEY }],
      })
      service = new WotService(repo as any, fetcher)

      const result = await service.buildGraph(baseSettings)
      const seedCount = result.filter((pk) => pk === SEED_PUBKEY).length
      expect(seedCount).to.equal(1)
    })
  })

  // ── state transitions ──────────────────────────────────────────────────────

  describe('buildGraph() — state transitions', () => {
    it('sets isReady() to true after a successful build', async () => {
      await service.buildGraph(baseSettings)
      expect(service.isReady()).to.equal(true)
    })

    it('returns [] immediately when a build is already in flight', async () => {
      const { gen, release } = hangingStream()
      fetcher.onFirstCall().returns(gen)

      const first = service.buildGraph(baseSettings)
      const second = await service.buildGraph(baseSettings)

      expect(second).to.deep.equal([])
      expect(fetcher.callCount).to.equal(1)

      release()
      await first
    })

    it('isReady() remains false after a thrown error', async () => {
      fetcher.callsFake(async function* () {
        throw new Error('boom')
      })

      await expect(service.buildGraph(baseSettings)).to.eventually.be.rejected
      expect(service.isReady()).to.equal(false)
    })

    it('building flag resets after error — subsequent build can run', async () => {
      fetcher.onFirstCall().callsFake(async function* () {
        throw new Error('first attempt failed')
      })

      await expect(service.buildGraph(baseSettings)).to.eventually.be.rejected

      // reset fetcher to empty stream for second attempt
      fetcher.callsFake(() => toStream([]))

      await expect(service.buildGraph(baseSettings)).to.eventually.be.fulfilled
      expect(service.isReady()).to.equal(true)
    })
  })
})
