import * as chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import * as sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { DatabaseClient } from '../../../src/@types/base'
import { ReportType } from '../../../src/@types/report'
import { ReportRepository } from '../../../src/repositories/report-repository'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('ReportRepository', () => {
  let repository: ReportRepository
  let sandbox: sinon.SinonSandbox

  const fixedDate = new Date('2026-09-10T00:00:00.000Z')
  const eventId = 'a'.repeat(64)
  const reporterPubkey = '2'.repeat(64)
  const reportedPubkey = '3'.repeat(64)
  const reportedEventId = '4'.repeat(64)

  const dbReportRow = {
    id: 7,
    event_id: Buffer.from(eventId, 'hex'),
    reporter_pubkey: Buffer.from(reporterPubkey, 'hex'),
    reported_pubkey: Buffer.from(reportedPubkey, 'hex'),
    reported_event_id: Buffer.from(reportedEventId, 'hex'),
    report_type: ReportType.SPAM,
    weight: 1,
    actionable: true,
    created_at: fixedDate,
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.useFakeTimers(fixedDate.getTime())

    repository = new ReportRepository({} as DatabaseClient)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('.create', () => {
    it('inserts into the reports table', async () => {
      const returningStub = sandbox.stub().resolves([{ id: 7 }])
      const insertStub = sandbox.stub().returns({ returning: returningStub })
      const client = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient

      await repository.create(
        {
          eventId,
          reporterPubkey,
          reportedPubkey,
          reportedEventId,
          reportType: ReportType.SPAM,
          weight: 1,
          actionable: true,
        },
        client,
      )

      expect(client).to.have.been.calledWith('reports')
      expect(returningStub).to.have.been.calledWith(['id'])
    })

    it('returns a Report reflecting the input, with the DB-generated id', async () => {
      const returningStub = sandbox.stub().resolves([{ id: 7 }])
      const insertStub = sandbox.stub().returns({ returning: returningStub })
      const client = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient

      const result = await repository.create(
        {
          eventId,
          reporterPubkey,
          reportedPubkey,
          reportedEventId,
          reportType: ReportType.SPAM,
          weight: 1,
          actionable: true,
        },
        client,
      )

      expect(result).to.deep.include({
        id: 7,
        eventId,
        reporterPubkey,
        reportedPubkey,
        reportedEventId,
        reportType: ReportType.SPAM,
        weight: 1,
        actionable: true,
      })
      expect(result.createdAt).to.be.instanceOf(Date)
    })

    it('stores hex fields as buffers', async () => {
      const returningStub = sandbox.stub().resolves([{ id: 7 }])
      const insertStub = sandbox.stub().returns({ returning: returningStub })
      const client = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient

      await repository.create(
        {
          eventId,
          reporterPubkey,
          reportedPubkey,
          reportedEventId,
          reportType: ReportType.SPAM,
          weight: 1,
          actionable: true,
        },
        client,
      )

      const insertedRow = insertStub.firstCall.args[0]
      expect(insertedRow.event_id).to.deep.equal(Buffer.from(eventId, 'hex'))
      expect(insertedRow.reporter_pubkey).to.deep.equal(Buffer.from(reporterPubkey, 'hex'))
      expect(insertedRow.reported_pubkey).to.deep.equal(Buffer.from(reportedPubkey, 'hex'))
      expect(insertedRow.reported_event_id).to.deep.equal(Buffer.from(reportedEventId, 'hex'))
      expect(insertedRow).to.not.have.property('id')
    })

    it('stores null reported_pubkey/reported_event_id when not provided', async () => {
      const returningStub = sandbox.stub().resolves([{ id: 8 }])
      const insertStub = sandbox.stub().returns({ returning: returningStub })
      const client = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient

      await repository.create(
        {
          eventId,
          reporterPubkey,
          reportedPubkey: null,
          reportedEventId: null,
          reportType: ReportType.OTHER,
          weight: 0,
          actionable: false,
        },
        client,
      )

      const insertedRow = insertStub.firstCall.args[0]
      expect(insertedRow.reported_pubkey).to.be.null
      expect(insertedRow.reported_event_id).to.be.null
    })
  })

  describe('.createMany', () => {
    it('returns an empty array without opening a transaction when given no reports', async () => {
      const transactionStub = sandbox.stub()
      const client = { transaction: transactionStub } as unknown as DatabaseClient

      const result = await repository.createMany([], client)

      expect(result).to.deep.equal([])
      expect(transactionStub).not.to.have.been.called
    })

    it('inserts every report inside a single transaction', async () => {
      const returningStub = sandbox.stub().resolves([{ id: 7 }])
      const insertStub = sandbox.stub().returns({ returning: returningStub })
      const trx = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient
      const transactionStub = sandbox.stub().callsFake(async (fn: (trx: DatabaseClient) => Promise<unknown>) => fn(trx))
      const client = { transaction: transactionStub } as unknown as DatabaseClient

      const reports = [
        {
          eventId,
          reporterPubkey,
          reportedPubkey,
          reportedEventId: null,
          reportType: ReportType.SPAM,
          weight: 1,
          actionable: false,
        },
        {
          eventId,
          reporterPubkey,
          reportedPubkey: null,
          reportedEventId,
          reportType: ReportType.NUDITY,
          weight: 0.5,
          actionable: false,
        },
      ]

      const result = await repository.createMany(reports, client)

      expect(transactionStub).to.have.been.calledOnce
      expect(insertStub).to.have.been.calledTwice
      expect(result).to.have.lengthOf(2)
    })

    it('propagates a failure from the transaction without inserting a partial set', async () => {
      const transactionStub = sandbox.stub().rejects(new Error('constraint violation'))
      const client = { transaction: transactionStub } as unknown as DatabaseClient

      await expect(
        repository.createMany(
          [
            {
              eventId,
              reporterPubkey,
              reportedPubkey,
              reportedEventId: null,
              reportType: ReportType.SPAM,
              weight: 1,
              actionable: false,
            },
          ],
          client,
        ),
      ).to.eventually.be.rejectedWith('constraint violation')
    })
  })

  describe('.findByEventId', () => {
    it('returns an empty array when no reports are found', async () => {
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findByEventId(eventId, client)

      expect(result).to.be.an('array').that.is.empty
    })

    it('returns transformed Report rows when found', async () => {
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([dbReportRow]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findByEventId(eventId, client)

      expect(result).to.have.lengthOf(1)
      expect(result[0].id).to.equal(7)
      expect(result[0].eventId).to.equal(eventId)
      expect(result[0].reporterPubkey).to.equal(reporterPubkey)
      expect(result[0].actionable).to.equal(true)
    })

    it('queries by event_id', async () => {
      const whereStub = sandbox.stub().returns({ select: sandbox.stub().resolves([]) })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.findByEventId(eventId, client)

      expect(whereStub).to.have.been.calledWith('event_id', Buffer.from(eventId, 'hex'))
    })
  })

  describe('.findActionable', () => {
    it('filters by actionable and orders newest first', async () => {
      const selectStub = sandbox.stub().resolves([dbReportRow])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereStub = sandbox.stub().returns({ orderBy: orderByStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      const result = await repository.findActionable(10, client)

      expect(whereStub).to.have.been.calledWith('actionable', true)
      expect(orderByStub).to.have.been.calledWith('created_at', 'desc')
      expect(limitStub).to.have.been.calledWith(10)
      expect(result).to.have.lengthOf(1)
      expect(result[0].id).to.equal(7)
    })

    it('defaults limit to 100', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereStub = sandbox.stub().returns({ orderBy: orderByStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.findActionable(undefined, client)

      expect(limitStub).to.have.been.calledWith(100)
    })
  })

  describe('.findActionableTargets', () => {
    it('filters by actionable and selects distinct targets', async () => {
      const selectStub = sandbox.stub().resolves([
        { reported_pubkey: Buffer.from(reportedPubkey, 'hex'), reported_event_id: null },
        { reported_pubkey: null, reported_event_id: Buffer.from(reportedEventId, 'hex') },
      ])
      const distinctStub = sandbox.stub().returns({ select: selectStub })
      const whereStub = sandbox.stub().returns({ distinct: distinctStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      const result = await repository.findActionableTargets(client)

      expect(whereStub).to.have.been.calledWith('actionable', true)
      expect(distinctStub).to.have.been.calledWith('reported_pubkey', 'reported_event_id')
      expect(result).to.deep.equal([
        { reportedPubkey, reportedEventId: null },
        { reportedPubkey: null, reportedEventId },
      ])
    })
  })
})
