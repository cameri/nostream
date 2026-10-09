import { expect } from 'chai'
import cluster from 'cluster'
import Sinon from 'sinon'

import {
  EVENT_STORE_BACKEND_ENV,
  EVENT_STORE_BACKENDS,
  getConfiguredEventStoreBackend,
  getEventStoreBackend,
  isEventStoreBackend,
} from '../../../src/utils/event-store'
import { EventStoreBackend } from '../../../src/constants/base'
import { Settings } from '../../../src/@types/settings'

describe('event-store', () => {
  const postgresSettings = { eventStore: { backend: 'postgres' } } as Settings
  const unsupportedSettings = { eventStore: { backend: 'mongodb' } } as unknown as Settings

  describe('getConfiguredEventStoreBackend', () => {
    it('defaults to postgres when eventStore is unset', () => {
      expect(getConfiguredEventStoreBackend({} as Settings)).to.equal(EventStoreBackend.POSTGRES)
    })

    it('defaults to postgres when eventStore.backend is unset', () => {
      expect(getConfiguredEventStoreBackend({ eventStore: {} } as Settings)).to.equal(EventStoreBackend.POSTGRES)
    })

    it('returns the configured backend', () => {
      expect(getConfiguredEventStoreBackend(postgresSettings)).to.equal(EventStoreBackend.POSTGRES)
    })

    it('throws on an unsupported backend and names the supported ones', () => {
      expect(() => getConfiguredEventStoreBackend(unsupportedSettings)).to.throw(
        Error,
        'Unsupported eventStore.backend "mongodb". Supported backends: postgres',
      )
    })

    it('does not accept a backend in the wrong case', () => {
      const settings = { eventStore: { backend: 'Postgres' } } as unknown as Settings

      expect(() => getConfiguredEventStoreBackend(settings)).to.throw(
        Error,
        'Unsupported eventStore.backend "Postgres"',
      )
    })
  })

  describe('getEventStoreBackend', () => {
    let inheritedBackend: string | undefined

    beforeEach(() => {
      inheritedBackend = process.env[EVENT_STORE_BACKEND_ENV]
    })

    afterEach(() => {
      Sinon.restore()
      if (inheritedBackend === undefined) {
        delete process.env[EVENT_STORE_BACKEND_ENV]
      } else {
        process.env[EVENT_STORE_BACKEND_ENV] = inheritedBackend
      }
    })

    it('reads the setting outside a cluster worker, ignoring the inherited variable', () => {
      Sinon.stub(cluster, 'isWorker').value(false)
      process.env[EVENT_STORE_BACKEND_ENV] = 'mongodb'

      expect(getEventStoreBackend(postgresSettings)).to.equal(EventStoreBackend.POSTGRES)
    })

    it('keeps the backend the primary handed a worker even after the setting changes', () => {
      Sinon.stub(cluster, 'isWorker').value(true)
      process.env[EVENT_STORE_BACKEND_ENV] = 'postgres'

      expect(getEventStoreBackend(unsupportedSettings)).to.equal(EventStoreBackend.POSTGRES)
    })

    it('reads the setting in a worker the primary handed no backend', () => {
      Sinon.stub(cluster, 'isWorker').value(true)
      delete process.env[EVENT_STORE_BACKEND_ENV]

      expect(() => getEventStoreBackend(unsupportedSettings)).to.throw(
        Error,
        'Unsupported eventStore.backend "mongodb"',
      )
    })

    it('rejects an unsupported inherited backend', () => {
      Sinon.stub(cluster, 'isWorker').value(true)
      process.env[EVENT_STORE_BACKEND_ENV] = 'mongodb'

      expect(() => getEventStoreBackend(postgresSettings)).to.throw(Error, 'Unsupported EVENT_STORE_BACKEND "mongodb"')
    })
  })

  describe('isEventStoreBackend', () => {
    it('accepts every supported backend', () => {
      EVENT_STORE_BACKENDS.forEach((backend) => {
        expect(isEventStoreBackend(backend)).to.equal(true)
      })
    })

    it('rejects anything else', () => {
      expect(isEventStoreBackend('strfry')).to.equal(false)
      expect(isEventStoreBackend('')).to.equal(false)
      expect(isEventStoreBackend(undefined)).to.equal(false)
      expect(isEventStoreBackend(null)).to.equal(false)
      expect(isEventStoreBackend(1)).to.equal(false)
    })
  })
})
