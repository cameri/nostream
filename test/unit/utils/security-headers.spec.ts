import chai from 'chai'
import express, { Express } from 'express'
import { AddressInfo } from 'net'
import { Server } from 'http'
import { securityHeaders } from '../../../src/utils/security-headers'

const { expect } = chai

describe('securityHeaders', () => {
  let server: Server
  let origin: string
  let response: Response

  before(async () => {
    const app: Express = express()
    app.use(securityHeaders())
    app.get('/', (_req, res) => {
      res.send('ok')
    })
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    response = await fetch(origin)
  })

  after(() => {
    server.close()
  })

  it('sets the transport and sniffing headers', () => {
    expect(response.headers.get('strict-transport-security')).to.contain('max-age=')
    expect(response.headers.get('x-content-type-options')).to.equal('nosniff')
  })

  it('refuses framing by other origins', () => {
    expect(response.headers.get('x-frame-options')).to.equal('SAMEORIGIN')
  })

  it('does not emit a Content-Security-Policy of its own', () => {
    // The web app owns one CSP, with the page nonce and the CDN origins it
    // loads from. A second policy from Helmet would intersect with it and block
    // the nonce'd inline scripts.
    expect(response.headers.get('content-security-policy')).to.equal(null)
  })

  it('still runs the whole middleware chain', () => {
    expect(response.status).to.equal(200)
  })
})
