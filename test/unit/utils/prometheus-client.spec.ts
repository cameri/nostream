import axios from 'axios'
import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
const { expect } = chai

import * as prometheusClient from '../../../src/utils/prometheus-client'

describe('prometheus-client', () => {
  let sandbox: Sinon.SinonSandbox
  let axiosGetStub: Sinon.SinonStub
  const originalPrometheusUrl = process.env.PROMETHEUS_URL

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    axiosGetStub = sandbox.stub(axios, 'get')
    delete process.env.PROMETHEUS_URL
  })

  afterEach(() => {
    sandbox.restore()
    if (originalPrometheusUrl === undefined) {
      delete process.env.PROMETHEUS_URL
    } else {
      process.env.PROMETHEUS_URL = originalPrometheusUrl
    }
  })

  describe('getPrometheusBaseUrl', () => {
    it('defaults to localhost prometheus', () => {
      expect(prometheusClient.getPrometheusBaseUrl()).to.equal('http://127.0.0.1:9090')
    })

    it('trims trailing slashes from configured URL', () => {
      process.env.PROMETHEUS_URL = 'http://prometheus:9090/'

      expect(prometheusClient.getPrometheusBaseUrl()).to.equal('http://prometheus:9090')
    })
  })

  describe('parsePrometheusInstantQueryScalar', () => {
    it('returns parsed scalar from successful vector response', () => {
      const value = prometheusClient.parsePrometheusInstantQueryScalar({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ value: [1710000000, '12.5'] }],
        },
      })

      expect(value).to.equal(12.5)
    })

    it('returns undefined for unsuccessful responses', () => {
      expect(
        prometheusClient.parsePrometheusInstantQueryScalar({
          status: 'error',
          error: 'bad_data',
        }),
      ).to.be.undefined
    })
  })

  describe('queryPrometheusInstant', () => {
    it('queries prometheus instant API and returns scalar', async () => {
      axiosGetStub.resolves({
        status: 200,
        data: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ value: [1710000000, '3'] }],
          },
        },
      })

      const value = await prometheusClient.queryPrometheusInstant('sum(up)')

      expect(value).to.equal(3)
      expect(axiosGetStub).to.have.been.calledOnceWith(
        'http://127.0.0.1:9090/api/v1/query',
        Sinon.match({
          params: { query: 'sum(up)' },
        }),
      )
    })

    it('returns undefined when prometheus responds with non-200', async () => {
      axiosGetStub.resolves({ status: 503, data: {} })

      const value = await prometheusClient.queryPrometheusInstant('sum(up)')

      expect(value).to.be.undefined
    })
  })
})
