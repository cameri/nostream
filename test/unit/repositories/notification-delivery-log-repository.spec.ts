import { expect } from 'chai'
import Sinon from 'sinon'

import { DBNotificationDeliveryLogEntry, NotificationDeliveryStatus } from '../../../src/@types/operator-notifications'
import { NotificationDeliveryLogRepository } from '../../../src/repositories/notification-delivery-log-repository'
import { createRecordingKnex } from './recording-knex'

describe('NotificationDeliveryLogRepository', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z')
  let clock: Sinon.SinonFakeTimers
  let queries: ReturnType<typeof createRecordingKnex>['queries']
  let respondWith: ReturnType<typeof createRecordingKnex>['respondWith']
  let repository: NotificationDeliveryLogRepository

  const row = (overrides: Partial<DBNotificationDeliveryLogEntry> = {}): DBNotificationDeliveryLogEntry => ({
    id: '7',
    outbox_id: 'outbox-1',
    event_type: 'admission.invoice.paid',
    target_id: 'ops-slack',
    target_type: 'slack',
    status: NotificationDeliveryStatus.SUCCESS,
    attempt_number: 1,
    error_snippet: null,
    created_at: new Date('2026-06-15T11:59:00.000Z'),
    ...overrides,
  })

  beforeEach(() => {
    clock = Sinon.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const recording = createRecordingKnex()
    queries = recording.queries
    respondWith = recording.respondWith
    repository = new NotificationDeliveryLogRepository(recording.db as any)
  })

  afterEach(() => {
    clock.restore()
  })

  describe('.append', () => {
    it('records a success with the outbox message, the target and the attempt, stamped now', async () => {
      respondWith(1)

      await repository.append({
        outboxId: 'outbox-1',
        eventType: 'admission.invoice.paid',
        targetId: 'ops-slack',
        targetType: 'slack',
        status: NotificationDeliveryStatus.SUCCESS,
        attemptNumber: 1,
        errorSnippet: null,
      })

      expect(queries).to.have.length(1)
      expect(queries[0].sql).to.match(/^insert into "notification_delivery_log" /)
      expect(queries[0].sql).to.include(
        '("attempt_number", "created_at", "error_snippet", "event_type", "outbox_id", "status", "target_id", "target_type")',
      )
      expect(queries[0].bindings).to.deep.equal([
        1,
        NOW,
        null,
        'admission.invoice.paid',
        'outbox-1',
        NotificationDeliveryStatus.SUCCESS,
        'ops-slack',
        'slack',
      ])
    })

    it('records a failure with the error it ended in', async () => {
      respondWith(1)

      await repository.append({
        outboxId: 'outbox-1',
        eventType: 'settings.changed',
        targetId: 'ops-http',
        targetType: 'http',
        status: NotificationDeliveryStatus.FAILED,
        attemptNumber: 3,
        errorSnippet: 'HTTP 503',
      })

      expect(queries[0].bindings).to.include.members([3, 'HTTP 503', NotificationDeliveryStatus.FAILED, 'ops-http'])
    })

    it('records a test notification, which has no outbox message', async () => {
      respondWith(1)

      await repository.append({
        outboxId: null,
        eventType: 'test',
        targetId: 'ops-http',
        targetType: 'http',
        status: NotificationDeliveryStatus.SUCCESS,
        attemptNumber: 1,
        errorSnippet: null,
      })

      expect(queries[0].bindings).to.include(null)
      expect(queries[0].bindings).to.not.include('outbox-1')
    })
  })

  describe('.findSuccessfulTargetIds', () => {
    it('lists, once each, the targets an outbox message was already delivered to, so a retry skips them', async () => {
      respondWith([{ target_id: 'ops-slack' }, { target_id: 'ops-http' }])

      const targetIds = await repository.findSuccessfulTargetIds('outbox-1')

      expect(targetIds).to.deep.equal(['ops-slack', 'ops-http'])
      expect(queries[0].sql).to.include('select distinct "target_id"')
      expect(queries[0].sql).to.include('from "notification_delivery_log"')
      expect(queries[0].sql).to.include('"outbox_id" = $1 and "status" = $2')
      expect(queries[0].bindings).to.deep.equal(['outbox-1', NotificationDeliveryStatus.SUCCESS])
    })

    it('returns nothing for a message that was never delivered', async () => {
      respondWith([])

      expect(await repository.findSuccessfulTargetIds('outbox-1')).to.deep.equal([])
    })
  })

  describe('.findRecent', () => {
    it('returns the latest 50 entries, newest first, when asked for no filter or limit', async () => {
      respondWith([row()])

      await repository.findRecent()

      expect(queries[0].sql).to.equal('select * from "notification_delivery_log" order by "created_at" desc limit $1')
      expect(queries[0].bindings).to.deep.equal([50])
    })

    it('honours the limit', async () => {
      respondWith([])

      await repository.findRecent(5)

      expect(queries[0].bindings).to.deep.equal([5])
    })

    it('filters by status', async () => {
      respondWith([])

      await repository.findRecent(50, { status: NotificationDeliveryStatus.FAILED })

      expect(queries[0].sql).to.include('where "status" = $1')
      expect(queries[0].bindings).to.deep.equal([NotificationDeliveryStatus.FAILED, 50])
    })

    it('filters by event type', async () => {
      respondWith([])

      await repository.findRecent(50, { eventType: 'settings.changed' })

      expect(queries[0].sql).to.include('where "event_type" = $1')
      expect(queries[0].bindings).to.deep.equal(['settings.changed', 50])
    })

    it('combines both filters', async () => {
      respondWith([])

      await repository.findRecent(50, { status: NotificationDeliveryStatus.SUCCESS, eventType: 'settings.changed' })

      expect(queries[0].sql).to.include('where "status" = $1 and "event_type" = $2')
      expect(queries[0].bindings).to.deep.equal([NotificationDeliveryStatus.SUCCESS, 'settings.changed', 50])
    })

    it('maps rows to entries', async () => {
      respondWith([row({ status: NotificationDeliveryStatus.FAILED, attempt_number: 2, error_snippet: 'HTTP 500' })])

      const [entry] = await repository.findRecent()

      expect(entry).to.deep.equal({
        id: '7',
        outboxId: 'outbox-1',
        eventType: 'admission.invoice.paid',
        targetId: 'ops-slack',
        targetType: 'slack',
        status: NotificationDeliveryStatus.FAILED,
        attemptNumber: 2,
        errorSnippet: 'HTTP 500',
        createdAt: new Date('2026-06-15T11:59:00.000Z'),
      })
    })
  })

  describe('.deleteOlderThan', () => {
    const cutoff = new Date('2026-05-15T00:00:00.000Z')

    it('deletes entries logged before the cutoff and returns how many', async () => {
      respondWith(12)

      expect(await repository.deleteOlderThan(cutoff)).to.equal(12)

      expect(queries[0].sql).to.equal('delete from "notification_delivery_log" where "created_at" < $1')
      expect(queries[0].bindings).to.deep.equal([cutoff])
    })
  })
})
