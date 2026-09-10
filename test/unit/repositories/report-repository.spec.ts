import * as chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import * as sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { DatabaseClient } from '../../../src/@types/base'
import { ReportRepository } from '../../../src/repositories/report-repository'
import { ReportType } from '../../../src/@types/report'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('ReportRepository', () => {
  let repository: ReportRepository
  let sandbox: sinon.SinonSandbox

  const fixedDate = new Date('2026-09-10T00:00:00.000Z')
  const reportId = 'a'.repeat(64)
  const reporterPubkey = '2'.repeat(64)
  const reportedPubkey = '3'.repeat(64)
  const reportedEventId = '4'.repeat(64)

  const dbReportRow = {
    id: Buffer.from(reportId, 'hex'),
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
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient

      await repository.create(
        {
          id: reportId,
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
    })

    it('returns a Report reflecting the input', async () => {
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient

      const result = await repository.create(
        {
          id: reportId,
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
        id: reportId,
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
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient

      await repository.create(
        {
          id: reportId,
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
      expect(insertedRow.id).to.deep.equal(Buffer.from(reportId, 'hex'))
      expect(insertedRow.reporter_pubkey).to.deep.equal(Buffer.from(reporterPubkey, 'hex'))
      expect(insertedRow.reported_pubkey).to.deep.equal(Buffer.from(reportedPubkey, 'hex'))
      expect(insertedRow.reported_event_id).to.deep.equal(Buffer.from(reportedEventId, 'hex'))
    })

    it('stores null reported_pubkey/reported_event_id when not provided', async () => {
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient

      await repository.create(
        {
          id: reportId,
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

  describe('.findById', () => {
    it('returns undefined when no report is found', async () => {
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findById(reportId, client)

      expect(result).to.be.undefined
    })

    it('returns a transformed Report when found', async () => {
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([dbReportRow]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findById(reportId, client)

      expect(result).to.not.be.undefined
      expect(result!.id).to.equal(reportId)
      expect(result!.reporterPubkey).to.equal(reporterPubkey)
      expect(result!.actionable).to.equal(true)
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
      expect(result[0].id).to.equal(reportId)
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
})
