import { Duplex, EventEmitter } from 'stream'
import { IncomingMessage, Server, ServerResponse } from 'http'

// import packageJson from '../../package.json'

import { createLogger } from '../factories/logger-factory'
import { Factory } from '../@types/base'
import { getRemoteAddress } from '../utils/http'
import { IRateLimiter } from '../@types/utils'
import { ISettings } from '../@types/settings'
import { IWebServerAdapter } from '../@types/adapters'

const debug = createLogger('web-server-adapter')

export class WebServerAdapter extends EventEmitter implements IWebServerAdapter {
  public constructor(
    protected readonly webServer: Server,
    private readonly slidingWindowRateLimiter: Factory<IRateLimiter>,
    private readonly settings: () => ISettings,
  ) {
    debug('web server starting')
    super()
    this.webServer
      //.on('request', this.onRequest.bind(this))
      .on('error', this.onError.bind(this))
      .on('clientError', this.onClientError.bind(this))
      .once('close', this.onClose.bind(this))
      .once('listening', this.onListening.bind(this))
  }

  public listen(port: number): void {
    debug('attempt to listen on port %d', port)
    this.webServer.listen(port)
  }

  private onListening() {
    debug('listening for incoming connections')
  }

  private async onRequest(request: IncomingMessage, response: ServerResponse) {
    debug('request received: %O', request.headers)

    const clientAddress = getRemoteAddress(request, this.settings())

    if (await this.isRateLimited(clientAddress)) {
      response.end()
    }

    // const {
    //   info: { name, description, pubkey, contact },
    // } = this.settings()

    // try {
    //   if (request.method === 'GET' && request.headers['accept'] === 'application/nostr+json') {
    //     const relayInformationDocument = {
    //       name,
    //       description,
    //       pubkey,
    //       contact,
    //       supported_nips: packageJson.supportedNips,
    //       software: packageJson.repository.url,
    //       version: packageJson.version,
    //     }

    //     response.setHeader('content-type', 'application/nostr+json')
    //     response.setHeader('access-control-allow-origin', '*')
    //     const body = JSON.stringify(relayInformationDocument)
    //     response.end(body)
    //   } else if (request.headers['upgrade'] !== 'connection') {
    //     const url = new URL(request.url, `https://${request.headers.host}`)
    //     if (request.method === 'GET' && url.pathname === '/') {
    //       response.setHeader('content-type', 'text/html; charset=utf-8')
    //       response.write('<html>')
    //       response.write('<head>')
    //       response.write(`<title>${name}</title>`)
    //       response.write('</head>')
    //       response.write('<body>')
    //       response.write('<form action="/generate-invoice">')
    //       response.write('Public key (HEX): ')
    //       response.write('<input name="pubkey" type="text" value="" minlength="64" maxlength="64" />')
    //       response.write('<input type="submit" value="Request invoice" />')
    //       response.write('</form>')
    //       response.write('</body>')
    //       response.write('</html>')
    //       response.end()
    //     } else if (request.method === 'GET' && url.pathname === '/generate-invoice') {
    //       response.setHeader('content-type', 'text/html; charset=utf-8')
    //       response.write('<html>')
    //       response.write('<head>')
    //       response.write(`<title>${name}</title>`)
    //       response.write('</head>')
    //       response.write('<body>')
    //       response.write('Invoice ')
    //       response.write(JSON.stringify(url.searchParams))
    //       response.write('</body>')
    //       response.write('</html>')
    //       response.end()
    //     } else {
    //       response.setHeader('content-type', 'text/plain')
    //       response.end('Please use a Nostr client to connect.')
    //     }
    //   }
    // } catch (error) {
    //   debug('error: %o', error)
    //   response.statusCode = 500
    //   response.end('Internal server error')
    // }
  }

  private async isRateLimited(client: string): Promise<boolean> {
    const {
      rateLimits,
      ipWhitelist = [],
    } = this.settings().limits?.connection ?? {}

    if (ipWhitelist.includes(client)) {
      return false
    }

    const rateLimiter = this.slidingWindowRateLimiter()

    const hit = (period: number, rate: number) =>
      rateLimiter.hit(
        `${client}:connection:${period}`,
        1,
        { period: period, rate: rate },
      )

    let limited = false
    for (const { rate, period } of rateLimits) {
      const isRateLimited = await hit(period, rate)


      if (isRateLimited) {
        debug('rate limited %s: %d messages / %d ms exceeded', client, rate, period)

        limited = true
      }
    }

    return limited
  }

  private onError(error: Error) {
    debug('error: %o', error)

    throw error
  }

  private onClientError(error: Error, socket: Duplex) {
    debug('socket error: %o', error)
    if (error['code'] === 'ECONNRESET' || !socket.writable) {
      return
    }
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\n')
  }

  protected onClose() {
    debug('stopped listening to incoming connections')
    this.webServer.removeAllListeners()
  }
}
