import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

import { nwc } from '@getalby/sdk'
import { NwcPaymentsProcessor } from '../../../src/payments-processors/nwc-payments-processor'
import { InvoiceStatus } from '../../../src/@types/invoice'

describe('NwcPaymentsProcessor', () => {
  let sandbox: sinon.SinonSandbox
  let makeInvoiceStub: sinon.SinonStub
  let lookupInvoiceStub: sinon.SinonStub
  let closeStub: sinon.SinonStub

  const settings = () => ({
    paymentsProcessors: {
      nwc: {
        invoiceExpirySeconds: 900,
        replyTimeoutMs: 10_000,
      },
    },
  }) as any

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    makeInvoiceStub = sandbox.stub()
    lookupInvoiceStub = sandbox.stub()
    closeStub = sandbox.stub()

    sandbox.stub(nwc, 'NWCClient').callsFake(() => {
      return {
        makeInvoice: makeInvoiceStub,
        lookupInvoice: lookupInvoiceStub,
        close: closeStub,
      } as any
    })
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('maps makeInvoice response to CreateInvoiceResponse', async () => {
    makeInvoiceStub.resolves({
      payment_hash: 'payment-hash-1',
      invoice: 'lnbc1abc',
      amount: 21000,
      description: 'Admission fee',
      state: 'pending',
      created_at: 1710000000,
      expires_at: 1710000900,
    })

    const processor = new NwcPaymentsProcessor('nostr+walletconnect://wallet?relay=wss://relay&secret=abc', 10_000, settings)

    const result = await processor.createInvoice({
      amount: 21000n,
      description: 'Admission fee',
      requestId: 'pubkey123',
    })

    expect(result.id).to.equal('payment-hash-1')
    expect(result.bolt11).to.equal('lnbc1abc')
    expect(result.amountRequested).to.equal(21000n)
    expect(result.status).to.equal(InvoiceStatus.PENDING)
    expect(result.pubkey).to.equal('pubkey123')
    expect(closeStub).to.have.been.calledOnce
  })

  it('maps settled lookup invoice to completed', async () => {
    lookupInvoiceStub.resolves({
      payment_hash: 'payment-hash-2',
      invoice: 'lnbc1def',
      amount: 21000,
      description: 'Admission fee',
      state: 'settled',
      created_at: 1710000000,
      settled_at: 1710000100,
      expires_at: 1710000900,
    })

    const processor = new NwcPaymentsProcessor('nostr+walletconnect://wallet?relay=wss://relay&secret=abc', 10_000, settings)

    const result = await processor.getInvoice('payment-hash-2')

    expect(result.id).to.equal('payment-hash-2')
    expect(result.status).to.equal(InvoiceStatus.COMPLETED)
    expect(result.confirmedAt).to.be.instanceOf(Date)
    expect(closeStub).to.have.been.calledOnce
  })

  it('maps failed lookup invoice to expired', async () => {
    lookupInvoiceStub.resolves({
      payment_hash: 'payment-hash-3',
      state: 'failed',
      created_at: 1710000000,
      expires_at: 1710000900,
    })

    const processor = new NwcPaymentsProcessor('nostr+walletconnect://wallet?relay=wss://relay&secret=abc', 10_000, settings)

    const result = await processor.getInvoice('payment-hash-3')

    expect(result.status).to.equal(InvoiceStatus.EXPIRED)
  })

  it('maps accepted lookup invoice to pending', async () => {
    lookupInvoiceStub.resolves({
      payment_hash: 'payment-hash-4',
      state: 'accepted',
      created_at: 1710000000,
      expires_at: 1710000900,
    })

    const processor = new NwcPaymentsProcessor('nostr+walletconnect://wallet?relay=wss://relay&secret=abc', 10_000, settings)

    const result = await processor.getInvoice('payment-hash-4')

    expect(result.status).to.equal(InvoiceStatus.PENDING)
  })

  it('rethrows SDK errors and still closes client', async () => {
    makeInvoiceStub.rejects(new Error('wallet unavailable'))

    const processor = new NwcPaymentsProcessor('nostr+walletconnect://wallet?relay=wss://relay&secret=abc', 10_000, settings)

    await expect(
      processor.createInvoice({ amount: 1n, description: 'x', requestId: 'p' })
    ).to.be.rejectedWith('wallet unavailable')

    expect(closeStub).to.have.been.calledOnce
  })

  it('applies configured replyTimeoutMs to makeInvoice requests', async () => {
    makeInvoiceStub.returns(new Promise(() => {}))

    const processor = new NwcPaymentsProcessor('nostr+walletconnect://wallet?relay=wss://relay&secret=abc', 5, settings)

    const pending = processor.createInvoice({
      amount: 1000n,
      description: 'Timeout test',
      requestId: 'pubkey-timeout',
    })

    await expect(pending).to.be.rejectedWith('reply timeout after 5ms')
    expect(closeStub).to.have.been.calledOnce
  })

  it('passes invoiceExpirySeconds to makeInvoice and maps expiresAt', async () => {
    makeInvoiceStub.resolves({
      payment_hash: 'payment-hash-expiry',
      invoice: 'lnbc1expiry',
      amount: 1000,
      description: 'Expiry test',
      state: 'pending',
      created_at: 1710000000,
      expires_at: 1710000300,
    })

    const processor = new NwcPaymentsProcessor('nostr+walletconnect://wallet?relay=wss://relay&secret=abc', 10_000, settings)

    const result = await processor.createInvoice({
      amount: 1000n,
      description: 'Expiry test',
      requestId: 'pubkey-expiry',
    })

    expect(makeInvoiceStub).to.have.been.calledOnceWithExactly({
      amount: 1000,
      description: 'Expiry test',
      expiry: 900,
    })
    expect(result.expiresAt?.toISOString()).to.equal('2024-03-09T16:05:00.000Z')
  })

  it('does not wait for the reply timeout when operation succeeds first', async () => {
    makeInvoiceStub.resolves({
      payment_hash: 'payment-hash-fast',
      invoice: 'lnbc1fast',
      amount: 1000,
      description: 'Fast op',
      state: 'pending',
      created_at: 1710000000,
      expires_at: 1710000300,
    })

    const processor = new NwcPaymentsProcessor('nostr+walletconnect://wallet?relay=wss://relay&secret=abc', 10_000, settings)

    await processor.createInvoice({
      amount: 1000n,
      description: 'Fast op',
      requestId: 'pubkey-fast',
    })

    expect(closeStub).to.have.been.calledOnce
  })

  it('throws when createInvoice amount exceeds Number.MAX_SAFE_INTEGER', async () => {
    const processor = new NwcPaymentsProcessor('nostr+walletconnect://wallet?relay=wss://relay&secret=abc', 10_000, settings)

    await expect(
      processor.createInvoice({
        amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        description: 'Unsafe amount',
        requestId: 'pubkey-unsafe',
      })
    ).to.be.rejectedWith('CreateInvoiceRequest.amount exceeds Number.MAX_SAFE_INTEGER.')
  })
})
