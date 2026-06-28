import * as chai from 'chai'
import * as sinon from 'sinon'
import knex from 'knex'
import sinonChai from 'sinon-chai'
import chaiAsPromised from 'chai-as-promised'

import { DatabaseClient } from '../../../src/@types/base'
import { generateInviteCode, InviteCodeRepository } from '../../../src/repositories/invite-code-repository'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('InviteCodeRepository', () => {
  let repository: InviteCodeRepository
  let sandbox: sinon.SinonSandbox
  let dbClient: DatabaseClient

  const fixedDate = new Date('2026-06-24T00:00:00.000Z')
  const testCode = 'abc123deadbeef4567890000cafebabe'
  const pubkeyHex = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'

  const dbInviteCodeRow = {
    code: testCode,
    created_by: null as Buffer | null,
    claimed_by: null as Buffer | null,
    expires_at: null as Date | null,
    remaining_uses: 1,
    created_at: fixedDate,
    updated_at: fixedDate,
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.useFakeTimers(fixedDate.getTime())
    dbClient = knex({ client: 'pg' })

    repository = new InviteCodeRepository(dbClient)
  })

  afterEach(async () => {
    try { await dbClient.destroy() } finally { sandbox.restore() }
  })

  describe('generateInviteCode', () => {
    it('returns a 32-character hex string', () => {
      const code = generateInviteCode()
      expect(code).to.be.a('string')
      expect(code).to.have.lengthOf(32)
      expect(code).to.match(/^[0-9a-f]{32}$/)
    })

    it('generates unique codes on successive calls', () => {
      const codes = new Set(Array.from({ length: 50 }, () => generateInviteCode()))
      expect(codes.size).to.equal(50)
    })
  })

  describe('.create', () => {
    it('inserts into the invite_codes table', async () => {
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({
        insert: insertStub,
      }) as unknown as DatabaseClient

      await repository.create(testCode, undefined, 1, client)

      expect(client).to.have.been.calledWith('invite_codes')
    })

    it('returns an InviteCode object with correct defaults', async () => {
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({
        insert: insertStub,
      }) as unknown as DatabaseClient

      const result = await repository.create(testCode, undefined, 1, client)

      expect(result).to.deep.include({
        code: testCode,
        createdBy: null,
        claimedBy: null,
        expiresAt: null,
        remainingUses: 1,
      })
      expect(result.createdAt).to.be.instanceOf(Date)
      expect(result.updatedAt).to.be.instanceOf(Date)
    })

    it('passes the expires_at date when provided', async () => {
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({
        insert: insertStub,
      }) as unknown as DatabaseClient

      const expiresAt = new Date('2026-07-01T00:00:00.000Z')
      const result = await repository.create(testCode, expiresAt, 5, client)

      expect(result.expiresAt).to.deep.equal(expiresAt)
      expect(result.remainingUses).to.equal(5)

      const insertedRow = insertStub.firstCall.args[0]
      expect(insertedRow.expires_at).to.deep.equal(expiresAt)
      expect(insertedRow.remaining_uses).to.equal(5)
    })

    it('sets expiresAt to null when omitted', async () => {
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({
        insert: insertStub,
      }) as unknown as DatabaseClient

      const result = await repository.create(testCode, undefined, 1, client)

      expect(result.expiresAt).to.be.null
      const insertedRow = insertStub.firstCall.args[0]
      expect(insertedRow.expires_at).to.be.null
    })

    it('defaults remainingUses to 1', async () => {
      const insertStub = sandbox.stub().resolves()
      const client = sandbox.stub().returns({
        insert: insertStub,
      }) as unknown as DatabaseClient

      const result = await repository.create(testCode, undefined, undefined, client)

      expect(result.remainingUses).to.equal(1)
    })
  })

  describe('.findByCode', () => {
    it('returns undefined when no code is found', async () => {
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findByCode('nonexistent', client)

      expect(result).to.be.undefined
    })

    it('returns a transformed InviteCode when found', async () => {
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([dbInviteCodeRow]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findByCode(testCode, client)

      expect(result).to.not.be.undefined
      expect(result!.code).to.equal(testCode)
      expect(result!.createdBy).to.be.null
      expect(result!.claimedBy).to.be.null
      expect(result!.remainingUses).to.equal(1)
    })

    it('decodes created_by Buffer to hex string', async () => {
      const row = {
        ...dbInviteCodeRow,
        created_by: Buffer.from(pubkeyHex, 'hex'),
      }
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([row]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findByCode(testCode, client)

      expect(result!.createdBy).to.equal(pubkeyHex)
    })

    it('decodes claimed_by Buffer to hex string', async () => {
      const row = {
        ...dbInviteCodeRow,
        claimed_by: Buffer.from(pubkeyHex, 'hex'),
      }
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([row]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findByCode(testCode, client)

      expect(result!.claimedBy).to.equal(pubkeyHex)
    })

    it('queries the invite_codes table by code', async () => {
      const whereStub = sandbox.stub().returns({ select: sandbox.stub().resolves([]) })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.findByCode(testCode, client)

      expect(client).to.have.been.calledWith('invite_codes')
      const [field, value] = whereStub.firstCall.args
      expect(field).to.equal('code')
      expect(value).to.equal(testCode)
    })
  })

  describe('.claimCode', () => {
    it('returns true when claim succeeds (rowCount > 0)', async () => {
      const updateStub = sandbox.stub().resolves(1)
      const whereStub3 = sandbox.stub().returns({ update: updateStub })
      const whereStub2 = sandbox.stub().returns({ where: whereStub3 })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient
      ;(client as any).raw = sandbox.stub().returnsArg(0)

      const result = await repository.claimCode(testCode, pubkeyHex, client)

      expect(result).to.be.true
    })

    it('returns false when claim fails (rowCount = 0)', async () => {
      const updateStub = sandbox.stub().resolves(0)
      const whereStub3 = sandbox.stub().returns({ update: updateStub })
      const whereStub2 = sandbox.stub().returns({ where: whereStub3 })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient
      ;(client as any).raw = sandbox.stub().returnsArg(0)

      const result = await repository.claimCode(testCode, pubkeyHex, client)

      expect(result).to.be.false
    })

    it('returns true when pg returns { rowCount } object', async () => {
      const updateStub = sandbox.stub().resolves({ rowCount: 1 })
      const whereStub3 = sandbox.stub().returns({ update: updateStub })
      const whereStub2 = sandbox.stub().returns({ where: whereStub3 })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient
      ;(client as any).raw = sandbox.stub().returnsArg(0)

      const result = await repository.claimCode(testCode, pubkeyHex, client)

      expect(result).to.be.true
    })

    it('returns false when pg returns { rowCount: 0 }', async () => {
      const updateStub = sandbox.stub().resolves({ rowCount: 0 })
      const whereStub3 = sandbox.stub().returns({ update: updateStub })
      const whereStub2 = sandbox.stub().returns({ where: whereStub3 })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient
      ;(client as any).raw = sandbox.stub().returnsArg(0)

      const result = await repository.claimCode(testCode, pubkeyHex, client)

      expect(result).to.be.false
    })

    it('queries the invite_codes table', async () => {
      const updateStub = sandbox.stub().resolves(0)
      const whereStub3 = sandbox.stub().returns({ update: updateStub })
      const whereStub2 = sandbox.stub().returns({ where: whereStub3 })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient
      ;(client as any).raw = sandbox.stub().returnsArg(0)

      await repository.claimCode(testCode, pubkeyHex, client)

      expect(client).to.have.been.calledWith('invite_codes')
    })
  })

  describe('.findActiveCodes', () => {
    it('returns an empty array when no active codes exist', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereStub2 = sandbox.stub().returns({ orderBy: orderByStub })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient

      const result = await repository.findActiveCodes(10, client)

      expect(result).to.be.an('array').that.is.empty
    })

    it('returns transformed InviteCode objects', async () => {
      const selectStub = sandbox.stub().resolves([dbInviteCodeRow])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereStub2 = sandbox.stub().returns({ orderBy: orderByStub })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient

      const result = await repository.findActiveCodes(10, client)

      expect(result).to.have.lengthOf(1)
      expect(result[0].code).to.equal(testCode)
    })

    it('limits results to the requested count', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereStub2 = sandbox.stub().returns({ orderBy: orderByStub })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient

      await repository.findActiveCodes(25, client)

      expect(limitStub).to.have.been.calledWith(25)
    })

    it('orders by created_at descending', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereStub2 = sandbox.stub().returns({ orderBy: orderByStub })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient

      await repository.findActiveCodes(10, client)

      expect(orderByStub).to.have.been.calledWith('created_at', 'desc')
    })

    it('defaults limit to 100', async () => {
      const selectStub = sandbox.stub().resolves([])
      const limitStub = sandbox.stub().returns({ select: selectStub })
      const orderByStub = sandbox.stub().returns({ limit: limitStub })
      const whereStub2 = sandbox.stub().returns({ orderBy: orderByStub })
      const whereStub1 = sandbox.stub().returns({ where: whereStub2 })
      const client = sandbox.stub().returns({ where: whereStub1 }) as unknown as DatabaseClient

      await repository.findActiveCodes(undefined, client)

      expect(limitStub).to.have.been.calledWith(100)
    })
  })

  describe('.deleteExpiredCodes', () => {
    it('returns 0 when no expired codes exist', async () => {
      const deleteStub = sandbox.stub().resolves(0)
      const whereStub = sandbox.stub().returns({ delete: deleteStub })
      const whereNotNullStub = sandbox.stub().returns({ where: whereStub })
      const client = sandbox.stub().returns({ whereNotNull: whereNotNullStub }) as unknown as DatabaseClient

      const result = await repository.deleteExpiredCodes(client)

      expect(result).to.equal(0)
    })

    it('returns the count of deleted codes', async () => {
      const deleteStub = sandbox.stub().resolves(3)
      const whereStub = sandbox.stub().returns({ delete: deleteStub })
      const whereNotNullStub = sandbox.stub().returns({ where: whereStub })
      const client = sandbox.stub().returns({ whereNotNull: whereNotNullStub }) as unknown as DatabaseClient

      const result = await repository.deleteExpiredCodes(client)

      expect(result).to.equal(3)
    })

    it('handles pg { rowCount } response format', async () => {
      const deleteStub = sandbox.stub().resolves({ rowCount: 5 })
      const whereStub = sandbox.stub().returns({ delete: deleteStub })
      const whereNotNullStub = sandbox.stub().returns({ where: whereStub })
      const client = sandbox.stub().returns({ whereNotNull: whereNotNullStub }) as unknown as DatabaseClient

      const result = await repository.deleteExpiredCodes(client)

      expect(result).to.equal(5)
    })

    it('queries the invite_codes table', async () => {
      const deleteStub = sandbox.stub().resolves(0)
      const whereStub = sandbox.stub().returns({ delete: deleteStub })
      const whereNotNullStub = sandbox.stub().returns({ where: whereStub })
      const client = sandbox.stub().returns({ whereNotNull: whereNotNullStub }) as unknown as DatabaseClient

      await repository.deleteExpiredCodes(client)

      expect(client).to.have.been.calledWith('invite_codes')
    })

    it('filters for non-null expires_at', async () => {
      const deleteStub = sandbox.stub().resolves(0)
      const whereStub = sandbox.stub().returns({ delete: deleteStub })
      const whereNotNullStub = sandbox.stub().returns({ where: whereStub })
      const client = sandbox.stub().returns({ whereNotNull: whereNotNullStub }) as unknown as DatabaseClient

      await repository.deleteExpiredCodes(client)

      expect(whereNotNullStub).to.have.been.calledWith('expires_at')
    })
  })
})
