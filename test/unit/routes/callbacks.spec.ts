import axios from 'axios'
import { expect } from 'chai'
import express from 'express'
import Sinon from 'sinon'

import * as openNodeControllerFactory from '../../../src/factories/controllers/opennode-callback-controller-factory'
import * as settingsFactory from '../../../src/factories/settings-factory'

describe('callbacks router', () => {
  let createOpenNodeCallbackControllerStub: Sinon.SinonStub
  let createSettingsStub: Sinon.SinonStub
  let receivedBody: unknown
  let server: any

  beforeEach(async () => {
    receivedBody = undefined

    createSettingsStub = Sinon.stub(settingsFactory, 'createSettings').returns({
      payments: { processor: 'opennode' },
    } as any)

    createOpenNodeCallbackControllerStub = Sinon.stub(openNodeControllerFactory, 'createOpenNodeCallbackController').returns({
      handleRequest: async (request: any, response: any) => {
        receivedBody = request.body
        response.status(200).send('OK')
      },
    } as any)

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    delete require.cache[require.resolve('../../../src/routes/callbacks')]
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../../../src/routes/callbacks').default

    const app = express()
    app.use(router)

    server = await new Promise((resolve) => {
      const listeningServer = app.listen(0, () => resolve(listeningServer))
    })
  })

  afterEach(async () => {
    createOpenNodeCallbackControllerStub.restore()
    createSettingsStub.restore()
    delete require.cache[require.resolve('../../../src/routes/callbacks')]

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
    }
  })

  it('parses form-urlencoded OpenNode callbacks', async () => {
    const { port } = server.address()
    const response = await axios.post(
      `http://127.0.0.1:${port}/opennode`,
      new URLSearchParams({
        hashed_order: 'signature',
        id: 'invoice-id',
        order_id: 'pubkey',
        status: 'paid',
      }).toString(),
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        validateStatus: () => true,
      },
    )

    expect(response.status).to.equal(200)
    expect(receivedBody).to.deep.equal({
      hashed_order: 'signature',
      id: 'invoice-id',
      order_id: 'pubkey',
      status: 'paid',
    })
  })
})