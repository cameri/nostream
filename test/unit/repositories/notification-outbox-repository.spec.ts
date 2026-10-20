import { expect } from 'chai'
import Sinon from 'sinon'

import { DBNotificationOutboxMessage, NotificationOutboxStatus } from '../../../src/@types/notification-outbox'
import {
  NOTIFICATION_OUTBOX_PROCESSING_LEASE_MS,
  NotificationOutboxRepository,
} from '../../../src/repositories/notification-outbox-repository'
import { createRecordingKnex } from './recording-knex'

describe('NotificationOutboxRepository', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z')
  let clock: Sinon.SinonFakeTimers
  let queries: ReturnType<typeof createRecordingKnex>['queries']
  let respondWith: ReturnType<typeof createRecordingKnex>['respondWith']
  let repository: NotificationOutboxRepository

  const row = (overrides: Partial<DBNotificationOutboxMessage> = {}): DBNotificationOutboxMessage => ({
    id: '6d1c9d4e-61a0-4a52-90a4-0c7f9a1c2b11',
    event_type: 'admission.invoice.paid',
    payload: { invoiceId: 'inv-1' },
    status: NotificationOutboxStatus.PENDING,
    attempt_count: 0,
    available_at: new Date('2026-06-15T11:00:00.000Z'),
    last_error: null,
    delivered_at: null,
    created_at: new Date('2026-06-15T10:00:00.000Z'),
    updated_at: new Date('2026-06-15T10:00:00.000Z'),
    ...overrides,
  })

  beforeEach(() => {
    clock = Sinon.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const recording = createRecordingKnex()
    queries = recording.queries
    respondWith = recording.respondWith
    repository = new NotificationOutboxRepository(recording.db as any)
  })

  afterEach(() => {
    clock.restore()
  })

  describe('.enqueue', () => {
    it('inserts a pending message that is available now and has not been attempted', async () => {
      respondWith(1)

      const message = await repository.enqueue('admission.invoice.paid', { invoiceId: 'inv-1' })

      expect(queries).to.have.length(1)
      expect(queries[0].sql).to.match(/^insert into "notification_outbox"/)
      expect(queries[0].bindings).to.include.members(['admission.invoice.paid', NotificationOutboxStatus.PENDING, 0])
      expect(message).to.include({
        eventType: 'admission.invoice.paid',
        status: NotificationOutboxStatus.PENDING,
        attemptCount: 0,
        lastError: null,
        deliveredAt: null,
      })
      expect(message.payload).to.deep.equal({ invoiceId: 'inv-1' })
      expect(message.availableAt).to.deep.equal(NOW)
      expect(message.createdAt).to.deep.equal(NOW)
      expect(message.updatedAt).to.deep.equal(NOW)
    })

    it('gives every message its own id', async () => {
      respondWith(1, 1)

      const first = await repository.enqueue('a', {})
      const second = await repository.enqueue('a', {})

      expect(first.id).to.match(/^[0-9a-f-]{36}$/)
      expect(first.id).to.not.equal(second.id)
    })

    it('does not swallow a failed insert, so the caller can roll back with it', async () => {
      const failing = createRecordingKnex()
      ;(failing.db.client as any).acquireConnection = async () => {
        throw new Error('connection refused')
      }

      let error: Error | undefined
      try {
        await new NotificationOutboxRepository(failing.db as any).enqueue('a', {})
      } catch (caught) {
        error = caught as Error
      }

      expect(error?.message).to.contain('connection refused')
    })
  })

  describe('.claimBatch', () => {
    it('returns nothing, and updates nothing, when no message is due', async () => {
      respondWith([])

      expect(await repository.claimBatch(10)).to.deep.equal([])

      expect(queries).to.have.length(1)
      expect(queries[0].sql).to.match(/^select/)
    })

    it('selects due pending messages and processing ones whose lease ran out, oldest first, up to the limit', async () => {
      respondWith([])

      await repository.claimBatch(7)

      const { sql, bindings } = queries[0]
      expect(sql).to.include('"status" = $1 and "available_at" <= CURRENT_TIMESTAMP')
      expect(sql).to.include('"status" = $2 and "updated_at" < $3')
      expect(sql).to.include('order by "created_at" asc')
      expect(sql).to.include('limit $4')
      expect(bindings[0]).to.equal(NotificationOutboxStatus.PENDING)
      expect(bindings[1]).to.equal(NotificationOutboxStatus.PROCESSING)
      expect(bindings[3]).to.equal(7)
    })

    it('reclaims a processing message once it has been held for longer than the lease', async () => {
      respondWith([])

      await repository.claimBatch(1)

      const staleBefore = queries[0].bindings[2] as Date
      expect(staleBefore).to.deep.equal(new Date(NOW.getTime() - NOTIFICATION_OUTBOX_PROCESSING_LEASE_MS))
      expect(NOTIFICATION_OUTBOX_PROCESSING_LEASE_MS).to.equal(5 * 60 * 1000)
    })

    it('locks the rows it selects and skips rows another worker holds, so no message goes to two workers', async () => {
      respondWith([])

      await repository.claimBatch(1)

      expect(queries[0].sql).to.match(/for update skip locked$/)
    })

    it('marks the selected messages as processing and returns them that way', async () => {
      const first = row({ id: 'id-1' })
      const second = row({ id: 'id-2', status: NotificationOutboxStatus.PROCESSING })
      respondWith([first, second], 2)

      const claimed = await repository.claimBatch(10)

      expect(queries).to.have.length(2)
      expect(queries[1].sql).to.match(
        /^update "notification_outbox" set "status" = \$1, "updated_at" = \$2 where "id" in \(\$3, \$4\)$/,
      )
      expect(queries[1].bindings).to.deep.equal([NotificationOutboxStatus.PROCESSING, NOW, 'id-1', 'id-2'])
      expect(claimed.map((message) => message.id)).to.deep.equal(['id-1', 'id-2'])
      for (const message of claimed) {
        expect(message.status).to.equal(NotificationOutboxStatus.PROCESSING)
        expect(message.updatedAt).to.deep.equal(NOW)
      }
    })

    it('maps the row, and leaves the attempt count for the caller to advance', async () => {
      respondWith([row({ attempt_count: 2, last_error: 'timeout' })], 1)

      const [message] = await repository.claimBatch(1)

      expect(message).to.include({
        eventType: 'admission.invoice.paid',
        attemptCount: 2,
        lastError: 'timeout',
      })
      expect(message.payload).to.deep.equal({ invoiceId: 'inv-1' })
      expect(message.availableAt).to.deep.equal(new Date('2026-06-15T11:00:00.000Z'))
    })
  })

  describe('.markDelivered', () => {
    it('marks the message delivered now and clears its last error', async () => {
      respondWith(1)

      await repository.markDelivered('id-1')

      expect(queries).to.have.length(1)
      expect(queries[0].sql).to.match(/^update "notification_outbox" set /)
      expect(queries[0].sql).to.include('"status" = $1')
      expect(queries[0].sql).to.include('"delivered_at" = $2')
      expect(queries[0].sql).to.include('"last_error" = $3')
      expect(queries[0].sql).to.match(/where "id" = \$5$/)
      expect(queries[0].bindings).to.deep.equal([NotificationOutboxStatus.DELIVERED, NOW, null, NOW, 'id-1'])
    })
  })

  describe('.markFailed', () => {
    const update = () => {
      const [{ sql, bindings }] = queries
      const columns = [...sql.matchAll(/"(\w+)" = \$(\d+)/g)].reduce(
        (all, [, column, position]) => ({ ...all, [column]: bindings[Number(position) - 1] }),
        {} as Record<string, unknown>,
      )

      return columns
    }

    beforeEach(() => {
      respondWith(1)
    })

    it('puts the message back to pending with the attempt count and the error', async () => {
      await repository.markFailed('id-1', 'HTTP 500', 1, 5, 1000)

      expect(update()).to.include({
        status: NotificationOutboxStatus.PENDING,
        attempt_count: 1,
        last_error: 'HTTP 500',
      })
      expect(queries[0].bindings[queries[0].bindings.length - 1]).to.equal('id-1')
    })

    it('waits the base delay after the first failure and doubles it after each one', async () => {
      const waits: number[] = []
      for (const attempt of [1, 2, 3, 4]) {
        queries.length = 0
        respondWith(1)

        await repository.markFailed('id-1', 'e', attempt, 10, 1000)

        waits.push((update().available_at as Date).getTime() - NOW.getTime())
      }

      expect(waits).to.deep.equal([1000, 2000, 4000, 8000])
    })

    it('never waits more than a minute', async () => {
      await repository.markFailed('id-1', 'e', 9, 10, 1000)

      expect((update().available_at as Date).getTime() - NOW.getTime()).to.equal(60_000)
    })

    it('does not wait at all when the base delay is negative', async () => {
      await repository.markFailed('id-1', 'e', 3, 10, -500)

      expect(update().available_at).to.deep.equal(NOW)
    })

    it('gives up once the attempts are used up, marking the message dead, available now', async () => {
      await repository.markFailed('id-1', 'HTTP 500', 5, 5, 1000)

      expect(update()).to.include({ status: NotificationOutboxStatus.DEAD, attempt_count: 5 })
      expect(update().available_at).to.deep.equal(NOW)
    })

    it('keeps retrying one attempt before the limit', async () => {
      await repository.markFailed('id-1', 'e', 4, 5, 1000)

      expect(update().status).to.equal(NotificationOutboxStatus.PENDING)
    })

    it('keeps no more than 2000 characters of the error', async () => {
      await repository.markFailed('id-1', 'x'.repeat(5000), 1, 5, 1000)

      expect(update().last_error).to.equal('x'.repeat(2000))
    })
  })

  describe('.deleteTerminalOlderThan', () => {
    const cutoff = new Date('2026-05-15T00:00:00.000Z')

    it('deletes delivered and dead messages last touched before the cutoff, never pending or processing ones', async () => {
      respondWith(4)

      await repository.deleteTerminalOlderThan(cutoff)

      expect(queries[0].sql).to.match(
        /^delete from "notification_outbox" where "status" in \(\$1, \$2\) and "updated_at" < \$3$/,
      )
      expect(queries[0].bindings).to.deep.equal([
        NotificationOutboxStatus.DELIVERED,
        NotificationOutboxStatus.DEAD,
        cutoff,
      ])
    })

    it('returns how many it deleted', async () => {
      respondWith(4)

      expect(await repository.deleteTerminalOlderThan(cutoff)).to.equal(4)
    })
  })
})
