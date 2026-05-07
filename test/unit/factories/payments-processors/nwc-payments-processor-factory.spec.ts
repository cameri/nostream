import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
const { expect } = chai

import { createNwcPaymentsProcessor } from '../../../../src/factories/payments-processors/nwc-payments-processor-factory'

describe('createNwcPaymentsProcessor', () => {
  let sandbox: sinon.SinonSandbox
  const originalUrl = process.env.NWC_URL

  const settings = {
    paymentsProcessors: {
      nwc: {
        replyTimeoutMs: 10_000,
        invoiceExpirySeconds: 900,
      },
    },
  } as any

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
    if (typeof originalUrl === 'string') {
      process.env.NWC_URL = originalUrl
    } else {
      delete process.env.NWC_URL
    }
  })

  it('throws when NWC_URL is missing', () => {
    delete process.env.NWC_URL

    expect(() => createNwcPaymentsProcessor(settings)).to.throw('NWC_URL must be set.')
  })

  it('throws when NWC_URL is invalid', () => {
    process.env.NWC_URL = 'https://example.com/not-nwc'

    expect(() => createNwcPaymentsProcessor(settings)).to.throw('NWC_URL must be a valid nostr+walletconnect:// or nostrwalletconnect:// URI.')
  })

  it('throws when settings.paymentsProcessors.nwc.replyTimeoutMs is invalid', () => {
    process.env.NWC_URL = 'nostr+walletconnect://wallet?relay=wss://relay&secret=abc'

    expect(() =>
      createNwcPaymentsProcessor({
        paymentsProcessors: {
          nwc: {
            replyTimeoutMs: 0,
            invoiceExpirySeconds: 900,
          },
        },
      } as any)
    ).to.throw('Setting paymentsProcessors.nwc.replyTimeoutMs must be a positive number.')
  })

  it('throws when settings.paymentsProcessors.nwc.invoiceExpirySeconds is invalid', () => {
    process.env.NWC_URL = 'nostr+walletconnect://wallet?relay=wss://relay&secret=abc'

    expect(() =>
      createNwcPaymentsProcessor({
        paymentsProcessors: {
          nwc: {
            replyTimeoutMs: 10_000,
            invoiceExpirySeconds: 0,
          },
        },
      } as any)
    ).to.throw('Setting paymentsProcessors.nwc.invoiceExpirySeconds must be a positive integer.')
  })

  it('creates the processor when config is valid', () => {
    process.env.NWC_URL = 'nostr+walletconnect://wallet?relay=wss://relay&secret=abc'

    const result = createNwcPaymentsProcessor(settings)

    expect(result).to.have.property('createInvoice')
    expect(result).to.have.property('getInvoice')
  })

  it('accepts legacy nostrwalletconnect URI scheme', () => {
    process.env.NWC_URL = 'nostrwalletconnect://wallet?relay=wss://relay&secret=abc'

    const result = createNwcPaymentsProcessor(settings)

    expect(result).to.have.property('createInvoice')
    expect(result).to.have.property('getInvoice')
  })
})
