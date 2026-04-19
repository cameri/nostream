import * as chai from 'chai'
import * as sinon from 'sinon'
import knex from 'knex'
import sinonChai from 'sinon-chai'

import { DatabaseClient } from '../../../src/@types/base'
import { DBUser, User } from '../../../src/@types/user'
import { IEventRepository, IUserRepository } from '../../../src/@types/repositories'
import { UserRepository } from '../../../src/repositories/user-repository'

chai.use(sinonChai)
const { expect } = chai

const PUBKEY = '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793'

function makeDBUser(overrides: Partial<DBUser> = {}): DBUser {
  const now = new Date()
  return {
    pubkey: Buffer.from(PUBKEY, 'hex'),
    is_admitted: true,
    is_vanished: false,
    balance: 0n,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('UserRepository', () => {
  let repository: UserRepository
  let sandbox: sinon.SinonSandbox
  let dbClient: DatabaseClient
  let eventRepository: sinon.SinonStubbedInstance<IEventRepository>

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    dbClient = knex({ client: 'pg' })
    eventRepository = {
      hasActiveRequestToVanish: sandbox.stub().resolves(false),
      create: sandbox.stub(),
      createMany: sandbox.stub(),
      upsert: sandbox.stub(),
      upsertMany: sandbox.stub(),
      findByFilters: sandbox.stub(),
      deleteByPubkeyAndIds: sandbox.stub(),
      deleteByPubkeyExceptKinds: sandbox.stub(),
      deleteExpiredAndRetained: sandbox.stub(),
    } as any

    repository = new UserRepository(dbClient, eventRepository as unknown as IEventRepository)
  })

  afterEach(() => {
    dbClient.destroy()
    sandbox.restore()
  })

  describe('.upsert', () => {
    it('returns a thenable with then, catch, and toString', () => {
      const result = repository.upsert({ pubkey: PUBKEY })

      expect(result).to.have.property('then')
      expect(result).to.have.property('catch')
      expect(result).to.have.property('toString')
    })

    it('resolves to a number when the query succeeds', async () => {
      const mockQuery = {
        then: (fn: any) => Promise.resolve().then(() => fn({ rowCount: 1 })),
        catch: () => {},
        toString: () => '',
      }
      const mergeStub = sandbox.stub().returns(mockQuery)
      const onConflictStub = sandbox.stub().returns({ merge: mergeStub })
      const insertStub = sandbox.stub().returns({ onConflict: onConflictStub })
      const mockClient = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient

      const repo = new UserRepository(mockClient, eventRepository as unknown as IEventRepository)
      const result = await repo.upsert({ pubkey: PUBKEY, isAdmitted: true, isVanished: false })

      expect(result).to.equal(1)
    })

    it('defaults isAdmitted and isVanished to false when omitted', async () => {
      const mockQuery = {
        then: (fn: any) => Promise.resolve().then(() => fn({ rowCount: 1 })),
        catch: () => {},
        toString: () => '',
      }
      const mergeStub = sandbox.stub().returns(mockQuery)
      const onConflictStub = sandbox.stub().returns({ merge: mergeStub })
      const insertStub = sandbox.stub().returns({ onConflict: onConflictStub })
      const mockClient = sandbox.stub().returns({ insert: insertStub }) as unknown as DatabaseClient

      const repo = new UserRepository(mockClient, eventRepository as unknown as IEventRepository)
      await repo.upsert({ pubkey: PUBKEY })

      const insertedRow = insertStub.firstCall.args[0]
      expect(insertedRow.is_admitted).to.equal(false)
      expect(insertedRow.is_vanished).to.equal(false)
    })
  })

  describe('.setVanished', () => {
    it('returns a thenable with then, catch, and toString', () => {
      const result = repository.setVanished(PUBKEY, true)

      expect(result).to.have.property('then')
      expect(result).to.have.property('catch')
      expect(result).to.have.property('toString')
    })

    it('toString targets "users" with is_vanished and on conflict clause', () => {
      const sql = repository.setVanished(PUBKEY, true).toString()

      expect(sql).to.include('"users"')
      expect(sql).to.include('is_vanished')
      expect(sql).to.include('on conflict')
    })
  })

  describe('.findByPubkey', () => {
    it('returns undefined when user not found', async () => {
      const mockSelect = sandbox.stub().resolves([])
      const mockWhere = sandbox.stub().returns({ select: mockSelect })
      const mockClient = sandbox.stub().returns({ where: mockWhere }) as unknown as DatabaseClient

      const repo = new UserRepository(mockClient, eventRepository as unknown as IEventRepository)
      const result = await repo.findByPubkey(PUBKEY)

      expect(result).to.be.undefined
    })

    it('returns mapped User when found', async () => {
      const dbUser = makeDBUser({ is_admitted: true, is_vanished: false, balance: 9000n })
      const mockSelect = sandbox.stub().resolves([dbUser])
      const mockWhere = sandbox.stub().returns({ select: mockSelect })
      const mockClient = sandbox.stub().returns({ where: mockWhere }) as unknown as DatabaseClient

      const repo = new UserRepository(mockClient, eventRepository as unknown as IEventRepository)
      const result = await repo.findByPubkey(PUBKEY)

      expect(result).to.not.be.undefined
      expect(result!.pubkey).to.equal(PUBKEY)
      expect(result!.isAdmitted).to.equal(true)
      expect(result!.isVanished).to.equal(false)
      expect(result!.balance).to.equal(9000n)
    })
  })

  describe('.isVanished', () => {
    it('returns isVanished=true from existing user without querying events', async () => {
      const existingUser: User = {
        pubkey: PUBKEY,
        isAdmitted: true,
        isVanished: true,
        balance: 0n,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      sandbox.stub(repository, 'findByPubkey').resolves(existingUser)

      const result = await repository.isVanished(PUBKEY)

      expect(result).to.equal(true)
      expect(eventRepository.hasActiveRequestToVanish).to.not.have.been.called
    })

    it('returns isVanished=false from existing user without querying events', async () => {
      const existingUser: User = {
        pubkey: PUBKEY,
        isAdmitted: true,
        isVanished: false,
        balance: 0n,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      sandbox.stub(repository, 'findByPubkey').resolves(existingUser)

      const result = await repository.isVanished(PUBKEY)

      expect(result).to.equal(false)
      expect(eventRepository.hasActiveRequestToVanish).to.not.have.been.called
    })

    it('falls back to event repo and upserts when no user row exists (vanished)', async () => {
      sandbox.stub(repository, 'findByPubkey').resolves(undefined)
      ;(eventRepository.hasActiveRequestToVanish as sinon.SinonStub).resolves(true)
      const upsertVanishStub = sandbox.stub(repository as any, 'upsertVanishState').resolves(1)

      const result = await repository.isVanished(PUBKEY)

      expect(result).to.equal(true)
      expect(eventRepository.hasActiveRequestToVanish).to.have.been.calledWith(PUBKEY)
      expect(upsertVanishStub).to.have.been.calledWith(PUBKEY, true, sinon.match.any)
    })

    it('falls back to event repo and upserts when no user row exists (not vanished)', async () => {
      sandbox.stub(repository, 'findByPubkey').resolves(undefined)
      ;(eventRepository.hasActiveRequestToVanish as sinon.SinonStub).resolves(false)
      const upsertVanishStub = sandbox.stub(repository as any, 'upsertVanishState').resolves(0)

      const result = await repository.isVanished(PUBKEY)

      expect(result).to.equal(false)
      expect(upsertVanishStub).to.have.been.calledWith(PUBKEY, false, sinon.match.any)
    })
  })

  describe('.getBalanceByPubkey', () => {
    it('returns 0n when no user row found', async () => {
      const mockLimit = sandbox.stub().resolves([])
      const mockWhere = sandbox.stub().returns({ limit: mockLimit })
      const mockSelect = sandbox.stub().returns({ where: mockWhere })
      const mockClient = sandbox.stub().returns({ select: mockSelect }) as unknown as DatabaseClient

      const repo = new UserRepository(mockClient, eventRepository as unknown as IEventRepository)
      const result = await repo.getBalanceByPubkey(PUBKEY)

      expect(result).to.equal(0n)
    })

    it('returns BigInt balance when user row found', async () => {
      const mockLimit = sandbox.stub().resolves([{ balance: '7777' }])
      const mockWhere = sandbox.stub().returns({ limit: mockLimit })
      const mockSelect = sandbox.stub().returns({ where: mockWhere })
      const mockClient = sandbox.stub().returns({ select: mockSelect }) as unknown as DatabaseClient

      const repo = new UserRepository(mockClient, eventRepository as unknown as IEventRepository)
      const result = await repo.getBalanceByPubkey(PUBKEY)

      expect(result).to.equal(7777n)
    })
  })

  describe('.admitUser', () => {
    it('calls client.raw with pubkey buffer and ISO date string', async () => {
      const rawStub = sandbox.stub().resolves()
      const mockClient = { raw: rawStub } as unknown as DatabaseClient

      const admittedAt = new Date('2024-03-01T12:00:00.000Z')
      const repo = new UserRepository(mockClient, eventRepository as unknown as IEventRepository)
      await repo.admitUser(PUBKEY, admittedAt)

      expect(rawStub).to.have.been.calledOnce
      const [sql, [pubkeyBuf, isoDate]] = rawStub.firstCall.args
      expect(sql).to.equal('select admit_user(?, ?)')
      expect(Buffer.isBuffer(pubkeyBuf)).to.equal(true)
      expect(isoDate).to.equal(admittedAt.toISOString())
    })

    it('uses injected client over the default', async () => {
      const defaultRaw = sandbox.stub().resolves()
      const injectedRaw = sandbox.stub().resolves()
      const defaultClient = { raw: defaultRaw } as unknown as DatabaseClient
      const injectedClient = { raw: injectedRaw } as unknown as DatabaseClient

      const repo = new UserRepository(defaultClient, eventRepository as unknown as IEventRepository)
      await repo.admitUser(PUBKEY, new Date(), injectedClient)

      expect(defaultRaw).to.not.have.been.called
      expect(injectedRaw).to.have.been.calledOnce
    })

    it('re-throws when client.raw rejects', async () => {
      const err = new Error('connection refused')
      const rawStub = sandbox.stub().rejects(err)
      const mockClient = { raw: rawStub } as unknown as DatabaseClient

      const repo = new UserRepository(mockClient, eventRepository as unknown as IEventRepository)
      let thrown: Error | undefined

      try {
        await repo.admitUser(PUBKEY, new Date())
      } catch (e) {
        thrown = e as Error
      }

      expect(thrown).to.not.be.undefined
      expect(thrown!.message).to.equal('connection refused')
    })
  })
})
