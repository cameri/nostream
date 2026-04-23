import * as chai from 'chai'
import * as sinon from 'sinon'
import knex from 'knex'
import sinonChai from 'sinon-chai'
import chaiAsPromised from 'chai-as-promised'

import { DatabaseClient } from '../../../src/@types/base'
import { User } from '../../../src/@types/user'
import { IEventRepository, IUserRepository } from '../../../src/@types/repositories'
import { UserRepository } from '../../../src/repositories/user-repository'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

describe('UserRepository', () => {
  let repository: IUserRepository
  let sandbox: sinon.SinonSandbox
  let dbClient: DatabaseClient
  let eventRepository: sinon.SinonStubbedInstance<IEventRepository>

  const pubkeyHex = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'
  const fixedDate = new Date('2026-01-01T00:00:00.000Z')

  const testUser: User = {
    pubkey: pubkeyHex,
    isAdmitted: true,
    isVanished: false,
    balance: 0n,
    tosAcceptedAt: null,
    createdAt: fixedDate,
    updatedAt: fixedDate,
  }

  const dbUserRow = {
    pubkey: Buffer.from(pubkeyHex, 'hex'),
    is_admitted: true,
    is_vanished: false,
    balance: 0n,
    created_at: fixedDate,
    updated_at: fixedDate,
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.useFakeTimers(fixedDate.getTime())
    dbClient = knex({ client: 'pg' })

    eventRepository = {
      create: sandbox.stub(),
      createMany: sandbox.stub(),
      upsert: sandbox.stub(),
      upsertMany: sandbox.stub(),
      findByFilters: sandbox.stub(),
      deleteByPubkeyAndIds: sandbox.stub(),
      deleteByPubkeyExceptKinds: sandbox.stub(),
      hasActiveRequestToVanish: sandbox.stub(),
      deleteExpiredAndRetained: sandbox.stub(),
    } as unknown as sinon.SinonStubbedInstance<IEventRepository>

    repository = new UserRepository(dbClient, eventRepository)
  })

  afterEach(() => {
    dbClient.destroy()
    sandbox.restore()
  })

  describe('.findByPubkey', () => {
    it('returns undefined when no user is found', async () => {
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findByPubkey(pubkeyHex, client)

      expect(result).to.be.undefined
    })

    it('returns a transformed User when found', async () => {
      const client = sandbox.stub().returns({
        where: sandbox.stub().returns({ select: sandbox.stub().resolves([dbUserRow]) }),
      }) as unknown as DatabaseClient

      const result = await repository.findByPubkey(pubkeyHex, client)

      expect(result).to.not.be.undefined
      expect(result!.pubkey).to.equal(pubkeyHex)
      expect(result!.isAdmitted).to.equal(true)
      expect(result!.isVanished).to.equal(false)
    })

    it('queries users table with toBuffer-encoded pubkey', async () => {
      const whereStub = sandbox.stub().returns({ select: sandbox.stub().resolves([]) })
      const client = sandbox.stub().returns({ where: whereStub }) as unknown as DatabaseClient

      await repository.findByPubkey(pubkeyHex, client)

      expect(client).to.have.been.calledWith('users')
      const [field, value] = whereStub.firstCall.args
      expect(field).to.equal('pubkey')
      expect(Buffer.isBuffer(value)).to.be.true
    })
  })

  describe('.upsert', () => {
    function makeFakeQueryBuilder(rowCount = 1) {
      const fakeQB = {
        then: (fn: (v: any) => any) => Promise.resolve({ rowCount }).then(fn),
        catch: (fn: (e: any) => any) => Promise.resolve(rowCount).catch(fn),
        toString: () => 'fake',
      }
      const mergeStub = sandbox.stub().returns(fakeQB)
      const onConflictStub = sandbox.stub().returns({ merge: mergeStub })
      const insertStub = sandbox.stub().returns({ onConflict: onConflictStub })
      const client = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient
      return { client, insertStub, onConflictStub, mergeStub }
    }

    it('resolves with the row count from the DB response', async () => {
      const { client } = makeFakeQueryBuilder(1)

      const result = await repository.upsert(testUser, client)

      expect(result).to.equal(1)
    })

    it('inserts into the users table', async () => {
      const { client } = makeFakeQueryBuilder()

      await repository.upsert(testUser, client)

      expect(client).to.have.been.calledWith('users')
    })

    it('encodes pubkey as a Buffer in the inserted row', async () => {
      const { client, insertStub } = makeFakeQueryBuilder()

      await repository.upsert(testUser, client)

      const row = insertStub.firstCall.args[0]
      expect(Buffer.isBuffer(row.pubkey)).to.be.true
      expect(row.pubkey.toString('hex')).to.equal(pubkeyHex)
    })

    it('includes is_admitted and is_vanished in the inserted row', async () => {
      const { client, insertStub } = makeFakeQueryBuilder()

      await repository.upsert(testUser, client)

      const row = insertStub.firstCall.args[0]
      expect(row).to.have.property('is_admitted', true)
      expect(row).to.have.property('is_vanished', false)
    })

    it('defaults is_admitted and is_vanished to false when not provided', async () => {
      const { client, insertStub } = makeFakeQueryBuilder()

      await repository.upsert({ pubkey: pubkeyHex }, client)

      const row = insertStub.firstCall.args[0]
      expect(row.is_admitted).to.equal(false)
      expect(row.is_vanished).to.equal(false)
    })

    it('conflicts on pubkey and omits pubkey from the merge set', async () => {
      const { client, onConflictStub, mergeStub } = makeFakeQueryBuilder()

      await repository.upsert(testUser, client)

      expect(onConflictStub).to.have.been.calledWith('pubkey')
      const mergeRow = mergeStub.firstCall.args[0]
      expect(mergeRow).to.not.have.property('pubkey')
      expect(mergeRow).to.not.have.property('created_at')
      expect(mergeRow).to.have.property('updated_at')
    })
  })

  describe('.isVanished', () => {
    it('returns isVanished=false from existing user row', async () => {
      sandbox.stub(repository, 'findByPubkey').resolves({ ...testUser, isVanished: false })

      const result = await repository.isVanished(pubkeyHex)

      expect(result).to.equal(false)
      expect(eventRepository.hasActiveRequestToVanish).to.not.have.been.called
    })

    it('returns isVanished=true from existing user row', async () => {
      sandbox.stub(repository, 'findByPubkey').resolves({ ...testUser, isVanished: true })

      const result = await repository.isVanished(pubkeyHex)

      expect(result).to.equal(true)
      expect(eventRepository.hasActiveRequestToVanish).to.not.have.been.called
    })

    it('calls eventRepository when user row does not exist and returns vanish state', async () => {
      sandbox.stub(repository, 'findByPubkey').resolves(undefined)
      ;(eventRepository.hasActiveRequestToVanish as sinon.SinonStub).resolves(true)

      const fakeQB = {
        then: (fn: (v: any) => any) => Promise.resolve({ rowCount: 1 }).then(fn),
        catch: (fn: (e: any) => any) => Promise.resolve(1).catch(fn),
        toString: () => 'fake',
      }
      const client = sandbox.stub().returns({
        insert: sandbox.stub().returns({
          onConflict: sandbox.stub().returns({
            merge: sandbox.stub().returns(fakeQB),
          }),
        }),
      }) as unknown as DatabaseClient

      const result = await repository.isVanished(pubkeyHex, client)

      expect(result).to.equal(true)
      expect(eventRepository.hasActiveRequestToVanish).to.have.been.calledWith(pubkeyHex)
    })

    it('hydrates vanish=false when eventRepository returns false', async () => {
      sandbox.stub(repository, 'findByPubkey').resolves(undefined)
      ;(eventRepository.hasActiveRequestToVanish as sinon.SinonStub).resolves(false)

      const fakeQB = {
        then: (fn: (v: any) => any) => Promise.resolve({ rowCount: 1 }).then(fn),
        catch: (fn: (e: any) => any) => Promise.resolve(1).catch(fn),
        toString: () => 'fake',
      }
      const client = sandbox.stub().returns({
        insert: sandbox.stub().returns({
          onConflict: sandbox.stub().returns({
            merge: sandbox.stub().returns(fakeQB),
          }),
        }),
      }) as unknown as DatabaseClient

      const result = await repository.isVanished(pubkeyHex, client)

      expect(result).to.equal(false)
    })
  })

  describe('.setVanished', () => {
    it('returns an object with then, catch, and toString', () => {
      const result = repository.setVanished(pubkeyHex, true)

      expect(result).to.have.property('then').that.is.a('function')
      expect(result).to.have.property('catch').that.is.a('function')
      expect(result).to.have.property('toString').that.is.a('function')
    })

    it('generates upsert SQL for vanish state', () => {
      const sql = repository.setVanished(pubkeyHex, true).toString()

      expect(sql).to.include('insert into "users"')
      expect(sql).to.include('"is_vanished"')
      expect(sql).to.include('on conflict')
    })

    it('encodes pubkey as hex buffer in SQL', () => {
      const sql = repository.setVanished(pubkeyHex, false).toString()

      expect(sql).to.include(`X'${pubkeyHex}'`)
    })
  })

  describe('.getBalanceByPubkey', () => {
    it('returns 0n when no user is found', async () => {
      const client = sandbox.stub().returns({
        select: sandbox.stub().returns({
          where: sandbox.stub().returns({ limit: sandbox.stub().resolves([]) }),
        }),
      }) as unknown as DatabaseClient

      const result = await repository.getBalanceByPubkey(pubkeyHex, client)

      expect(result).to.equal(0n)
    })

    it('returns the user balance as BigInt when user is found', async () => {
      const client = sandbox.stub().returns({
        select: sandbox.stub().returns({
          where: sandbox.stub().returns({ limit: sandbox.stub().resolves([{ balance: 5000n }]) }),
        }),
      }) as unknown as DatabaseClient

      const result = await repository.getBalanceByPubkey(pubkeyHex, client)

      expect(result).to.equal(5000n)
    })

    it('queries users table selecting only balance field', async () => {
      const limitStub = sandbox.stub().resolves([])
      const whereStub = sandbox.stub().returns({ limit: limitStub })
      const selectStub = sandbox.stub().returns({ where: whereStub })
      const client = sandbox.stub().returns({ select: selectStub }) as unknown as DatabaseClient

      await repository.getBalanceByPubkey(pubkeyHex, client)

      expect(client).to.have.been.calledWith('users')
      expect(selectStub).to.have.been.calledWith('balance')
      expect(limitStub).to.have.been.calledWith(1)
    })
  })

  describe('.admitUser', () => {
    it('calls raw with admit_user stored procedure and correct arguments', async () => {
      const rawStub = sandbox.stub().resolves()
      const client = { raw: rawStub } as unknown as DatabaseClient

      await repository.admitUser(pubkeyHex, fixedDate, client)

      expect(rawStub).to.have.been.calledOnce
      expect(rawStub.firstCall.args[0]).to.equal('select admit_user(?, ?)')
      expect(Buffer.isBuffer(rawStub.firstCall.args[1][0])).to.be.true
      expect(rawStub.firstCall.args[1][1]).to.equal(fixedDate.toISOString())
    })

    it('re-throws when raw call rejects', async () => {
      const dbError = new Error('admit failed')
      const client = { raw: sandbox.stub().rejects(dbError) } as unknown as DatabaseClient

      await expect(
        repository.admitUser(pubkeyHex, fixedDate, client),
      ).to.be.rejectedWith(dbError)
    })
  })
})
