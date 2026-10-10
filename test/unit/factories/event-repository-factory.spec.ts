import { expect } from 'chai'
import cluster from 'cluster'
import fs from 'fs'
import knex from 'knex'
import path from 'path'
import Sinon from 'sinon'

import { createEventRepository } from '../../../src/factories/event-repository-factory'
import { DatabaseClient } from '../../../src/@types/base'
import { EVENT_STORE_BACKEND_ENV } from '../../../src/utils/event-store'
import { EventRepository } from '../../../src/repositories/event-repository'
import { Settings } from '../../../src/@types/settings'
import { SettingsStatic } from '../../../src/utils/settings'

describe('createEventRepository', () => {
  let dbClient: DatabaseClient
  let rrDbClient: DatabaseClient
  let inheritedBackend: string | undefined

  beforeEach(() => {
    dbClient = knex({ client: 'pg' })
    rrDbClient = knex({ client: 'pg' })
    inheritedBackend = process.env[EVENT_STORE_BACKEND_ENV]
  })

  afterEach(async () => {
    Sinon.restore()
    if (inheritedBackend === undefined) {
      delete process.env[EVENT_STORE_BACKEND_ENV]
    } else {
      process.env[EVENT_STORE_BACKEND_ENV] = inheritedBackend
    }
    await dbClient.destroy()
    await rrDbClient.destroy()
  })

  it('returns a PostgreSQL event repository when eventStore is unset', () => {
    const repository = createEventRepository(dbClient, rrDbClient, () => ({}) as Settings)

    expect(repository).to.be.an.instanceOf(EventRepository)
  })

  it('returns a PostgreSQL event repository when eventStore.backend is postgres', () => {
    const settings = () => ({ eventStore: { backend: 'postgres' } }) as Settings

    expect(createEventRepository(dbClient, rrDbClient, settings)).to.be.an.instanceOf(EventRepository)
  })

  it('hands the repository the same settings source', () => {
    const search = [{ search: 'nostr' }]
    const withSearch = createEventRepository(dbClient, rrDbClient, () => ({ nip50: { enabled: true } }) as Settings)
    const withoutSearch = createEventRepository(dbClient, rrDbClient, () => ({ nip50: { enabled: false } }) as Settings)

    expect(withSearch.findByFilters(search).toString()).to.include('plainto_tsquery')
    expect(withoutSearch.findByFilters(search).toString()).not.to.include('plainto_tsquery')
  })

  it('throws on an unsupported backend instead of falling back to postgres', () => {
    const settings = () => ({ eventStore: { backend: 'mongodb' } }) as unknown as Settings

    expect(() => createEventRepository(dbClient, rrDbClient, settings)).to.throw(
      Error,
      'Unsupported eventStore.backend "mongodb"',
    )
  })

  it('reads the relay settings when no settings source is given', () => {
    const createSettingsStub = Sinon.stub(SettingsStatic, 'createSettings').returns({
      eventStore: { backend: 'mongodb' },
    } as unknown as Settings)

    expect(() => createEventRepository(dbClient, rrDbClient)).to.throw(Error, 'Unsupported eventStore.backend')
    expect(createSettingsStub.called).to.equal(true)
  })

  it('in a worker, builds the store the primary chose at startup rather than the current setting', () => {
    Sinon.stub(cluster, 'isWorker').value(true)
    process.env[EVENT_STORE_BACKEND_ENV] = 'postgres'
    const editedSettings = () => ({ eventStore: { backend: 'mongodb' } }) as unknown as Settings

    expect(createEventRepository(dbClient, rrDbClient, editedSettings)).to.be.an.instanceOf(EventRepository)
  })

  it('is the only place an EventRepository is constructed', () => {
    const srcDir = path.join(process.cwd(), 'src')
    const factoryFile = path.join('factories', 'event-repository-factory.ts')

    const offenders = (fs.readdirSync(srcDir, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts') && file !== factoryFile)
      .filter((file) => /new\s+EventRepository\s*\(/.test(fs.readFileSync(path.join(srcDir, file), 'utf-8')))

    expect(offenders, 'construct event repositories through createEventRepository').to.deep.equal([])
  })
})
