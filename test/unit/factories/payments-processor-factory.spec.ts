import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { LazyPaymentsProcessor } from '../../../src/factories/payments-processor-factory'

chai.use(sinonChai)
const { expect } = chai

describe('LazyPaymentsProcessor', () => {
  it('does not create the processor until a call needs it', async () => {
    const createInvoice = Sinon.stub().resolves({ id: 'inv-1' })
    const getInvoice = Sinon.stub()
    const factory = Sinon.stub().returns({ createInvoice, getInvoice })
    const processor = new LazyPaymentsProcessor(factory)

    expect(factory).not.to.have.been.called

    const result = await processor.createInvoice({ amount: 1000n })

    expect(result).to.deep.equal({ id: 'inv-1' })
    expect(factory).to.have.been.calledOnce
    expect(createInvoice).to.have.been.calledWith({ amount: 1000n })
  })

  it('caches the processor across calls', async () => {
    const createInvoice = Sinon.stub().resolves({ id: 'inv-1' })
    const factory = Sinon.stub().returns({ createInvoice, getInvoice: Sinon.stub() })
    const processor = new LazyPaymentsProcessor(factory)

    await processor.createInvoice({ amount: 1000n })
    await processor.createInvoice({ amount: 2000n })

    expect(factory).to.have.been.calledOnce
    expect(createInvoice).to.have.been.calledTwice
  })

  it('delegates getInvoice to the real processor', async () => {
    const getInvoice = Sinon.stub().resolves({ id: 'inv-1', status: 'completed' })
    const factory = Sinon.stub().returns({ createInvoice: Sinon.stub(), getInvoice })
    const processor = new LazyPaymentsProcessor(factory)

    const result = await processor.getInvoice('inv-1')

    expect(result).to.deep.equal({ id: 'inv-1', status: 'completed' })
    expect(getInvoice).to.have.been.calledWith('inv-1')
  })
})
