import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { InvoiceStatus } from '../../../src/@types/invoice'
import { ZebedeePaymentsProcessor } from '../../../src/payments-processors/zebedee-payments-processor'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

const PUBKEY = 'a'.repeat(64)

const charge = (overrides: any = {}) => ({
  id: 'zbd-charge-id',
  internalId: PUBKEY,
  amount: '21000',
  description: 'Admission fee',
  unit: 'msats',
  status: 'pending',
  invoice: { request: 'lnbc210n1zebedee' },
  expiresAt: '2030-01-01T00:00:00.000Z',
  confirmedAt: null,
  createdAt: '2029-12-31T23:50:00.000Z',
  ...overrides,
})

describe('ZebedeePaymentsProcessor', () => {
  const settings = () =>
    ({ paymentsProcessors: { zebedee: { callbackBaseURL: 'https://relay.example.com/callbacks/zebedee' } } }) as any

  const makeProcessor = (httpClient: any, currentSettings: () => any = settings) =>
    new ZebedeePaymentsProcessor(httpClient, currentSettings)

  describe('createInvoice', () => {
    it('posts the charge in msats with the pubkey as internal id and the callback url', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: { data: charge() } }) }

      await makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'Admission fee', requestId: PUBKEY })

      expect(httpClient.post).to.have.been.calledOnceWithExactly(
        '/v0/charges',
        {
          amount: '21000',
          description: 'Admission fee',
          internalId: PUBKEY,
          callbackUrl: 'https://relay.example.com/callbacks/zebedee',
        },
        { maxRedirects: 1 },
      )
    })

    it('sends the amount as a string so large msat amounts keep their precision', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: { data: charge() } }) }

      await makeProcessor(httpClient).createInvoice({
        amount: 9007199254740993000n,
        description: 'big',
        requestId: PUBKEY,
      })

      expect(httpClient.post.firstCall.args[1].amount).to.equal('9007199254740993000')
    })

    it('leaves the callback url unset when the processor is not configured with one', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: { data: charge() } }) }

      await makeProcessor(httpClient, () => ({ paymentsProcessors: {} })).createInvoice({
        amount: 1000n,
        description: 'd',
        requestId: PUBKEY,
      })

      expect(httpClient.post.firstCall.args[1].callbackUrl).to.equal(undefined)
    })

    it('maps the charge to an invoice', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: { data: charge() } }) }

      const invoice = await makeProcessor(httpClient).createInvoice({
        amount: 21000n,
        description: 'Admission fee',
        requestId: PUBKEY,
      })

      expect(invoice.id).to.equal('zbd-charge-id')
      expect(invoice.pubkey).to.equal(PUBKEY)
      expect(invoice.bolt11).to.equal('lnbc210n1zebedee')
      expect(invoice.amountRequested).to.equal(21000n)
      expect(invoice.description).to.equal('Admission fee')
      expect(invoice.unit).to.equal('msats')
      expect(invoice.status).to.equal(InvoiceStatus.PENDING)
      expect(invoice.expiresAt).to.deep.equal(new Date('2030-01-01T00:00:00.000Z'))
      expect(invoice.createdAt).to.deep.equal(new Date('2029-12-31T23:50:00.000Z'))
      expect(invoice.confirmedAt).to.equal(null)
    })

    it('leaves dates the provider does not report as null', async () => {
      const httpClient = {
        post: sinon.stub().resolves({ data: { data: charge({ expiresAt: null, createdAt: undefined }) } }),
      }

      const invoice = await makeProcessor(httpClient).createInvoice({
        amount: 21000n,
        description: 'd',
        requestId: PUBKEY,
      })

      expect(invoice.expiresAt).to.equal(null)
      expect(invoice.createdAt).to.equal(null)
    })

    it('rethrows when the provider is unavailable, so no invoice is recorded', async () => {
      const httpClient = { post: sinon.stub().rejects(new Error('503 service unavailable')) }

      await expect(
        makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'd', requestId: PUBKEY }),
      ).to.be.rejectedWith('503 service unavailable')
    })

    it('fails when the provider answers without charge data', async () => {
      const httpClient = { post: sinon.stub().resolves({ data: {} }) }

      await expect(makeProcessor(httpClient).createInvoice({ amount: 21000n, description: 'd', requestId: PUBKEY })).to
        .be.rejected
    })
  })

  describe('getInvoice', () => {
    it('reads the charge by id', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: { data: charge() } }) }

      await makeProcessor(httpClient).getInvoice('zbd-charge-id')

      expect(httpClient.get).to.have.been.calledOnceWithExactly('/v0/charges/zbd-charge-id', { maxRedirects: 1 })
    })

    for (const status of [InvoiceStatus.PENDING, InvoiceStatus.COMPLETED, InvoiceStatus.EXPIRED]) {
      it(`reports a ${status} charge as ${status}`, async () => {
        const httpClient = { get: sinon.stub().resolves({ data: { data: charge({ status }) } }) }

        const invoice = await makeProcessor(httpClient).getInvoice('zbd-charge-id')

        expect(invoice.status).to.equal(status)
      })
    }

    it('reports when a paid charge was confirmed', async () => {
      const httpClient = {
        get: sinon
          .stub()
          .resolves({ data: { data: charge({ status: 'completed', confirmedAt: '2030-01-01T00:05:00.000Z' }) } }),
      }

      const invoice = await makeProcessor(httpClient).getInvoice('zbd-charge-id')

      expect(invoice.confirmedAt).to.deep.equal(new Date('2030-01-01T00:05:00.000Z'))
    })

    it('has no confirmation date for a charge that is not paid', async () => {
      const httpClient = { get: sinon.stub().resolves({ data: { data: charge() } }) }

      expect((await makeProcessor(httpClient).getInvoice('zbd-charge-id')).confirmedAt).to.equal(null)
    })

    it('rethrows when the provider is unavailable', async () => {
      const httpClient = { get: sinon.stub().rejects(new Error('ETIMEDOUT')) }

      await expect(makeProcessor(httpClient).getInvoice('zbd-charge-id')).to.be.rejectedWith('ETIMEDOUT')
    })
  })
})
