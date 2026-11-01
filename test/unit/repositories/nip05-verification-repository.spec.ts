import { expect } from 'chai'
import Sinon from 'sinon'

import { DBNip05Verification, Nip05Verification } from '../../../src/@types/nip05'
import { Nip05VerificationRepository } from '../../../src/repositories/nip05-verification-repository'
import { createRecordingKnex } from './recording-knex'

describe('Nip05VerificationRepository', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z')
  const DAY_MS = 86_400_000
  const pubkeyHex = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'

  let clock: Sinon.SinonFakeTimers
  let queries: ReturnType<typeof createRecordingKnex>['queries']
  let respondWith: ReturnType<typeof createRecordingKnex>['respondWith']
  let repository: Nip05VerificationRepository

  const row = (overrides: Partial<DBNip05Verification> = {}): DBNip05Verification => ({
    pubkey: Buffer.from(pubkeyHex, 'hex'),
    nip05: 'alice@example.com',
    domain: 'example.com',
    is_verified: true,
    last_verified_at: new Date('2026-06-14T12:00:00.000Z'),
    last_checked_at: new Date('2026-06-14T12:00:00.000Z'),
    failure_count: 0,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-14T12:00:00.000Z'),
    ...overrides,
  })

  const verification = (overrides: Partial<Nip05Verification> = {}): Nip05Verification => ({
    pubkey: pubkeyHex,
    nip05: 'alice@example.com',
    domain: 'example.com',
    isVerified: true,
    lastVerifiedAt: new Date('2026-06-14T12:00:00.000Z'),
    lastCheckedAt: new Date('2026-06-14T12:00:00.000Z'),
    failureCount: 0,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-14T12:00:00.000Z'),
    ...overrides,
  })

  beforeEach(() => {
    clock = Sinon.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const recording = createRecordingKnex()
    queries = recording.queries
    respondWith = recording.respondWith
    repository = new Nip05VerificationRepository(recording.db as any)
  })

  afterEach(() => {
    clock.restore()
  })

  describe('.findByPubkey', () => {
    it('returns undefined for a pubkey that was never verified', async () => {
      respondWith([])

      expect(await repository.findByPubkey(pubkeyHex)).to.equal(undefined)
    })

    it('looks the pubkey up by its bytes and maps the row', async () => {
      respondWith([row({ is_verified: false, failure_count: 2, last_verified_at: null })])

      const found = await repository.findByPubkey(pubkeyHex)

      expect(queries[0].sql).to.equal('select * from "nip05_verifications" where "pubkey" = $1')
      expect(queries[0].bindings).to.deep.equal([Buffer.from(pubkeyHex, 'hex')])
      expect(found).to.deep.equal(
        verification({
          isVerified: false,
          failureCount: 2,
          lastVerifiedAt: null,
        }),
      )
    })
  })

  describe('.upsert', () => {
    it('inserts the verification, and on a second one for the same pubkey updates everything but the pubkey and creation time', async () => {
      respondWith(1)

      await repository.upsert(verification({ isVerified: false, failureCount: 3 }))

      const { sql } = queries[0]
      expect(sql).to.match(/^insert into "nip05_verifications" /)
      expect(sql).to.include('on conflict ("pubkey") do update set')
      const update = sql.slice(sql.indexOf('do update set'))
      for (const column of [
        'nip05',
        'domain',
        'is_verified',
        'last_verified_at',
        'last_checked_at',
        'failure_count',
        'updated_at',
      ]) {
        expect(update, column).to.include(`"${column}" =`)
      }
      expect(update).to.not.include('"pubkey" =')
      expect(update).to.not.include('"created_at" =')
    })

    it('stores the values it was given, stamping creation and update now', async () => {
      respondWith(1)

      await repository.upsert(verification({ failureCount: 3 }))

      const { bindings } = queries[0]
      expect(bindings).to.deep.include(Buffer.from(pubkeyHex, 'hex'))
      expect(bindings).to.include.members(['alice@example.com', 'example.com', true, 3])
      expect(bindings.filter((binding) => binding instanceof Date && binding.getTime() === NOW.getTime())).to.not.be
        .empty
    })

    it('checks now when the verification says nothing about when it was last checked, on insert and on conflict', async () => {
      respondWith(1)
      const checkedAt = new Date('2026-06-10T00:00:00.000Z')

      await repository.upsert(verification({ lastCheckedAt: undefined as unknown as Date }))
      await repository.upsert(verification({ lastCheckedAt: checkedAt }))

      const written = (query: (typeof queries)[number]) => {
        const insertColumns = /^insert into "nip05_verifications" \(([^)]*)\)/.exec(query.sql)![1].split(', ')
        const inserted = insertColumns.indexOf('"last_checked_at"')
        const updated = /"last_checked_at" = \$(\d+)/.exec(query.sql.slice(query.sql.indexOf('do update set')))![1]

        return [query.bindings[inserted], query.bindings[Number(updated) - 1]]
      }
      expect(written(queries[0])).to.deep.equal([NOW, NOW])
      expect(written(queries[1])).to.deep.equal([checkedAt, checkedAt])
    })

    it('resolves with the number of rows written', async () => {
      respondWith(1)

      expect(await repository.upsert(verification())).to.equal(1)
    })
  })

  describe('.findPendingVerifications', () => {
    it('selects verifications not checked within the update frequency and not yet failing too often, least recently checked first', async () => {
      respondWith([row()])

      const pending = await repository.findPendingVerifications(DAY_MS, 10, 50)

      expect(queries[0].sql).to.equal(
        'select * from "nip05_verifications" where "last_checked_at" < $1 and "failure_count" < $2 order by "last_checked_at" asc limit $3',
      )
      expect(queries[0].bindings).to.deep.equal([new Date(NOW.getTime() - DAY_MS), 10, 50])
      expect(pending).to.deep.equal([verification()])
    })

    it('gives up on a verification once it has failed the maximum number of times', async () => {
      respondWith([])

      await repository.findPendingVerifications(DAY_MS, 3, 50)

      expect(queries[0].sql).to.include('"failure_count" < $2')
      expect(queries[0].bindings[1]).to.equal(3)
    })
  })

  describe('.deleteByPubkey', () => {
    it('deletes the verification of the pubkey and returns how many rows went', async () => {
      respondWith(1)

      expect(await repository.deleteByPubkey(pubkeyHex)).to.equal(1)

      expect(queries[0].sql).to.equal('delete from "nip05_verifications" where "pubkey" = $1')
      expect(queries[0].bindings).to.deep.equal([Buffer.from(pubkeyHex, 'hex')])
    })
  })

  describe('.listForAdmin', () => {
    const query = { verifyExpirationMs: 7 * DAY_MS, limit: 25, offset: 50 }

    // Each list is two statements: the count, then the page.
    const list = (filters: Partial<Parameters<Nip05VerificationRepository['listForAdmin']>[0]> = {}, total = 0) => {
      respondWith([{ count: String(total) }], [])

      return repository.listForAdmin({ ...query, ...filters })
    }

    it('counts, then returns the page newest check first, with the limit and offset', async () => {
      respondWith([{ count: '120' }], [row()])

      const result = await repository.listForAdmin(query)

      expect(queries).to.have.length(2)
      expect(queries[0].sql).to.equal('select count(*) as "count" from "nip05_verifications" limit $1')
      expect(queries[1].sql).to.equal(
        'select * from "nip05_verifications" order by "last_checked_at" desc limit $1 offset $2',
      )
      expect(queries[1].bindings).to.deep.equal([25, 50])
      expect(result.total).to.equal(120)
      expect(result.rows).to.deep.equal([verification()])
    })

    it('reports a total of zero for an empty table', async () => {
      respondWith([], [])

      expect(await repository.listForAdmin(query)).to.deep.equal({ rows: [], total: 0 })
    })

    it('filters by domain, in the count and in the page', async () => {
      await list({ domain: 'example.com' })

      for (const { sql, bindings } of queries) {
        expect(sql).to.include('where "domain" = $1')
        expect(bindings[0]).to.equal('example.com')
      }
    })

    it('filters verified ones, and unverified ones', async () => {
      await list({ verified: true })
      await list({ verified: false })

      expect(queries[0].sql).to.include('where "is_verified" = $1')
      expect(queries[0].bindings[0]).to.equal(true)
      expect(queries[2].bindings[0]).to.equal(false)
    })

    it('filters by a minimum failure count, including zero', async () => {
      await list({ minFailures: 3 })
      await list({ minFailures: 0 })

      expect(queries[0].sql).to.include('where "failure_count" >= $1')
      expect(queries[0].bindings[0]).to.equal(3)
      expect(queries[2].bindings[0]).to.equal(0)
    })

    it('treats a verification as stale when it is unverified, was never verified, or was verified before the expiry', async () => {
      await list({ stale: true })

      expect(queries[0].sql).to.include(
        'where ("is_verified" = $1 or "last_verified_at" is null or "last_verified_at" < $2)',
      )
      expect(queries[0].bindings.slice(0, 2)).to.deep.equal([false, new Date(NOW.getTime() - 7 * DAY_MS)])
    })

    it('treats a verification as fresh when it is verified and was verified since the expiry', async () => {
      await list({ stale: false })

      expect(queries[0].sql).to.include('where "is_verified" = $1 and "last_verified_at" >= $2')
      expect(queries[0].bindings.slice(0, 2)).to.deep.equal([true, new Date(NOW.getTime() - 7 * DAY_MS)])
    })

    it('does not filter on staleness unless asked to', async () => {
      await list()

      expect(queries[0].sql).to.not.include('last_verified_at')
    })

    it('combines the filters with and', async () => {
      await list({ domain: 'example.com', verified: true, minFailures: 2, stale: false })

      const { sql, bindings } = queries[1]
      expect(sql).to.include(
        'where "domain" = $1 and "is_verified" = $2 and "failure_count" >= $3 and "is_verified" = $4 and "last_verified_at" >= $5',
      )
      expect(bindings.slice(0, 4)).to.deep.equal(['example.com', true, 2, true])
    })

    it('pages with the filters applied to the count too, so the total matches the filtered list', async () => {
      await list({ domain: 'example.com' }, 7)

      expect(queries[0].sql).to.match(/^select count\(\*\) as "count" from "nip05_verifications" where "domain" = \$1/)
    })
  })
})
