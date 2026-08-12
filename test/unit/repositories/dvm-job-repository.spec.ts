import * as chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import * as sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { DatabaseClient } from '../../../src/@types/base'
import { DvmJobStatus } from '../../../src/@types/dvm'
import { DvmJobRepository } from '../../../src/repositories/dvm-job-repository'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('DvmJobRepository', () => {
  let repository: DvmJobRepository
  let sandbox: sinon.SinonSandbox

  const fixedDate = new Date('2026-08-12T00:00:00.000Z')
  const jobId = 'a'.repeat(64)
  const pubkeyHex = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'
  const resultEventId = 'b'.repeat(64)

  const dbDvmJobRow = {
    id: Buffer.from(jobId, 'hex'),
    requester_pubkey: Buffer.from(pubkeyHex, 'hex'),
    kind: 5000,
    worker_index: null as number | null,
    status: DvmJobStatus.SUBMITTED,
    result_event_id: null as Buffer | null,
    error: null as string | null,
    picked_up_at: null as Date | null,
    completed_at: null as Date | null,
    created_at: fixedDate,
    updated_at: fixedDate,
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.useFakeTimers(fixedDate.getTime())

    repository = new DvmJobRepository({} as DatabaseClient)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('.create', () => {
    it('inserts into the dvm_jobs table', async () => {
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({
        insert: insertStub,
      }) as unknown as DatabaseClient

      await repository.create(jobId, pubkeyHex, 5000, client)

      expect(client).to.have.been.calledWith('dvm_jobs')
    })

    it('returns a DvmJob with submitted status and no worker assigned', async () => {
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({
        insert: insertStub,
      }) as unknown as DatabaseClient

      const result = await repository.create(jobId, pubkeyHex, 5000, client)

      expect(result).to.deep.include({
        id: jobId,
        requesterPubkey: pubkeyHex,
        kind: 5000,
        workerIndex: null,
        status: DvmJobStatus.SUBMITTED,
        resultEventId: null,
        error: null,
      })
      expect(result.createdAt).to.be.instanceOf(Date)
      expect(result.updatedAt).to.be.instanceOf(Date)
    })

    it('stores id and requester pubkey as buffers', async () => {
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({
        insert: insertStub,
      }) as unknown as DatabaseClient

      await repository.create(jobId, pubkeyHex, 5000, client)

      const insertedRow = insertStub.firstCall.args[0]
      expect(insertedRow.id).to.deep.equal(Buffer.from(jobId, 'hex'))
      expect(insertedRow.requester_pubkey).to.deep.equal(Buffer.from(pubkeyHex, 'hex'))
    })
  })

  describe('.findById', () => {
    it('returns undefined when no job is found', async () => {
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findById(jobId, client)

      expect(result).to.be.undefined
    })

    it('returns a transformed DvmJob when found', async () => {
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([dbDvmJobRow]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findById(jobId, client)

      expect(result).to.not.be.undefined
      expect(result!.id).to.equal(jobId)
      expect(result!.requesterPubkey).to.equal(pubkeyHex)
      expect(result!.status).to.equal(DvmJobStatus.SUBMITTED)
    })

    it('queries the dvm_jobs table by id', async () => {
      const whereStub = sandbox.stub().returns({ select: sandbox.stub().resolves([]) })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.findById(jobId, client)

      expect(client).to.have.been.calledWith('dvm_jobs')
      const [field, value] = whereStub.firstCall.args
      expect(field).to.equal('id')
      expect(value).to.deep.equal(Buffer.from(jobId, 'hex'))
    })
  })

  describe('.assignWorker', () => {
    it('returns true when assignment succeeds (rowCount > 0)', async () => {
      const updateStub = sandbox.stub().resolves(1)
      const whereStub2 = sandbox.stub().returns({ update: updateStub })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient

      const result = await repository.assignWorker(jobId, 0, client)

      expect(result).to.be.true
    })

    it('returns false when no submitted job matched (rowCount = 0)', async () => {
      const updateStub = sandbox.stub().resolves(0)
      const whereStub2 = sandbox.stub().returns({ update: updateStub })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient

      const result = await repository.assignWorker(jobId, 0, client)

      expect(result).to.be.false
    })

    it('returns true when pg returns { rowCount } object', async () => {
      const updateStub = sandbox.stub().resolves({ rowCount: 1 })
      const whereStub2 = sandbox.stub().returns({ update: updateStub })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient

      const result = await repository.assignWorker(jobId, 0, client)

      expect(result).to.be.true
    })

    it('only matches jobs still in submitted status', async () => {
      const updateStub = sandbox.stub().resolves(1)
      const whereStub2 = sandbox.stub().returns({ update: updateStub })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient

      await repository.assignWorker(jobId, 2, client)

      expect(whereStub2).to.have.been.calledWith('status', DvmJobStatus.SUBMITTED)
    })
  })

  describe('.updateStatus', () => {
    it('updates status and returns the transformed job', async () => {
      const updatedRow = { ...dbDvmJobRow, status: DvmJobStatus.COMPLETED, completed_at: fixedDate }
      const returningStub = sandbox.stub().resolves([updatedRow])
      const updateStub = sandbox.stub().returns({ returning: returningStub })
      const whereStub = sandbox.stub().returns({ update: updateStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      const result = await repository.updateStatus({ id: jobId, status: DvmJobStatus.COMPLETED }, client)

      expect(result).to.not.be.undefined
      expect(result!.status).to.equal(DvmJobStatus.COMPLETED)
    })

    it('returns undefined when no matching job exists', async () => {
      const returningStub = sandbox.stub().resolves([])
      const updateStub = sandbox.stub().returns({ returning: returningStub })
      const whereStub = sandbox.stub().returns({ update: updateStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      const result = await repository.updateStatus({ id: jobId, status: DvmJobStatus.FAILED }, client)

      expect(result).to.be.undefined
    })

    it('sets completed_at for terminal statuses', async () => {
      const returningStub = sandbox.stub().resolves([dbDvmJobRow])
      const updateStub = sandbox.stub().returns({ returning: returningStub })
      const whereStub = sandbox.stub().returns({ update: updateStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.updateStatus({ id: jobId, status: DvmJobStatus.TIMED_OUT }, client)

      const update = updateStub.firstCall.args[0]
      expect(update.completed_at).to.deep.equal(fixedDate)
    })

    it('does not set completed_at for the picked_up status', async () => {
      const returningStub = sandbox.stub().resolves([dbDvmJobRow])
      const updateStub = sandbox.stub().returns({ returning: returningStub })
      const whereStub = sandbox.stub().returns({ update: updateStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.updateStatus({ id: jobId, status: DvmJobStatus.PICKED_UP }, client)

      const update = updateStub.firstCall.args[0]
      expect(update.completed_at).to.be.undefined
    })

    it('encodes resultEventId as a buffer when provided', async () => {
      const returningStub = sandbox.stub().resolves([dbDvmJobRow])
      const updateStub = sandbox.stub().returns({ returning: returningStub })
      const whereStub = sandbox.stub().returns({ update: updateStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.updateStatus({ id: jobId, status: DvmJobStatus.COMPLETED, resultEventId }, client)

      const update = updateStub.firstCall.args[0]
      expect(update.result_event_id).to.deep.equal(Buffer.from(resultEventId, 'hex'))
    })

    it('sets error when provided', async () => {
      const returningStub = sandbox.stub().resolves([dbDvmJobRow])
      const updateStub = sandbox.stub().returns({ returning: returningStub })
      const whereStub = sandbox.stub().returns({ update: updateStub })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.updateStatus({ id: jobId, status: DvmJobStatus.FAILED, error: 'worker crashed' }, client)

      const update = updateStub.firstCall.args[0]
      expect(update.error).to.equal('worker crashed')
    })
  })

  describe('.findPendingJobs', () => {
    it('returns an empty array when no pending jobs exist', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereInStub = sandbox.stub().returns({ orderBy: orderByStub })
      const client = sandbox.stub().returns({ whereIn: whereInStub }) as unknown as DatabaseClient

      const result = await repository.findPendingJobs(10, client)

      expect(result).to.be.an('array').that.is.empty
    })

    it('returns transformed DvmJob objects', async () => {
      const selectStub = sandbox.stub().resolves([dbDvmJobRow])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereInStub = sandbox.stub().returns({ orderBy: orderByStub })
      const client = sandbox.stub().returns({ whereIn: whereInStub }) as unknown as DatabaseClient

      const result = await repository.findPendingJobs(10, client)

      expect(result).to.have.lengthOf(1)
      expect(result[0].id).to.equal(jobId)
    })

    it('filters for submitted and picked_up statuses', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereInStub = sandbox.stub().returns({ orderBy: orderByStub })
      const client = sandbox.stub().returns({ whereIn: whereInStub }) as unknown as DatabaseClient

      await repository.findPendingJobs(10, client)

      expect(whereInStub).to.have.been.calledWith('status', [DvmJobStatus.SUBMITTED, DvmJobStatus.PICKED_UP])
    })

    it('orders by created_at ascending', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereInStub = sandbox.stub().returns({ orderBy: orderByStub })
      const client = sandbox.stub().returns({ whereIn: whereInStub }) as unknown as DatabaseClient

      await repository.findPendingJobs(10, client)

      expect(orderByStub).to.have.been.calledWith('created_at', 'asc')
    })

    it('defaults limit to 100', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereInStub = sandbox.stub().returns({ orderBy: orderByStub })
      const client = sandbox.stub().returns({ whereIn: whereInStub }) as unknown as DatabaseClient

      await repository.findPendingJobs(undefined, client)

      expect(limitStub).to.have.been.calledWith(100)
    })
  })
})
