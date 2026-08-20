import axios from 'axios'
import { expect } from 'chai'
import express from 'express'
import { request as httpRequest } from 'http'
import { AddressInfo } from 'net'

import {
  AdminRequest,
  adminJsonBodyMiddleware,
} from '../../../../src/handlers/request-handlers/admin-json-body-middleware'

describe('adminJsonBodyMiddleware', () => {
  let server: ReturnType<ReturnType<typeof express>['listen']>

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
    }
  })

  const startServer = async (): Promise<string> => {
    const app = express()
    app.patch('/', adminJsonBodyMiddleware, (request: AdminRequest, response) => {
      response.status(200).send({
        body: request.body,
        rawBody: request.rawBody?.toString('utf8'),
      })
    })

    server = await new Promise((resolve) => {
      const listeningServer = app.listen(0, () => resolve(listeningServer))
    })

    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('rejects non-JSON media types', async () => {
    const url = await startServer()
    const rawBody = '{\n  "path": "info.name",\n  "value": "relay"\n}'

    const result = await axios.patch(url, rawBody, {
      headers: { 'content-type': 'text/plain' },
      validateStatus: () => true,
    })

    expect(result.status).to.equal(415)
    expect(result.data).to.deep.equal({ error: 'Unsupported Media Type' })
  })

  it('captures the actual bytes from a chunked request', async () => {
    const url = await startServer()
    const rawBody = '{"path":"info.name","value":"relay"}'

    const result = await new Promise<{ body: Record<string, unknown>; status: number }>((resolve, reject) => {
      const request = httpRequest(
        url,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          },
        },
        (response) => {
          let responseBody = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            responseBody += chunk
          })
          response.on('end', () => {
            resolve({
              body: JSON.parse(responseBody),
              status: response.statusCode ?? 0,
            })
          })
        },
      )

      request.on('error', reject)
      request.write(rawBody.slice(0, 12))
      request.end(rawBody.slice(12))
    })

    expect(result.status).to.equal(200)
    expect(result.body.rawBody).to.equal(rawBody)
    expect(result.body.body).to.deep.equal({ path: 'info.name', value: 'relay' })
  })
})
