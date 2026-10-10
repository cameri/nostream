import * as chai from 'chai'
import * as sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { SettingsOverrideRepository } from '../../../src/repositories/settings-override-repository'

chai.use(sinonChai)

const { expect } = chai

describe('SettingsOverrideRepository', () => {
  let queryBuilder: {
    select: sinon.SinonStub
    delete: sinon.SinonStub
    insert: sinon.SinonStub
  }
  let transactionBuilder: {
    delete: sinon.SinonStub
    insert: sinon.SinonStub
  }
  let dbClient: any
  let repository: SettingsOverrideRepository

  beforeEach(() => {
    queryBuilder = {
      select: sinon.stub().resolves([
        { path: 'info.name', value: 'Test Relay' },
        { path: 'nip66.enabled', value: true },
      ]),
      delete: sinon.stub(),
      insert: sinon.stub(),
    }

    transactionBuilder = {
      delete: sinon.stub().resolves(),
      insert: sinon.stub().resolves(),
    }

    const transactionFn = sinon.stub()
    transactionFn.withArgs('settings_overrides').returns(transactionBuilder)

    dbClient = sinon.stub()
    dbClient.callsFake((table: string) => {
      if (table === 'settings_overrides') {
        return queryBuilder
      }

      throw new Error(`unexpected table ${table}`)
    })
    dbClient.transaction = sinon.stub().callsFake(async (callback: (trx: typeof transactionFn) => Promise<void>) => {
      await callback(transactionFn)
    })

    repository = new SettingsOverrideRepository(dbClient)
  })

  it('loads overrides into a nested settings object', async () => {
    const overrides = await repository.loadOverrides()

    expect(overrides).to.deep.equal({
      info: { name: 'Test Relay' },
      nip66: { enabled: true },
    })
  })

  it('replaces all override rows from a nested settings object', async () => {
    await repository.replaceOverrides({
      info: { name: 'Updated Relay' },
      admin: { enabled: true },
    } as any)

    expect(dbClient.transaction).to.have.been.calledOnce
    expect(transactionBuilder.delete).to.have.been.calledOnce
    expect(transactionBuilder.insert).to.have.been.calledOnce

    const insertedRows = transactionBuilder.insert.firstCall.args[0]
    expect(insertedRows).to.have.length(2)
    expect(insertedRows[0]).to.deep.include({
      path: 'info.name',
      value: 'Updated Relay',
    })
    expect(insertedRows[0].updated_at).to.be.instanceOf(Date)
    expect(insertedRows[1]).to.deep.include({
      path: 'admin.enabled',
      value: true,
    })
    expect(insertedRows[1].updated_at).to.be.instanceOf(Date)
  })

  it('clears all rows when overrides are empty', async () => {
    await repository.replaceOverrides({} as any)

    expect(transactionBuilder.delete).to.have.been.calledOnce
    expect(transactionBuilder.insert).not.to.have.been.called
  })
})
