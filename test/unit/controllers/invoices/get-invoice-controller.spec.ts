import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

import * as settingsFactory from '../../../../src/factories/settings-factory'
import * as templateCache from '../../../../src/utils/template-cache'
import { GetInvoiceController } from '../../../../src/controllers/invoices/get-invoice-controller'

const disabledPaymentsSettings = {
  info: { name: 'Test Relay' },
  payments: {
    enabled: false,
    feeSchedules: { admission: [] },
    processor: 'lnbits',
  },
}

const enabledPaymentsSettings = {
  info: { name: 'Test Relay', relay_url: 'wss://relay.example.com' },
  payments: {
    enabled: true,
    feeSchedules: {
      admission: [{ enabled: true, amount: 21000, whitelists: {} }],
    },
    processor: 'lnbits',
  },
  network: {},
}

describe('GetInvoiceController', () => {
  let createSettingsStub: sinon.SinonStub
  let getTemplateStub: sinon.SinonStub
  let controller: GetInvoiceController
  let res: any

  beforeEach(() => {
    createSettingsStub = sinon.stub(settingsFactory, 'createSettings')
    getTemplateStub = sinon.stub(templateCache, 'getTemplate')

    controller = new GetInvoiceController()

    res = {
      status: sinon.stub().returnsThis(),
      setHeader: sinon.stub().returnsThis(),
      send: sinon.stub().returnsThis(),
      locals: { nonce: 'invoice-nonce' },
    }
  })

  afterEach(() => {
    createSettingsStub.restore()
    getTemplateStub.restore()
  })

  describe('when payments are disabled', () => {
    it('responds with 404', async () => {
      createSettingsStub.returns(disabledPaymentsSettings)

      await controller.handleRequest({} as any, res)

      expect(res.status).to.have.been.calledWith(404)
      expect(res.send).to.have.been.called
    })

    it('does not render the template', async () => {
      createSettingsStub.returns(disabledPaymentsSettings)

      await controller.handleRequest({} as any, res)

      expect(getTemplateStub).to.not.have.been.called
    })
  })

  describe('when admission fee is not enabled', () => {
    it('responds with 404', async () => {
      const settings = {
        ...enabledPaymentsSettings,
        payments: {
          ...enabledPaymentsSettings.payments,
          feeSchedules: {
            admission: [{ enabled: false, amount: 21000, whitelists: {} }],
          },
        },
      }
      createSettingsStub.returns(settings)

      await controller.handleRequest({} as any, res)

      expect(res.status).to.have.been.calledWith(404)
    })
  })

  describe('when payments and admission fee are enabled', () => {
    beforeEach(() => {
      createSettingsStub.returns(enabledPaymentsSettings)
      getTemplateStub.returns('{{name}}|{{path_prefix}}|{{processor_json}}|{{amount}}|{{nonce}}')
    })

    it('loads the get-invoice template', async () => {
      await controller.handleRequest({} as any, res)

      expect(getTemplateStub).to.have.been.calledWith('./resources/get-invoice.html')
    })

    it('responds with 200 and text/html content type', async () => {
      await controller.handleRequest({} as any, res)

      expect(res.status).to.have.been.calledWith(200)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'text/html; charset=utf8')
    })

    it('substitutes all template variables', async () => {
      await controller.handleRequest({} as any, res)

      const sent = res.send.firstCall.args[0] as string
      expect(sent).to.not.include('{{name}}')
      expect(sent).to.not.include('{{path_prefix}}')
      expect(sent).to.not.include('{{processor_json}}')
      expect(sent).to.not.include('{{amount}}')
      expect(sent).to.not.include('{{nonce}}')
    })

    it('HTML-escapes the relay name', async () => {
      createSettingsStub.returns({
        ...enabledPaymentsSettings,
        info: { name: '<script>xss</script>' },
      })
      getTemplateStub.returns('{{name}}')

      await controller.handleRequest({} as any, res)

      const sent = res.send.firstCall.args[0] as string
      expect(sent).to.not.include('<script>')
      expect(sent).to.include('&lt;script&gt;')
    })

    it('renders amount in sats (msats / 1000)', async () => {
      // 21000 msats → 21 sats
      getTemplateStub.returns('{{amount}}')

      await controller.handleRequest({} as any, res)

      expect(res.send.firstCall.args[0]).to.equal('21')
    })

    it('safe-serializes processor for inline script', async () => {
      getTemplateStub.returns('{{processor_json}}')

      await controller.handleRequest({} as any, res)

      const sent = res.send.firstCall.args[0] as string
      // Should be a JSON string (quoted), not contain raw <
      expect(sent).to.not.include('<')
      expect(JSON.parse(sent)).to.equal('lnbits')
    })

    it('injects the CSP nonce', async () => {
      getTemplateStub.returns('{{nonce}}')

      await controller.handleRequest({} as any, res)

      expect(res.send.firstCall.args[0]).to.equal('invoice-nonce')
    })

    it('injects relay_url path prefix into form actions', async () => {
      getTemplateStub.returns('{{path_prefix}}/invoices')
      createSettingsStub.returns({
        ...enabledPaymentsSettings,
        info: { ...enabledPaymentsSettings.info, relay_url: 'wss://relay.example.com/nostream' },
      })

      await controller.handleRequest({ headers: {} } as any, res)

      expect(res.send.firstCall.args[0]).to.equal('/nostream/invoices')
    })
  })
})
