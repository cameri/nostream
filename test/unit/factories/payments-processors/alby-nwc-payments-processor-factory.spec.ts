import chai from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
const { expect } = chai

import { createAlbyNwcPaymentsProcessor } from '../../../../src/factories/payments-processors/alby-nwc-payments-processor-factory'

describe('createAlbyNwcPaymentsProcessor', () => {
  let sandbox: sinon.SinonSandbox
  const originalUrl = process.env.ALBY_NWC_URL

  const settings = {
    paymentsProcessors: {
      alby: {
        replyTimeoutMs: 10_000,
      },
    },
  } as any

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
    if (typeof originalUrl === 'string') {
      process.env.ALBY_NWC_URL = originalUrl
    } else {
      delete process.env.ALBY_NWC_URL
    }
  })

  it('throws when ALBY_NWC_URL is missing', () => {
    delete process.env.ALBY_NWC_URL

    expect(() => createAlbyNwcPaymentsProcessor(settings)).to.throw('ALBY_NWC_URL must be set.')
  })

  it('throws when ALBY_NWC_URL is invalid', () => {
    process.env.ALBY_NWC_URL = 'https://example.com/not-nwc'

    expect(() => createAlbyNwcPaymentsProcessor(settings)).to.throw('ALBY_NWC_URL must be a valid nostr+walletconnect:// or nostrwalletconnect:// URI.')
  })

  it('throws when settings.paymentsProcessors.alby.replyTimeoutMs is invalid', () => {
    process.env.ALBY_NWC_URL = 'nostr+walletconnect://wallet?relay=wss://relay&secret=abc'

    expect(() =>
      createAlbyNwcPaymentsProcessor({
        paymentsProcessors: {
          alby: {
            replyTimeoutMs: 0,
          },
        },
      } as any)
    ).to.throw('Setting paymentsProcessors.alby.replyTimeoutMs must be a positive number.')
  })

  it('creates the processor when config is valid', () => {
    process.env.ALBY_NWC_URL = 'nostr+walletconnect://wallet?relay=wss://relay&secret=abc'

    const result = createAlbyNwcPaymentsProcessor(settings)

    expect(result).to.have.property('createInvoice')
    expect(result).to.have.property('getInvoice')
  })

  it('accepts legacy nostrwalletconnect URI scheme', () => {
    process.env.ALBY_NWC_URL = 'nostrwalletconnect://wallet?relay=wss://relay&secret=abc'

    const result = createAlbyNwcPaymentsProcessor(settings)

    expect(result).to.have.property('createInvoice')
    expect(result).to.have.property('getInvoice')
  })
})
